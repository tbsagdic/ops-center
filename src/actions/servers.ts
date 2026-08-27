"use server";

import { revalidatePath } from "next/cache";
import { requirePermission, PermissionError } from "@/lib/auth/permissions";
import { getTenantDb } from "@/lib/db/tenant";
import { writeAudit } from "@/lib/audit";
import { serverSchema, projectServerSchema } from "@/lib/validation/server";
import { ok, fail, zodFail, type ActionResponse } from "@/lib/action-response";
import { logError } from "@/lib/logger";
import { decryptSecret, encryptSecret } from "@/lib/crypto/encryption";

function handleError(error: unknown): ActionResponse<never> {
  if (error instanceof PermissionError) return fail(error.message);
  logError("action.server_failed", error);
  return fail("İşlem sırasında beklenmeyen bir hata oluştu.");
}

function buildData(data: ServerData) {
  return {
    name: data.name,
    provider: data.provider,
    external_ref: data.external_ref,
    type: data.type,
    hostname: data.hostname,
    primary_ip: data.primary_ip,
    region: data.region,
    operating_system: data.operating_system,
    cpu_cores: data.cpu_cores,
    ram_mb: data.ram_mb,
    disk_gb: data.disk_gb,
    management_url: data.management_url,
    ssh_port: data.ssh_port,
    ssh_user: data.ssh_user,
    web_stack: data.web_stack ?? null,
    nginx_sites_path: data.nginx_sites_path ?? null,
    status: data.status,
    renewal_at: data.renewal_at ? new Date(data.renewal_at) : null,
    monthly_cost: data.monthly_cost ?? null,
    cost_period: data.cost_period,
    currency: data.currency,
    // TL kayıtlarda kur tutmanın anlamı yok.
    manual_fx_rate: data.currency === "TRY" ? null : data.manual_fx_rate ?? null,
  };
}

type ServerData = ReturnType<typeof serverSchema.parse>;

/** Parolalar yalnız yeni değer girildiğinde yazılır; boş form alanı mevcut kaydı silmez. */
function encryptServerSecrets(data: ServerData) {
  return {
    ...(data.ssh_password
      ? { ssh_password_encrypted: encryptSecret(data.ssh_password) }
      : {}),
    ...(data.ssh_sudo_password
      ? { ssh_sudo_password_encrypted: encryptSecret(data.ssh_sudo_password) }
      : {}),
  };
}

export async function createServer(
  input: unknown
): Promise<ActionResponse<{ id: string }>> {
  try {
    const ctx = await requirePermission("servers.create");
    const parsed = serverSchema.safeParse(input);
    if (!parsed.success) return zodFail(parsed.error);

    const db = await getTenantDb();
    const secrets = encryptServerSecrets(parsed.data);
    const created = await db.server.create({
      data: {
        ...buildData(parsed.data),
        workspace_id: ctx.workspaceId,
        ...secrets,
      },
    });

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "CREATE",
      auditable_type: "server",
      auditable_id: created.id,
      after_data: created,
    });

    revalidatePath("/sunucular");
    return ok({ id: created.id }, "Sunucu eklendi.");
  } catch (error) {
    return handleError(error);
  }
}

export async function updateServer(
  id: string,
  input: unknown
): Promise<ActionResponse<{ id: string }>> {
  try {
    const ctx = await requirePermission("servers.update");
    const parsed = serverSchema.safeParse(input);
    if (!parsed.success) return zodFail(parsed.error);

    const db = await getTenantDb();
    const before = await db.server.findUnique({ where: { id } });
    if (!before) return fail("Sunucu bulunamadı.");

    const updated = await db.server.update({
      where: { id },
      data: {
        ...buildData(parsed.data),
        ...encryptServerSecrets(parsed.data),
      },
    });

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "UPDATE",
      auditable_type: "server",
      auditable_id: id,
      before_data: before,
      after_data: updated,
    });

    revalidatePath("/sunucular");
    return ok({ id }, "Sunucu güncellendi.");
  } catch (error) {
    return handleError(error);
  }
}

/** Yetkili kullanıcı için kayıtlı SSH parolasını çözer ve erişimi denetim izine yazar. */
export async function revealServerSshPassword(
  id: string
): Promise<ActionResponse<{ sshPassword: string }>> {
  try {
    const ctx = await requirePermission("servers.update");
    const db = await getTenantDb();
    const server = await db.server.findUnique({
      where: { id },
      select: { id: true, ssh_password_encrypted: true },
    });
    if (!server) return fail("Sunucu bulunamadı.");
    if (!server.ssh_password_encrypted) {
      return fail("Bu sunucu için kayıtlı SSH parolası bulunamadı.");
    }

    const sshPassword = decryptSecret(server.ssh_password_encrypted);

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "REVEAL_SSH_PASSWORD",
      auditable_type: "server",
      auditable_id: server.id,
    });

    return ok({ sshPassword });
  } catch (error) {
    return handleError(error);
  }
}

export async function archiveServer(id: string): Promise<ActionResponse<null>> {
  try {
    const ctx = await requirePermission("servers.delete");
    const db = await getTenantDb();
    const server = await db.server.findUnique({ where: { id } });
    if (!server) return fail("Sunucu bulunamadı.");

    await db.server.update({
      where: { id },
      data: { status: "terminated", deleted_at: new Date() },
    });

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "ARCHIVE",
      auditable_type: "server",
      auditable_id: id,
      before_data: server,
    });

    revalidatePath("/sunucular");
    return ok(null, "Sunucu sonlandırıldı.");
  } catch (error) {
    return handleError(error);
  }
}

/** Proje-Sunucu pivot eşleştirmesi ekle. */
export async function linkProjectServer(
  input: unknown
): Promise<ActionResponse<null>> {
  try {
    const ctx = await requirePermission("servers.update");
    const parsed = projectServerSchema.safeParse(input);
    if (!parsed.success) return zodFail(parsed.error);
    const { server_id, project_id, role, environment, is_primary } = parsed.data;

    const db = await getTenantDb();
    // İki kayıt da aynı workspace'te mi? (tenant katmanı zorlar)
    const [server, project] = await Promise.all([
      db.server.findUnique({ where: { id: server_id } }),
      db.project.findUnique({ where: { id: project_id } }),
    ]);
    if (!server || !project) return fail("Sunucu veya proje bulunamadı.");

    try {
      await db.$queryRaw`
        INSERT INTO project_server (id, project_id, server_id, role, environment, is_primary, created_at, updated_at)
        VALUES (gen_random_uuid(), ${project_id}::uuid, ${server_id}::uuid, ${role ?? null}, ${environment ?? null}, ${is_primary}, now(), now())
      `;
    } catch {
      return fail("Bu proje ve sunucu zaten eşleştirilmiş.");
    }

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "LINK_SERVER",
      auditable_type: "server",
      auditable_id: server_id,
      after_data: { project_id, role, environment },
    });

    revalidatePath("/sunucular");
    return ok(null, "Proje sunucuya eşleştirildi.");
  } catch (error) {
    return handleError(error);
  }
}

export async function unlinkProjectServer(
  serverId: string,
  projectId: string
): Promise<ActionResponse<null>> {
  try {
    const ctx = await requirePermission("servers.update");
    const db = await getTenantDb();
    const server = await db.server.findUnique({ where: { id: serverId } });
    if (!server) return fail("Sunucu bulunamadı.");

    await db.$queryRaw`
      DELETE FROM project_server WHERE server_id = ${serverId}::uuid AND project_id = ${projectId}::uuid
    `;

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "UNLINK_SERVER",
      auditable_type: "server",
      auditable_id: serverId,
      after_data: { project_id: projectId },
    });

    revalidatePath("/sunucular");
    return ok(null, "Eşleştirme kaldırıldı.");
  } catch (error) {
    return handleError(error);
  }
}

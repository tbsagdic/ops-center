"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import { requirePermission, PermissionError } from "@/lib/auth/permissions";
import { getTenantDb, type TenantDb } from "@/lib/db/tenant";
import { validateTenantReferences } from "@/lib/db/tenant-references";
import { writeAudit } from "@/lib/audit";
import { normalizeDomain } from "@/lib/domain";
import { ok, fail, zodFail, type ActionResponse } from "@/lib/action-response";
import { logError } from "@/lib/logger";
import { serverDomainOperationSchema } from "@/lib/validation/server-domain";
import { connectSsh, SshError } from "@/lib/ssh/client";
import { shellQuote } from "@/lib/ssh/shell-quote";
import { parseServerBlocks } from "@/lib/nginx/config";
import {
  parseGrepFileList,
  serverNameGrepPattern,
} from "@/lib/nginx/vhost-search";
import {
  MAX_LOG_LINES,
  MAX_LOG_LINE_LENGTH,
  parseContext,
  parseLog,
  parseSteps,
  planSteps,
  type LogLine,
  type OperationContext,
  type StepKey,
  type StepState,
} from "@/lib/server-domains/steps";
import {
  rollback,
  runStep,
  StepError,
  timeoutForStep,
  type OperationRecord,
  type StepRunContext,
} from "@/lib/server-domains/runner";
import {
  buildServerAccess,
  ServerAccessError,
  type ServerAccessRecord,
} from "@/lib/server-domains/target";

/**
 * Sunucu domain kontrolü: SSH üzerinden nginx site tanımı açma/değiştirme akışı.
 *
 * Akış tek bir çağrıda değil, `advanceOperation` ile adım adım ilerletilir.
 * Her çağrı yalnız bir adımı çalıştırır ve sonucu kalıcılaştırır; böylece işlem
 * yarıda kalsa bile nerede kaldığı bellidir ve kaldığı yerden sürdürülebilir.
 */

const PANEL_PATH = "/sunucu-domain";

/** Hata mesajı ile teknik ayrıntıyı ayıran boşluk. */
const DETAIL_SEPARATOR = "\n\n";

function handleError(error: unknown): ActionResponse<never> {
  if (error instanceof PermissionError) return fail(error.message);
  if (error instanceof ServerAccessError) return fail(error.message);
  logError("action.server_domain_failed", error);
  return fail("İşlem sırasında beklenmeyen bir hata oluştu.");
}

const SERVER_ACCESS_SELECT = {
  id: true,
  name: true,
  hostname: true,
  primary_ip: true,
  ssh_port: true,
  ssh_user: true,
  ssh_password_encrypted: true,
  ssh_sudo_password_encrypted: true,
  ssh_host_fingerprint: true,
  nginx_sites_path: true,
} as const;

function appendLog(existing: LogLine[], additions: LogLine[]): LogLine[] {
  const merged = [...existing, ...additions].map((line) => ({
    ...line,
    message: line.message.slice(0, MAX_LOG_LINE_LENGTH),
  }));
  return merged.slice(-MAX_LOG_LINES);
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

// ─── İşlem oluşturma ─────────────────────────────────────────────────────────

export async function createServerDomainOperation(
  input: unknown
): Promise<ActionResponse<{ id: string }>> {
  try {
    const ctx = await requirePermission("server_domains.create");
    const parsed = serverDomainOperationSchema.safeParse(input);
    if (!parsed.success) return zodFail(parsed.error);
    const data = parsed.data;

    const db = await getTenantDb();
    const server = await db.server.findUnique({
      where: { id: data.server_id },
      select: { ...SERVER_ACCESS_SELECT, status: true },
    });
    if (!server) return fail("Sunucu bulunamadı.");
    if (server.status !== "active") {
      return fail("Yalnızca aktif sunucularda domain işlemi yapılabilir.");
    }

    // Erişim bilgileri şimdi doğrulanır: kullanıcı adımlara başlamadan eksiği görsün.
    buildServerAccess(server as ServerAccessRecord);

    const references = await validateTenantReferences(db, ctx.workspaceId, {
      customerId: data.customer_id,
      projectId: data.project_id,
      requireProjectCustomerMatch: true,
    });
    if (!references.ok) return fail(references.message);

    const running = await db.serverDomainOperation.findFirst({
      where: { server_id: data.server_id, status: { in: ["pending", "running"] } },
      select: { id: true, new_domain: true },
    });
    if (running) {
      return fail(
        `Bu sunucuda ${running.new_domain} için yürüyen bir işlem var. Önce onu tamamlayın veya iptal edin.`
      );
    }

    const steps = planSteps({ type: data.type, enableSsl: data.enable_ssl });

    const created = await db.serverDomainOperation.create({
      data: {
        workspace_id: ctx.workspaceId,
        server_id: data.server_id,
        actor_user_id: ctx.user.id,
        type: data.type,
        new_domain: data.new_domain,
        old_domain: data.old_domain ?? null,
        include_www: data.include_www,
        enable_ssl: data.enable_ssl,
        ssl_email: data.ssl_email ?? null,
        redirect_old: data.type === "change" ? data.redirect_old : false,
        document_root: data.document_root ?? null,
        proxy_pass: data.proxy_pass ?? null,
        steps: toJson(steps),
        context: toJson({
          customerId: data.customer_id ?? null,
          projectId: data.project_id ?? null,
        }),
        log: toJson([]),
      },
      select: { id: true },
    });

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "CREATE",
      auditable_type: "server_domain_operation",
      auditable_id: created.id,
      after_data: {
        server_id: data.server_id,
        type: data.type,
        new_domain: data.new_domain,
        old_domain: data.old_domain ?? null,
        enable_ssl: data.enable_ssl,
      },
    });

    revalidatePath(PANEL_PATH);
    return ok(
      { id: created.id },
      "İşlem oluşturuldu. Ön kontrol ile başlayın — bu adım sunucuya hiçbir şey yazmaz."
    );
  } catch (error) {
    return handleError(error);
  }
}

// ─── Adım ilerletme ──────────────────────────────────────────────────────────

export type OperationView = {
  id: string;
  server_id: string;
  server_name: string;
  type: "add" | "change";
  status: string;
  new_domain: string;
  old_domain: string | null;
  enable_ssl: boolean;
  include_www: boolean;
  redirect_old: boolean;
  steps: StepState[];
  current_step: number;
  log: LogLine[];
  error: string | null;
  warnings: string[];
  backup_path: string | null;
  created_at: string;
  finished_at: string | null;
};

function toView(
  operation: {
    id: string;
    server_id: string;
    type: string;
    status: string;
    new_domain: string;
    old_domain: string | null;
    enable_ssl: boolean;
    include_www: boolean;
    redirect_old: boolean;
    steps: unknown;
    context: unknown;
    current_step: number;
    log: unknown;
    error: string | null;
    backup_path: string | null;
    created_at: Date;
    finished_at: Date | null;
    server?: { name: string } | null;
  }
): OperationView {
  const context = parseContext(operation.context);
  return {
    id: operation.id,
    server_id: operation.server_id,
    server_name: operation.server?.name ?? "—",
    type: operation.type as "add" | "change",
    status: operation.status,
    new_domain: operation.new_domain,
    old_domain: operation.old_domain,
    enable_ssl: operation.enable_ssl,
    include_www: operation.include_www,
    redirect_old: operation.redirect_old,
    steps: parseSteps(operation.steps),
    current_step: operation.current_step,
    log: parseLog(operation.log),
    error: operation.error,
    warnings: context.warnings ?? [],
    backup_path: operation.backup_path,
    created_at: operation.created_at.toISOString(),
    finished_at: operation.finished_at?.toISOString() ?? null,
  };
}

const OPERATION_SELECT = {
  id: true,
  server_id: true,
  type: true,
  status: true,
  new_domain: true,
  old_domain: true,
  include_www: true,
  enable_ssl: true,
  ssl_email: true,
  redirect_old: true,
  document_root: true,
  proxy_pass: true,
  steps: true,
  context: true,
  current_step: true,
  log: true,
  error: true,
  backup_path: true,
  created_at: true,
  finished_at: true,
  server: { select: { name: true } },
} as const;

export async function getServerDomainOperation(
  id: string
): Promise<ActionResponse<OperationView>> {
  try {
    await requirePermission("server_domains.view");
    const db = await getTenantDb();
    const operation = await db.serverDomainOperation.findUnique({
      where: { id },
      select: OPERATION_SELECT,
    });
    if (!operation) return fail("İşlem bulunamadı.");
    return ok(toView(operation));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Sıradaki adımı çalıştırır.
 *
 * Eşzamanlılık: adım, `current_step` alanı üzerinden atomik olarak "sahiplenilir".
 * İki sekme aynı anda ilerletmeye çalışırsa yalnız biri sahiplenir, diğeri reddedilir.
 */
export async function advanceServerDomainOperation(
  id: string
): Promise<ActionResponse<OperationView>> {
  try {
    const ctx = await requirePermission("server_domains.create");
    const db = await getTenantDb();

    const operation = await db.serverDomainOperation.findUnique({
      where: { id },
      select: { ...OPERATION_SELECT, server_id: true },
    });
    if (!operation) return fail("İşlem bulunamadı.");
    if (operation.status === "succeeded") {
      return fail("Bu işlem zaten tamamlandı.");
    }
    if (operation.status === "rolled_back") {
      return fail("Bu işlem geri alındı; yeni bir işlem oluşturun.");
    }

    const steps = parseSteps(operation.steps);
    const index = operation.current_step;
    const step = steps[index];
    if (!step) {
      return fail("Çalıştırılacak adım kalmadı.");
    }

    const startedAt = new Date().toISOString();
    steps[index] = { ...step, status: "running", started_at: startedAt, message: undefined };

    // Sahiplenme: current_step ilerletilir, böylece ikinci eşzamanlı çağrı bu adımı bulamaz.
    const claim = await db.serverDomainOperation.updateMany({
      where: { id, current_step: index, status: { in: ["pending", "running", "failed"] } },
      data: {
        current_step: index + 1,
        status: "running",
        error: null,
        steps: toJson(steps),
        ...(index === 0 ? { started_at: new Date() } : {}),
      },
    });
    if (claim.count === 0) {
      return fail("Bu adım başka bir oturumda çalıştırılıyor. Sayfayı yenileyin.");
    }

    const result = await executeStep({
      db,
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.user.id,
      operationId: id,
      stepKey: step.key,
      stepIndex: index,
    });

    revalidatePath(PANEL_PATH);
    return result;
  } catch (error) {
    return handleError(error);
  }
}

/** Sahiplenilmiş adımı çalıştırıp sonucu kalıcılaştırır. */
async function executeStep(args: {
  db: TenantDb;
  workspaceId: string;
  actorUserId: string;
  operationId: string;
  stepKey: StepKey;
  stepIndex: number;
}): Promise<ActionResponse<OperationView>> {
  const { db, operationId, stepKey, stepIndex } = args;

  const operation = await db.serverDomainOperation.findUnique({
    where: { id: operationId },
    select: { ...OPERATION_SELECT, server: { select: SERVER_ACCESS_SELECT } },
  });
  if (!operation) return fail("İşlem bulunamadı.");

  const context = parseContext(operation.context);
  const collected: LogLine[] = [];
  const log = (level: LogLine["level"], message: string) => {
    collected.push({ at: new Date().toISOString(), level, step: stepKey, message });
  };

  const finish = async (
    outcome:
      | {
          ok: true;
          message: string;
          context?: Partial<OperationContext>;
          patch?: { backup_path?: string };
          /** Adım sunucuda sürüyor; ilerleme kaydedilir ama sıraya geçilmez. */
          pending?: boolean;
        }
      | { ok: false; message: string; detail?: string }
  ): Promise<ActionResponse<OperationView>> => {
    const steps = parseSteps(operation.steps);
    const current = steps[stepIndex];
    const finishedAt = new Date().toISOString();
    const isPending = outcome.ok && outcome.pending === true;

    if (current) {
      steps[stepIndex] = {
        ...current,
        status: isPending ? "running" : outcome.ok ? "succeeded" : "failed",
        message: outcome.message,
        ...(isPending ? {} : { finished_at: finishedAt }),
      };
    }

    const isLastStep = stepIndex === steps.length - 1;
    const isComplete = outcome.ok && !isPending;
    const nextContext = outcome.ok
      ? { ...context, ...(outcome.context ?? {}) }
      : context;

    if (!outcome.ok) {
      log("error", outcome.detail ? `${outcome.message} ${outcome.detail}` : outcome.message);
    } else {
      log(isPending ? "info" : "info", outcome.message);
    }

    const updated = await db.serverDomainOperation.update({
      where: { id: operationId },
      data: {
        status: outcome.ok ? (isComplete && isLastStep ? "succeeded" : "running") : "failed",
        // Adım bitmediyse (pending) veya hata verdiyse sayaç aynı adımda kalır:
        // bir sonraki çağrı aynı adımı sürdürür ya da yeniden dener.
        current_step: isComplete ? stepIndex + 1 : stepIndex,
        steps: toJson(steps),
        context: toJson(nextContext),
        log: toJson(appendLog(parseLog(operation.log), collected)),
        error: outcome.ok ? null : outcome.message,
        ...(isComplete && outcome.patch?.backup_path
          ? { backup_path: outcome.patch.backup_path }
          : {}),
        ...(isComplete && isLastStep ? { finished_at: new Date() } : {}),
      },
      select: OPERATION_SELECT,
    });

    if (!outcome.ok) {
      // Güncel durum kalıcılaştı; istemci hatayı gösterip kaydı yeniden okur.
      return fail(
        outcome.detail ? `${outcome.message}${DETAIL_SEPARATOR}${outcome.detail}` : outcome.message
      );
    }
    return ok(toView(updated), outcome.message);
  };

  // Panel tarafı adımı: sunucuya bağlanmaya gerek yok.
  if (stepKey === "finalize") {
    try {
      const message = await finalizeOperation(args, operation, context);
      return finish({ ok: true, message });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Panel kayıtları güncellenemedi.";
      logError("server_domain.finalize_failed", error);
      return finish({ ok: false, message });
    }
  }

  let access;
  try {
    access = buildServerAccess(operation.server as ServerAccessRecord);
  } catch (error) {
    return finish({
      ok: false,
      message: error instanceof Error ? error.message : "Sunucu erişim bilgileri okunamadı.",
    });
  }

  let connection;
  try {
    connection = await connectSsh(access.target);
  } catch (error) {
    const message =
      error instanceof SshError ? error.message : "Sunucuya bağlanılamadı.";
    if (!(error instanceof SshError)) logError("server_domain.connect_failed", error);
    return finish({ ok: false, message });
  }

  try {
    // İlk başarılı bağlantıda host anahtarı kaydedilir; sonraki bağlantılar buna göre doğrulanır.
    if (connection.firstSeen && connection.fingerprint) {
      await db.server.update({
        where: { id: operation.server_id },
        data: { ssh_host_fingerprint: connection.fingerprint },
      });
      log("info", `Sunucu SSH kimliği kaydedildi: ${connection.fingerprint}`);
    }

    const runContext: StepRunContext = {
      operation: operation as unknown as OperationRecord,
      connection,
      context,
      sitesAvailable: access.sitesAvailable,
      sitesEnabled: access.sitesEnabled,
      log,
    };

    const result = await Promise.race([
      runStep(stepKey, runContext),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new StepError("Adım zaman aşımına uğradı.")),
          timeoutForStep(stepKey) + 15_000
        )
      ),
    ]);

    await writeAudit({
      workspace_id: args.workspaceId,
      actor_user_id: args.actorUserId,
      action: "SERVER_DOMAIN_STEP",
      auditable_type: "server_domain_operation",
      auditable_id: operationId,
      after_data: { step: stepKey, result: result.message },
    });

    return finish({
      ok: true,
      message: result.message,
      context: result.context,
      patch: result.patch,
    });
  } catch (error) {
    const message =
      error instanceof StepError || error instanceof SshError
        ? error.message
        : "Adım beklenmedik bir hatayla durdu.";
    const detail = error instanceof StepError ? error.detail : undefined;
    if (!(error instanceof StepError) && !(error instanceof SshError)) {
      logError("server_domain.step_failed", error, { step: stepKey });
    }
    return finish({ ok: false, message, detail });
  } finally {
    connection.close();
  }
}

// ─── Panel kayıtları ─────────────────────────────────────────────────────────

/** Sunucudaki değişiklik tamamlandıktan sonra domain kayıtlarını hizalar. */
async function finalizeOperation(
  args: { db: TenantDb; workspaceId: string; actorUserId: string },
  operation: {
    id: string;
    server_id: string;
    type: string;
    new_domain: string;
    old_domain: string | null;
    redirect_old: boolean;
  },
  context: OperationContext & { customerId?: string | null; projectId?: string | null }
): Promise<string> {
  const { db } = args;
  const normalized = normalizeDomain(operation.new_domain);
  if (!normalized) throw new Error("Yeni alan adı normalize edilemedi.");

  const sslExpiresAt = context.sslExpiresAt ? new Date(context.sslExpiresAt) : null;

  const previous = operation.old_domain
    ? await db.domain.findFirst({
        where: { normalized_name: operation.old_domain },
        select: { id: true, customer_id: true, project_id: true, registrar: true },
      })
    : null;

  const existing = await db.domain.findFirst({
    where: { normalized_name: normalized },
    select: { id: true },
  });

  const shared = {
    server_id: operation.server_id,
    status: "active" as const,
    ...(sslExpiresAt ? { ssl_expires_at: sslExpiresAt } : {}),
  };

  if (existing) {
    await db.domain.update({ where: { id: existing.id }, data: shared });
  } else {
    await db.domain.create({
      data: {
        workspace_id: args.workspaceId,
        name: operation.new_domain,
        normalized_name: normalized,
        // Devralınan bağlar: değiştirme işleminde yeni domain eski müşteri/projeye bağlanır.
        customer_id: context.customerId ?? previous?.customer_id ?? null,
        project_id: context.projectId ?? previous?.project_id ?? null,
        ...shared,
      },
    });
  }

  const notes: string[] = [
    existing
      ? `${operation.new_domain} kaydı güncellendi.`
      : `${operation.new_domain} domain kaydı oluşturuldu.`,
  ];

  if (previous) {
    await db.domain.update({
      where: { id: previous.id },
      data: {
        status: operation.redirect_old ? "transferred" : "cancelled",
        notes: `Ops Center: ${operation.new_domain} alan adına taşındı (${new Date()
          .toISOString()
          .slice(0, 10)}).`,
      },
    });
    notes.push(
      `${operation.old_domain} kaydı ${
        operation.redirect_old ? "devredildi" : "bırakıldı"
      } olarak işaretlendi.`
    );
  } else if (operation.old_domain) {
    notes.push(`${operation.old_domain} için panelde domain kaydı bulunamadı.`);
  }

  await writeAudit({
    workspace_id: args.workspaceId,
    actor_user_id: args.actorUserId,
    action: "SERVER_DOMAIN_COMPLETED",
    auditable_type: "server_domain_operation",
    auditable_id: operation.id,
    after_data: {
      new_domain: operation.new_domain,
      old_domain: operation.old_domain,
      ssl_expires_at: context.sslExpiresAt ?? null,
    },
  });

  revalidatePath("/domainler");
  return notes.join(" ");
}

// ─── Geri alma ve iptal ──────────────────────────────────────────────────────

export async function rollbackServerDomainOperation(
  id: string
): Promise<ActionResponse<OperationView>> {
  try {
    const ctx = await requirePermission("server_domains.delete");
    const db = await getTenantDb();

    const operation = await db.serverDomainOperation.findUnique({
      where: { id },
      select: { ...OPERATION_SELECT, server: { select: SERVER_ACCESS_SELECT } },
    });
    if (!operation) return fail("İşlem bulunamadı.");
    if (operation.status === "rolled_back") return fail("Bu işlem zaten geri alındı.");
    if (!operation.backup_path) {
      return fail(
        "Bu işlemde henüz sunucuya yazma yapılmadı; geri alınacak bir değişiklik yok."
      );
    }

    const access = buildServerAccess(operation.server as ServerAccessRecord);
    const context = parseContext(operation.context);
    const collected: LogLine[] = [];
    const log = (level: LogLine["level"], message: string) => {
      collected.push({ at: new Date().toISOString(), level, step: "system", message });
    };

    const connection = await connectSsh(access.target);
    let actions: string[];
    try {
      actions = await rollback({
        operation: operation as unknown as OperationRecord,
        connection,
        context,
        sitesAvailable: access.sitesAvailable,
        sitesEnabled: access.sitesEnabled,
        log,
      });
    } finally {
      connection.close();
    }

    for (const action of actions) log("info", action);

    const steps = parseSteps(operation.steps).map((step) =>
      step.status === "succeeded" || step.status === "failed"
        ? { ...step, status: "skipped" as const, message: "Geri alındı." }
        : step
    );

    const updated = await db.serverDomainOperation.update({
      where: { id },
      data: {
        status: "rolled_back",
        steps: toJson(steps),
        log: toJson(appendLog(parseLog(operation.log), collected)),
        finished_at: new Date(),
        error: null,
      },
      select: OPERATION_SELECT,
    });

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "SERVER_DOMAIN_ROLLBACK",
      auditable_type: "server_domain_operation",
      auditable_id: id,
      after_data: { actions },
    });

    revalidatePath(PANEL_PATH);
    return ok(toView(updated), `Geri alındı: ${actions.join(", ")}.`);
  } catch (error) {
    if (error instanceof StepError) return fail(error.message);
    if (error instanceof SshError) return fail(error.message);
    return handleError(error);
  }
}

/** Henüz sunucuya dokunmamış bir işlemi kapatır. */
export async function cancelServerDomainOperation(
  id: string
): Promise<ActionResponse<null>> {
  try {
    const ctx = await requirePermission("server_domains.delete");
    const db = await getTenantDb();
    const operation = await db.serverDomainOperation.findUnique({
      where: { id },
      select: { id: true, status: true, backup_path: true },
    });
    if (!operation) return fail("İşlem bulunamadı.");
    if (operation.status === "succeeded") return fail("Tamamlanmış işlem iptal edilemez.");
    if (operation.backup_path) {
      return fail(
        "Sunucuda değişiklik yapılmış. İptal yerine 'Geri al' seçeneğini kullanın."
      );
    }

    await db.serverDomainOperation.update({
      where: { id },
      data: { status: "rolled_back", finished_at: new Date(), error: "Kullanıcı iptal etti." },
    });

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "SERVER_DOMAIN_CANCELLED",
      auditable_type: "server_domain_operation",
      auditable_id: id,
    });

    revalidatePath(PANEL_PATH);
    return ok(null, "İşlem iptal edildi.");
  } catch (error) {
    return handleError(error);
  }
}

// ─── Sunucu keşfi ────────────────────────────────────────────────────────────

export type DiscoveredSite = {
  file: string;
  domains: string[];
  enabled: boolean;
  ssl: boolean;
  root: string | null;
  proxyPass: string | null;
};

/**
 * Sunucuda tanımlı siteleri listeler — hiçbir şey yazmaz.
 * "Domaini değiştir" formunda eski alan adını elle yazmak yerine seçtirmek için.
 */
export async function listServerSites(
  serverId: string
): Promise<ActionResponse<DiscoveredSite[]>> {
  try {
    await requirePermission("server_domains.view");
    const db = await getTenantDb();
    const server = await db.server.findUnique({
      where: { id: serverId },
      select: SERVER_ACCESS_SELECT,
    });
    if (!server) return fail("Sunucu bulunamadı.");

    const access = buildServerAccess(server as ServerAccessRecord);
    const connection = await connectSsh(access.target);

    try {
      if (connection.firstSeen && connection.fingerprint) {
        await db.server.update({
          where: { id: serverId },
          data: { ssh_host_fingerprint: connection.fingerprint },
        });
      }
      return ok(await discoverSites(connection, access));
    } finally {
      connection.close();
    }
  } catch (error) {
    if (error instanceof SshError) return fail(error.message);
    return handleError(error);
  }
}

async function discoverSites(
  connection: Awaited<ReturnType<typeof connectSsh>>,
  access: { sitesAvailable: string; sitesEnabled: string }
): Promise<DiscoveredSite[]> {
  const listing = await connection.sudo(
    `ls -1 ${shellQuote(access.sitesAvailable)}`
  );
  if (listing.code !== 0) return [];

  const files = listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && /^[A-Za-z0-9._-]+$/.test(line))
    .slice(0, 60);

  const enabledListing = await connection.sudo(`ls -1 ${shellQuote(access.sitesEnabled)}`);
  const enabled = new Set(
    enabledListing.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
  );

  const sites: DiscoveredSite[] = [];
  for (const file of files) {
    const content = await connection.sudo(
      `cat ${shellQuote(`${access.sitesAvailable}/${file}`)}`
    );
    if (content.code !== 0) continue;

    const blocks = parseServerBlocks(content.stdout);
    const domains = [
      ...new Set(
        blocks
          .flatMap((block) => block.serverNames)
          .filter((name) => name !== "_" && !name.startsWith("~"))
      ),
    ];
    if (domains.length === 0) continue;

    const primary = blocks.find((block) => !block.isSsl) ?? blocks[0];
    sites.push({
      file,
      domains,
      enabled: enabled.has(file),
      ssl: blocks.some((block) => block.isSsl),
      root: primary?.root ?? null,
      proxyPass: primary?.proxyPass ?? null,
    });
  }
  return sites;
}

/** Sunucunun kayıtlı SSH parmak izini siler; yeniden kurulan sunucular için. */
export async function resetServerFingerprint(
  serverId: string
): Promise<ActionResponse<null>> {
  try {
    const ctx = await requirePermission("servers.update");
    const db = await getTenantDb();
    const server = await db.server.findUnique({
      where: { id: serverId },
      select: { id: true, ssh_host_fingerprint: true },
    });
    if (!server) return fail("Sunucu bulunamadı.");

    await db.server.update({
      where: { id: serverId },
      data: { ssh_host_fingerprint: null },
    });

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "RESET_SSH_FINGERPRINT",
      auditable_type: "server",
      auditable_id: serverId,
      before_data: { ssh_host_fingerprint: server.ssh_host_fingerprint },
    });

    revalidatePath(PANEL_PATH);
    return ok(
      null,
      "Parmak izi sıfırlandı. Sonraki bağlantıda sunucunun yeni kimliği kaydedilecek."
    );
  } catch (error) {
    return handleError(error);
  }
}

/** Cron/temizlik: tamamlanmış işlemlerin sunucudaki yedeklerini listeler. */
export async function listOperations(
  serverId?: string
): Promise<ActionResponse<OperationView[]>> {
  try {
    await requirePermission("server_domains.view");
    const db = await getTenantDb();
    const operations = await db.serverDomainOperation.findMany({
      where: serverId ? { server_id: serverId } : undefined,
      select: OPERATION_SELECT,
      orderBy: { created_at: "desc" },
      take: 50,
    });
    return ok(operations.map(toView));
  } catch (error) {
    return handleError(error);
  }
}

// ─── Alan adı arama ──────────────────────────────────────────────────────────

export type DomainLocation = {
  serverId: string;
  serverName: string;
  address: string;
  /** Alan adının tanımlı olduğu vhost dosyaları. */
  files: string[];
  /** Sunucuya bağlanılamadıysa nedeni. */
  error?: string;
};

/** Aynı anda kaç sunucuya bağlanılacağı; çok sayıda kayıtta ağı boğmamak için. */
const LOCATE_CONCURRENCY = 5;
/** Aramaya dahil edilecek azami sunucu sayısı. */
const LOCATE_MAX_SERVERS = 25;

/**
 * Bir alan adının hangi kayıtlı sunucuda tanımlı olduğunu bulur.
 *
 * Kullanıcının hangi sitenin hangi makinede olduğunu ezbere bilmesi gerekmesin
 * diye vardır: alan adı yazılır, panel erişebildiği sunucuları tarar. Salt okuma
 * yapar; hiçbir sunucuya yazmaz.
 */
export async function locateDomain(
  domain: string
): Promise<ActionResponse<DomainLocation[]>> {
  try {
    await requirePermission("server_domains.view");

    const normalized = normalizeDomain(domain);
    if (!normalized) return fail("Geçerli bir alan adı girin.");

    const db = await getTenantDb();
    const servers = await db.server.findMany({
      where: { status: "active" },
      orderBy: { name: "asc" },
      take: LOCATE_MAX_SERVERS,
      select: SERVER_ACCESS_SELECT,
    });

    const usable = servers.filter((server) => server.ssh_password_encrypted);
    if (usable.length === 0) {
      return fail(
        "Aramaya uygun sunucu yok. Sunucular ekranından SSH kullanıcısı ve parolası kayıtlı en az bir aktif sunucu gerekir."
      );
    }

    const results: DomainLocation[] = [];
    for (let i = 0; i < usable.length; i += LOCATE_CONCURRENCY) {
      const batch = usable.slice(i, i + LOCATE_CONCURRENCY);
      const settled = await Promise.all(
        batch.map((server) => searchOneServer(server as ServerAccessRecord, normalized))
      );
      results.push(...settled);
    }

    // Bulunan sunucular başa alınır; erişilemeyenler sona.
    results.sort((a, b) => {
      if (a.files.length !== b.files.length) return b.files.length - a.files.length;
      return Number(Boolean(a.error)) - Number(Boolean(b.error));
    });

    return ok(results);
  } catch (error) {
    return handleError(error);
  }
}

/** Tek bir sunucuda alan adını arar; bağlantı hatası sonucu düşürmez. */
async function searchOneServer(
  server: ServerAccessRecord,
  domain: string
): Promise<DomainLocation> {
  const base: DomainLocation = {
    serverId: server.id,
    serverName: server.name,
    address: server.primary_ip || server.hostname || "",
    files: [],
  };

  let access;
  try {
    access = buildServerAccess(server);
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : "Erişim bilgileri eksik.",
    };
  }

  try {
    const connection = await connectSsh(access.target);
    try {
      const result = await connection.sudo(
        `grep -rlE ${shellQuote(serverNameGrepPattern(domain))} ${shellQuote(access.sitesAvailable)}`
      );
      if (result.code > 1) {
        return { ...base, error: `${access.sitesAvailable} taranamadı (yetki?).` };
      }
      return { ...base, files: parseGrepFileList(result.stdout) };
    } finally {
      connection.close();
    }
  } catch (error) {
    return {
      ...base,
      error: error instanceof SshError ? error.message : "Sunucuya bağlanılamadı.",
    };
  }
}

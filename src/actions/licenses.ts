"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type {
  LicenseStatus,
  Prisma,
} from "@/generated/prisma/client";
import { requirePermission, PermissionError } from "@/lib/auth/permissions";
import { getTenantDb } from "@/lib/db/tenant";
import { prisma } from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { encryptSecret, decryptSecret } from "@/lib/crypto/encryption";
import {
  generateLicenseKey,
  hashLicenseKey,
} from "@/lib/crypto/license-key";
import { normalizeDomain } from "@/lib/domain";
import {
  createLicenseSchema,
  updateLicenseSchema,
  changeStatusSchema,
  licenseDomainSchema,
  domainStatusSchema,
} from "@/lib/validation/license";
import { ok, fail, zodFail, type ActionResponse } from "@/lib/action-response";
import {
  createLicenseWebhookDelivery,
  publishWebhookDelivery,
} from "@/lib/queue/webhook-dispatch";
import { logError } from "@/lib/logger";
import {
  addLicenseGraceDays,
  addLicenseYear,
  licenseExpiresAt,
  licenseStartsAt,
} from "@/lib/licenses/dates";

/** Aynı lisansın bu süre içinde ikinci kez yenilenmesi engellenir. */
const RENEWAL_LOCK_MS = 15_000;
const licenseIdSchema = z.uuid("Lisans kimliği geçersiz.");

function handleError(error: unknown): ActionResponse<never> {
  if (error instanceof PermissionError) return fail(error.message);
  logError("action.license_failed", error);
  return fail("İşlem sırasında beklenmeyen bir hata oluştu.");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

function keyPrefixOf(licenseKey: string): string {
  // PT-A8F2K-... → "PT-A8F2K"
  const parts = licenseKey.split("-");
  return `${parts[0]}-${parts[1]}`;
}

async function lockTenantLicense(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  licenseId: string
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM licenses
    WHERE id = ${licenseId}::uuid
      AND workspace_id = ${workspaceId}::uuid
    FOR UPDATE
  `;
  if (rows.length === 0) return null;
  return tx.license.findUnique({ where: { id: licenseId } });
}

async function publishOutbox(deliveryId: string | null): Promise<void> {
  if (!deliveryId) return;
  try {
    await publishWebhookDelivery(deliveryId);
  } catch (error) {
    // Kalıcı outbox kaydı commit edildi; cron daha sonra yeniden yayınlayacak.
    logError("webhook.outbox_initial_publish_failed", error, {
      delivery_id: deliveryId,
    });
  }
}

/** Yeni lisansı ve birincil domain bağını aynı transaction içinde üretir. */
export async function createLicense(
  input: unknown
): Promise<ActionResponse<{ id: string; licenseKey: string }>> {
  try {
    const ctx = await requirePermission("licenses.create");
    const parsed = createLicenseSchema.safeParse(input);
    if (!parsed.success) return zodFail(parsed.error);
    const data = parsed.data;

    const normalizedDomain = normalizeDomain(data.domain);
    if (!normalizedDomain) {
      return fail("Geçersiz domain biçimi.", { domain: ["Geçerli bir domain girin."] });
    }

    const licenseKey = generateLicenseKey();
    // Süresiz lisansta hiçbir tarih penceresi tutulmaz.
    const startsAt = data.unlimited ? null : licenseStartsAt(data.starts_at);
    const expiresAt = data.unlimited ? null : licenseExpiresAt(data.expires_at);
    const graceEndsAt = data.unlimited
      ? null
      : addLicenseGraceDays(expiresAt, data.grace_days);

    const result = await prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: {
          id: data.project_id,
          workspace_id: ctx.workspaceId,
          deleted_at: null,
        },
        select: { id: true, customer_id: true },
      });
      if (!project) return null;

      const created = await tx.license.create({
        data: {
          workspace_id: ctx.workspaceId,
          project_id: data.project_id,
          product_name: data.product_name,
          key_prefix: keyPrefixOf(licenseKey),
          key_hash: hashLicenseKey(licenseKey),
          key_secret: encryptSecret(licenseKey),
          status: "active",
          starts_at: startsAt,
          expires_at: expiresAt,
          grace_ends_at: graceEndsAt,
          activation_limit: data.activation_limit,
          auto_suspend: data.auto_suspend,
          features: data.features
            ? data.features.split(",").map((s) => s.trim()).filter(Boolean)
            : [],
        },
      });
      await tx.licenseDomain.create({
        data: {
          license_id: created.id,
          domain: normalizedDomain,
          normalized_domain: normalizedDomain,
          environment: data.environment,
          is_primary: true,
          status: "active",
        },
      });
      await tx.domain.upsert({
        where: {
          workspace_id_normalized_name: {
            workspace_id: ctx.workspaceId,
            normalized_name: normalizedDomain,
          },
        },
        create: {
          workspace_id: ctx.workspaceId,
          customer_id: project.customer_id,
          project_id: project.id,
          name: normalizedDomain,
          normalized_name: normalizedDomain,
          status: "active",
        },
        update: {},
      });
      await tx.licenseEvent.create({
        data: {
          license_id: created.id,
          actor_user_id: ctx.user.id,
          type: "issued",
          new_status: "active",
        },
      });
      const deliveryId = await createLicenseWebhookDelivery(
        tx,
        ctx.workspaceId,
        data.project_id,
        created.id,
        "license.issued",
        {
          license_id: created.id,
          product: created.product_name,
          status: created.status,
          domain: normalizedDomain,
          environment: data.environment,
          expires_at: created.expires_at?.toISOString() ?? null,
        }
      );
      return { created, deliveryId };
    });
    if (!result) return fail("Seçilen proje bulunamadı.");
    const { created, deliveryId } = result;

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "CREATE",
      auditable_type: "license",
      auditable_id: created.id,
      after_data: {
        ...created,
        primary_domain: normalizedDomain,
        environment: data.environment,
      },
    });

    await publishOutbox(deliveryId);

    revalidatePath("/lisanslar");
    return ok(
      { id: created.id, licenseKey },
      "Lisans domain bağlantısıyla birlikte üretildi."
    );
  } catch (error) {
    return handleError(error);
  }
}

/** Lisansın kullanıcı tarafından düzenlenebilen alanlarını tek işlemde günceller. */
export async function updateLicense(input: unknown): Promise<ActionResponse<null>> {
  try {
    const ctx = await requirePermission("licenses.update");
    const parsed = updateLicenseSchema.safeParse(input);
    if (!parsed.success) return zodFail(parsed.error);
    const data = parsed.data;

    // Süresiz lisansta hiçbir tarih penceresi tutulmaz.
    const startsAt =
      data.unlimited || !data.starts_at ? null : licenseStartsAt(data.starts_at);
    const expiresAt = data.unlimited ? null : licenseExpiresAt(data.expires_at);
    const graceEndsAt = data.unlimited
      ? null
      : addLicenseGraceDays(expiresAt, data.grace_days);

    const result = await prisma.$transaction(
      async (tx) => {
        const license = await lockTenantLicense(
          tx,
          ctx.workspaceId,
          data.license_id
        );
        if (!license) {
          return { kind: "error" as const, message: "Lisans bulunamadı." };
        }

        const activeActivationCount = await tx.licenseActivation.count({
          where: { license_id: license.id, status: "active" },
        });
        if (data.activation_limit < activeActivationCount) {
          return {
            kind: "error" as const,
            message: `Aktivasyon limiti aktif kurulum sayısından (${activeActivationCount}) düşük olamaz.`,
          };
        }

        const now = new Date();
        if (data.status === "active" && expiresAt && expiresAt < now) {
          return {
            kind: "error" as const,
            message: "Süresi dolmuş lisans aktif durumda kaydedilemez.",
          };
        }
        if (
          data.status === "grace" &&
          !(graceEndsAt && graceEndsAt >= now)
        ) {
          return {
            kind: "error" as const,
            message: "Ek süre durumu için geçerli bir bitiş tarihi ve ek süre girilmelidir.",
          };
        }

        const before = {
          product_name: license.product_name,
          status: license.status,
          starts_at: license.starts_at,
          expires_at: license.expires_at,
          grace_ends_at: license.grace_ends_at,
          activation_limit: license.activation_limit,
          auto_suspend: license.auto_suspend,
          features: license.features,
        };
        const features = data.features
          ? data.features.split(",").map((feature) => feature.trim()).filter(Boolean)
          : [];
        const updated = await tx.license.update({
          where: { id: license.id },
          data: {
            product_name: data.product_name,
            status: data.status,
            starts_at: startsAt,
            expires_at: expiresAt,
            grace_ends_at: graceEndsAt,
            activation_limit: data.activation_limit,
            auto_suspend: data.auto_suspend,
            features,
          },
          select: {
            product_name: true,
            status: true,
            starts_at: true,
            expires_at: true,
            grace_ends_at: true,
            activation_limit: true,
            auto_suspend: true,
            features: true,
          },
        });

        if (license.status !== data.status) {
          await tx.licenseEvent.create({
            data: {
              license_id: license.id,
              actor_user_id: ctx.user.id,
              type: "status_changed",
              previous_status: license.status,
              new_status: data.status,
              reason: data.reason ?? null,
            },
          });
        }

        const deliveryId = await createLicenseWebhookDelivery(
          tx,
          ctx.workspaceId,
          license.project_id,
          license.id,
          "license.updated",
          {
            license_id: license.id,
            product: updated.product_name,
            previous_status: license.status,
            status: updated.status,
            starts_at: updated.starts_at?.toISOString() ?? null,
            expires_at: updated.expires_at?.toISOString() ?? null,
            grace_ends_at: updated.grace_ends_at?.toISOString() ?? null,
            activation_limit: updated.activation_limit,
          }
        );

        return { kind: "ok" as const, before, updated, deliveryId };
      },
      { maxWait: 5_000, timeout: 15_000 }
    );
    if (result.kind === "error") return fail(result.message);

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "UPDATE",
      auditable_type: "license",
      auditable_id: data.license_id,
      before_data: result.before,
      after_data: { ...result.updated, reason: data.reason ?? null },
    });
    await publishOutbox(result.deliveryId);

    revalidatePath("/lisanslar");
    return ok(null, "Lisans güncellendi.");
  } catch (error) {
    return handleError(error);
  }
}

export async function changeLicenseStatus(
  input: unknown
): Promise<ActionResponse<null>> {
  try {
    const ctx = await requirePermission("licenses.update");
    const parsed = changeStatusSchema.safeParse(input);
    if (!parsed.success) return zodFail(parsed.error);
    const { license_id, status, reason } = parsed.data;

    type StatusResult =
      | { kind: "error"; message: string }
      | {
          kind: "ok";
          previous: LicenseStatus;
          deliveryId: string | null;
        };
    const result = await prisma.$transaction(
      async (tx): Promise<StatusResult> => {
        const license = await lockTenantLicense(
          tx,
          ctx.workspaceId,
          license_id
        );
        if (!license) return { kind: "error", message: "Lisans bulunamadı." };
        if (license.status === status) {
          return { kind: "error", message: "Lisans zaten bu durumda." };
        }

        const now = new Date();
        const expired = Boolean(license.expires_at && license.expires_at < now);
        if (status === "active" && expired) {
          return {
            kind: "error",
            message:
              "Süresi dolmuş lisans doğrudan aktife alınamaz. Önce lisansı yenileyin.",
          };
        }
        if (
          status === "grace" &&
          !(license.grace_ends_at && license.grace_ends_at >= now)
        ) {
          return {
            kind: "error",
            message:
              "Ek süre penceresi tanımlı değil veya dolmuş. Önce lisansı yenileyin.",
          };
        }

        const previous = license.status;
        await tx.license.update({
          where: { id: license_id },
          data: { status },
        });
        await tx.licenseEvent.create({
          data: {
            license_id,
            actor_user_id: ctx.user.id,
            type: "status_changed",
            previous_status: previous,
            new_status: status,
            reason: reason ?? null,
          },
        });
        const deliveryId = await createLicenseWebhookDelivery(
          tx,
          ctx.workspaceId,
          license.project_id,
          license_id,
          "license.status_changed",
          {
            license_id,
            previous_status: previous,
            new_status: status,
          }
        );
        return { kind: "ok", previous, deliveryId };
      },
      { maxWait: 5_000, timeout: 15_000 }
    );
    if (result.kind === "error") return fail(result.message);
    const { previous, deliveryId } = result;

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "STATUS_CHANGE",
      auditable_type: "license",
      auditable_id: license_id,
      before_data: { status: previous },
      after_data: { status, reason },
    });

    await publishOutbox(deliveryId);

    revalidatePath("/lisanslar");
    return ok(null, "Lisans durumu güncellendi.");
  } catch (error) {
    return handleError(error);
  }
}

/** 1 yıl yenile. Gelecekteyse mevcut bitişe +1 yıl, geçmişteyse bugünden +1 yıl. */
export async function renewLicense(
  licenseId: string
): Promise<ActionResponse<null>> {
  try {
    const ctx = await requirePermission("licenses.update");
    if (!licenseIdSchema.safeParse(licenseId).success) {
      return fail("Lisans kimliği geçersiz.");
    }

    type RenewResult =
      | { kind: "error"; message: string }
      | {
          kind: "ok";
          previousExpiry: Date | null;
          previousStatus: LicenseStatus;
          newExpiry: Date;
          newGrace: Date | null;
          newStatus: LicenseStatus;
          deliveryId: string | null;
        };
    const result = await prisma.$transaction(
      async (tx): Promise<RenewResult> => {
        const license = await lockTenantLicense(
          tx,
          ctx.workspaceId,
          licenseId
        );
        if (!license) return { kind: "error", message: "Lisans bulunamadı." };
        // Süresiz lisansa yenileme uygulanırsa lisans sessizce süreli hâle gelir.
        if (!license.expires_at) {
          return {
            kind: "error",
            message:
              "Süresiz lisans yenilenemez. Önce lisansa bitiş tarihi tanımlayın.",
          };
        }

        const recent = await tx.licenseEvent.findFirst({
          where: {
            license_id: licenseId,
            type: "renewed",
            occurred_at: { gt: new Date(Date.now() - RENEWAL_LOCK_MS) },
          },
          select: { id: true },
        });
        if (recent) {
          return {
            kind: "error",
            message:
              "Bu lisans az önce yenilendi. Lütfen birkaç saniye bekleyin.",
          };
        }

        const now = Date.now();
        const currentExpiry = license.expires_at?.getTime() ?? 0;
        const base = currentExpiry > now ? currentExpiry : now;
        const newExpiry = addLicenseYear(new Date(base));

        let newGrace: Date | null = null;
        if (license.grace_ends_at && license.expires_at) {
          const graceSpan =
            license.grace_ends_at.getTime() - license.expires_at.getTime();
          if (graceSpan > 0) {
            newGrace = new Date(newExpiry.getTime() + graceSpan);
          }
        }

        const previousStatus = license.status;
        const reactivatable =
          previousStatus === "expired" ||
          previousStatus === "grace" ||
          (previousStatus === "suspended" &&
            license.auto_suspend &&
            currentExpiry > 0 &&
            currentExpiry < now);
        const newStatus: LicenseStatus = reactivatable
          ? "active"
          : previousStatus;

        await tx.license.update({
          where: { id: licenseId },
          data: {
            expires_at: newExpiry,
            grace_ends_at: newGrace,
            status: newStatus,
          },
        });
        await tx.licenseEvent.create({
          data: {
            license_id: licenseId,
            actor_user_id: ctx.user.id,
            type: "renewed",
            previous_status: previousStatus,
            new_status: newStatus,
          },
        });
        const deliveryId = await createLicenseWebhookDelivery(
          tx,
          ctx.workspaceId,
          license.project_id,
          licenseId,
          "license.renewed",
          {
            license_id: licenseId,
            expires_at: newExpiry.toISOString(),
            grace_ends_at: newGrace?.toISOString() ?? null,
            previous_status: previousStatus,
            new_status: newStatus,
          }
        );
        return {
          kind: "ok",
          previousExpiry: license.expires_at,
          previousStatus,
          newExpiry,
          newGrace,
          newStatus,
          deliveryId,
        };
      },
      { maxWait: 5_000, timeout: 15_000 }
    );
    if (result.kind === "error") return fail(result.message);
    const {
      previousExpiry,
      previousStatus,
      newExpiry,
      newStatus,
      deliveryId,
    } = result;

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "RENEW",
      auditable_type: "license",
      auditable_id: licenseId,
      before_data: { expires_at: previousExpiry, status: previousStatus },
      after_data: { expires_at: newExpiry, status: newStatus },
    });

    await publishOutbox(deliveryId);

    revalidatePath("/lisanslar");
    return ok(null, `Lisans yenilendi. Yeni bitiş: ${newExpiry.toLocaleDateString("tr-TR")}`);
  } catch (error) {
    return handleError(error);
  }
}

/** Yetkili kullanıcı için şifreli anahtarı çözer ve erişimi denetim izine yazar. */
export async function revealLicenseKey(
  licenseId: string
): Promise<ActionResponse<{ licenseKey: string }>> {
  try {
    const ctx = await requirePermission("licenses.update");
    const db = await getTenantDb();
    const license = await db.license.findUnique({ where: { id: licenseId } });
    if (!license) return fail("Lisans bulunamadı.");

    const licenseKey = decryptSecret(license.key_secret);

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "REVEAL_KEY",
      auditable_type: "license",
      auditable_id: licenseId,
    });

    return ok({ licenseKey });
  } catch (error) {
    return handleError(error);
  }
}

/** Tüm aktivasyonları sıfırla (deaktive et). */
export async function resetActivations(
  licenseId: string
): Promise<ActionResponse<null>> {
  try {
    const ctx = await requirePermission("licenses.update");
    if (!licenseIdSchema.safeParse(licenseId).success) {
      return fail("Lisans kimliği geçersiz.");
    }

    const result = await prisma.$transaction(
      async (tx) => {
        const license = await lockTenantLicense(
          tx,
          ctx.workspaceId,
          licenseId
        );
        if (!license) return null;

        const reset = await tx.licenseActivation.updateMany({
          where: { license_id: licenseId, status: "active" },
          data: { status: "deactivated" },
        });
        await tx.licenseEvent.create({
          data: {
            license_id: licenseId,
            actor_user_id: ctx.user.id,
            type: "activations_reset",
            reason: `${reset.count} aktivasyon sıfırlandı.`,
          },
        });
        const deliveryId = await createLicenseWebhookDelivery(
          tx,
          ctx.workspaceId,
          license.project_id,
          licenseId,
          "license.activations_reset",
          { license_id: licenseId, reset_count: reset.count }
        );
        return { resetCount: reset.count, deliveryId };
      },
      { maxWait: 5_000, timeout: 15_000 }
    );
    if (!result) return fail("Lisans bulunamadı.");
    const { resetCount, deliveryId } = result;

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "RESET_ACTIVATIONS",
      auditable_type: "license",
      auditable_id: licenseId,
      after_data: { reset_count: resetCount },
    });

    await publishOutbox(deliveryId);

    revalidatePath("/lisanslar");
    return ok(null, `${resetCount} aktivasyon sıfırlandı.`);
  } catch (error) {
    return handleError(error);
  }
}

/** Anahtar rotasyonu: yeni anahtar üret, eski hash geçersizleşir, aktivasyonlar deaktive olur. */
export async function rotateLicenseKey(
  licenseId: string
): Promise<ActionResponse<{ licenseKey: string }>> {
  try {
    const ctx = await requirePermission("licenses.update");
    if (!licenseIdSchema.safeParse(licenseId).success) {
      return fail("Lisans kimliği geçersiz.");
    }

    const newKey = generateLicenseKey();
    const deliveryId = await prisma.$transaction(
      async (tx) => {
        const license = await lockTenantLicense(
          tx,
          ctx.workspaceId,
          licenseId
        );
        if (!license) return undefined;

        await tx.license.update({
          where: { id: licenseId },
          data: {
            key_prefix: keyPrefixOf(newKey),
            key_hash: hashLicenseKey(newKey),
            key_secret: encryptSecret(newKey),
          },
        });
        await tx.licenseActivation.updateMany({
          where: { license_id: licenseId, status: "active" },
          data: { status: "deactivated" },
        });
        await tx.licenseEvent.create({
          data: {
            license_id: licenseId,
            actor_user_id: ctx.user.id,
            type: "key_rotated",
            reason: "Anahtar rotasyonu",
          },
        });
        return createLicenseWebhookDelivery(
          tx,
          ctx.workspaceId,
          license.project_id,
          licenseId,
          "license.key_rotated",
          { license_id: licenseId }
        );
      },
      { maxWait: 5_000, timeout: 15_000 }
    );
    if (deliveryId === undefined) return fail("Lisans bulunamadı.");

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "ROTATE_KEY",
      auditable_type: "license",
      auditable_id: licenseId,
    });

    await publishOutbox(deliveryId);

    revalidatePath("/lisanslar");
    return ok(
      { licenseKey: newKey },
      "Anahtar döndürüldü. Yeni anahtarı kaydedin; eski anahtar artık geçersiz."
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function addLicenseDomain(
  input: unknown
): Promise<ActionResponse<null>> {
  try {
    const ctx = await requirePermission("licenses.create");
    const parsed = licenseDomainSchema.safeParse(input);
    if (!parsed.success) return zodFail(parsed.error);
    const { license_id, domain, environment, is_primary } = parsed.data;

    const normalized = normalizeDomain(domain);
    if (!normalized) return fail("Geçersiz domain biçimi.");

    const db = await getTenantDb();
    const license = await db.license.findUnique({ where: { id: license_id } });
    if (!license) return fail("Lisans bulunamadı.");

    // İlk domain her zaman birincil olur; birincil seçimi tekilleştirilir.
    const existingCount = await db.licenseDomain.count({ where: { license_id } });
    const makePrimary = is_primary || existingCount === 0;

    try {
      await db.$transaction(async (tx) => {
        if (makePrimary) {
          await tx.licenseDomain.updateMany({
            where: { license_id, is_primary: true },
            data: { is_primary: false },
          });
        }
        await tx.licenseDomain.create({
          data: {
            license_id,
            domain,
            normalized_domain: normalized,
            environment,
            is_primary: makePrimary,
            status: "active",
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return fail("Bu domain bu ortam için zaten kayıtlı.");
      }
      throw error;
    }

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "ADD_DOMAIN",
      auditable_type: "license",
      auditable_id: license_id,
      after_data: { domain: normalized, environment, is_primary: makePrimary },
    });

    revalidatePath("/lisanslar");
    return ok(null, "Domain eklendi.");
  } catch (error) {
    return handleError(error);
  }
}

/** Domaini silmeden doğrulama dışı bırakır (aktivasyon geçmişi korunur). */
export async function setLicenseDomainStatus(
  input: unknown
): Promise<ActionResponse<null>> {
  try {
    const ctx = await requirePermission("licenses.update");
    const parsed = domainStatusSchema.safeParse(input);
    if (!parsed.success) return zodFail(parsed.error);
    const { license_id, domain_id, status } = parsed.data;

    const db = await getTenantDb();
    const license = await db.license.findUnique({ where: { id: license_id } });
    if (!license) return fail("Lisans bulunamadı.");

    const updated = await db.licenseDomain.updateMany({
      where: { id: domain_id, license_id },
      data: { status },
    });
    if (updated.count === 0) return fail("Domain bulunamadı.");

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "UPDATE_DOMAIN_STATUS",
      auditable_type: "license",
      auditable_id: license_id,
      after_data: { domain_id, status },
    });

    revalidatePath("/lisanslar");
    return ok(
      null,
      status === "active" ? "Domain yeniden etkinleştirildi." : "Domain pasife alındı."
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function removeLicenseDomain(
  licenseId: string,
  domainId: string
): Promise<ActionResponse<null>> {
  try {
    const ctx = await requirePermission("licenses.delete");
    const db = await getTenantDb();
    const license = await db.license.findUnique({ where: { id: licenseId } });
    if (!license) return fail("Lisans bulunamadı.");

    const target = await db.licenseDomain.findFirst({
      where: { id: domainId, license_id: licenseId },
      select: { id: true, normalized_domain: true, is_primary: true },
    });
    if (!target) return fail("Domain bulunamadı.");

    await db.licenseDomain.delete({ where: { id: target.id } });

    // Birincil domain silindiyse en eski kayıt birincil olur.
    if (target.is_primary) {
      const next = await db.licenseDomain.findFirst({
        where: { license_id: licenseId },
        orderBy: { created_at: "asc" },
        select: { id: true },
      });
      if (next) {
        await db.licenseDomain.update({
          where: { id: next.id },
          data: { is_primary: true },
        });
      }
    }

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "REMOVE_DOMAIN",
      auditable_type: "license",
      auditable_id: licenseId,
      before_data: { domain: target.normalized_domain, is_primary: target.is_primary },
    });

    revalidatePath("/lisanslar");
    return ok(null, "Domain kaldırıldı.");
  } catch (error) {
    return handleError(error);
  }
}

/** Lisansı ve ona bağlı domain, aktivasyon ve olay kayıtlarını kalıcı olarak siler. */
export async function deleteLicense(licenseId: string): Promise<ActionResponse<null>> {
  try {
    const ctx = await requirePermission("licenses.delete");
    if (!licenseIdSchema.safeParse(licenseId).success) {
      return fail("Lisans kimliği geçersiz.");
    }

    const result = await prisma.$transaction(
      async (tx) => {
        const license = await lockTenantLicense(tx, ctx.workspaceId, licenseId);
        if (!license) {
          return { kind: "error" as const, message: "Lisans bulunamadı." };
        }

        const [domainCount, activationCount, eventCount] = await Promise.all([
          tx.licenseDomain.count({ where: { license_id: license.id } }),
          tx.licenseActivation.count({ where: { license_id: license.id } }),
          tx.licenseEvent.count({ where: { license_id: license.id } }),
        ]);
        const deliveryId = await createLicenseWebhookDelivery(
          tx,
          ctx.workspaceId,
          license.project_id,
          license.id,
          "license.deleted",
          {
            license_id: license.id,
            product: license.product_name,
            status: license.status,
            key_prefix: license.key_prefix,
          }
        );

        await tx.license.delete({ where: { id: license.id } });
        return {
          kind: "ok" as const,
          deliveryId,
          before: {
            id: license.id,
            project_id: license.project_id,
            product_name: license.product_name,
            key_prefix: license.key_prefix,
            status: license.status,
            starts_at: license.starts_at,
            expires_at: license.expires_at,
            grace_ends_at: license.grace_ends_at,
            activation_limit: license.activation_limit,
            auto_suspend: license.auto_suspend,
            features: license.features,
            domain_count: domainCount,
            activation_count: activationCount,
            event_count: eventCount,
          },
        };
      },
      { maxWait: 5_000, timeout: 15_000 }
    );
    if (result.kind === "error") return fail(result.message);

    await writeAudit({
      workspace_id: ctx.workspaceId,
      actor_user_id: ctx.user.id,
      action: "DELETE",
      auditable_type: "license",
      auditable_id: licenseId,
      before_data: result.before,
    });
    await publishOutbox(result.deliveryId);

    revalidatePath("/lisanslar");
    return ok(null, "Lisans silindi.");
  } catch (error) {
    return handleError(error);
  }
}

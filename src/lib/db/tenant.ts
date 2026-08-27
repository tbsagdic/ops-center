import { prisma } from "./prisma";
import { getAuthContext } from "@/lib/auth/context";

/**
 * Kiracı (tenant) izolasyon katmanı.
 *
 * getTenantDb() ile alınan istemci, workspace_id kolonu taşıyan tüm modellerde:
 *  - READ sorgularına otomatik { workspace_id, deleted_at: null } filtresi uygular,
 *  - CREATE işlemlerinde workspace_id'yi oturumun aktif workspace'i ile zorlar,
 *  - UPDATE/DELETE işlemlerini aktif workspace ile sınırlar ve
 *    workspace_id alanının sonradan değiştirilmesini engeller.
 *
 * workspace_id kolonu olmayan alt tablolar (license_domains, license_activations,
 * license_events, project_server) tenant-scoped parent kayıt üzerinden erişilmelidir.
 * Workspace bağlamı yoksa TenantError fırlatılır — asla filtresiz veri dönmez.
 */

export class TenantError extends Error {}

const TENANT_MODELS = new Set<string>([
  "Customer",
  "Product",
  "Project",
  "License",
  "Server",
  "Domain",
  "BillingSchedule",
  "Invoice",
  "Payment",
  "WebhookDelivery",
  "AuditLog",
  "GithubConnection",
  "ServerDomainOperation",
]);

const SOFT_DELETE_MODELS = new Set<string>([
  "Customer",
  "Product",
  "Project",
  "Server",
  "Domain",
]);

// where'i AND ile birleştirilen operasyonlar (unique olmayan filtreler)
const LIST_OPS = new Set<string>([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

// where'i unique alan + AND guard olarak birleştirilen operasyonlar
const UNIQUE_OPS = new Set<string>([
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "delete",
  "upsert",
]);

const DATA_WRITE_OPS = new Set<string>(["create", "createMany", "update", "updateMany", "upsert"]);

type AnyRecord = Record<string, unknown>;

function toAndArray(existing: unknown): unknown[] {
  if (existing === undefined || existing === null) return [];
  return Array.isArray(existing) ? [...existing] : [existing];
}

function stripWorkspaceMutation(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const clone = { ...(data as AnyRecord) };
  delete clone.workspace_id;
  delete clone.workspace;
  return clone;
}

function forceWorkspace(data: unknown, workspaceId: string): unknown {
  const clone = stripWorkspaceMutation(data) as AnyRecord;
  return { ...clone, workspace_id: workspaceId };
}

export function tenantClientFor(workspaceId: string) {
  if (!workspaceId) {
    throw new TenantError("Workspace bağlamı olmadan veri erişimi reddedildi.");
  }

  return prisma.$extends({
    name: "tenant-isolation",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model)) return query(args);

          const a = { ...(args as AnyRecord) };
          const guard: AnyRecord = { workspace_id: workspaceId };
          if (SOFT_DELETE_MODELS.has(model)) guard.deleted_at = null;

          if (LIST_OPS.has(operation)) {
            a.where = a.where ? { AND: [a.where, guard] } : guard;
          } else if (UNIQUE_OPS.has(operation)) {
            const where = (a.where ?? {}) as AnyRecord;
            a.where = { ...where, AND: [...toAndArray(where.AND), guard] };
          }

          if (DATA_WRITE_OPS.has(operation)) {
            if (operation === "create") {
              a.data = forceWorkspace(a.data, workspaceId);
            } else if (operation === "createMany") {
              const data = a.data;
              a.data = Array.isArray(data)
                ? data.map((d) => forceWorkspace(d, workspaceId))
                : forceWorkspace(data, workspaceId);
            } else if (operation === "upsert") {
              a.create = forceWorkspace(a.create, workspaceId);
              a.update = stripWorkspaceMutation(a.update);
            } else {
              // update / updateMany
              a.data = stripWorkspaceMutation(a.data);
            }
          }

          return query(a as never);
        },
      },
    },
  });
}

export type TenantDb = ReturnType<typeof tenantClientFor>;

/**
 * Aktif oturumun workspace bağlamına bağlı Prisma istemcisi döndürür.
 * Oturum veya aktif workspace yoksa TenantError fırlatır.
 */
export async function getTenantDb(): Promise<TenantDb> {
  const ctx = await getAuthContext();
  if (!ctx) throw new TenantError("Oturum bulunamadı.");
  if (!ctx.workspaceId) {
    throw new TenantError("Aktif çalışma alanı bulunamadı veya üyeliğiniz pasif.");
  }
  return tenantClientFor(ctx.workspaceId);
}

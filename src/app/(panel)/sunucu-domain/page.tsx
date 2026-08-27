import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/context";
import { getEffectivePermissions, hasPermission } from "@/lib/auth/permissions";
import { getTenantDb } from "@/lib/db/tenant";
import { PageHeader } from "@/components/page-header";
import {
  DomainControlView,
  type OperationSummary,
  type ServerOption,
} from "@/components/sunucu-domain/domain-control-view";
import { parseSteps } from "@/lib/server-domains/steps";

export const metadata = { title: "Sunucu Domain Kontrolü · Operasyon Merkezi" };

/**
 * Sayfadaki Server Action'ların süre sınırı.
 *
 * Certbot dakikalarca sürebilir ama bu istekleri bloklamaz: SSL adımı işi sunucuda
 * arka plana atıp yalnız kısa aralıklarla yoklar (bkz. stepBudgetMs). Bu yüzden 60
 * saniye yeterlidir ve akış Vercel Hobby planında da çalışır.
 */
export const maxDuration = 60;

export default async function ServerDomainPage() {
  const ctx = await getAuthContext();
  if (!ctx?.workspaceId || !ctx.role) redirect("/yetkisiz");
  const permissions = await getEffectivePermissions(ctx.workspaceId, ctx.role);
  if (!hasPermission(ctx.role, "server_domains.view", permissions)) redirect("/yetkisiz");

  const db = await getTenantDb();
  const [servers, operations, customers, projects] = await Promise.all([
    db.server.findMany({
      where: { status: "active" },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        hostname: true,
        primary_ip: true,
        ssh_user: true,
        ssh_password_encrypted: true,
        ssh_host_fingerprint: true,
        web_stack: true,
        nginx_sites_path: true,
      },
    }),
    db.serverDomainOperation.findMany({
      orderBy: { created_at: "desc" },
      take: 25,
      select: {
        id: true,
        type: true,
        status: true,
        new_domain: true,
        old_domain: true,
        steps: true,
        current_step: true,
        created_at: true,
        server: { select: { name: true } },
      },
    }),
    db.customer.findMany({
      where: { status: { not: "archived" } },
      orderBy: { legal_name: "asc" },
      take: 200,
      select: { id: true, legal_name: true },
    }),
    db.project.findMany({
      where: { status: { not: "archived" } },
      orderBy: { code: "asc" },
      take: 200,
      select: { id: true, code: true, name: true, customer_id: true },
    }),
  ]);

  const serverOptions: ServerOption[] = servers.map((server) => ({
    id: server.id,
    name: server.name,
    address: server.primary_ip || server.hostname || "",
    sshUser: server.ssh_user ?? "",
    hasPassword: Boolean(server.ssh_password_encrypted),
    knownHost: Boolean(server.ssh_host_fingerprint),
    isNginx: server.web_stack === "nginx",
    sitesPath: server.nginx_sites_path ?? "/etc/nginx/sites-available",
  }));

  const operationSummaries: OperationSummary[] = operations.map((operation) => {
    const steps = parseSteps(operation.steps);
    return {
      id: operation.id,
      serverName: operation.server?.name ?? "—",
      type: operation.type as "add" | "change",
      status: operation.status,
      newDomain: operation.new_domain,
      oldDomain: operation.old_domain,
      stepCount: steps.length,
      doneCount: steps.filter((step) => step.status === "succeeded").length,
      createdAt: operation.created_at.toISOString(),
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sunucu Domain Kontrolü"
        description="Kayıtlı sunuculara SSH ile bağlanarak nginx site tanımı açar, alan adını değiştirir ve Let's Encrypt sertifikasını kurar."
      />
      <DomainControlView
        servers={serverOptions}
        operations={operationSummaries}
        customers={customers.map((customer) => ({
          id: customer.id,
          label: customer.legal_name,
        }))}
        projects={projects.map((project) => ({
          id: project.id,
          label: `${project.code} · ${project.name}`,
          customerId: project.customer_id,
        }))}
        canRun={hasPermission(ctx.role, "server_domains.create", permissions)}
        canRollback={hasPermission(ctx.role, "server_domains.delete", permissions)}
      />
    </div>
  );
}

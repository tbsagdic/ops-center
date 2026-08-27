"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Loader2, RefreshCw, Search, ServerCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field } from "@/components/form-field";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import {
  createServerDomainOperation,
  getServerDomainOperation,
  listServerSites,
  type DiscoveredSite,
  type OperationView,
} from "@/actions/server-domains";
import { SERVER_DOMAIN_OP_TYPE_OPTIONS } from "@/lib/validation/server-domain";
import { OperationRunner } from "./operation-runner";

export type ServerOption = {
  id: string;
  name: string;
  address: string;
  sshUser: string;
  hasPassword: boolean;
  knownHost: boolean;
  isNginx: boolean;
  sitesPath: string;
};

export type OperationSummary = {
  id: string;
  serverName: string;
  type: "add" | "change";
  status: string;
  newDomain: string;
  oldDomain: string | null;
  stepCount: number;
  doneCount: number;
  createdAt: string;
};

type Option = { id: string; label: string };
type ProjectOption = Option & { customerId: string | null };

const STATUS_LABELS: Record<string, string> = {
  pending: "Bekliyor",
  running: "Çalışıyor",
  succeeded: "Tamamlandı",
  failed: "Başarısız",
  rolled_back: "Geri alındı",
};

const EMPTY_FORM = {
  type: "change" as "add" | "change",
  new_domain: "",
  old_domain: "",
  include_www: true,
  enable_ssl: true,
  ssl_email: "",
  redirect_old: true,
  document_root: "",
  proxy_pass: "",
  customer_id: "none",
  project_id: "none",
};

export function DomainControlView({
  servers,
  operations,
  customers,
  projects,
  canRun,
  canRollback,
}: {
  servers: ServerOption[];
  operations: OperationSummary[];
  customers: Option[];
  projects: ProjectOption[];
  canRun: boolean;
  canRollback: boolean;
}) {
  const router = useRouter();
  const [serverId, setServerId] = useState<string>(servers[0]?.id ?? "");
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [sites, setSites] = useState<DiscoveredSite[] | null>(null);
  const [active, setActive] = useState<OperationView | null>(null);
  const [isCreating, startCreate] = useTransition();
  const [isScanning, startScan] = useTransition();
  const [isOpening, startOpen] = useTransition();

  const server = servers.find((item) => item.id === serverId) ?? null;
  const blockers = useMemo(() => describeBlockers(server), [server]);

  const filteredProjects = useMemo(
    () =>
      form.customer_id === "none"
        ? projects
        : projects.filter((project) => project.customerId === form.customer_id),
    [projects, form.customer_id]
  );

  function set<K extends keyof typeof EMPTY_FORM>(key: K, value: (typeof EMPTY_FORM)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function onScan() {
    if (!serverId) return;
    setSites(null);
    startScan(async () => {
      const res = await listServerSites(serverId);
      if (res.success) {
        setSites(res.data);
        toast.success(
          res.data.length > 0
            ? `${res.data.length} site tanımı bulundu.`
            : "Sunucuda tanımlı site bulunamadı."
        );
      } else {
        toast.error(res.error);
      }
    });
  }

  function onSelectSite(site: DiscoveredSite) {
    const primary = site.domains.find((domain) => !domain.startsWith("www.")) ?? site.domains[0];
    setForm((prev) => ({
      ...prev,
      type: "change",
      old_domain: primary,
      include_www: site.domains.some((domain) => domain.startsWith("www.")),
      // Kaynak vhost kopyalanacağı için kök/vekil alanları elle doldurulmaz.
      document_root: "",
      proxy_pass: "",
    }));
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});
    startCreate(async () => {
      const res = await createServerDomainOperation({ ...form, server_id: serverId });
      if (!res.success) {
        if (res.fieldErrors) setErrors(res.fieldErrors);
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "İşlem oluşturuldu.");
      const detail = await getServerDomainOperation(res.data.id);
      if (detail.success) setActive(detail.data);
      setForm(EMPTY_FORM);
      router.refresh();
    });
  }

  function openOperation(id: string) {
    startOpen(async () => {
      const res = await getServerDomainOperation(id);
      if (res.success) setActive(res.data);
      else toast.error(res.error);
    });
  }

  if (active) {
    return (
      <Card>
        <CardContent className="pt-6">
          <OperationRunner
            operation={active}
            canRollback={canRollback}
            onClose={() => {
              setActive(null);
              router.refresh();
            }}
          />
        </CardContent>
      </Card>
    );
  }

  if (servers.length === 0) {
    return (
      <EmptyState
        title="Aktif sunucu yok"
        description="Bu ekranı kullanmak için önce Sunucular bölümünden SSH bilgileriyle bir sunucu kaydedin."
      />
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Card>
        <CardHeader>
          <CardTitle>Yeni işlem</CardTitle>
          <CardDescription>
            Ön kontrol adımı sunucuya hiçbir şey yazmaz; yazma adımları ayrıca onaylanır.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <Field label="Sunucu" required>
              <Select value={serverId} onValueChange={setServerId}>
                <SelectTrigger>
                  <SelectValue placeholder="Sunucu seçin" />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                      {item.address ? ` · ${item.address}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {blockers.length > 0 && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>Bu sunucu için eksikler var</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc space-y-1 pl-4">
                    {blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {server && blockers.length === 0 && (
              <div className="space-y-1 text-xs text-muted-foreground">
                {!server.knownHost && (
                  <p>
                    Bu sunucuya ilk kez bağlanılacak. İlk bağlantıda sunucunun SSH kimliği
                    kaydedilir ve sonraki bağlantılarda değişirse işlem durdurulur.
                  </p>
                )}
                {!server.isNginx && (
                  <p>
                    Sunucu kaydında web yığını nginx olarak işaretlenmemiş. Ön kontrol
                    adımı nginx varlığını sunucuda ayrıca doğrular.
                  </p>
                )}
              </div>
            )}

            <Field label="İşlem türü" required>
              <Select
                value={form.type}
                onValueChange={(value) => set("type", value as "add" | "change")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SERVER_DOMAIN_OP_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {form.type === "change" && (
              <Field
                label="Eski alan adı"
                error={errors.old_domain}
                required
                hint="Bu adresin mevcut nginx yapılandırması kopyalanır; PHP, vekil ve diğer ayarlar korunur."
              >
                <div className="flex gap-2">
                  <Input
                    value={form.old_domain}
                    onChange={(event) => set("old_domain", event.target.value)}
                    placeholder="domain100.com"
                    spellCheck={false}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onScan}
                    disabled={isScanning || !serverId || blockers.length > 0}
                    title="Sunucudaki site tanımlarını listele"
                  >
                    {isScanning ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                    Sunucudan getir
                  </Button>
                </div>
              </Field>
            )}

            {sites && form.type === "change" && (
              <div className="max-h-56 space-y-1.5 overflow-auto rounded-lg border p-2">
                {sites.length === 0 && (
                  <p className="px-1 py-2 text-xs text-muted-foreground">
                    {server?.sitesPath} altında site tanımı bulunamadı.
                  </p>
                )}
                {sites.map((site) => (
                  <button
                    key={site.file}
                    type="button"
                    onClick={() => onSelectSite(site)}
                    className={cn(
                      "flex w-full items-start justify-between gap-3 rounded-md px-2 py-1.5 text-left hover:bg-accent",
                      site.domains.includes(form.old_domain) && "bg-accent"
                    )}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {site.domains.join(", ")}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {site.file}
                        {site.proxyPass
                          ? ` · vekil: ${site.proxyPass}`
                          : site.root
                            ? ` · ${site.root}`
                            : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {site.ssl && <Badge variant="secondary">SSL</Badge>}
                      <Badge variant={site.enabled ? "default" : "outline"}>
                        {site.enabled ? "Aktif" : "Pasif"}
                      </Badge>
                    </div>
                  </button>
                ))}
              </div>
            )}

            <Field
              label="Yeni alan adı"
              error={errors.new_domain}
              required
              hint="DNS A kaydı bu sunucuya bakmalı; ön kontrol bunu doğrular."
            >
              <Input
                value={form.new_domain}
                onChange={(event) => set("new_domain", event.target.value)}
                placeholder="domain101.com"
                spellCheck={false}
                required
              />
            </Field>

            {form.type === "add" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Site kök dizini"
                  error={errors.document_root}
                  hint="Statik veya PHP siteler için."
                >
                  <Input
                    value={form.document_root}
                    onChange={(event) => set("document_root", event.target.value)}
                    placeholder="/var/www/domain101"
                    spellCheck={false}
                  />
                </Field>
                <Field
                  label="Vekil hedefi"
                  error={errors.proxy_pass}
                  hint="Node/uygulama sunucusu için; kök dizin yerine kullanılır."
                >
                  <Input
                    value={form.proxy_pass}
                    onChange={(event) => set("proxy_pass", event.target.value)}
                    placeholder="http://127.0.0.1:3000"
                    spellCheck={false}
                  />
                </Field>
              </div>
            )}

            <div className="space-y-3 rounded-lg border p-3">
              <ToggleRow
                label="www alt alan adını da ekle"
                description="server_name'e ve sertifikaya www kaydı dahil edilir."
                checked={form.include_www}
                onChange={(value) => set("include_www", value)}
              />
              <ToggleRow
                label="Let's Encrypt sertifikası al"
                description="Certbot ile HTTPS kurulur ve HTTP'den yönlendirme yapılır."
                checked={form.enable_ssl}
                onChange={(value) => set("enable_ssl", value)}
              />
              {form.type === "change" && (
                <ToggleRow
                  label="Eski adresi yeniye yönlendir"
                  description="Kapatılırsa eski adres tamamen erişilemez olur."
                  checked={form.redirect_old}
                  onChange={(value) => set("redirect_old", value)}
                />
              )}
            </div>

            {form.enable_ssl && (
              <Field
                label="Let's Encrypt e-postası"
                error={errors.ssl_email}
                required
                hint="Sertifika bitiş uyarıları bu adrese gider."
              >
                <Input
                  type="email"
                  value={form.ssl_email}
                  onChange={(event) => set("ssl_email", event.target.value)}
                  placeholder="teknik@sirket.com"
                />
              </Field>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Müşteri" error={errors.customer_id} hint="Panel domain kaydı için.">
                <Select
                  value={form.customer_id}
                  onValueChange={(value) =>
                    setForm((prev) => ({ ...prev, customer_id: value, project_id: "none" }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Seçilmedi</SelectItem>
                    {customers.map((customer) => (
                      <SelectItem key={customer.id} value={customer.id}>
                        {customer.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Proje" error={errors.project_id}>
                <Select
                  value={form.project_id}
                  onValueChange={(value) => set("project_id", value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Seçilmedi</SelectItem>
                    {filteredProjects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Button
              type="submit"
              disabled={!canRun || isCreating || blockers.length > 0 || !serverId}
            >
              {isCreating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ServerCog className="h-4 w-4" />
              )}
              İşlemi oluştur
            </Button>
            {!canRun && (
              <p className="text-xs text-muted-foreground">
                Bu işlemi çalıştırma yetkiniz yok. Rol yönetiminden
                &quot;Sunucu Domain Kontrolü&quot; iznini talep edin.
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            Son işlemler
            <Button variant="ghost" size="icon" onClick={() => router.refresh()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {operations.length === 0 && (
            <p className="text-sm text-muted-foreground">Henüz işlem yapılmadı.</p>
          )}
          {operations.map((operation) => (
            <button
              key={operation.id}
              type="button"
              onClick={() => openOperation(operation.id)}
              disabled={isOpening}
              className="flex w-full items-start justify-between gap-2 rounded-lg border px-3 py-2 text-left hover:bg-accent"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {operation.oldDomain
                    ? `${operation.oldDomain} → ${operation.newDomain}`
                    : operation.newDomain}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {operation.serverName} ·{" "}
                  {new Date(operation.createdAt).toLocaleString("tr-TR")}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <Badge
                  variant={
                    operation.status === "succeeded"
                      ? "default"
                      : operation.status === "failed"
                        ? "destructive"
                        : "outline"
                  }
                >
                  {STATUS_LABELS[operation.status] ?? operation.status}
                </Badge>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {operation.doneCount}/{operation.stepCount} adım
                </p>
              </div>
            </button>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/** Sunucu kaydında bu ekranın çalışması için eksik olan bilgiler. */
function describeBlockers(server: ServerOption | null): string[] {
  if (!server) return [];
  const blockers: string[] = [];
  if (!server.address) {
    blockers.push("Sunucu adresi (hostname veya IP) girilmemiş.");
  }
  if (!server.sshUser) blockers.push("SSH kullanıcısı girilmemiş.");
  if (!server.hasPassword) blockers.push("SSH parolası kaydedilmemiş.");
  return blockers;
}

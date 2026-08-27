"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field } from "@/components/form-field";
import {
  createServer,
  revealServerSshPassword,
  updateServer,
} from "@/actions/servers";
import { useRouter } from "next/navigation";
import { COST_PERIOD_OPTIONS } from "@/lib/validation/server";
import {
  BASE_CURRENCY,
  isForeignCurrency,
  resolveRate,
  type ExchangeRates,
} from "@/lib/currency";
import { CurrencySelect, ExchangeRateField } from "@/components/currency-fields";
import { formatMoney } from "@/lib/format";

export type ServerFormValues = {
  id?: string;
  name: string;
  provider: string;
  external_ref: string;
  type: string;
  hostname: string;
  primary_ip: string;
  region: string;
  operating_system: string;
  cpu_cores: string;
  ram_mb: string;
  disk_gb: string;
  management_url: string;
  ssh_port: string;
  ssh_user: string;
  ssh_password: string;
  has_ssh_password: boolean;
  ssh_sudo_password: string;
  has_sudo_password: boolean;
  web_stack: string;
  nginx_sites_path: string;
  status: string;
  renewal_at: string;
  monthly_cost: string;
  cost_period: string;
  currency: string;
  manual_fx_rate: string;
};

const EMPTY: ServerFormValues = {
  name: "", provider: "", external_ref: "", type: "vps", hostname: "",
  primary_ip: "", region: "", operating_system: "", cpu_cores: "", ram_mb: "",
  disk_gb: "", management_url: "", ssh_port: "22", ssh_user: "", status: "active",
  ssh_password: "", has_ssh_password: false,
  ssh_sudo_password: "", has_sudo_password: false, web_stack: "", nginx_sites_path: "",
  renewal_at: "", monthly_cost: "", cost_period: "monthly", currency: "TRY",
  manual_fx_rate: "",
};

export function ServerForm({
  initial,
  rates,
  onDone,
}: {
  initial?: Partial<ServerFormValues>;
  rates: ExchangeRates | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const [values, setValues] = useState<ServerFormValues>({ ...EMPTY, ...initial });
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [showSshPassword, setShowSshPassword] = useState(false);
  const [isRevealingPassword, startRevealTransition] = useTransition();
  const [isPending, startTransition] = useTransition();

  function set<K extends keyof ServerFormValues>(key: K, value: ServerFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  /** Para birimi değişince önceki birime ait elle girilmiş kur düşer. */
  function setCurrency(code: string) {
    setValues((prev) => ({ ...prev, currency: code, manual_fx_rate: "" }));
  }

  const isForeign = isForeignCurrency(values.currency);
  const isYearly = values.cost_period === "yearly";
  // Elle kur girilmişse o, girilmemişse günlük TCMB kuru kullanılır.
  const fx = resolveRate(values.currency, Number(values.manual_fx_rate) || null, rates);

  const amount = Number(values.monthly_cost);
  /** Girilen tutarın seçilen periyottaki ve karşıt periyottaki TL karşılığı. */
  const converted =
    fx && Number.isFinite(amount) && amount > 0
      ? {
          primary: amount * fx.value,
          counterpart: isYearly ? (amount * fx.value) / 12 : amount * fx.value * 12,
        }
      : null;

  function toggleSshPasswordVisibility() {
    if (showSshPassword) {
      setShowSshPassword(false);
      return;
    }

    const serverId = initial?.id;
    if (values.ssh_password || !serverId || !values.has_ssh_password) {
      setShowSshPassword(true);
      return;
    }

    startRevealTransition(async () => {
      const res = await revealServerSshPassword(serverId);
      if (res.success) {
        setValues((prev) => ({
          ...prev,
          ssh_password: res.data.sshPassword,
        }));
        setShowSshPassword(true);
      } else {
        toast.error(res.error);
      }
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    startTransition(async () => {
      const res = initial?.id
        ? await updateServer(initial.id, values)
        : await createServer(values);
      if (res.success) {
        toast.success(res.message ?? "Kaydedildi.");
        onDone();
        router.refresh();
      } else {
        if (res.fieldErrors) setErrors(res.fieldErrors);
        toast.error(res.error);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 pt-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Sunucu Adı" error={errors.name} required>
          <Input value={values.name} onChange={(e) => set("name", e.target.value)} required />
        </Field>
        <Field label="Tür" error={errors.type}>
          <Select value={values.type} onValueChange={(v) => set("type", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="vds">VDS</SelectItem>
              <SelectItem value="vps">VPS</SelectItem>
              <SelectItem value="hosting">Hosting</SelectItem>
              <SelectItem value="dedicated">Dedicated</SelectItem>
              <SelectItem value="cloud">Cloud</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Sağlayıcı" error={errors.provider}>
          <Input value={values.provider} onChange={(e) => set("provider", e.target.value)} placeholder="Hetzner, DigitalOcean..." />
        </Field>
        <Field label="Durum" error={errors.status}>
          <Select value={values.status} onValueChange={(v) => set("status", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Aktif</SelectItem>
              <SelectItem value="maintenance">Bakım</SelectItem>
              <SelectItem value="suspended">Askıda</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Hostname" error={errors.hostname}>
          <Input value={values.hostname} onChange={(e) => set("hostname", e.target.value)} />
        </Field>
        <Field label="Ana IP" error={errors.primary_ip}>
          <Input value={values.primary_ip} onChange={(e) => set("primary_ip", e.target.value)} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Bölge" error={errors.region}>
          <Input value={values.region} onChange={(e) => set("region", e.target.value)} />
        </Field>
        <Field label="İşletim Sistemi" error={errors.operating_system}>
          <Input value={values.operating_system} onChange={(e) => set("operating_system", e.target.value)} placeholder="Ubuntu 24.04" />
        </Field>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Field label="CPU (çekirdek)" error={errors.cpu_cores}>
          <Input type="number" value={values.cpu_cores} onChange={(e) => set("cpu_cores", e.target.value)} />
        </Field>
        <Field label="RAM (MB)" error={errors.ram_mb}>
          <Input type="number" value={values.ram_mb} onChange={(e) => set("ram_mb", e.target.value)} />
        </Field>
        <Field label="Disk (GB)" error={errors.disk_gb}>
          <Input type="number" value={values.disk_gb} onChange={(e) => set("disk_gb", e.target.value)} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="SSH Portu" error={errors.ssh_port}>
          <Input type="number" value={values.ssh_port} onChange={(e) => set("ssh_port", e.target.value)} />
        </Field>
        <Field label="SSH Kullanıcı" error={errors.ssh_user}>
          <Input value={values.ssh_user} onChange={(e) => set("ssh_user", e.target.value)} />
        </Field>
      </div>

      <Field
        label="SSH Parolası"
        error={errors.ssh_password}
        hint={
          values.has_ssh_password
            ? "Göz ikonuyla kayıtlı parolayı görüntüleyebilir veya yeni parolayla değiştirebilirsiniz."
            : "Parola şifreli olarak saklanır."
        }
      >
        <div className="relative">
          <Input
            type={showSshPassword ? "text" : "password"}
            value={values.ssh_password}
            onChange={(e) => set("ssh_password", e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            className="pr-10"
            placeholder={initial?.id ? "Değiştirmek için yeni parola girin" : ""}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2"
            onClick={toggleSshPasswordVisibility}
            disabled={isRevealingPassword}
            aria-label={showSshPassword ? "Parolayı gizle" : "Parolayı göster"}
          >
            {isRevealingPassword ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : showSshPassword ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
        </div>
      </Field>

      <Field
        label="sudo Parolası"
        error={errors.ssh_sudo_password}
        hint={
          values.has_sudo_password
            ? "Kayıtlı bir sudo parolası var. Değiştirmek için yeni parola girin."
            : "Yalnızca sudo parolanız SSH parolanızdan farklıysa doldurun; boşsa SSH parolası kullanılır."
        }
      >
        <Input
          type="password"
          value={values.ssh_sudo_password}
          onChange={(e) => set("ssh_sudo_password", e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          placeholder={values.has_sudo_password ? "Değiştirmek için yeni parola girin" : ""}
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Web Yığını"
          error={errors.web_stack}
          hint="Sunucu Domain Kontrolü ekranı yalnız nginx seçili sunucuları listeler."
        >
          <Select
            value={values.web_stack || "none"}
            onValueChange={(v) => set("web_stack", v === "none" ? "" : v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Belirtilmedi</SelectItem>
              <SelectItem value="nginx">Nginx</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Nginx vhost Dizini"
          error={errors.nginx_sites_path}
          hint="Boşsa /etc/nginx/sites-available kullanılır."
        >
          <Input
            value={values.nginx_sites_path}
            onChange={(e) => set("nginx_sites_path", e.target.value)}
            placeholder="/etc/nginx/sites-available"
            spellCheck={false}
          />
        </Field>
      </div>

      <Field label="Yönetim URL" error={errors.management_url}>
        <Input value={values.management_url} onChange={(e) => set("management_url", e.target.value)} />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Yenileme Tarihi" error={errors.renewal_at}>
          <Input type="date" value={values.renewal_at} onChange={(e) => set("renewal_at", e.target.value)} />
        </Field>
        <Field label="Maliyet Periyodu" error={errors.cost_period}>
          <Select value={values.cost_period} onValueChange={(v) => set("cost_period", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {COST_PERIOD_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label={isYearly ? "Yıllık Maliyet" : "Aylık Maliyet"} error={errors.monthly_cost}>
          <Input type="number" step="0.01" min="0" value={values.monthly_cost} onChange={(e) => set("monthly_cost", e.target.value)} />
        </Field>
        <Field label="Para Birimi" error={errors.currency}>
          <CurrencySelect value={values.currency} onChange={setCurrency} />
        </Field>
      </div>

      <ExchangeRateField
        currency={values.currency}
        value={values.manual_fx_rate}
        onChange={(v) => set("manual_fx_rate", v)}
        rates={rates}
        error={errors.manual_fx_rate}
      />

      {isForeign && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
          {converted ? (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">TL Karşılığı</span>
                <span className="font-bold tabular-nums text-[#141821]">
                  ≈ {formatMoney(converted.primary, BASE_CURRENCY)} / {isYearly ? "yıl" : "ay"}
                </span>
              </div>
              <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                <span>{isYearly ? "Aylık ortalama" : "Yıllık toplam"}</span>
                <span className="tabular-nums">
                  ≈ {formatMoney(converted.counterpart, BASE_CURRENCY)}
                </span>
              </div>
            </>
          ) : (
            <p className="text-xs text-amber-600">
              TL karşılığı için tutar ve kur girin.
            </p>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={isPending}>Vazgeç</Button>
        <Button type="submit" disabled={isPending} className="bg-[#5267ff] hover:bg-[#4254e1]">
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {initial?.id ? "Güncelle" : "Ekle"}
        </Button>
      </div>
    </form>
  );
}

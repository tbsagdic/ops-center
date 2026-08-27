"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, Globe2, Infinity as InfinityIcon, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createLicense } from "@/actions/licenses";
import { Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { LicenseProjectOption } from "@/lib/licenses/domain-candidates";

const MANUAL_DOMAIN = "__manual_domain__";

export function LicenseForm({
  projects,
  onCreated,
  onCancel,
}: {
  projects: LicenseProjectOption[];
  onCreated: (licenseKey: string) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [projectId, setProjectId] = useState("");
  const [productName, setProductName] = useState("");
  const [domain, setDomain] = useState("");
  const [manualDomain, setManualDomain] = useState(false);
  const [environment, setEnvironment] = useState<"production" | "staging" | "local">(
    "production"
  );
  const [unlimited, setUnlimited] = useState(false);
  const [startsAt, setStartsAt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [graceDays, setGraceDays] = useState("");
  const [activationLimit, setActivationLimit] = useState("1");
  const [autoSuspend, setAutoSuspend] = useState(false);
  const [features, setFeatures] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [isPending, startTransition] = useTransition();

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === projectId),
    [projectId, projects]
  );
  const domainCandidates = selectedProject?.domain_candidates ?? [];

  function onProjectChange(id: string) {
    const project = projects.find((item) => item.id === id);
    setProjectId(id);
    setProductName(project?.product_name ?? "");
    setErrors((current) => ({ ...current, project_id: [], domain: [] }));

    const candidates = project?.domain_candidates ?? [];
    if (candidates.length === 1) {
      setDomain(candidates[0].domain);
      setManualDomain(false);
    } else if (candidates.length === 0) {
      setDomain("");
      setManualDomain(true);
    } else {
      setDomain("");
      setManualDomain(false);
    }
  }

  function onDomainSelection(value: string) {
    if (value === MANUAL_DOMAIN) {
      setDomain("");
      setManualDomain(true);
      return;
    }
    setDomain(value);
    setManualDomain(false);
  }

  function onExpiresAtChange(value: string) {
    setExpiresAt(value);
    setErrors((current) => ({ ...current, expires_at: [], grace_days: [] }));
    if (!value) {
      setGraceDays("");
    } else if (!graceDays) {
      setGraceDays("14");
    }
  }

  // Süresiz lisansta tarih alanları hem kapanır hem temizlenir; sunucuya boş
  // gitmeleri "tarih girmediğim hâlde tarih atandı" karışıklığını önler.
  function onUnlimitedChange(next: boolean) {
    setUnlimited(next);
    setErrors((current) => ({
      ...current,
      starts_at: [],
      expires_at: [],
      grace_days: [],
    }));
    if (next) {
      setStartsAt("");
      setExpiresAt("");
      setGraceDays("");
      setAutoSuspend(false);
    }
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});
    startTransition(async () => {
      const res = await createLicense({
        project_id: projectId,
        product_name: productName,
        domain,
        environment,
        unlimited,
        starts_at: unlimited ? "" : startsAt,
        expires_at: unlimited ? "" : expiresAt,
        grace_days: unlimited || !expiresAt ? 0 : graceDays,
        activation_limit: activationLimit,
        auto_suspend: unlimited ? false : autoSuspend,
        features,
      });
      if (res.success) {
        toast.success(res.message ?? "Lisans üretildi.");
        onCreated(res.data.licenseKey);
        router.refresh();
      } else {
        if (res.fieldErrors) setErrors(res.fieldErrors);
        toast.error(res.error);
      }
    });
  }

  const activationLimitField = (
    <Field label="Aktivasyon Limiti" error={errors.activation_limit} required>
      <Input
        type="number"
        min="1"
        value={activationLimit}
        onChange={(event) => setActivationLimit(event.target.value)}
        required
      />
    </Field>
  );

  return (
    <form onSubmit={onSubmit} className="space-y-4 pt-4">
      <Field label="Proje" error={errors.project_id} required>
        <Select value={projectId} onValueChange={onProjectChange}>
          <SelectTrigger>
            <SelectValue placeholder="Proje seçin" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {selectedProject && (
        <Field label="Müşteri">
          <Input value={selectedProject.customer_name} readOnly />
        </Field>
      )}

      {selectedProject && (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
          {domainCandidates.length > 1 && !manualDomain && (
            <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Proje için birden fazla farklı domain bulundu. Lisansın bağlanacağı
                domaini seçin.
              </span>
            </div>
          )}

          {domainCandidates.length === 0 && (
            <div className="flex gap-2 text-sm text-slate-600">
              <Globe2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Projede veya Domainler sayfasında bağlı domain bulunamadı. Domaini
                manuel girin.
              </span>
            </div>
          )}

          {domainCandidates.length > 0 && !manualDomain ? (
            <Field label="Lisans Domaini" error={errors.domain} required>
              <Select value={domain} onValueChange={onDomainSelection}>
                <SelectTrigger>
                  <SelectValue placeholder="Domain seçin" />
                </SelectTrigger>
                <SelectContent>
                  {domainCandidates.map((candidate) => (
                    <SelectItem key={candidate.domain} value={candidate.domain}>
                      {candidate.domain} — {candidate.sources.join(", ")}
                    </SelectItem>
                  ))}
                  <SelectItem value={MANUAL_DOMAIN}>Farklı bir domain gir</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <Field label="Lisans Domaini" error={errors.domain} required>
              <Input
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                placeholder="ornek.com"
                autoComplete="off"
                required
              />
            </Field>
          )}

          <Field label="Ortam" error={errors.environment} required>
            <Select
              value={environment}
              onValueChange={(value) =>
                setEnvironment(value as "production" | "staging" | "local")
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="production">Canlı (production)</SelectItem>
                <SelectItem value="staging">Test (staging)</SelectItem>
                <SelectItem value="local">Yerel (local)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}

      <Field label="Ürün Adı" error={errors.product_name} required>
        <Input
          value={productName}
          onChange={(event) => setProductName(event.target.value)}
          required
        />
      </Field>

      <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div className="flex gap-2">
          <InfinityIcon className="mt-0.5 h-4 w-4 shrink-0 text-[#5267ff]" />
          <div>
            <p className="text-sm font-semibold text-[#141821]">Süresiz Lisans</p>
            <p className="text-xs text-muted-foreground">
              Açıkken tarih ve ek süre alanları kapanır; lisans süre sınırı olmadan
              geçerli olur.
            </p>
          </div>
        </div>
        <Switch checked={unlimited} onCheckedChange={onUnlimitedChange} />
      </div>

      {unlimited ? (
        <div className="grid grid-cols-2 gap-4">{activationLimitField}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Başlangıç"
              error={errors.starts_at}
              hint="Boş bırakılırsa lisans üretildiği an başlar."
            >
              <Input
                type="date"
                value={startsAt}
                onChange={(event) => setStartsAt(event.target.value)}
              />
            </Field>
            <Field label="Bitiş" error={errors.expires_at}>
              <Input
                type="date"
                value={expiresAt}
                onChange={(event) => onExpiresAtChange(event.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Ek Süre (gün)" error={errors.grace_days}>
              <Input
                type="number"
                min="0"
                value={expiresAt ? graceDays : ""}
                onChange={(event) => setGraceDays(event.target.value)}
                disabled={!expiresAt}
                aria-describedby={!expiresAt ? "grace-days-hint" : undefined}
              />
              {!expiresAt && (
                <p id="grace-days-hint" className="text-xs text-muted-foreground">
                  Ek süre girmek için önce bitiş tarihini seçin.
                </p>
              )}
            </Field>
            {activationLimitField}
          </div>
        </>
      )}

      <Field
        label="Özellikler"
        error={errors.features}
        hint="Virgülle ayırın: api_access, multi_user"
      >
        <Input value={features} onChange={(event) => setFeatures(event.target.value)} />
      </Field>

      {!unlimited && (
        <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div>
            <p className="text-sm font-semibold text-[#141821]">Otomatik Askıya Alma</p>
            <p className="text-xs text-muted-foreground">
              Süre ve ek süre dolduğunda lisans otomatik askıya alınır.
            </p>
          </div>
          <Switch checked={autoSuspend} onCheckedChange={setAutoSuspend} />
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          Vazgeç
        </Button>
        <Button
          type="submit"
          disabled={isPending || !projectId || !domain}
          className="bg-[#5267ff] hover:bg-[#4254e1]"
        >
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Lisans Üret
        </Button>
      </div>
    </form>
  );
}

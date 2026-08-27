"use client";

import { useState, useTransition } from "react";
import { Infinity as InfinityIcon, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateLicense } from "@/actions/licenses";
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
import { LICENSE_STATUS_OPTIONS } from "@/lib/validation/license";

export type EditableLicense = {
  id: string;
  customer_name: string;
  project_name: string;
  project_code: string;
  product_name: string;
  status: string;
  starts_at_input: string;
  expires_at_input: string;
  grace_days: number;
  active_activations: number;
  activation_limit: number;
  auto_suspend: boolean;
  features: string;
};

export function LicenseEditForm({
  license,
  onDone,
}: {
  license: EditableLicense;
  onDone: () => void;
}) {
  const router = useRouter();
  const [productName, setProductName] = useState(license.product_name);
  // Bitişi olmayan lisans süresizdir; form da onu böyle açar.
  const [unlimited, setUnlimited] = useState(!license.expires_at_input);
  const [startsAt, setStartsAt] = useState(license.starts_at_input);
  const [expiresAt, setExpiresAt] = useState(license.expires_at_input);
  const [graceDays, setGraceDays] = useState(
    license.expires_at_input && license.grace_days > 0
      ? String(license.grace_days)
      : ""
  );
  const [activationLimit, setActivationLimit] = useState(
    String(license.activation_limit)
  );
  const [status, setStatus] = useState(license.status);
  const [reason, setReason] = useState("");
  const [autoSuspend, setAutoSuspend] = useState(license.auto_suspend);
  const [features, setFeatures] = useState(license.features);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [isPending, startTransition] = useTransition();

  function onExpiresAtChange(value: string) {
    setExpiresAt(value);
    setErrors((current) => ({ ...current, expires_at: [], grace_days: [] }));
    if (!value) {
      setGraceDays("");
    } else if (!graceDays) {
      setGraceDays("14");
    }
  }

  // Süresiz lisansta tarih alanları hem kapanır hem temizlenir; kayıtta da boş
  // gider, böylece lisansta girilmemiş bir tarih kalmaz.
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
    } else {
      setStartsAt(license.starts_at_input);
      setExpiresAt(license.expires_at_input);
      setGraceDays(
        license.expires_at_input && license.grace_days > 0
          ? String(license.grace_days)
          : ""
      );
    }
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});
    startTransition(async () => {
      const result = await updateLicense({
        license_id: license.id,
        product_name: productName,
        unlimited,
        starts_at: unlimited ? "" : startsAt,
        expires_at: unlimited ? "" : expiresAt,
        grace_days: unlimited || !expiresAt ? 0 : graceDays,
        activation_limit: activationLimit,
        auto_suspend: unlimited ? false : autoSuspend,
        features,
        status,
        reason,
      });
      if (result.success) {
        toast.success(result.message ?? "Lisans güncellendi.");
        onDone();
        router.refresh();
      } else {
        if (result.fieldErrors) setErrors(result.fieldErrors);
        toast.error(result.error);
      }
    });
  }

  const activationLimitField = (
    <Field label="Aktivasyon Limiti" error={errors.activation_limit} required>
      <Input
        type="number"
        min={Math.max(1, license.active_activations)}
        max="10000"
        value={activationLimit}
        onChange={(event) => setActivationLimit(event.target.value)}
        required
      />
      <p className="text-xs text-muted-foreground">
        Aktif kurulum: {license.active_activations}
      </p>
    </Field>
  );

  return (
    <form onSubmit={onSubmit} className="space-y-4 pt-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Müşteri">
          <Input value={license.customer_name} readOnly />
        </Field>
        <Field label="Proje">
          <Input value={`${license.project_name} (${license.project_code})`} readOnly />
        </Field>
      </div>

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
              hint="Boş bırakılırsa başlangıç kısıtı uygulanmaz."
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
                max="365"
                value={expiresAt ? graceDays : ""}
                onChange={(event) => setGraceDays(event.target.value)}
                disabled={!expiresAt}
                aria-describedby={!expiresAt ? "edit-grace-days-hint" : undefined}
              />
              {!expiresAt && (
                <p id="edit-grace-days-hint" className="text-xs text-muted-foreground">
                  Ek süre girmek için önce bitiş tarihini seçin.
                </p>
              )}
            </Field>
            {activationLimitField}
          </div>
        </>
      )}

      <Field label="Durum" error={errors.status} required>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LICENSE_STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {status !== license.status && (
        <Field label="Durum Değişikliği Açıklaması" error={errors.reason}>
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={300}
            placeholder="Opsiyonel"
          />
        </Field>
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
        <Button type="button" variant="outline" onClick={onDone} disabled={isPending}>
          Vazgeç
        </Button>
        <Button
          type="submit"
          disabled={isPending}
          className="bg-[#5267ff] hover:bg-[#4254e1]"
        >
          {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Güncelle
        </Button>
      </div>
    </form>
  );
}

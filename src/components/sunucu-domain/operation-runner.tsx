"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDashed,
  Loader2,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import {
  advanceServerDomainOperation,
  cancelServerDomainOperation,
  getServerDomainOperation,
  rollbackServerDomainOperation,
  type OperationView,
} from "@/actions/server-domains";
import type { StepState } from "@/lib/server-domains/steps";

/**
 * İşlemi adım adım yürüten panel.
 *
 * Otomatik akış bilinçli olarak "ön kontrolden sonra dur" biçiminde kurgulanmıştır:
 * ön kontrol sunucuya hiçbir şey yazmaz, kullanıcı sonucu gördükten sonra yazma
 * adımlarını onaylar. Onaydan sonra kalan adımlar kesintisiz akar.
 */

const STATUS_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Bekliyor", variant: "outline" },
  running: { label: "Çalışıyor", variant: "secondary" },
  succeeded: { label: "Tamamlandı", variant: "default" },
  failed: { label: "Başarısız", variant: "destructive" },
  rolled_back: { label: "Geri alındı", variant: "outline" },
};

function StepIcon({ status }: { status: StepState["status"] }) {
  if (status === "succeeded") return <Check className="h-4 w-4 text-emerald-600" />;
  if (status === "failed") return <X className="h-4 w-4 text-rose-600" />;
  if (status === "running") return <Loader2 className="h-4 w-4 animate-spin text-sky-600" />;
  if (status === "skipped") return <CircleDashed className="h-4 w-4 text-muted-foreground" />;
  return <CircleDashed className="h-4 w-4 text-muted-foreground/50" />;
}

export function OperationRunner({
  operation: initial,
  canRollback,
  onClose,
}: {
  operation: OperationView;
  canRollback: boolean;
  onClose: () => void;
}) {
  const [operation, setOperation] = useState<OperationView>(initial);
  const [isPending, startTransition] = useTransition();
  const [autoRun, setAutoRun] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  /** Otomatik zincirin bir sonraki tura girmeden durmasını sağlayan bayrak. */
  const stopRef = useRef(false);

  const steps = operation.steps;
  const nextStep = steps[operation.current_step];
  const isDone = operation.status === "succeeded";
  const isClosed = isDone || operation.status === "rolled_back";
  // Ön kontrol sunucuya yazmaz; sonrasındaki her adım kalıcı değişiklik yapar.
  const isPreflightDone = steps[0]?.status === "succeeded";

  /**
   * Adımları çalıştırır. `auto` verildiğinde bir adım biter bitmez sıradakine
   * geçer; ilk hatada zincir kendiliğinden durur. Kullanıcı "durdur" derse
   * bayrak üzerinden mevcut adımın sonunda çıkılır — yarıda kesilme olmaz.
   */
  const run = useCallback(
    (auto: boolean) => {
      stopRef.current = false;
      if (auto) setAutoRun(true);

      startTransition(async () => {
        let current = operation;
        for (;;) {
          const res = await advanceServerDomainOperation(current.id);
          if (!res.success) {
            toast.error(res.error);
            // Hata adım kaydına yazıldı; güncel durumu geri okuyup gösterelim.
            const refreshed = await getServerDomainOperation(current.id);
            if (refreshed.success) setOperation(refreshed.data);
            break;
          }

          current = res.data;
          setOperation(current);
          if (res.message) toast.success(res.message);

          const hasMore = Boolean(current.steps[current.current_step]);
          if (!auto || !hasMore || stopRef.current) break;
        }
        setAutoRun(false);
      });
    },
    [operation]
  );

  const runNext = useCallback(() => run(false), [run]);

  useEffect(() => {
    if (showLog) logEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [operation.log, showLog]);

  function onRollback() {
    if (
      !confirm(
        "Sunucudaki değişiklikler yedekten geri alınacak ve eski site yeniden yayına açılacak. Devam edilsin mi?"
      )
    ) {
      return;
    }
    setAutoRun(false);
    startTransition(async () => {
      const res = await rollbackServerDomainOperation(operation.id);
      if (res.success) {
        setOperation(res.data);
        toast.success(res.message ?? "Geri alındı.");
      } else {
        toast.error(res.error);
      }
    });
  }

  function onCancel() {
    startTransition(async () => {
      const res = await cancelServerDomainOperation(operation.id);
      if (res.success) {
        toast.success(res.message ?? "İptal edildi.");
        onClose();
      } else {
        toast.error(res.error);
      }
    });
  }

  const badge = STATUS_BADGE[operation.status] ?? STATUS_BADGE.pending;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-bold">
              {operation.type === "change"
                ? `${operation.old_domain} → ${operation.new_domain}`
                : operation.new_domain}
            </h3>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {operation.server_name} · {operation.enable_ssl ? "SSL kurulacak" : "SSL kurulmayacak"}
            {operation.type === "change" &&
              (operation.redirect_old
                ? " · eski adres yeniye yönlendirilecek"
                : " · eski adres tamamen kapatılacak")}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Kapat
        </Button>
      </div>

      {operation.warnings.length > 0 && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Ön kontrol uyarıları</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {operation.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {operation.error && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Adım başarısız oldu</AlertTitle>
          <AlertDescription>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">
              {operation.error}
            </pre>
          </AlertDescription>
        </Alert>
      )}

      <ol className="space-y-1.5">
        {steps.map((step, index) => (
          <li
            key={step.key}
            className={cn(
              "flex gap-3 rounded-lg border px-3 py-2.5",
              index === operation.current_step && !isClosed
                ? "border-sky-200 bg-sky-50/60"
                : "border-border"
            )}
          >
            <div className="pt-0.5">
              <StepIcon status={step.status} />
            </div>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-semibold">{step.label}</p>
              <p className="text-xs text-muted-foreground">
                {step.message ?? step.description}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        {!isClosed && nextStep && (
          <>
            <Button onClick={runNext} disabled={isPending || autoRun}>
              {isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {operation.status === "failed"
                ? `"${nextStep.label}" adımını yeniden dene`
                : nextStep.status === "running"
                  ? `Devam et: ${nextStep.label}`
                  : `Sırayı çalıştır: ${nextStep.label}`}
            </Button>

            {isPreflightDone && (
              <Button
                variant="secondary"
                onClick={() => run(true)}
                disabled={isPending || autoRun}
              >
                {autoRun ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Kalan adımları otomatik tamamla
              </Button>
            )}
            {autoRun && (
              <Button
                variant="ghost"
                onClick={() => {
                  stopRef.current = true;
                }}
              >
                Otomatiği durdur
              </Button>
            )}
          </>
        )}

        {!isClosed && !operation.backup_path && (
          <Button variant="ghost" onClick={onCancel} disabled={isPending}>
            İşlemi iptal et
          </Button>
        )}

        {canRollback && operation.backup_path && operation.status !== "rolled_back" && (
          <Button variant="outline" onClick={onRollback} disabled={isPending}>
            <RotateCcw className="h-4 w-4" />
            Sunucudaki değişiklikleri geri al
          </Button>
        )}
      </div>

      {isDone && (
        <Alert>
          <Check />
          <AlertTitle>İşlem tamamlandı</AlertTitle>
          <AlertDescription>
            {operation.new_domain} yayında ve panel kayıtları güncellendi.
            {operation.backup_path
              ? ` Sunucudaki yedek: ${operation.backup_path}`
              : ""}
          </AlertDescription>
        </Alert>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowLog((prev) => !prev)}
          className="flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            className={cn("h-3.5 w-3.5 transition-transform", showLog && "rotate-180")}
          />
          Çalıştırma günlüğü ({operation.log.length} satır)
        </button>
        {showLog && (
          <div className="mt-2 max-h-72 overflow-auto rounded-lg bg-[#141821] p-3 font-mono text-[11px] leading-relaxed text-slate-200">
            {operation.log.length === 0 ? (
              <p className="text-slate-400">Henüz kayıt yok.</p>
            ) : (
              operation.log.map((line, index) => (
                <div
                  key={`${line.at}-${index}`}
                  className={cn(
                    "whitespace-pre-wrap",
                    line.level === "error" && "text-rose-300",
                    line.level === "warn" && "text-amber-300"
                  )}
                >
                  <span className="text-slate-500">
                    {new Date(line.at).toLocaleTimeString("tr-TR")} [{line.step}]{" "}
                  </span>
                  {line.message}
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        )}
      </div>
    </div>
  );
}

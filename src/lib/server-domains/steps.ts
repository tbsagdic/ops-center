/**
 * Sunucu domain işleminin adım planı.
 *
 * İş tek bir istekte değil, adım adım yürütülür: her adım ayrı bir Server Action
 * çağrısında kendi SSH oturumunu açar. Böylece Certbot gibi uzun süren adımlar
 * serverless süre sınırını tek başına doldurur, diğer adımları riske atmaz.
 */

export const STEP_KEYS = [
  "preflight",
  "backup",
  "write_vhost",
  "enable",
  "ssl",
  "verify",
  "deactivate_old",
  "finalize",
] as const;

export type StepKey = (typeof STEP_KEYS)[number];

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type StepState = {
  key: StepKey;
  label: string;
  description: string;
  status: StepStatus;
  /** Kullanıcıya gösterilen kısa sonuç veya hata özeti. */
  message?: string;
  started_at?: string;
  finished_at?: string;
};

const STEP_META: Record<StepKey, { label: string; description: string }> = {
  preflight: {
    label: "Ön kontrol",
    description:
      "Sunucuya bağlanır; nginx, certbot, hedef vhost ve DNS kaydı doğrulanır. Sunucuya hiçbir şey yazılmaz.",
  },
  backup: {
    label: "Yedekleme",
    description: "Mevcut nginx yapılandırması sunucuda zaman damgalı bir dizine kopyalanır.",
  },
  write_vhost: {
    label: "Site tanımı yazılıyor",
    description:
      "Yeni alan adının vhost dosyası oluşturulur. Değiştirme işleminde mevcut yapılandırma birebir kopyalanır.",
  },
  enable: {
    label: "Yayına alma",
    description: "Site etkinleştirilir, `nginx -t` ile sözdizimi doğrulanır ve nginx yeniden yüklenir.",
  },
  ssl: {
    label: "SSL sertifikası",
    description: "Certbot ile Let's Encrypt sertifikası alınır ve HTTPS yönlendirmesi kurulur.",
  },
  verify: {
    label: "Doğrulama",
    description: "Alan adına istek atılır ve sertifikanın geçerliliği kontrol edilir.",
  },
  deactivate_old: {
    label: "Eski alan adını pasife alma",
    description:
      "Eski site yayından kaldırılır; yönlendirme seçiliyse eski adres yeniye 301 ile taşınır.",
  },
  finalize: {
    label: "Panel kayıtları",
    description: "Domain kaydı güncellenir, SSL bitiş tarihi işlenir ve denetim izi yazılır.",
  },
};

export type StepPlanInput = {
  type: "add" | "change";
  enableSsl: boolean;
};

/** İşlem tipine göre çalışacak adımları sırayla üretir. */
export function planSteps(input: StepPlanInput): StepState[] {
  const keys = STEP_KEYS.filter((key) => {
    if (key === "ssl" && !input.enableSsl) return false;
    if (key === "deactivate_old" && input.type !== "change") return false;
    return true;
  });

  return keys.map((key) => ({
    key,
    ...STEP_META[key],
    status: "pending" as const,
  }));
}

/** Kaydedilmiş JSON'u güvenle StepState listesine çevirir. */
export function parseSteps(value: unknown): StepState[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const step = raw as Partial<StepState>;
    if (!step.key || !STEP_KEYS.includes(step.key)) return [];
    return [
      {
        key: step.key,
        label: step.label ?? STEP_META[step.key].label,
        description: step.description ?? STEP_META[step.key].description,
        status: (step.status ?? "pending") as StepStatus,
        message: typeof step.message === "string" ? step.message : undefined,
        started_at: typeof step.started_at === "string" ? step.started_at : undefined,
        finished_at: typeof step.finished_at === "string" ? step.finished_at : undefined,
      },
    ];
  });
}

/** Adımlar arasında taşınan, sunucudan tespit edilmiş bilgiler. */
export type OperationContext = {
  /** Kaynak (eski) vhost dosyasının tam yolu. */
  sourceVhostPath?: string;
  /** Yeni alan adı için oluşturulan vhost dosyasının tam yolu. */
  targetVhostPath?: string;
  /** Eski alan adı için yazılan yönlendirme vhost'unun yolu. */
  redirectVhostPath?: string;
  /** Kullanılan sites-available dizini. */
  sitesAvailable?: string;
  /** Kullanılan sites-enabled dizini. */
  sitesEnabled?: string;
  /** Tespit edilen PHP-FPM soketi. */
  phpFpmSocket?: string;
  /** Sertifikanın bitiş tarihi (ISO). */
  sslExpiresAt?: string;
  /** www alt alan adı bu sunucuya çözümleniyor mu? (sertifikaya dahil edilme koşulu) */
  wwwResolvable?: boolean;
  /** Kaynak vhost'tan tespit edilen site kök dizini. */
  documentRoot?: string;
  /** Kaynak vhost'tan tespit edilen ters vekil hedefi. */
  proxyPass?: string;
  /** Ön kontrolde toplanan uyarılar. */
  warnings?: string[];
  /** Sunucunun dışa görünen IP adresleri. */
  serverIps?: string[];
  /** İşlem sırasında nginx yeniden yüklendi mi? (geri alma bunu bilmeli) */
  nginxReloaded?: boolean;
};

export function parseContext(value: unknown): OperationContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as OperationContext;
}

export type LogLine = {
  at: string;
  level: "info" | "warn" | "error";
  step: StepKey | "system";
  message: string;
};

/** Günlükte tutulan azami satır sayısı; taşarsa en eskiler düşer. */
export const MAX_LOG_LINES = 400;
/** Tek bir günlük satırının azami uzunluğu. */
export const MAX_LOG_LINE_LENGTH = 2_000;

export function parseLog(value: unknown): LogLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const line = raw as Partial<LogLine>;
    if (typeof line.message !== "string") return [];
    return [
      {
        at: typeof line.at === "string" ? line.at : new Date().toISOString(),
        level: line.level === "warn" || line.level === "error" ? line.level : "info",
        step: (line.step ?? "system") as LogLine["step"],
        message: line.message,
      },
    ];
  });
}

import { z } from "zod";
import { normalizeDomain } from "@/lib/domain";

/**
 * Sunucu domain kontrolü form doğrulaması.
 *
 * Buradaki her alan uzak sunucuda bir kabuk komutuna girdi olur; bu yüzden
 * doğrulama "boş mu" kontrolünden ibaret değildir: yol, alan adı ve vekil hedefi
 * için izin verilen karakter kümesi daraltılmıştır.
 */

export const SERVER_DOMAIN_OP_TYPES = ["add", "change"] as const;

export const SERVER_DOMAIN_OP_TYPE_OPTIONS = [
  {
    value: "add",
    label: "Yeni domain ekle",
    description: "Sunucuya yeni bir site tanımı açar ve SSL alır.",
  },
  {
    value: "change",
    label: "Domaini değiştir",
    description:
      "Yayındaki bir alan adının yerine yenisini geçirir; mevcut yapılandırma kopyalanır.",
  },
] as const;

export const SERVER_DOMAIN_OP_STATUS_LABELS: Record<string, string> = {
  pending: "Bekliyor",
  running: "Çalışıyor",
  succeeded: "Tamamlandı",
  failed: "Başarısız",
  rolled_back: "Geri alındı",
};

const domainField = (label: string) =>
  z
    .string()
    .trim()
    .min(3, `${label} zorunludur.`)
    .max(253)
    .transform((value, ctx) => {
      const normalized = normalizeDomain(value);
      if (!normalized) {
        ctx.addIssue({ code: "custom", message: `${label} geçerli bir alan adı değil.` });
        return z.NEVER;
      }
      if (!normalized.includes(".")) {
        ctx.addIssue({
          code: "custom",
          message: `${label} en az bir nokta içermelidir (ör. ornek.com).`,
        });
        return z.NEVER;
      }
      return normalized;
    });

/** Mutlak POSIX yolu; `..`, boşluk ve kabuk metakarakterleri kabul edilmez. */
const absolutePath = (label: string, max = 300) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value, ctx) => {
      if (!value) return undefined;
      if (!value.startsWith("/")) {
        ctx.addIssue({ code: "custom", message: `${label} / ile başlamalıdır.` });
        return z.NEVER;
      }
      if (!/^\/[A-Za-z0-9._\-/]*$/.test(value)) {
        ctx.addIssue({
          code: "custom",
          message: `${label} yalnızca harf, rakam, nokta, tire, alt çizgi ve / içerebilir.`,
        });
        return z.NEVER;
      }
      if (value.split("/").includes("..")) {
        ctx.addIssue({ code: "custom", message: `${label} ".." içeremez.` });
        return z.NEVER;
      }
      return value.replace(/\/+$/, "") || "/";
    })
    .optional();

const proxyTarget = z
  .string()
  .trim()
  .max(200)
  .transform((value, ctx) => {
    if (!value) return undefined;
    if (!/^https?:\/\/[A-Za-z0-9.\-_]+(:\d{1,5})?(\/[A-Za-z0-9._\-/]*)?$/.test(value)) {
      ctx.addIssue({
        code: "custom",
        message: "Vekil hedefi http://127.0.0.1:3000 biçiminde olmalıdır.",
      });
      return z.NEVER;
    }
    return value;
  })
  .optional();

const optionalBool = z
  .union([z.boolean(), z.literal("true"), z.literal("false"), z.literal("on"), z.literal("")])
  .optional();

const boolWithDefault = (fallback: boolean) =>
  optionalBool.transform((value) => {
    if (typeof value === "boolean") return value;
    if (value === undefined) return fallback;
    return value === "true" || value === "on";
  });

const optUuid = z
  .union([z.uuid(), z.literal(""), z.literal("none")])
  .optional()
  .transform((v) => (v && v !== "none" ? v : undefined));

export const serverDomainOperationSchema = z
  .object({
    server_id: z.uuid("Sunucu seçilmelidir."),
    type: z.enum(SERVER_DOMAIN_OP_TYPES),
    new_domain: domainField("Yeni alan adı"),
    old_domain: z
      .union([z.string(), z.literal("")])
      .optional()
      .transform((v) => (v ? v : undefined))
      .pipe(domainField("Eski alan adı").optional()),
    include_www: boolWithDefault(true),
    enable_ssl: boolWithDefault(true),
    ssl_email: z
      .union([z.email("Geçerli bir e-posta girin."), z.literal("")])
      .optional()
      .transform((v) => (v ? v : undefined)),
    redirect_old: boolWithDefault(true),
    document_root: absolutePath("Site kök dizini"),
    proxy_pass: proxyTarget,
    /** İşlem sonunda oluşturulacak domain kaydının müşteri/proje bağı. */
    customer_id: optUuid,
    project_id: optUuid,
  })
  .superRefine((data, ctx) => {
    if (data.type === "change") {
      if (!data.old_domain) {
        ctx.addIssue({
          code: "custom",
          path: ["old_domain"],
          message: "Değiştirme işleminde eski alan adı zorunludur.",
        });
      } else if (data.old_domain === data.new_domain) {
        ctx.addIssue({
          code: "custom",
          path: ["new_domain"],
          message: "Yeni alan adı eskisiyle aynı olamaz.",
        });
      }
    }

    if (data.type === "add" && !data.document_root && !data.proxy_pass) {
      ctx.addIssue({
        code: "custom",
        path: ["document_root"],
        message: "Yeni domain için site kök dizini veya vekil hedefi girilmelidir.",
      });
    }

    if (data.document_root && data.proxy_pass) {
      ctx.addIssue({
        code: "custom",
        path: ["proxy_pass"],
        message: "Kök dizin ve vekil hedefi aynı anda kullanılamaz.",
      });
    }

    if (data.enable_ssl && !data.ssl_email) {
      ctx.addIssue({
        code: "custom",
        path: ["ssl_email"],
        message:
          "Let's Encrypt bildirimleri için e-posta gerekir (sertifika bitiş uyarıları buraya gider).",
      });
    }
  });

export type ServerDomainOperationInput = z.infer<typeof serverDomainOperationSchema>;

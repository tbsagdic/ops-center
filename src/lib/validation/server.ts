import { z } from "zod";
import { CURRENCY_CODES } from "@/lib/currency";

export const SERVER_STATUS_OPTIONS = [
  { value: "active", label: "Aktif" },
  { value: "maintenance", label: "Bakım" },
  { value: "suspended", label: "Askıda" },
  { value: "terminated", label: "Sonlandırıldı" },
] as const;

export const COST_PERIODS = ["monthly", "yearly"] as const;

export const COST_PERIOD_OPTIONS = [
  { value: "monthly", label: "Aylık" },
  { value: "yearly", label: "Yıllık" },
];

const optStr = (max = 300) =>
  z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

const optInt = z
  .union([z.string(), z.number(), z.literal("")])
  .optional()
  .transform((v) => (v === "" || v === undefined ? undefined : Number(v)))
  .refine((v) => v === undefined || (Number.isInteger(v) && v >= 0), {
    message: "Geçerli bir sayı girin.",
  });

export const serverSchema = z.object({
  name: z.string().trim().min(2, "Sunucu adı zorunludur.").max(150),
  provider: optStr(100),
  external_ref: optStr(150),
  type: z.enum(["vds", "vps", "hosting", "dedicated", "cloud"]).default("vps"),
  hostname: optStr(253),
  primary_ip: optStr(45),
  region: optStr(100),
  operating_system: optStr(100),
  cpu_cores: optInt,
  ram_mb: optInt,
  disk_gb: optInt,
  management_url: optStr(300),
  ssh_port: z
    .union([z.string(), z.number(), z.literal("")])
    .optional()
    .transform((v) => (v === "" || v === undefined ? 22 : Number(v)))
    .refine((v) => Number.isInteger(v) && v >= 1 && v <= 65535, {
      message: "SSH portu 1-65535 arasında olmalıdır.",
    }),
  ssh_user: optStr(100),
  ssh_password: z
    .string()
    .max(1000, "SSH parolası en fazla 1000 karakter olabilir.")
    .optional()
    .transform((v) => (v === "" || v === undefined ? undefined : v)),
  /** sudo parolası SSH parolasından farklıysa; boş bırakılırsa SSH parolası denenir. */
  ssh_sudo_password: z
    .string()
    .max(1000, "sudo parolası en fazla 1000 karakter olabilir.")
    .optional()
    .transform((v) => (v === "" || v === undefined ? undefined : v)),
  /** Domain otomasyonunun kullanacağı web yığını. */
  web_stack: z.preprocess(
    // Form "" veya "none" gönderebilir; ikisi de "seçilmedi" demektir.
    (v) => (v === "nginx" ? "nginx" : undefined),
    z.enum(["nginx"]).optional()
  ),
  /** Nginx vhost dizini; boşsa /etc/nginx/sites-available varsayılır. */
  nginx_sites_path: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      if (!/^\/[A-Za-z0-9._\-/]+$/.test(v) || v.split("/").includes("..")) {
        ctx.addIssue({
          code: "custom",
          message: "Geçerli bir mutlak dizin yolu girin (ör. /etc/nginx/sites-available).",
        });
        return z.NEVER;
      }
      return v.replace(/\/+$/, "");
    }),
  status: z.enum(["active", "maintenance", "suspended", "terminated"]).default("active"),
  renewal_at: z
    .union([z.string(), z.literal("")])
    .optional()
    .transform((v) => (v ? v : undefined)),
  monthly_cost: z
    .union([z.string(), z.number(), z.literal("")])
    .optional()
    .transform((v) => (v === "" || v === undefined ? undefined : Number(v)))
    .refine((v) => v === undefined || (Number.isFinite(v) && v >= 0), {
      message: "Geçerli bir tutar girin.",
    }),
  cost_period: z.enum(COST_PERIODS).default("monthly"),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.enum(CURRENCY_CODES, { message: "Desteklenmeyen para birimi." }))
    .default("TRY"),
  /** Boş bırakılırsa TCMB'nin o günkü kuru kullanılır. */
  manual_fx_rate: z
    .union([z.string(), z.number(), z.literal("")])
    .optional()
    .transform((v) => (v === "" || v === undefined ? undefined : Number(v)))
    .refine((v) => v === undefined || (Number.isFinite(v) && v > 0), {
      message: "Kur sıfırdan büyük olmalıdır.",
    }),
});

export type ServerInput = z.infer<typeof serverSchema>;

export const projectServerSchema = z.object({
  server_id: z.uuid(),
  project_id: z.uuid(),
  role: z.string().trim().max(100).optional(),
  environment: z.string().trim().max(50).optional(),
  is_primary: z.boolean().optional().default(false),
});

export const PERMISSION_OPERATIONS = ["view", "create", "update", "delete"] as const;

export type PermissionOperation = (typeof PERMISSION_OPERATIONS)[number];

export const PERMISSION_MODULES = [
  {
    key: "dashboard",
    label: "Genel Bakış",
    description: "Özet ekranı ve operasyon göstergeleri",
    operations: ["view"],
  },
  {
    key: "customers",
    label: "Müşteriler",
    description: "Müşteri ve şube kayıtları",
    operations: PERMISSION_OPERATIONS,
  },
  {
    key: "projects",
    label: "Projeler ve Ürünler",
    description: "Proje, ürün ve GitHub proje verileri",
    operations: PERMISSION_OPERATIONS,
  },
  {
    key: "licenses",
    label: "Lisanslar",
    description: "Lisans, anahtar, aktivasyon ve lisans domainleri",
    operations: PERMISSION_OPERATIONS,
  },
  {
    key: "servers",
    label: "Sunucular",
    description: "Sunucu kayıtları ve proje bağlantıları",
    operations: PERMISSION_OPERATIONS,
  },
  {
    key: "domains",
    label: "Domainler",
    description: "Domain kayıtları ve lisans domain içe aktarma",
    operations: PERMISSION_OPERATIONS,
  },
  {
    key: "server_domains",
    label: "Sunucu Domain Kontrolü",
    description:
      "Sunucuya SSH ile bağlanıp nginx site tanımı açma, alan adı değiştirme ve SSL alma",
    operations: PERMISSION_OPERATIONS,
  },
  {
    key: "finance",
    label: "Finans",
    description: "Fatura, ödeme ve faturalama planları",
    operations: PERMISSION_OPERATIONS,
  },
  {
    key: "team",
    label: "Kullanıcılar",
    description: "Davet, rol, durum ve üyelik işlemleri",
    operations: PERMISSION_OPERATIONS,
  },
  {
    key: "workspaces",
    label: "Çalışma Alanları",
    description: "Alan görüntüleme, oluşturma ve silme işlemleri",
    operations: ["view", "create", "delete"],
  },
  {
    key: "settings",
    label: "Ayarlar",
    description: "Profil dışındaki çalışma alanı ayarları ve bağlantılar",
    operations: ["view", "update"],
  },
  {
    key: "system",
    label: "Sistem Özellikleri",
    description: "Sistem güncelleme ve yönetim ekranları",
    operations: ["view", "update"],
  },
] as const;

export type PermissionModuleKey = (typeof PERMISSION_MODULES)[number]["key"];
export type PermissionAction =
  | `${PermissionModuleKey}.${PermissionOperation}`
  | "roles.manage";

export type BuiltinRole = "owner" | "admin" | "technical" | "finance" | "viewer";

export const IMMUTABLE_ROLES: readonly BuiltinRole[] = ["owner", "admin"];

export const USER_CONFIGURABLE_PERMISSIONS = PERMISSION_MODULES.flatMap((module) =>
  module.operations.map((operation) => `${module.key}.${operation}` as PermissionAction)
);

export const ALL_PERMISSIONS: readonly PermissionAction[] = [
  ...USER_CONFIGURABLE_PERMISSIONS,
  "roles.manage",
];

const COMMON_VIEW_PERMISSIONS: PermissionAction[] = PERMISSION_MODULES.filter(
  (module) =>
    module.key !== "finance" &&
    module.key !== "system" &&
    // Sunucuda komut çalıştıran ekran hiçbir role varsayılan olarak açılmaz.
    module.key !== "server_domains"
).map((module) => `${module.key}.view` as PermissionAction);

const TECHNICAL_WRITE_PERMISSIONS: PermissionAction[] = [
  // Yürütme (server_domains.create) bilinçli olarak yok: sunucuda kalıcı değişiklik
  // yapan bir yetki, rol yönetiminden açıkça verilmelidir.
  "server_domains.view",
  "customers.create",
  "customers.update",
  "projects.create",
  "projects.update",
  "licenses.create",
  "licenses.update",
  "servers.create",
  "servers.update",
  "domains.create",
  "domains.update",
];

export const DEFAULT_ROLE_PERMISSIONS: Record<BuiltinRole, readonly PermissionAction[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS,
  technical: [...COMMON_VIEW_PERMISSIONS, ...TECHNICAL_WRITE_PERMISSIONS],
  finance: [
    ...COMMON_VIEW_PERMISSIONS,
    "finance.view",
    "finance.create",
    "finance.update",
    "finance.delete",
  ],
  viewer: COMMON_VIEW_PERMISSIONS,
};

const VALID_CONFIGURABLE_PERMISSIONS = new Set<PermissionAction>(
  USER_CONFIGURABLE_PERMISSIONS
);

/** Veritabanındaki JSON değerini güvenli, tekrarsız ve geçerli izin listesine çevirir. */
export function normalizePermissions(value: unknown): PermissionAction[] {
  if (!Array.isArray(value)) return [];

  const permissions = new Set<PermissionAction>();
  for (const candidate of value) {
    if (
      typeof candidate === "string" &&
      VALID_CONFIGURABLE_PERMISSIONS.has(candidate as PermissionAction)
    ) {
      permissions.add(candidate as PermissionAction);
    }
  }

  // Bir modülde yazma/silme izni varsa ekran erişimi de zorunlu olarak açıktır.
  for (const permission of [...permissions]) {
    const [moduleKey, operation] = permission.split(".") as [
      PermissionModuleKey,
      PermissionOperation,
    ];
    if (operation !== "view") {
      permissions.add(`${moduleKey}.view` as PermissionAction);
    }
  }

  return USER_CONFIGURABLE_PERMISSIONS.filter((permission) =>
    permissions.has(permission)
  );
}

import type { PermissionAction } from "@/lib/auth/permissions";

export type NavItem = {
  href: string;
  label: string;
  icon: string; // lucide-react ikon adı
  /** Bu öğeyi görmek için gereken modül izni. */
  requires?: PermissionAction;
  /** Bu izinlerden en az biri yeterlidir. */
  requiresAny?: PermissionAction[];
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Genel Bakış", icon: "LayoutDashboard", requires: "dashboard.view" },
  { href: "/musteriler", label: "Müşteriler", icon: "Users", requires: "customers.view" },
  { href: "/projeler", label: "Projeler", icon: "FolderKanban", requires: "projects.view" },
  { href: "/lisanslar", label: "Lisanslar", icon: "KeyRound", requires: "licenses.view" },
  { href: "/sunucular", label: "Sunucular", icon: "Server", requires: "servers.view" },
  { href: "/domainler", label: "Domainler", icon: "Globe", requires: "domains.view" },
  {
    href: "/sunucu-domain",
    label: "Sunucu Domain Kontrolü",
    icon: "ServerCog",
    requires: "server_domains.view",
  },
  { href: "/finans", label: "Finans", icon: "Wallet", requires: "finance.view" },
  {
    href: "/ekip",
    label: "Ekip",
    icon: "UserCog",
    requiresAny: ["team.view", "workspaces.view"],
  },
  { href: "/ayarlar", label: "Ayarlar", icon: "Settings", requires: "settings.view" },
  { href: "/rol-yonetimi", label: "Rol Yönetimi", icon: "ShieldCheck", requires: "roles.manage" },
  {
    href: "/sistem-guncelleme",
    label: "Sistem Özellikleri",
    icon: "RefreshCw",
    requires: "system.view",
  },
];

import { decryptSecret } from "@/lib/crypto/encryption";
import type { SshTarget } from "@/lib/ssh/client";
import { DEFAULT_SITES_AVAILABLE, assertSafePath, sitesEnabledFor } from "./runner";

/**
 * Sunucu kaydını SSH bağlantı hedefine çevirir.
 * Parolalar yalnız burada çözülür ve döndürülen nesne hiçbir zaman istemciye gitmez.
 */

export type ServerAccessRecord = {
  id: string;
  name: string;
  hostname: string | null;
  primary_ip: string | null;
  ssh_port: number;
  ssh_user: string | null;
  ssh_password_encrypted: string | null;
  ssh_sudo_password_encrypted: string | null;
  ssh_host_fingerprint: string | null;
  nginx_sites_path: string | null;
};

export class ServerAccessError extends Error {}

export type ServerAccess = {
  target: SshTarget;
  sitesAvailable: string;
  sitesEnabled: string;
};

/** Kayıtta SSH ile bağlanmaya yetecek bilgi var mı? (form uyarıları için) */
export function describeMissingAccess(server: ServerAccessRecord): string[] {
  const missing: string[] = [];
  if (!server.hostname && !server.primary_ip) missing.push("sunucu adresi (hostname veya IP)");
  if (!server.ssh_user) missing.push("SSH kullanıcısı");
  if (!server.ssh_password_encrypted) missing.push("SSH parolası");
  return missing;
}

export function buildServerAccess(server: ServerAccessRecord): ServerAccess {
  const missing = describeMissingAccess(server);
  if (missing.length > 0) {
    throw new ServerAccessError(
      `${server.name} kaydında eksik bilgi var: ${missing.join(", ")}. Sunucular ekranından tamamlayın.`
    );
  }

  let password: string;
  let sudoPassword: string | undefined;
  try {
    password = decryptSecret(server.ssh_password_encrypted as string);
    sudoPassword = server.ssh_sudo_password_encrypted
      ? decryptSecret(server.ssh_sudo_password_encrypted)
      : undefined;
  } catch {
    throw new ServerAccessError(
      "Kayıtlı SSH parolası çözülemedi. ENCRYPTION_KEY değiştiyse parolayı yeniden kaydedin."
    );
  }

  const sitesAvailable = server.nginx_sites_path
    ? assertSafePath(server.nginx_sites_path, "Nginx vhost dizini")
    : DEFAULT_SITES_AVAILABLE;

  return {
    target: {
      // IP varsa tercih edilir: DNS'e bağımlılık olmadan doğru makineye gidilir.
      host: (server.primary_ip || server.hostname) as string,
      port: server.ssh_port,
      username: server.ssh_user as string,
      password,
      sudoPassword,
      knownFingerprint: server.ssh_host_fingerprint,
    },
    sitesAvailable,
    sitesEnabled: sitesEnabledFor(sitesAvailable),
  };
}

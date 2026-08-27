import crypto from "node:crypto";
import net from "node:net";
import { Client } from "ssh2";
import { resolveSafeHostname, SsrfError } from "@/lib/security/ssrf-guard";
import { shellQuote } from "./shell-quote";

/**
 * Kayıtlı sunuculara parola ile SSH bağlantısı.
 *
 * Güvenlik modeli:
 * - hedef adres SSRF korumasından geçer ve bağlantı doğrulanan IP'ye sabitlenir
 *   (DNS rebinding yok); yalnız SSH_ALLOW_PRIVATE_TARGETS=1 ile özel ağa izin verilir;
 * - host anahtarı ilk bağlantıda kaydedilir (TOFU), sonrasında değişirse bağlantı
 *   reddedilir — MITM ile parolanın başka makineye gitmesi engellenir;
 * - sudo parolası komut satırına değil daima stdin'e yazılır ve çıktıda maskelenir;
 * - komut çıktısı ve süresi üst sınırlarla korunur.
 */

export class SshError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "network"
      | "auth"
      | "host_key"
      | "timeout"
      | "sudo"
      | "protocol" = "network"
  ) {
    super(message);
    this.name = "SshError";
  }
}

export type SshTarget = {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Boşsa SSH parolası sudo için de kullanılır. */
  sudoPassword?: string;
  /** Daha önce kaydedilmiş host anahtarı parmak izi (SHA256:...). */
  knownFingerprint?: string | null;
};

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/** Bağlantı kurulumu için azami süre. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Tek bir komut için varsayılan azami süre. */
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
/** Komut başına saklanan azami çıktı (byte). */
const MAX_OUTPUT_BYTES = 256 * 1024;

function allowPrivateTargets(): boolean {
  return process.env.SSH_ALLOW_PRIVATE_TARGETS === "1";
}

/** OpenSSH'in `ssh-keygen -lf` çıktısıyla aynı biçim: SHA256:<base64, padding'siz>. */
export function fingerprintOf(hostKey: Buffer): string {
  const digest = crypto.createHash("sha256").update(hostKey).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** Sabit zamanlı parmak izi karşılaştırması. */
function fingerprintMatches(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** Hedefi çözer; özel ağa yalnız açıkça izin verilmişse bağlanılır. */
async function resolveTarget(host: string): Promise<string> {
  if (allowPrivateTargets()) {
    const trimmed = host.trim().replace(/^\[|\]$/g, "");
    if (!trimmed || trimmed.length > 253 || trimmed.includes("\0")) {
      throw new SshError("Sunucu adresi geçersiz.", "network");
    }
    return trimmed;
  }
  try {
    const [first] = await resolveSafeHostname(host, { subject: "Sunucu adresi" });
    return first.address;
  } catch (error) {
    if (error instanceof SsrfError) {
      throw new SshError(
        `${error.message} Kendi iç ağınızdaki bir sunucuya bağlanmak için SSH_ALLOW_PRIVATE_TARGETS=1 tanımlayın.`,
        "network"
      );
    }
    throw new SshError("Sunucu adresi çözümlenemedi.", "network");
  }
}

export type SshConnection = {
  /** Bağlantıda görülen host anahtarı parmak izi. */
  fingerprint: string;
  /** Gerçekten bağlanılan IP adresi — DNS kontrollerinde referans alınır. */
  remoteAddress: string;
  /** Bu bağlantıda parmak izi ilk kez kaydedildiyse true. */
  firstSeen: boolean;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  /** Komutu sudo ile çalıştırır; parola stdin'den verilir. */
  sudo(command: string, options?: ExecOptions): Promise<ExecResult>;
  close(): void;
};

export type ExecOptions = {
  timeoutMs?: number;
  /** Komuta stdin olarak verilecek veri. */
  stdin?: string;
};

export async function connectSsh(target: SshTarget): Promise<SshConnection> {
  const address = await resolveTarget(target.host);
  const sudoPassword = target.sudoPassword || target.password;

  const socket = net.connect({ host: address, port: target.port });
  socket.setTimeout(CONNECT_TIMEOUT_MS);

  const client = new Client();
  let seenFingerprint = "";
  let firstSeen = false;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: SshError) => {
      if (settled) return;
      settled = true;
      if (error) {
        socket.destroy();
        client.end();
        reject(error);
      } else {
        resolve();
      }
    };

    socket.on("timeout", () =>
      finish(new SshError("Sunucuya bağlanılamadı: zaman aşımı.", "timeout"))
    );
    socket.on("error", () =>
      finish(
        new SshError(
          `Sunucuya bağlanılamadı (${address}:${target.port}). Adres, port ve güvenlik duvarını kontrol edin.`,
          "network"
        )
      )
    );

    client.on("ready", () => {
      socket.setTimeout(0);
      finish();
    });

    client.on("error", (error: Error & { level?: string }) => {
      if (error.level === "client-authentication") {
        finish(
          new SshError(
            "SSH kimlik doğrulaması başarısız. Kullanıcı adı veya parola hatalı.",
            "auth"
          )
        );
        return;
      }
      if (error instanceof SshError) {
        finish(error);
        return;
      }
      finish(new SshError("SSH bağlantısı kurulamadı.", "network"));
    });

    client.connect({
      sock: socket,
      username: target.username,
      password: target.password,
      readyTimeout: CONNECT_TIMEOUT_MS,
      // Yalnız parola tabanlı giriş; ajan/anahtar yönlendirmesi yapılmaz.
      tryKeyboard: false,
      hostVerifier: (key: Buffer) => {
        seenFingerprint = fingerprintOf(key);
        if (!target.knownFingerprint) {
          firstSeen = true;
          return true;
        }
        if (fingerprintMatches(seenFingerprint, target.knownFingerprint)) {
          return true;
        }
        finish(
          new SshError(
            `Sunucunun SSH kimliği değişmiş. Beklenen ${target.knownFingerprint}, görülen ${seenFingerprint}. ` +
              "Sunucuyu gerçekten yeniden kurduysanız sunucu kaydındaki parmak izini sıfırlayın; aksi halde bağlantı güvenli değildir.",
            "host_key"
          )
        );
        return false;
      },
    });
  });

  async function exec(
    command: string,
    options: ExecOptions = {}
  ): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

    return new Promise<ExecResult>((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(new SshError("Komut çalıştırılamadı.", "protocol"));
          return;
        }

        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          stream.destroy();
          reject(
            new SshError(
              `Komut ${Math.round(timeoutMs / 1000)} saniyede tamamlanmadı; işlem durduruldu.`,
              "timeout"
            )
          );
        }, timeoutMs);

        stream.on("data", (chunk: Buffer) => {
          if (stdoutBytes >= MAX_OUTPUT_BYTES) return;
          stdoutBytes += chunk.length;
          stdout += chunk.toString("utf8");
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          if (stderrBytes >= MAX_OUTPUT_BYTES) return;
          stderrBytes += chunk.length;
          stderr += chunk.toString("utf8");
        });

        stream.on("close", (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            code: code ?? -1,
            stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
            stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
          });
        });

        stream.on("error", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new SshError("Komut akışı beklenmedik şekilde kapandı.", "protocol"));
        });

        if (options.stdin !== undefined) stream.write(options.stdin);
        stream.end();
      });
    });
  }

  async function sudo(
    command: string,
    options: ExecOptions = {}
  ): Promise<ExecResult> {
    // -S: parolayı stdin'den okur (komut satırında ve process listesinde görünmez)
    // -p '': parola istemi çıktıya karışmaz
    // -k: önbelleğe alınmış oturum yerine parolayı her seferinde doğrula
    const wrapped = `sudo -S -k -p '' sh -c ${shellQuote(command)}`;
    const result = await exec(wrapped, {
      ...options,
      stdin: `${sudoPassword}\n${options.stdin ?? ""}`,
    });

    if (
      result.code !== 0 &&
      /incorrect password|Sorry, try again|is not in the sudoers/i.test(result.stderr)
    ) {
      throw new SshError(
        "sudo yetkisi alınamadı. Kullanıcının sudo hakkı ve sudo parolası doğru mu kontrol edin.",
        "sudo"
      );
    }
    return result;
  }

  return {
    fingerprint: seenFingerprint,
    remoteAddress: address,
    firstSeen,
    exec,
    sudo,
    close: () => {
      try {
        client.end();
      } catch {
        // bağlantı zaten kapalıysa yut
      }
    },
  };
}

/** Bağlantıyı açar, işi çalıştırır ve her durumda kapatır. */
export async function withSsh<T>(
  target: SshTarget,
  handler: (connection: SshConnection) => Promise<T>
): Promise<T> {
  const connection = await connectSsh(target);
  try {
    return await handler(connection);
  } finally {
    connection.close();
  }
}

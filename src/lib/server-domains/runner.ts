import dns from "node:dns/promises";
import {
  buildRedirectVhostWithSsl,
  buildVhost,
  extractSslPaths,
  parseServerBlocks,
  replaceServerNames,
  retargetLogPaths,
  stripCertbotArtifacts,
} from "@/lib/nginx/config";
import { shellQuote } from "@/lib/ssh/shell-quote";
import { SshError, type SshConnection } from "@/lib/ssh/client";
import type { OperationContext, StepKey } from "./steps";

/**
 * Adımların sunucu üzerindeki gerçek işleri.
 *
 * Tasarım kuralları:
 * - Her adım kendi başına yeniden çalıştırılabilir olmalıdır (ağ koparsa tekrar denenir).
 * - `preflight` sunucuya hiçbir şey yazmaz; yalnız okur.
 * - Yazan her adım öncesinde `backup` çalışmış olur; hata durumunda rollback() bu
 *   yedeği kullanarak yalnızca bu işlemin dokunduğu dosyaları geri alır.
 */

export const DEFAULT_SITES_AVAILABLE = "/etc/nginx/sites-available";
export const BACKUP_ROOT = "/var/backups/ops-center-domains";

/** Certbot'a tanınan süre; DNS doğrulaması ve ACME turu yavaş olabilir. */
const CERTBOT_TIMEOUT_MS = 240_000;
/** Sunucuya yazılabilecek azami vhost boyutu. */
const MAX_VHOST_BYTES = 512 * 1024;

export class StepError extends Error {
  constructor(
    message: string,
    /** Kullanıcıya gösterilecek ek teknik ayrıntı (komut çıktısı vb.). */
    readonly detail?: string
  ) {
    super(message);
    this.name = "StepError";
  }
}

export type OperationRecord = {
  id: string;
  type: "add" | "change";
  new_domain: string;
  old_domain: string | null;
  include_www: boolean;
  enable_ssl: boolean;
  ssl_email: string | null;
  redirect_old: boolean;
  document_root: string | null;
  proxy_pass: string | null;
  backup_path: string | null;
};

export type StepRunContext = {
  operation: OperationRecord;
  connection: SshConnection;
  context: OperationContext;
  sitesAvailable: string;
  sitesEnabled: string;
  log: (level: "info" | "warn" | "error", message: string) => void;
};

export type StepResult = {
  /** Kullanıcıya gösterilen tek satırlık sonuç. */
  message: string;
  /** Sonraki adımlara taşınacak bağlam güncellemesi. */
  context?: Partial<OperationContext>;
  /** İşlem kaydına yazılacak diğer alanlar. */
  patch?: { backup_path?: string };
};

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

/** Yapılandırılmış dizinden sites-enabled karşılığını türetir. */
export function sitesEnabledFor(sitesAvailable: string): string {
  const parent = sitesAvailable.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
  return `${parent || "/etc/nginx"}/sites-enabled`;
}

/** `nginx_sites_path` alanının kabuğa güvenle girebileceğini doğrular. */
export function assertSafePath(value: string, label: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed.startsWith("/") || !/^\/[A-Za-z0-9._\-/]+$/.test(trimmed)) {
    throw new StepError(`${label} geçerli bir mutlak yol değil: ${value}`);
  }
  if (trimmed.split("/").includes("..")) {
    throw new StepError(`${label} ".." içeremez.`);
  }
  return trimmed;
}

/** Alan adını grep için düzenli ifadeye çevirir (nokta literal olmalı). */
function domainPattern(domain: string): string {
  const escaped = domain.replaceAll(".", "\\.");
  return `^[[:space:]]*server_name[[:space:]][^;]*(^|[[:space:]])${escaped}([[:space:]]|;)`;
}

/** Komutu çalıştırır; sıfır olmayan çıkışta adım hatası fırlatır. */
async function run(
  ctx: StepRunContext,
  command: string,
  options: { sudo?: boolean; timeoutMs?: number; failMessage: string }
): Promise<string> {
  const exec = options.sudo ? ctx.connection.sudo : ctx.connection.exec;
  const result = await exec(command, { timeoutMs: options.timeoutMs });
  if (result.code !== 0) {
    const detail = [result.stdout, result.stderr]
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 4_000);
    throw new StepError(options.failMessage, detail || undefined);
  }
  return result.stdout;
}

/** Sıfır olmayan çıkışı hata saymayan sessiz çalıştırma. */
async function tryRun(
  ctx: StepRunContext,
  command: string,
  sudo = false
): Promise<{ code: number; stdout: string; stderr: string }> {
  const exec = sudo ? ctx.connection.sudo : ctx.connection.exec;
  return exec(command);
}

/** Dosyayı base64 üzerinden yazar: içerik hiçbir aşamada kabuk tarafından yorumlanmaz. */
async function writeRemoteFile(
  ctx: StepRunContext,
  path: string,
  content: string
): Promise<void> {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  if (encoded.length > MAX_VHOST_BYTES) {
    throw new StepError("Yazılacak yapılandırma dosyası beklenenden çok büyük.");
  }
  await run(
    ctx,
    `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)}`,
    { sudo: true, failMessage: `Dosya yazılamadı: ${path}` }
  );
}

async function readRemoteFile(ctx: StepRunContext, path: string): Promise<string> {
  return run(ctx, `cat ${shellQuote(path)}`, {
    sudo: true,
    failMessage: `Dosya okunamadı: ${path}`,
  });
}

/** `nginx -t` ile sözdizimini doğrular; hatalıysa çıktıyı kullanıcıya taşır. */
async function testNginx(ctx: StepRunContext): Promise<void> {
  const result = await tryRun(ctx, "nginx -t", true);
  if (result.code !== 0) {
    throw new StepError(
      "Nginx yapılandırma testi başarısız oldu; değişiklik uygulanmadı.",
      `${result.stdout}\n${result.stderr}`.trim().slice(0, 4_000)
    );
  }
}

/** Nginx'i kesintisiz yeniden yükler; systemd yoksa doğrudan sinyale düşer. */
async function reloadNginx(ctx: StepRunContext): Promise<void> {
  const systemd = await tryRun(ctx, "systemctl reload nginx", true);
  if (systemd.code === 0) return;
  const direct = await tryRun(ctx, "nginx -s reload", true);
  if (direct.code !== 0) {
    throw new StepError(
      "Nginx yeniden yüklenemedi.",
      `${systemd.stderr}\n${direct.stderr}`.trim().slice(0, 4_000)
    );
  }
}

/** İşlemin dokunduğu server_name listesi. */
export function serverNamesFor(operation: OperationRecord): string[] {
  return operation.include_www
    ? [operation.new_domain, `www.${operation.new_domain}`]
    : [operation.new_domain];
}

async function resolveIps(hostname: string): Promise<string[]> {
  const results = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);
  return results.flatMap((entry) =>
    entry.status === "fulfilled" ? entry.value : []
  );
}

// ─── Adımlar ─────────────────────────────────────────────────────────────────

async function preflight(ctx: StepRunContext): Promise<StepResult> {
  const { operation } = ctx;
  const warnings: string[] = [];

  const nginxPath = await tryRun(ctx, "command -v nginx");
  if (nginxPath.code !== 0) {
    throw new StepError(
      "Sunucuda nginx bulunamadı. Bu ekran nginx tabanlı sunucular içindir."
    );
  }

  const version = await tryRun(ctx, "nginx -v");
  const versionText = `${version.stdout}${version.stderr}`.trim();
  ctx.log("info", versionText || "nginx sürümü okunamadı.");

  const dirs = await tryRun(
    ctx,
    `test -d ${shellQuote(ctx.sitesAvailable)} && test -d ${shellQuote(ctx.sitesEnabled)}`,
    true
  );
  if (dirs.code !== 0) {
    throw new StepError(
      `Sunucuda ${ctx.sitesAvailable} / ${ctx.sitesEnabled} dizinleri bulunamadı. ` +
        "Sunucu kaydındaki 'nginx vhost dizini' alanından doğru yolu girin."
    );
  }

  if (operation.enable_ssl) {
    const certbot = await tryRun(ctx, "command -v certbot");
    if (certbot.code !== 0) {
      throw new StepError(
        "Sunucuda certbot bulunamadı. SSL'i kapatıp devam edebilir veya sunucuya certbot kurabilirsiniz " +
          "(Debian/Ubuntu: apt install certbot python3-certbot-nginx)."
      );
    }
  }

  // Yeni alan adı başka bir vhost'ta tanımlıysa nginx çakışma uyarısı verir.
  const conflict = await tryRun(
    ctx,
    `grep -rlE ${shellQuote(domainPattern(operation.new_domain))} ${shellQuote(ctx.sitesAvailable)}`,
    true
  );
  const conflictFiles = conflict.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (conflictFiles.length > 0) {
    throw new StepError(
      `${operation.new_domain} zaten şu dosyada tanımlı: ${conflictFiles.join(", ")}. ` +
        "Önce mevcut tanımı kaldırın veya farklı bir alan adı seçin."
    );
  }

  let sourceVhostPath: string | undefined;
  let documentRoot = operation.document_root ?? undefined;
  let proxyPass = operation.proxy_pass ?? undefined;

  if (operation.type === "change") {
    const oldDomain = operation.old_domain;
    if (!oldDomain) throw new StepError("Eski alan adı kaydı eksik.");

    const found = await tryRun(
      ctx,
      `grep -rlE ${shellQuote(domainPattern(oldDomain))} ${shellQuote(ctx.sitesAvailable)}`,
      true
    );
    const files = found.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (files.length === 0) {
      throw new StepError(
        `${oldDomain} için ${ctx.sitesAvailable} altında bir site tanımı bulunamadı. ` +
          "Alan adı bu sunucuda barınmıyor olabilir."
      );
    }
    if (files.length > 1) {
      throw new StepError(
        `${oldDomain} birden fazla dosyada tanımlı: ${files.join(", ")}. ` +
          "Hangisinin geçerli olduğu belirsiz olduğundan işlem güvenli değil; önce dosyaları sadeleştirin."
      );
    }
    sourceVhostPath = files[0];
    ctx.log("info", `Kaynak site tanımı: ${sourceVhostPath}`);

    const content = await readRemoteFile(ctx, sourceVhostPath);
    const blocks = parseServerBlocks(content);
    const httpBlock = blocks.find((block) => !block.isSsl) ?? blocks[0];
    if (!httpBlock) {
      throw new StepError(`${sourceVhostPath} içinde server bloğu bulunamadı.`);
    }
    documentRoot = documentRoot ?? httpBlock.root ?? undefined;
    proxyPass = proxyPass ?? httpBlock.proxyPass ?? undefined;
    ctx.log(
      "info",
      proxyPass
        ? `Mevcut yapılandırma ters vekil kullanıyor: ${proxyPass}`
        : `Mevcut site kök dizini: ${documentRoot ?? "belirlenemedi"}`
    );
  }

  // PHP-FPM soketi yalnız yeni site şablonu için gerekir.
  let phpFpmSocket: string | undefined;
  if (operation.type === "add" && !proxyPass) {
    const socket = await tryRun(ctx, "ls -1 /run/php/*.sock 2>/dev/null | tail -1");
    const candidate = socket.stdout.trim();
    if (candidate && /^\/[A-Za-z0-9._\-/]+$/.test(candidate)) {
      phpFpmSocket = candidate;
      ctx.log("info", `PHP-FPM soketi bulundu: ${candidate}`);
    }
  }

  // DNS: alan adı gerçekten bu sunucuya bakıyor mu? Bakmıyorsa Certbot kesin başarısız olur.
  const serverIp = ctx.connection.remoteAddress;
  const targetIps = await resolveIps(operation.new_domain);
  if (targetIps.length === 0) {
    const message = `${operation.new_domain} DNS üzerinden çözümlenemiyor.`;
    if (operation.enable_ssl) {
      throw new StepError(
        `${message} Let's Encrypt doğrulaması için alan adının A kaydı ${serverIp} olmalıdır. ` +
          "DNS yayıldıktan sonra tekrar deneyin."
      );
    }
    warnings.push(message);
  } else if (!targetIps.includes(serverIp)) {
    const message = `${operation.new_domain} şu adrese bakıyor: ${targetIps.join(", ")} — bu sunucu ise ${serverIp}.`;
    if (operation.enable_ssl) {
      throw new StepError(
        `${message} Sertifika alınamaz; önce A kaydını ${serverIp} olarak güncelleyin.`
      );
    }
    warnings.push(message);
  } else {
    ctx.log("info", `DNS doğrulandı: ${operation.new_domain} → ${serverIp}`);
  }

  // www kaydı yoksa sertifikaya dahil etmek tüm isteği başarısız kılar.
  let wwwResolvable = false;
  if (operation.include_www) {
    const wwwIps = await resolveIps(`www.${operation.new_domain}`);
    wwwResolvable = wwwIps.includes(serverIp);
    if (!wwwResolvable) {
      warnings.push(
        `www.${operation.new_domain} bu sunucuya çözümlenmiyor; sertifikaya dahil edilmeyecek ` +
          "(site tanımında yer almaya devam eder)."
      );
    }
  }

  return {
    message:
      warnings.length > 0
        ? `Ön kontrol tamamlandı, ${warnings.length} uyarı var.`
        : "Ön kontrol tamamlandı; engel yok.",
    context: {
      sourceVhostPath,
      sitesAvailable: ctx.sitesAvailable,
      sitesEnabled: ctx.sitesEnabled,
      phpFpmSocket,
      serverIps: [serverIp],
      warnings,
      wwwResolvable,
      documentRoot,
      proxyPass,
    } as OperationContext,
  };
}

async function backup(ctx: StepRunContext): Promise<StepResult> {
  const dir = `${BACKUP_ROOT}/${ctx.operation.id}`;
  await run(
    ctx,
    [
      `mkdir -p ${shellQuote(`${dir}/sites-available`)} ${shellQuote(`${dir}/sites-enabled`)}`,
      `chmod 700 ${shellQuote(BACKUP_ROOT)} ${shellQuote(dir)}`,
      `cp -a ${shellQuote(`${ctx.sitesAvailable}/.`)} ${shellQuote(`${dir}/sites-available/`)}`,
      // -a sembolik bağlantıları hedefe çözmeden kopyalar; enabled dizini bağlantılardan oluşur.
      `cp -a ${shellQuote(`${ctx.sitesEnabled}/.`)} ${shellQuote(`${dir}/sites-enabled/`)}`,
    ].join(" && "),
    { sudo: true, failMessage: "Nginx yapılandırması yedeklenemedi." }
  );

  ctx.log("info", `Yedek dizini: ${dir}`);
  return {
    message: `Yapılandırma ${dir} altına yedeklendi.`,
    patch: { backup_path: dir },
  };
}

async function writeVhost(ctx: StepRunContext): Promise<StepResult> {
  const { operation, context } = ctx;
  const targetPath = `${ctx.sitesAvailable}/${operation.new_domain}`;
  const names = serverNamesFor(operation);

  let content: string;
  if (operation.type === "change") {
    const sourcePath = context.sourceVhostPath;
    if (!sourcePath) {
      throw new StepError("Kaynak site tanımı bulunamadı; ön kontrolü tekrar çalıştırın.");
    }
    const original = await readRemoteFile(ctx, sourcePath);
    const stripped = stripCertbotArtifacts(original);
    if (!stripped.includes("server")) {
      throw new StepError(
        "Kaynak dosyada HTTP sunucu bloğu kalmadı; site yalnızca HTTPS için tanımlanmış olabilir."
      );
    }
    const renamed = replaceServerNames(stripped, names);
    content = retargetLogPaths(renamed, operation.old_domain ?? "", operation.new_domain);
    ctx.log("info", "Mevcut yapılandırma kopyalandı; yalnız alan adı ve log yolları değişti.");
  } else {
    const documentRoot = operation.document_root ?? context.documentRoot ?? null;
    const proxyPass = operation.proxy_pass ?? context.proxyPass ?? null;
    if (!documentRoot && !proxyPass) {
      throw new StepError("Yeni site için kök dizin veya vekil hedefi belirlenmedi.");
    }
    content = buildVhost({
      serverNames: names,
      documentRoot,
      proxyPass,
      phpFpmSocket: context.phpFpmSocket ?? null,
      operationId: operation.id,
    });

    if (documentRoot) {
      const exists = await tryRun(ctx, `test -d ${shellQuote(documentRoot)}`, true);
      if (exists.code !== 0) {
        await run(ctx, `mkdir -p ${shellQuote(documentRoot)}`, {
          sudo: true,
          failMessage: `Site kök dizini oluşturulamadı: ${documentRoot}`,
        });
        ctx.log("warn", `${documentRoot} yoktu, oluşturuldu. İçerik yüklemeyi unutmayın.`);
      }
    }
  }

  await writeRemoteFile(ctx, targetPath, content);
  ctx.log("info", `Site tanımı yazıldı: ${targetPath}`);

  return {
    message: `${targetPath} oluşturuldu.`,
    context: { targetVhostPath: targetPath },
  };
}

async function enable(ctx: StepRunContext): Promise<StepResult> {
  const targetPath =
    ctx.context.targetVhostPath ?? `${ctx.sitesAvailable}/${ctx.operation.new_domain}`;
  const linkPath = `${ctx.sitesEnabled}/${ctx.operation.new_domain}`;

  await run(ctx, `ln -sfn ${shellQuote(targetPath)} ${shellQuote(linkPath)}`, {
    sudo: true,
    failMessage: "Site etkinleştirilemedi.",
  });

  try {
    await testNginx(ctx);
  } catch (error) {
    // Hatalı yapılandırma yayına çıkmasın: bağlantıyı hemen geri al.
    await tryRun(ctx, `rm -f ${shellQuote(linkPath)}`, true);
    ctx.log("error", "nginx -t başarısız; site yeniden pasife alındı.");
    throw error;
  }

  await reloadNginx(ctx);
  ctx.log("info", "nginx yeniden yüklendi.");

  return {
    message: `${ctx.operation.new_domain} yayına alındı (HTTP).`,
    context: { nginxReloaded: true },
  };
}

async function ssl(ctx: StepRunContext): Promise<StepResult> {
  const { operation, context } = ctx;
  const certDomains = [operation.new_domain];
  if (operation.include_www && context.wwwResolvable) {
    certDomains.push(`www.${operation.new_domain}`);
  }

  const args = [
    "certbot",
    "--nginx",
    "--non-interactive",
    "--agree-tos",
    "--keep-until-expiring",
    "--redirect",
    ...certDomains.flatMap((domain) => ["-d", shellQuote(domain)]),
  ];
  args.push(
    operation.ssl_email ? `-m ${shellQuote(operation.ssl_email)}` : "--register-unsafely-without-email"
  );

  const result = await tryRun(ctx, args.join(" "), true);
  if (result.code !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`.trim();
    throw new StepError(
      "Let's Encrypt sertifikası alınamadı. Alan adının bu sunucuya çözümlendiğinden ve 80/443 portlarının açık olduğundan emin olun.",
      detail.slice(0, 4_000)
    );
  }
  ctx.log("info", `Sertifika alındı: ${certDomains.join(", ")}`);

  await testNginx(ctx);
  await reloadNginx(ctx);

  return {
    message: `HTTPS etkin (${certDomains.join(", ")}).`,
    context: { nginxReloaded: true },
  };
}

async function verify(ctx: StepRunContext): Promise<StepResult> {
  const { operation } = ctx;
  const scheme = operation.enable_ssl ? "https" : "http";
  const url = `${scheme}://${operation.new_domain}/`;

  const response = await tryRun(
    ctx,
    `curl -sS -o /dev/null -w '%{http_code}' --max-time 20 ${shellQuote(url)}`
  );
  const status = response.stdout.trim();
  if (response.code !== 0 || !/^\d{3}$/.test(status)) {
    throw new StepError(
      `${url} adresine sunucu üzerinden erişilemedi.`,
      `${response.stdout}\n${response.stderr}`.trim().slice(0, 2_000)
    );
  }
  ctx.log("info", `${url} → HTTP ${status}`);

  let sslExpiresAt: string | undefined;
  if (operation.enable_ssl) {
    // Gerçekten sunulan sertifikayı okur; certbot'un dosya adı tahminine güvenilmez.
    const cert = await tryRun(
      ctx,
      `echo | openssl s_client -connect 127.0.0.1:443 -servername ${shellQuote(operation.new_domain)} 2>/dev/null | openssl x509 -noout -enddate`
    );
    const match = /notAfter=(.+)/.exec(cert.stdout);
    if (match) {
      const parsed = new Date(match[1].trim());
      if (!Number.isNaN(parsed.getTime())) {
        sslExpiresAt = parsed.toISOString();
        ctx.log("info", `Sertifika bitişi: ${parsed.toISOString().slice(0, 10)}`);
      }
    }
    if (!sslExpiresAt) {
      ctx.log("warn", "Sertifika bitiş tarihi okunamadı; panel kaydına yazılmayacak.");
    }
  }

  const statusCode = Number(status);
  if (statusCode >= 500) {
    throw new StepError(
      `Site ${statusCode} döndürüyor. Nginx ayakta ama uygulama hata veriyor; ` +
        "site içeriğini veya uygulama servisini kontrol edin."
    );
  }

  return {
    message: `Site yanıt veriyor (HTTP ${status}).`,
    context: { sslExpiresAt },
  };
}

async function deactivateOld(ctx: StepRunContext): Promise<StepResult> {
  const { operation, context } = ctx;
  const oldDomain = operation.old_domain;
  const sourcePath = context.sourceVhostPath;
  if (!oldDomain || !sourcePath) {
    throw new StepError("Eski site tanımı bilinmiyor; ön kontrolü tekrar çalıştırın.");
  }

  // sites-enabled altında bu dosyaya işaret eden tüm bağlantılar kaldırılır.
  const fileName = sourcePath.replace(/^.*\//, "");
  const linkPath = `${ctx.sitesEnabled}/${fileName}`;
  await run(ctx, `rm -f ${shellQuote(linkPath)}`, {
    sudo: true,
    failMessage: "Eski site bağlantısı kaldırılamadı.",
  });
  ctx.log("info", `Eski site pasife alındı: ${linkPath}`);

  let redirectPath: string | undefined;
  if (operation.redirect_old) {
    const original = await readRemoteFile(ctx, sourcePath);
    const sslPaths = extractSslPaths(original);
    if (!sslPaths) {
      ctx.log(
        "warn",
        "Eski sitede sertifika yolu bulunamadı; yönlendirme yalnız HTTP üzerinden çalışacak."
      );
    }

    const oldNames = operation.include_www ? [oldDomain, `www.${oldDomain}`] : [oldDomain];
    redirectPath = `${ctx.sitesAvailable}/${oldDomain}.redirect`;
    await writeRemoteFile(
      ctx,
      redirectPath,
      buildRedirectVhostWithSsl(oldNames, operation.new_domain, operation.id, sslPaths)
    );
    await run(
      ctx,
      `ln -sfn ${shellQuote(redirectPath)} ${shellQuote(`${ctx.sitesEnabled}/${oldDomain}.redirect`)}`,
      { sudo: true, failMessage: "Yönlendirme sitesi etkinleştirilemedi." }
    );
    ctx.log("info", `${oldDomain} → ${operation.new_domain} yönlendirmesi kuruldu.`);
  }

  try {
    await testNginx(ctx);
  } catch (error) {
    // Eski siteyi geri aç: yayında boşluk oluşmasın.
    await tryRun(ctx, `ln -sfn ${shellQuote(sourcePath)} ${shellQuote(linkPath)}`, true);
    if (redirectPath) {
      await tryRun(
        ctx,
        `rm -f ${shellQuote(`${ctx.sitesEnabled}/${oldDomain}.redirect`)}`,
        true
      );
    }
    throw error;
  }

  await reloadNginx(ctx);

  return {
    message: operation.redirect_old
      ? `${oldDomain} pasife alındı ve ${operation.new_domain} adresine yönlendirildi.`
      : `${oldDomain} pasife alındı.`,
    context: { redirectVhostPath: redirectPath, nginxReloaded: true },
  };
}

const HANDLERS: Partial<Record<StepKey, (ctx: StepRunContext) => Promise<StepResult>>> = {
  preflight,
  backup,
  write_vhost: writeVhost,
  enable,
  ssl,
  verify,
  deactivate_old: deactivateOld,
};

/** Adım için gereken azami süre; UI ve serverless sınırı buna göre planlanır. */
export function timeoutForStep(step: StepKey): number {
  if (step === "ssl") return CERTBOT_TIMEOUT_MS;
  if (step === "backup") return 120_000;
  return 60_000;
}

/** Sunucuda çalışan adımları yürütür; `finalize` SSH gerektirmediğinden burada yer almaz. */
export async function runStep(
  step: StepKey,
  ctx: StepRunContext
): Promise<StepResult> {
  const handler = HANDLERS[step];
  if (!handler) {
    throw new StepError(`Bilinmeyen adım: ${step}`);
  }
  try {
    return await handler(ctx);
  } catch (error) {
    if (error instanceof StepError) throw error;
    if (error instanceof SshError) {
      throw new StepError(error.message);
    }
    throw error;
  }
}

/**
 * Yalnız bu işlemin dokunduğu dosyaları yedeğinden geri alır.
 * Yedeğin tamamını kopyalamak, işlem sırasında elle yapılmış başka değişiklikleri
 * de silerdi; bu yüzden geri alma cerrahi tutulur.
 */
export async function rollback(ctx: StepRunContext): Promise<string[]> {
  const { operation, context } = ctx;
  const actions: string[] = [];
  const backupDir = operation.backup_path;

  const newLink = `${ctx.sitesEnabled}/${operation.new_domain}`;
  const newFile = `${ctx.sitesAvailable}/${operation.new_domain}`;
  await tryRun(ctx, `rm -f ${shellQuote(newLink)}`, true);
  await tryRun(ctx, `rm -f ${shellQuote(newFile)}`, true);
  actions.push(`${operation.new_domain} site tanımı ve bağlantısı kaldırıldı`);

  if (operation.old_domain) {
    const redirectLink = `${ctx.sitesEnabled}/${operation.old_domain}.redirect`;
    const redirectFile = `${ctx.sitesAvailable}/${operation.old_domain}.redirect`;
    await tryRun(ctx, `rm -f ${shellQuote(redirectLink)}`, true);
    await tryRun(ctx, `rm -f ${shellQuote(redirectFile)}`, true);
  }

  // Eski site dosyasını ve bağlantısını yedekten tazele.
  if (backupDir && context.sourceVhostPath) {
    const fileName = context.sourceVhostPath.replace(/^.*\//, "");
    const backupFile = `${backupDir}/sites-available/${fileName}`;
    const restore = await tryRun(
      ctx,
      `test -f ${shellQuote(backupFile)} && cp -a ${shellQuote(backupFile)} ${shellQuote(context.sourceVhostPath)}`,
      true
    );
    if (restore.code === 0) {
      actions.push(`${fileName} yedekten geri yüklendi`);
    }
    await tryRun(
      ctx,
      `ln -sfn ${shellQuote(context.sourceVhostPath)} ${shellQuote(`${ctx.sitesEnabled}/${fileName}`)}`,
      true
    );
    actions.push(`${fileName} yeniden yayına alındı`);
  }

  const test = await tryRun(ctx, "nginx -t", true);
  if (test.code !== 0) {
    throw new StepError(
      "Geri alma sonrası nginx testi başarısız. Sunucuya elle bakmanız gerekiyor.",
      `${test.stdout}\n${test.stderr}`.trim().slice(0, 4_000) +
        (backupDir ? `\n\nYedek dizini: ${backupDir}` : "")
    );
  }
  await reloadNginx(ctx);
  actions.push("nginx yeniden yüklendi");

  return actions;
}

/**
 * Nginx vhost dosyalarını okuma/üretme yardımcıları.
 *
 * Domain değiştirme işinde sıfırdan vhost yazmak yerine mevcut dosya kopyalanır:
 * PHP-FPM, ters vekil, önbellek, güvenlik başlıkları gibi elle eklenmiş her şey
 * korunur ve yalnızca `server_name` ile Certbot'un ürettiği SSL parçaları değişir.
 */

export type ServerBlock = {
  /** Bloğun tamamı ("server { ... }"). */
  text: string;
  /** Blok içindeki server_name değerleri. */
  serverNames: string[];
  /** listen satırlarında ssl/443 geçiyor mu? */
  isSsl: boolean;
  /** root direktifinin değeri. */
  root: string | null;
  /** İlk proxy_pass direktifinin değeri. */
  proxyPass: string | null;
};

/** Yorum satırlarını ve string literal'leri hesaba katan basit blok ayırıcı. */
function findBlocks(content: string, keyword: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const pattern = new RegExp(`(^|[\\s;}])${keyword}\\s*\\{`, "g");

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const openIndex = content.indexOf("{", match.index);
    if (openIndex === -1) break;

    // Blok başlangıcı yorum içindeyse atla.
    const lineStart = content.lastIndexOf("\n", match.index) + 1;
    const commentIndex = content.indexOf("#", lineStart);
    if (commentIndex !== -1 && commentIndex < match.index) {
      pattern.lastIndex = openIndex + 1;
      continue;
    }

    let depth = 0;
    let end = -1;
    for (let i = openIndex; i < content.length; i += 1) {
      const char = content[i];
      if (char === "#") {
        const newline = content.indexOf("\n", i);
        i = newline === -1 ? content.length : newline;
        continue;
      }
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) break;

    const start = match.index + (match[1] ? match[1].length : 0);
    ranges.push([start, end]);
    pattern.lastIndex = end;
  }
  return ranges;
}

/** Bir blok metnindeki (iç içe bloklar hariç) direktif değerini döndürür. */
function directiveValue(block: string, name: string): string | null {
  const pattern = new RegExp(`^[ \\t]*${name}[ \\t]+([^;\\n]+);`, "m");
  const match = pattern.exec(stripComments(block));
  return match ? match[1].trim() : null;
}

function stripComments(text: string): string {
  return text.replace(/(^|\s)#[^\n]*/g, "$1");
}

export function parseServerBlocks(content: string): ServerBlock[] {
  return findBlocks(content, "server").map(([start, end]) => {
    const text = content.slice(start, end);
    const clean = stripComments(text);
    const serverNames = [...clean.matchAll(/^[ \t]*server_name[ \t]+([^;\n]+);/gm)]
      .flatMap((match) => match[1].trim().split(/\s+/))
      .filter(Boolean);
    const listens = [...clean.matchAll(/^[ \t]*listen[ \t]+([^;\n]+);/gm)].map((m) =>
      m[1].trim()
    );

    return {
      text,
      serverNames,
      isSsl:
        listens.some((line) => /\bssl\b/.test(line) || /(^|[\s:])443(\s|$)/.test(line)) ||
        /^[ \t]*ssl_certificate[ \t]/m.test(clean),
      root: directiveValue(text, "root"),
      proxyPass: directiveValue(text, "proxy_pass"),
    };
  });
}

/**
 * Bir server bloğundan Certbot'un eklediği satırları çıkarır.
 *
 * Certbot, ayrı bir SSL bloğu yaratmak yerine sitenin *kendi* bloğuna `listen 443 ssl`
 * ve `ssl_*` satırlarını enjekte eder. Bu yüzden "SSL içeren bloğu sil" yaklaşımı
 * sitenin tüm yapılandırmasını silmek anlamına gelir — blok silinmez, temizlenir.
 */
function cleanServerBlock(block: string): string {
  return (
    block
      // certbot'un blok başına eklediği koşullu HTTPS yönlendirmesi
      .replace(/^[ \t]*if\s*\(\s*\$host\s*=[^)]*\)\s*\{[^{}]*\}[^\n]*\n?/gm, "")
      // yalnız SSL/443 dinleyen satırlar; düz HTTP listen satırları korunur
      .replace(/^[ \t]*listen[ \t]+[^;\n]*;[^\n]*\n?/gm, (line) =>
        /\bssl\b/.test(line) || /(^|[\s:])443(\s|;)/.test(line) ? "" : line
      )
      .replace(
        /^[ \t]*(ssl_certificate|ssl_certificate_key|ssl_dhparam|ssl_protocols|ssl_ciphers|ssl_session_cache|ssl_session_timeout|ssl_stapling|ssl_stapling_verify|ssl_trusted_certificate)[ \t]+[^;\n]+;[^\n]*\n?/gm,
        ""
      )
      .replace(
        /^[ \t]*include[ \t]+[^;\n]*options-ssl-nginx\.conf[^;\n]*;[^\n]*\n?/gm,
        ""
      )
      .replace(/^[ \t]*#[ \t]*managed by Certbot[^\n]*\n?/gm, "")
      .replace(/[ \t]*#[ \t]*managed by Certbot[ \t]*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
  );
}

/**
 * Blokta gerçek bir site yapılandırması kaldı mı?
 * Certbot'un ürettiği "80'de dinle ve 301/404 dön" kabukları bu testi geçemez ve atılır.
 */
function hasSiteConfiguration(block: string): boolean {
  const clean = stripComments(block);
  return /^[ \t]*(location|root|proxy_pass|fastcgi_pass|alias|try_files|index)\b/m.test(
    clean
  );
}

/** Blokta hiç `listen` kalmadıysa HTTP dinleme satırlarını geri koyar. */
function ensureHttpListen(block: string): string {
  if (/^[ \t]*listen[ \t]/m.test(stripComments(block))) return block;
  return block.replace(
    /^([ \t]*)server_name[ \t]/m,
    (match, indent: string) => `${indent}listen 80;\n${indent}listen [::]:80;\n${match}`
  );
}

/**
 * Certbot'un dosyaya eklediği izleri temizler ve geriye saf HTTP yapılandırması bırakır.
 * Sertifikayı yeni alan adı için Certbot yeniden ekleyecektir.
 */
export function stripCertbotArtifacts(content: string): string {
  const blocks = parseServerBlocks(content);
  let result = content;

  // Sondan başa doğru işlenir ki önceki blokların konumları kaymasın.
  for (const block of [...blocks].reverse()) {
    const cleaned = cleanServerBlock(block.text);
    result = result.replace(
      block.text,
      hasSiteConfiguration(cleaned) ? ensureHttpListen(cleaned) : ""
    );
  }

  return result.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Bloklardaki server_name satırlarını verilen adlarla değiştirir. */
export function replaceServerNames(content: string, names: readonly string[]): string {
  const replacement = names.join(" ");
  let replaced = false;
  const result = content.replace(
    /^([ \t]*)server_name[ \t]+[^;\n]+;/gm,
    (_match, indent: string) => {
      replaced = true;
      return `${indent}server_name ${replacement};`;
    }
  );
  if (!replaced) {
    throw new Error("Kaynak vhost dosyasında server_name direktifi bulunamadı.");
  }
  return result;
}

/**
 * Bir vhost dosyasındaki access/error log yollarını yeni alan adına taşır.
 * Eski ve yeni site aynı log dosyasına yazmasın diye yapılır; log satırı yoksa dokunulmaz.
 */
export function retargetLogPaths(
  content: string,
  oldDomain: string,
  newDomain: string
): string {
  if (!oldDomain) return content;
  return content.replace(
    /^([ \t]*)(access_log|error_log)([ \t]+)([^;\n]+);/gm,
    (match, indent: string, directive: string, space: string, value: string) => {
      if (!value.includes(oldDomain)) return match;
      return `${indent}${directive}${space}${value.split(oldDomain).join(newDomain)};`;
    }
  );
}

export type VhostTemplateInput = {
  /** server_name'e yazılacak adlar (ilk sıradaki birincil). */
  serverNames: readonly string[];
  /** Statik/PHP site kök dizini. */
  documentRoot?: string | null;
  /** Ters vekil hedefi; doluysa root yerine proxy kullanılır. */
  proxyPass?: string | null;
  /** Sunucuda bulunan PHP-FPM soketi (varsa PHP location bloğu eklenir). */
  phpFpmSocket?: string | null;
  /** Dosya başlığına yazılan işlem kimliği. */
  operationId: string;
};

/** Yeni domain ekleme senaryosu için sıfırdan HTTP vhost üretir. */
export function buildVhost(input: VhostTemplateInput): string {
  const primary = input.serverNames[0];
  const header = [
    "# Ops Center tarafından oluşturuldu — elle düzenlediğinizde panel bu dosyayı",
    "# bir sonraki işlemde yedekleyip üzerine yazabilir.",
    `# domain: ${primary}`,
    `# islem : ${input.operationId}`,
    "",
  ].join("\n");

  const body: string[] = [
    "server {",
    "    listen 80;",
    "    listen [::]:80;",
    `    server_name ${input.serverNames.join(" ")};`,
    "",
    `    access_log /var/log/nginx/${primary}.access.log;`,
    `    error_log  /var/log/nginx/${primary}.error.log;`,
    "",
  ];

  if (input.proxyPass) {
    body.push(
      "    location / {",
      `        proxy_pass ${input.proxyPass};`,
      "        proxy_http_version 1.1;",
      "        proxy_set_header Upgrade $http_upgrade;",
      '        proxy_set_header Connection "upgrade";',
      "        proxy_set_header Host $host;",
      "        proxy_set_header X-Real-IP $remote_addr;",
      "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
      "        proxy_set_header X-Forwarded-Proto $scheme;",
      "        proxy_read_timeout 60s;",
      "    }"
    );
  } else {
    body.push(
      `    root ${input.documentRoot};`,
      input.phpFpmSocket ? "    index index.php index.html;" : "    index index.html;",
      "",
      "    location / {",
      input.phpFpmSocket
        ? "        try_files $uri $uri/ /index.php?$query_string;"
        : "        try_files $uri $uri/ =404;",
      "    }"
    );

    if (input.phpFpmSocket) {
      body.push(
        "",
        "    location ~ \\.php$ {",
        "        include snippets/fastcgi-php.conf;",
        `        fastcgi_pass unix:${input.phpFpmSocket};`,
        "    }"
      );
    }

    body.push(
      "",
      "    location ~ /\\.(?!well-known).* {",
      "        deny all;",
      "    }"
    );
  }

  body.push("}", "");
  return `${header}${body.join("\n")}`;
}

/** Eski alan adını yeniye kalıcı olarak yönlendiren küçük bir vhost. */
export function buildRedirectVhost(
  oldNames: readonly string[],
  newDomain: string,
  operationId: string
): string {
  return [
    "# Ops Center: eski alan adını yeni alan adına yönlendirir.",
    `# ${oldNames[0]} -> ${newDomain}`,
    `# islem : ${operationId}`,
    "",
    "server {",
    "    listen 80;",
    "    listen [::]:80;",
    `    server_name ${oldNames.join(" ")};`,
    "",
    "    location ^~ /.well-known/acme-challenge/ {",
    "        root /var/www/html;",
    "    }",
    "",
    "    location / {",
    `        return 301 https://${newDomain}$request_uri;`,
    "    }",
    "}",
    "",
  ].join("\n");
}

export type SslPaths = {
  certificate: string;
  certificateKey: string;
};

/**
 * Certbot'un vhost'a yazdığı sertifika yollarını okur.
 * Eski alan adını HTTPS üzerinden de yönlendirebilmek için gerekir —
 * eski sertifika süresi dolana dek geçerliliğini korur.
 */
export function extractSslPaths(content: string): SslPaths | null {
  const clean = stripComments(content);
  const certificate = /^[ \t]*ssl_certificate[ \t]+([^;\n]+);/m.exec(clean)?.[1]?.trim();
  const certificateKey = /^[ \t]*ssl_certificate_key[ \t]+([^;\n]+);/m
    .exec(clean)?.[1]
    ?.trim();
  if (!certificate || !certificateKey) return null;
  // Yalnız beklenen biçimdeki mutlak yollar kabul edilir; değer komuta girmez ama
  // yazılacak dosyaya gideceği için yine de daraltılır.
  const safe = /^\/[A-Za-z0-9._\-/]+$/;
  if (!safe.test(certificate) || !safe.test(certificateKey)) return null;
  return { certificate, certificateKey };
}

/**
 * Eski alan adını yeniye yönlendirirken HTTPS bacağını da ayakta tutan vhost.
 * Sertifika yolu bilinmiyorsa yalnız HTTP bloğu yazılır.
 */
export function buildRedirectVhostWithSsl(
  oldNames: readonly string[],
  newDomain: string,
  operationId: string,
  ssl: SslPaths | null
): string {
  const base = buildRedirectVhost(oldNames, newDomain, operationId);
  if (!ssl) return base;

  return `${base}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${oldNames.join(" ")};

    ssl_certificate ${ssl.certificate};
    ssl_certificate_key ${ssl.certificateKey};

    location / {
        return 301 https://${newDomain}$request_uri;
    }
}
`;
}

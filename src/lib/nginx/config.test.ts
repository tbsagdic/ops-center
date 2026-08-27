import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRedirectVhostWithSsl,
  buildVhost,
  extractSslPaths,
  parseServerBlocks,
  replaceServerNames,
  retargetLogPaths,
  stripCertbotArtifacts,
} from "./config";

/**
 * Bu testlerin konusu yayındaki bir sitenin yapılandırmasıdır: hata durumunda
 * canlı site bozulur. Örnek girdi, `certbot --nginx` çalıştırılmış gerçek bir
 * vhost dosyasının yapısını birebir taklit eder.
 */

const CERTBOT_VHOST = `server {
    server_name domain100.com www.domain100.com;

    root /var/www/domain100;
    index index.php index.html;

    access_log /var/log/nginx/domain100.com.access.log;
    error_log  /var/log/nginx/domain100.com.error.log;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php8.2-fpm.sock;
    }

    listen [::]:443 ssl ipv6only=on; # managed by Certbot
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/domain100.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/domain100.com/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}

server {
    if ($host = www.domain100.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    if ($host = domain100.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    listen 80;
    listen [::]:80;
    server_name domain100.com www.domain100.com;
    return 404; # managed by Certbot
}
`;

test("server bloklarını ve içindeki direktifleri ayırır", () => {
  const blocks = parseServerBlocks(CERTBOT_VHOST);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].serverNames, ["domain100.com", "www.domain100.com"]);
  assert.equal(blocks[0].root, "/var/www/domain100");
  assert.equal(blocks[0].isSsl, true);
  assert.equal(blocks[1].isSsl, false);
});

test("certbot izlerini temizler ama uygulama yapılandırmasını korur", () => {
  const cleaned = stripCertbotArtifacts(CERTBOT_VHOST);

  // Sertifikaya ait hiçbir şey kalmamalı — yenisini certbot ekleyecek.
  assert.ok(!cleaned.includes("ssl_certificate"));
  assert.ok(!cleaned.includes("listen 443"));
  assert.ok(!cleaned.includes("options-ssl-nginx.conf"));
  assert.ok(!cleaned.includes("$host = domain100.com"));

  // Elle yazılmış her şey yerinde durmalı.
  assert.ok(cleaned.includes("fastcgi_pass unix:/run/php/php8.2-fpm.sock;"));
  assert.ok(cleaned.includes("try_files $uri $uri/ /index.php?$query_string;"));
  assert.ok(cleaned.includes("root /var/www/domain100;"));
  assert.ok(cleaned.includes("server_name domain100.com www.domain100.com;"));
});

test("temizlenen dosyada dengeli sayıda süslü parantez kalır", () => {
  const cleaned = stripCertbotArtifacts(CERTBOT_VHOST);
  const open = (cleaned.match(/\{/g) ?? []).length;
  const close = (cleaned.match(/\}/g) ?? []).length;
  assert.equal(open, close);
});

test("alan adı değişimi uçtan uca doğru dosyayı üretir", () => {
  const cleaned = stripCertbotArtifacts(CERTBOT_VHOST);
  const renamed = replaceServerNames(cleaned, ["domain101.com", "www.domain101.com"]);
  const final = retargetLogPaths(renamed, "domain100.com", "domain101.com");

  assert.ok(final.includes("server_name domain101.com www.domain101.com;"));
  assert.ok(!final.includes("server_name domain100.com"));
  assert.ok(final.includes("/var/log/nginx/domain101.com.access.log"));
  assert.ok(final.includes("/var/log/nginx/domain101.com.error.log"));
  // Kök dizin kasıtlı olarak değişmez: dosyalar aynı yerde durur.
  assert.ok(final.includes("root /var/www/domain100;"));
});

test("regex location bloklarındaki ters bölüyü aynen korur", () => {
  // `location ~ \.php$` içindeki ters bölü düşerse nokta joker karaktere döner ve
  // "dosya.phpx" gibi adresler de PHP olarak yorumlanır — sessiz bir güvenlik açığı.
  const cleaned = stripCertbotArtifacts(CERTBOT_VHOST);
  assert.ok(cleaned.includes("location ~ \\.php$ {"));

  const renamed = replaceServerNames(cleaned, ["yeni.com"]);
  assert.ok(renamed.includes("location ~ \\.php$ {"));
});

test("server_name yoksa sessizce geçmez", () => {
  assert.throws(() => replaceServerNames("server {\n  listen 80;\n}", ["a.com"]));
});

test("yorum içindeki server bloğu gerçek blok sayılmaz", () => {
  const content = `# server { server_name eski.com; }\nserver {\n  server_name yeni.com;\n}\n`;
  const blocks = parseServerBlocks(content);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].serverNames, ["yeni.com"]);
});

test("sertifika yollarını okur", () => {
  const paths = extractSslPaths(CERTBOT_VHOST);
  assert.deepEqual(paths, {
    certificate: "/etc/letsencrypt/live/domain100.com/fullchain.pem",
    certificateKey: "/etc/letsencrypt/live/domain100.com/privkey.pem",
  });
});

test("beklenmedik biçimdeki sertifika yolunu kabul etmez", () => {
  const hostile = `server {
    ssl_certificate /etc/letsencrypt/live/x.com/fullchain.pem";
    ssl_certificate_key /etc/le/$(id).pem;
  }`;
  assert.equal(extractSslPaths(hostile), null);
});

test("yönlendirme vhost'u eski sertifikayla HTTPS bacağını da kurar", () => {
  const vhost = buildRedirectVhostWithSsl(
    ["domain100.com", "www.domain100.com"],
    "domain101.com",
    "op-1",
    {
      certificate: "/etc/letsencrypt/live/domain100.com/fullchain.pem",
      certificateKey: "/etc/letsencrypt/live/domain100.com/privkey.pem",
    }
  );
  assert.ok(vhost.includes("listen 80;"));
  assert.ok(vhost.includes("listen 443 ssl;"));
  assert.ok(vhost.includes("return 301 https://domain101.com$request_uri;"));
  // ACME doğrulaması yönlendirmeye takılmamalı, yoksa eski sertifika yenilenemez.
  assert.ok(vhost.includes("/.well-known/acme-challenge/"));
});

test("sertifika bilinmiyorsa yönlendirme yalnız HTTP bacağını kurar", () => {
  const vhost = buildRedirectVhostWithSsl(["eski.com"], "yeni.com", "op-1", null);
  assert.ok(!vhost.includes("listen 443"));
  assert.ok(vhost.includes("return 301 https://yeni.com$request_uri;"));
});

test("PHP soketi bulunduğunda şablona php bloğu ekler", () => {
  const vhost = buildVhost({
    serverNames: ["yeni.com", "www.yeni.com"],
    documentRoot: "/var/www/yeni",
    phpFpmSocket: "/run/php/php8.3-fpm.sock",
    operationId: "op-1",
  });
  assert.ok(vhost.includes("fastcgi_pass unix:/run/php/php8.3-fpm.sock;"));
  assert.ok(vhost.includes("server_name yeni.com www.yeni.com;"));
  assert.ok(vhost.includes("root /var/www/yeni;"));
});

test("vekil hedefi verildiğinde kök dizin yazılmaz", () => {
  const vhost = buildVhost({
    serverNames: ["api.yeni.com"],
    proxyPass: "http://127.0.0.1:3000",
    operationId: "op-1",
  });
  assert.ok(vhost.includes("proxy_pass http://127.0.0.1:3000;"));
  assert.ok(!vhost.includes("root "));
  assert.ok(vhost.includes("proxy_set_header Host $host;"));
});

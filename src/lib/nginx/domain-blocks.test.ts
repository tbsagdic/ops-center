import assert from "node:assert/strict";
import test from "node:test";
import {
  blocksForDomain,
  domainsSharingBlockWith,
  extractDomainBlocks,
  removeDomainBlocks,
  swapDomainInServerNames,
  unrelatedDomainsIn,
} from "./domain-blocks";
import { stripCertbotArtifacts } from "./config";

/**
 * Girdi, gerçek bir sunucudan alınan kalıbı taklit eder: tek dosyada aktif site
 * ve kullanımdan kalkmış alan adlarının yönlendirme blokları bir arada durur.
 * Bu dosyanın tamamını kopyalamak ya da tamamını pasife almak, ilgisiz siteleri
 * de etkilerdi; testler bunun olmadığını sabitler.
 */
const MULTI_SITE = `server {
    server_name aktif.com www.aktif.com;
    root /var/www/aktif;
    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/aktif.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/aktif.com/privkey.pem; # managed by Certbot
}

server {
    if ($host = www.aktif.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot
    listen 80;
    server_name aktif.com www.aktif.com;
    return 404; # managed by Certbot
}

server {
    listen 80;
    server_name eski1.com www.eski1.com eski2.com www.eski2.com;
    return 301 https://aktif.com$request_uri;
}

server {
    listen 443 ssl;
    server_name eski1.com www.eski1.com eski2.com www.eski2.com;
    ssl_certificate /etc/letsencrypt/live/eski1.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/eski1.com/privkey.pem;
    return 301 https://aktif.com$request_uri;
}
`;

test("hedef alan adına ait blokları bulur, diğerlerini almaz", () => {
  const blocks = blocksForDomain(MULTI_SITE, "aktif.com");
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    assert.ok(block.serverNames.includes("aktif.com"));
  }
});

test("dosyadaki ilgisiz alan adlarını listeler", () => {
  const others = unrelatedDomainsIn(MULTI_SITE, "aktif.com");
  assert.deepEqual(others.sort(), [
    "eski1.com",
    "eski2.com",
    "www.eski1.com",
    "www.eski2.com",
  ]);
});

test("aynı bloğu paylaşan alan adlarını tespit eder", () => {
  // aktif.com yalnız kendi www'siyle aynı blokta: paylaşım yok.
  assert.deepEqual(domainsSharingBlockWith(MULTI_SITE, "aktif.com"), []);
  // eski1.com ise eski2.com ile aynı blokta: otomatik değiştirme güvenli değil.
  assert.deepEqual(domainsSharingBlockWith(MULTI_SITE, "eski1.com").sort(), [
    "eski2.com",
    "www.eski2.com",
  ]);
});

test("yeni dosyaya yalnız hedef alan adının blokları taşınır", () => {
  const extracted = extractDomainBlocks(MULTI_SITE, "aktif.com");
  assert.ok(extracted.includes("root /var/www/aktif;"));
  assert.ok(extracted.includes("try_files"));
  // Yönlendirme blokları yeni dosyaya sızmamalı.
  assert.ok(!extracted.includes("eski1.com"));
  assert.ok(!extracted.includes("eski2.com"));
});

test("eski alan adı çıkarılırken dosyadaki diğer siteler korunur", () => {
  const remaining = removeDomainBlocks(MULTI_SITE, "aktif.com");
  assert.ok(!remaining.includes("server_name aktif.com"));
  assert.ok(!remaining.includes("root /var/www/aktif;"));
  // Diğer alan adlarının yönlendirmeleri yerinde durmalı.
  assert.ok(remaining.includes("server_name eski1.com www.eski1.com eski2.com www.eski2.com;"));
  const open = (remaining.match(/\{/g) ?? []).length;
  const close = (remaining.match(/\}/g) ?? []).length;
  assert.equal(open, close);
});

test("server_name değişimi yalnız hedef alan adına dokunur", () => {
  const swapped = swapDomainInServerNames(MULTI_SITE, "aktif.com", "yeni.com");
  assert.ok(swapped.includes("server_name yeni.com www.yeni.com;"));
  // Bu, eski hatanın nöbetçisi: ilgisiz bloğun server_name'i değişmemeli.
  assert.ok(
    swapped.includes("server_name eski1.com www.eski1.com eski2.com www.eski2.com;")
  );
  assert.ok(!swapped.includes("server_name aktif.com"));
});

test("karışık bir satırda yalnız hedef alan adı değişir", () => {
  const swapped = swapDomainInServerNames(MULTI_SITE, "eski1.com", "eski3.com");
  assert.ok(
    swapped.includes("server_name eski3.com www.eski3.com eski2.com www.eski2.com;")
  );
});

test("hedef alan adı yoksa sessizce geçmez", () => {
  assert.throws(() => swapDomainInServerNames(MULTI_SITE, "yok.com", "yeni.com"));
});

test("uçtan uca: çok siteli dosyadan tek sitenin yeni vhost'u üretilir", () => {
  const extracted = extractDomainBlocks(MULTI_SITE, "aktif.com");
  const cleaned = stripCertbotArtifacts(extracted);
  const final = swapDomainInServerNames(cleaned, "aktif.com", "yeni.com");

  assert.ok(final.includes("server_name yeni.com www.yeni.com;"));
  assert.ok(final.includes("root /var/www/aktif;"));
  // Sertifika satırları temizlenir; yenisini certbot ekleyecek.
  assert.ok(!final.includes("ssl_certificate"));
  assert.ok(!final.includes("listen 443"));
  // HTTP dinleme satırı korunur ki certbot siteyi bulabilsin.
  assert.ok(final.includes("listen 80;"));
  assert.ok(!final.includes("eski1.com"));
});

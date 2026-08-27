import assert from "node:assert/strict";
import test from "node:test";
import { shellCommand, shellQuote } from "./shell-quote";

/**
 * Bu fonksiyon uzak sunucuda root yetkisiyle çalışan komutların tek savunma hattı.
 * Testler, kabuğun özel saydığı her karakter sınıfını kapsar.
 */

test("düz değeri tek tırnak içine alır", () => {
  assert.equal(shellQuote("ornek.com"), "'ornek.com'");
});

test("komut ayırıcılarını etkisizleştirir", () => {
  for (const payload of [
    "a.com; rm -rf /",
    "a.com && reboot",
    "a.com | tee /etc/passwd",
    "a.com\nrm -rf /",
    "a.com`id`",
    "a.com$(id)",
    "a.com${HOME}",
    "a.com & shutdown now",
    "a.com > /etc/nginx/nginx.conf",
  ]) {
    const quoted = shellQuote(payload);
    // Tek tırnak içinde hiçbir metakarakter yorumlanmaz; içerik birebir korunur.
    assert.equal(quoted.startsWith("'"), true);
    assert.equal(quoted.endsWith("'"), true);
    assert.equal(quoted.slice(1, -1).replaceAll(`'\\''`, "'"), payload);
  }
});

test("tek tırnak kaçışı kabuğun beklediği biçimde yapılır", () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote("'"), `''\\'''`);
  assert.equal(shellQuote("a'; rm -rf /; echo '"), `'a'\\''; rm -rf /; echo '\\'''`);
});

test("NUL karakterini reddeder", () => {
  assert.throws(() => shellQuote("a.com\0evil"));
});

test("komut ve argümanları birleştirir", () => {
  assert.equal(
    shellCommand("rm", "-f", "/etc/nginx/sites-enabled/a b.com"),
    "rm '-f' '/etc/nginx/sites-enabled/a b.com'"
  );
});

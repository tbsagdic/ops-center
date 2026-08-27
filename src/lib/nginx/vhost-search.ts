/**
 * Sunucuda bir alan adının hangi vhost dosyasında tanımlı olduğunu bulmak için
 * kullanılan desen ve filtreler.
 */

/**
 * Alan adını `grep -E` desenine çevirir.
 *
 * server_name satırında alan adı tek başına da (`server_name ornek.com;`) başka
 * adların arasında da (`server_name a.com ornek.com;`) geçebilir. Bu yüzden
 * alan adından önceki bölüm isteğe bağlıdır; zorunlu tutmak tek adlı satırları
 * kaçırırdı. Noktalar literal olmalıdır, yoksa herhangi bir karaktere eşleşir.
 */
export function serverNameGrepPattern(domain: string): string {
  const escaped = domain.replaceAll(".", String.raw`\.`);
  return `^[[:space:]]*server_name[[:space:]]+([^;]*[[:space:]])?${escaped}([[:space:]]|;)`;
}

/** Nginx'in okumadığı yedek/devre dışı dosyalar aday sayılmaz. */
const IGNORED_FILE = /\.(bak|old|orig|disabled|save|dpkg-[a-z]+)\b|~$/i;

export function isIgnoredVhostFile(path: string): boolean {
  return IGNORED_FILE.test(path);
}

/** grep çıktısını dosya listesine çevirir; yedek dosyalar elenir. */
export function parseGrepFileList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !isIgnoredVhostFile(file));
}

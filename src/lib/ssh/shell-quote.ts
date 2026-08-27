/**
 * Uzak kabuğa gönderilen komutlarda argüman kaçışı.
 *
 * Tüm kullanıcı kaynaklı değerler (alan adı, dizin yolu, e-posta, proxy hedefi)
 * uzak sunucuda `sh -c` ile yorumlanır. Değerler doğrudan birleştirilirse komut
 * enjeksiyonu oluşur; bu yüzden istisnasız hepsi buradan geçirilir.
 */

/**
 * POSIX kabuğu için tek tırnaklı literal üretir.
 * Tek tırnak içinde hiçbir karakter (`$`, backtick, `;`, `\n`) özel değildir;
 * tek istisna olan tırnağın kendisi `'\''` ile kapatılıp yeniden açılır.
 */
export function shellQuote(value: string): string {
  if (value.includes("\0")) {
    throw new Error("Kabuk argümanı NUL karakteri içeremez.");
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Komut ve argümanlarını tek bir kabuk satırına çevirir. */
export function shellCommand(
  program: string,
  ...args: readonly string[]
): string {
  return [program, ...args.map(shellQuote)].join(" ");
}

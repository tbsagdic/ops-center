import { parseServerBlocks, type ServerBlock } from "./config";

/**
 * Bir vhost dosyasındaki blokları alan adına göre ayırma yardımcıları.
 *
 * Gerçek sunucularda tek bir dosya birden fazla siteyi barındırabilir: aktif site
 * bir blokta, kullanımdan kalkmış alan adlarının 301 yönlendirmeleri başka bir
 * blokta durur. Bu yüzden "dosyayı komple kopyala" veya "dosyayı komple pasife al"
 * yaklaşımları yanlıştır — yalnızca hedef alan adına ait bloklara dokunulur.
 */

/** İsim, hedef alan adının kendisi mi yoksa www alt alanı mı? */
function isTargetName(name: string, domain: string): boolean {
  return name === domain || name === `www.${domain}`;
}

/** Hedef alan adını server_name'inde barındıran bloklar. */
export function blocksForDomain(content: string, domain: string): ServerBlock[] {
  return parseServerBlocks(content).filter((block) =>
    block.serverNames.some((name) => isTargetName(name, domain))
  );
}

/**
 * Hedef alan adıyla aynı server bloğunu paylaşan diğer alan adları.
 * Boş değilse otomatik değiştirme güvenli değildir: bloğun server_name'ini
 * değiştirmek o alan adlarını da taşır.
 */
export function domainsSharingBlockWith(content: string, domain: string): string[] {
  const shared = new Set<string>();
  for (const block of blocksForDomain(content, domain)) {
    for (const name of block.serverNames) {
      if (!isTargetName(name, domain)) shared.add(name);
    }
  }
  return [...shared];
}

/** Dosyada tanımlı olup hedef alan adına ait olmayan tüm alan adları. */
export function unrelatedDomainsIn(content: string, domain: string): string[] {
  const others = new Set<string>();
  for (const block of parseServerBlocks(content)) {
    if (block.serverNames.some((name) => isTargetName(name, domain))) continue;
    for (const name of block.serverNames) {
      if (name !== "_" && !name.startsWith("~")) others.add(name);
    }
  }
  return [...others];
}

/**
 * Yalnız hedef alan adına ait blokları içeren yeni bir dosya metni üretir.
 * Dosyadaki diğer siteler yeni dosyaya taşınmaz.
 */
export function extractDomainBlocks(content: string, domain: string): string {
  const blocks = blocksForDomain(content, domain);
  if (blocks.length === 0) return "";
  return blocks.map((block) => block.text.trim()).join("\n\n") + "\n";
}

/**
 * Hedef alan adına ait blokları dosyadan çıkarır; geri kalan yapılandırma
 * olduğu gibi kalır. Eski alan adını yayından kaldırırken aynı dosyadaki
 * diğer sitelerin ayakta kalması için kullanılır.
 */
export function removeDomainBlocks(content: string, domain: string): string {
  let result = content;
  // Sondan başa: önceki blokların konumları kaymasın.
  for (const block of [...blocksForDomain(content, domain)].reverse()) {
    result = result.replace(block.text, "");
  }
  return result.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/**
 * server_name satırlarındaki hedef alan adını (ve www alt alanını) yenisiyle
 * değiştirir. Aynı satırdaki diğer alan adlarına dokunulmaz.
 */
export function swapDomainInServerNames(
  content: string,
  oldDomain: string,
  newDomain: string,
  /** true ise www alt alan adı sonuçta mutlaka yer alır (kaynakta yoksa eklenir). */
  includeWww = false
): string {
  let changed = false;
  const result = content.replace(
    /^([ \t]*)server_name([ \t]+)([^;\n]+);/gm,
    (match, indent: string, space: string, value: string) => {
      const names = value.trim().split(/\s+/);
      if (!names.some((name) => isTargetName(name, oldDomain))) return match;

      const seen = new Set<string>();
      const mapped: string[] = [];
      for (const name of names) {
        const next =
          name === oldDomain
            ? newDomain
            : name === `www.${oldDomain}`
              ? `www.${newDomain}`
              : name;
        if (seen.has(next)) continue;
        seen.add(next);
        mapped.push(next);
      }

      // Kaynakta www yoksa ama isteniyorsa, ana alan adının hemen ardına eklenir.
      if (includeWww && !seen.has(`www.${newDomain}`)) {
        const at = mapped.indexOf(newDomain);
        mapped.splice(at === -1 ? mapped.length : at + 1, 0, `www.${newDomain}`);
      }

      changed = true;
      return `${indent}server_name${space}${mapped.join(" ")};`;
    }
  );

  if (!changed) {
    throw new Error(
      `Kaynak yapılandırmada ${oldDomain} için server_name satırı bulunamadı.`
    );
  }
  return result;
}

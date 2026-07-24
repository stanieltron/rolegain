const WINDOWS_1252_BYTES = new Map<number, number>([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

// UTF-8 bytes misread as Windows-1252 usually contain one of these lead
// characters. Unicode escapes keep this detector stable across Windows code
// pages and prevent the repair code itself from becoming mojibake.
const SUSPICIOUS_LEAD = /[\u00c2-\u00c5\u00e2\u00f0\u00ef]/gu;
const SUSPICIOUS_PAIRS =
  /(?:\u00c3[\u0080-\u00ff]|\u00c4[\u0080-\u2122]|\u00e2[\u0080-\u2122]|\u00f0[\u0080-\u2122])/gu;

/**
 * Repairs UTF-8 text that was previously decoded as Windows-1252.
 * Clean Unicode is returned unchanged. A repair is accepted only when the
 * complete value decodes safely and its mojibake score decreases.
 */
export function repairMojibake(value: string): string {
  let current = value;
  for (let pass = 0; pass < 4; pass += 1) {
    const before = mojibakeScore(current);
    if (before === 0) break;
    const decoded = decodeWindows1252BytesAsUtf8(current);
    if (!decoded || mojibakeScore(decoded) >= before) break;
    current = decoded;
  }
  return decodeHtmlEntities(current);
}

/**
 * Converts HTML-bearing job-board metadata into readable plain text. Some
 * boards entity-escape their description markup, so entity decoding must run
 * before tag removal.
 */
export function normalizeExtractedText(value: string): string {
  const decoded = repairMojibake(value);
  if (!/<\/?[a-z][^>]*>/iu.test(decoded)) return decoded;
  return repairMojibake(
    decoded
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<\/(?:p|div|li|ul|ol|h[1-6])>/giu, "\n")
      .replace(/<li[^>]*>/giu, "- ")
      .replace(/<[^>]+>/gu, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n")
      .trim(),
  );
}

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: "\u00a0",
  quot: '"',
};

/** Decode the small, safe entity set commonly leaked by job-board metadata. */
function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/giu,
    (entity, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (decimal || hex) {
        const codePoint = Number.parseInt(decimal || hex!, decimal ? 10 : 16);
        if (
          Number.isInteger(codePoint) &&
          codePoint > 0 &&
          codePoint <= 0x10ffff &&
          !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        )
          return String.fromCodePoint(codePoint);
        return entity;
      }
      return NAMED_HTML_ENTITIES[named!.toLowerCase()] ?? entity;
    },
  );
}

function mojibakeScore(value: string): number {
  return (
    [...value.matchAll(SUSPICIOUS_LEAD)].length +
    [...value.matchAll(SUSPICIOUS_PAIRS)].length * 2 +
    (value.match(/\ufffd/g)?.length ?? 0) * 4
  );
}

function decodeWindows1252BytesAsUtf8(value: string): string | undefined {
  const bytes: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0xff) bytes.push(codePoint);
    else {
      const byte = WINDOWS_1252_BYTES.get(codePoint);
      if (byte === undefined) return undefined;
      bytes.push(byte);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    return undefined;
  }
}

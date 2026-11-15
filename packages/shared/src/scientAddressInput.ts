/**
 * Characters domain names never allow but a right-to-left keyboard types unseen: direction marks,
 * isolates and embeddings, zero-width space, word joiner and byte-order mark. ZWJ and ZWNJ stay:
 * some scripts' domains use them.
 */
const INVISIBLE = /[\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;
const MARK = /\p{M}/u;
/** Marks that can belong to a Latin letter: Latin's own and those every script shares. */
const LATIN_MARK = /[\p{scx=Latn}\p{scx=Zinh}\p{scx=Zyyy}]/u;
const ASCII_LABEL = /^[a-z\d-]*$/i;
const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

/**
 * A label of plain letters, digits and hyphens carrying marks of another script, such as Hebrew
 * points typed after `app`, loses those marks: no registry allows such a label, and the browser
 * would otherwise send it to a name no site has. Every other label stays as typed.
 */
function withoutStrayMarks(label: string): string {
  const chars = Array.from(label);
  const stray = (char: string) => MARK.test(char) && !LATIN_MARK.test(char);
  if (!chars.some(stray)) return label;
  const kept = chars.filter((char) => !stray(char)).join("");
  return ASCII_LABEL.test(kept) ? kept : label;
}

/**
 * Typed address-bar input with what can't be part of its host taken out of the host: invisible
 * characters, and stray marks of another script on plain labels. Only an address is touched (a
 * scheme, or a dotted host), and only its host: path, query and port stay exactly as typed.
 */
export function cleanTypedHost(input: string): string {
  const start = SCHEME.exec(input)?.[0].length ?? 0;
  const rest = input.slice(start);
  const authorityEnd = rest.search(/[/?#]/u);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const hostStart = authority.lastIndexOf("@") + 1;
  const port = /:\d*$/u.exec(authority.slice(hostStart))?.[0] ?? "";
  const host = authority.slice(hostStart, authority.length - port.length);
  if (start === 0 && !host.includes(".")) return input;
  const cleaned = host.replace(INVISIBLE, "").split(".").map(withoutStrayMarks).join(".");
  if (cleaned === host) return input;
  return (
    input.slice(0, start + hostStart) +
    cleaned +
    input.slice(start + authority.length - port.length)
  );
}

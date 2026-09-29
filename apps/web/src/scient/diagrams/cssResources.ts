/** CSS that loads a resource, once CSS escapes are decoded. */
const FETCHING_CSS =
  /(?:^|[^\w-])(?:-(?:webkit|moz|o|ms)-)?(?:url|image|image-set|cross-fade|element|src)\s*\(|@import/iu;

/** Decodes CSS escapes (`\75`, `\72 `, `\(`) so an escaped `url(` is still seen. */
export function decodeCssEscapes(text: string): string {
  return text.replace(/\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|([^\n\r\f0-9a-f]))/giu, (_, hex, char) => {
    if (typeof char === "string") return char;
    const code = Number.parseInt(hex as string, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
      ? "�"
      : String.fromCodePoint(code);
  });
}

/** Whether CSS text could load a resource: a fetch function or `@import`, escapes decoded. */
export const fetchesInCss = (css: string) => FETCHING_CSS.test(decodeCssEscapes(css));

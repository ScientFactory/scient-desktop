/**
 * A small HTML start-tag scanner for raw HTML inside Markdown. It follows the
 * HTML tokenizer's rules for tag names and attributes: values are read within
 * their own quotes, so text inside one attribute is never taken for another,
 * comments are skipped, and the contents of raw-text elements (`script`,
 * `style`, `textarea`, `title`) are not scanned for tags.
 */

export interface HtmlStartTag {
  /** Offsets of `<` and just past `>` in the scanned text. */
  readonly start: number;
  readonly end: number;
  /** Lowercase tag name. */
  readonly name: string;
  /** Lowercase attribute names to raw (still entity-encoded) values; the first of a repeated name wins. */
  readonly attributes: ReadonlyMap<string, string>;
}

const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "xmp"]);

const isSpace = (character: string | undefined) =>
  character === " " ||
  character === "\t" ||
  character === "\n" ||
  character === "\r" ||
  character === "\f";

const isAsciiLetter = (character: string | undefined) =>
  character !== undefined && /^[A-Za-z]$/u.test(character);

/** Every complete start tag in `html`, in order. An unterminated tag ends the scan. */
export function scanHtmlStartTags(html: string): ReadonlyArray<HtmlStartTag> {
  const tags: HtmlStartTag[] = [];
  const length = html.length;
  let cursor = 0;
  while (cursor < length) {
    const open = html.indexOf("<", cursor);
    if (open < 0) break;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      if (close < 0) break;
      cursor = close + 3;
      continue;
    }
    if (!isAsciiLetter(html[open + 1])) {
      cursor = open + 1;
      continue;
    }
    let position = open + 1;
    while (
      position < length &&
      !isSpace(html[position]) &&
      html[position] !== "/" &&
      html[position] !== ">"
    )
      position += 1;
    const name = html.slice(open + 1, position).toLowerCase();
    const attributes = new Map<string, string>();
    let closed = false;
    while (position < length) {
      while (position < length && (isSpace(html[position]) || html[position] === "/"))
        position += 1;
      if (position >= length) break;
      if (html[position] === ">") {
        closed = true;
        break;
      }
      // An attribute name may start with `=`; after that, `=` ends it.
      const nameStart = position;
      position += 1;
      while (
        position < length &&
        !isSpace(html[position]) &&
        html[position] !== "/" &&
        html[position] !== ">" &&
        html[position] !== "="
      )
        position += 1;
      const attributeName = html.slice(nameStart, position).toLowerCase();
      while (position < length && isSpace(html[position])) position += 1;
      let value = "";
      if (html[position] === "=") {
        position += 1;
        while (position < length && isSpace(html[position])) position += 1;
        const quote = html[position];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, position + 1);
          if (close < 0) {
            position = length;
            break;
          }
          value = html.slice(position + 1, close);
          position = close + 1;
        } else {
          const valueStart = position;
          while (position < length && !isSpace(html[position]) && html[position] !== ">")
            position += 1;
          value = html.slice(valueStart, position);
        }
      }
      if (!attributes.has(attributeName)) attributes.set(attributeName, value);
    }
    if (!closed) break;
    tags.push({ start: open, end: position + 1, name, attributes });
    cursor = position + 1;
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const end = html.toLowerCase().indexOf(`</${name}`, cursor);
      if (end < 0) break;
      cursor = end;
    }
  }
  return tags;
}

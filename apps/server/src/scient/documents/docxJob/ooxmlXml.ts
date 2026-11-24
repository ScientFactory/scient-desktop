/**
 * Offset-preserving XML tokens for OOXML parts. Edits splice the original text, so everything
 * outside an edited element keeps its exact bytes. A DOCTYPE or an entity XML predeclares nothing
 * for is refused: Word never writes one, and resolving it is the parser's attack surface.
 */
import * as Schema from "effect/Schema";

export class OoxmlShapeError extends Schema.TaggedError<OoxmlShapeError>()("OoxmlShapeError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `The XML part is not supported: ${this.reason}.`;
  }
}

export const isOoxmlShapeError = Schema.is(OoxmlShapeError);

export type XmlToken =
  | {
      readonly kind: "open" | "empty";
      readonly name: string;
      readonly attributes: ReadonlyMap<string, string>;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: "close"; readonly name: string; readonly start: number; readonly end: number }
  | { readonly kind: "text"; readonly text: string; readonly start: number; readonly end: number }
  | { readonly kind: "other"; readonly start: number; readonly end: number };

const PREDEFINED: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function decodeXmlText(raw: string): string {
  return raw.replace(/&([^;&\s]{1,16});|&/gu, (match, entity: string | undefined) => {
    if (entity === undefined) throw new OoxmlShapeError({ reason: "bare ampersand" });
    const named = PREDEFINED[entity];
    if (named !== undefined) return named;
    const numeric = /^#(?:x([0-9a-fA-F]{1,6})|([0-9]{1,7}))$/u.exec(entity);
    if (numeric === null) throw new OoxmlShapeError({ reason: "undeclared entity" });
    const codePoint = Number.parseInt(numeric[1] ?? numeric[2] ?? "", numeric[1] ? 16 : 10);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint === 0)
      throw new OoxmlShapeError({ reason: "invalid character reference" });
    return String.fromCodePoint(codePoint);
  });
}

export const escapeXmlText = (value: string): string =>
  value.replace(/[&<>]/gu, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

export const escapeXmlAttribute = (value: string): string =>
  escapeXmlText(value).replace(/"/gu, "&quot;");

const NAME = /[A-Za-z_][\w.\-:]*/uy;
const ATTRIBUTE = /\s+([A-Za-z_][\w.\-:]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/uy;
const TAG_END = /\s*(\/?)>/uy;
const END_TAG_REST = /\s*>/uy;

const sticky = (pattern: RegExp, xml: string, at: number): RegExpExecArray | null => {
  pattern.lastIndex = at;
  return pattern.exec(xml);
};

/** Tokens in document order with balanced elements; a malformed part throws. */
export function tokenizeXml(xml: string): ReadonlyArray<XmlToken> {
  const tokens: XmlToken[] = [];
  const open: string[] = [];
  let rootClosed = false;
  let index = 0;
  while (index < xml.length) {
    const lt = xml.indexOf("<", index);
    if (lt === -1 || lt > index) {
      const end = lt === -1 ? xml.length : lt;
      const raw = xml.slice(index, end);
      if (open.length === 0) {
        if (raw.trim() !== "")
          throw new OoxmlShapeError({ reason: "text outside the root element" });
      } else {
        tokens.push({ kind: "text", text: decodeXmlText(raw), start: index, end });
      }
      index = end;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) throw new OoxmlShapeError({ reason: "unterminated processing instruction" });
      tokens.push({ kind: "other", start: lt, end: end + 2 });
      index = end + 2;
      continue;
    }
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw new OoxmlShapeError({ reason: "unterminated comment" });
      tokens.push({ kind: "other", start: lt, end: end + 3 });
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1 || open.length === 0) throw new OoxmlShapeError({ reason: "misplaced CDATA" });
      tokens.push({ kind: "text", text: xml.slice(lt + 9, end), start: lt, end: end + 3 });
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<!", lt))
      throw new OoxmlShapeError({ reason: "document type declaration" });
    if (xml.startsWith("</", lt)) {
      const name = sticky(NAME, xml, lt + 2)?.[0];
      const rest = name === undefined ? null : sticky(END_TAG_REST, xml, lt + 2 + name.length);
      if (name === undefined || rest === null)
        throw new OoxmlShapeError({ reason: "malformed end tag" });
      if (open.pop() !== name) throw new OoxmlShapeError({ reason: "mismatched end tag" });
      if (open.length === 0) rootClosed = true;
      const end = lt + 2 + name.length + rest[0].length;
      tokens.push({ kind: "close", name, start: lt, end });
      index = end;
      continue;
    }
    const name = sticky(NAME, xml, lt + 1)?.[0];
    if (name === undefined) throw new OoxmlShapeError({ reason: "malformed start tag" });
    if (open.length === 0 && rootClosed)
      throw new OoxmlShapeError({ reason: "more than one root element" });
    let cursor = lt + 1 + name.length;
    const attributes = new Map<string, string>();
    for (;;) {
      const match = sticky(ATTRIBUTE, xml, cursor);
      if (match === null) break;
      const attribute = match[1]!;
      if (attributes.has(attribute)) throw new OoxmlShapeError({ reason: "duplicate attribute" });
      attributes.set(attribute, decodeXmlText(match[2] ?? match[3] ?? ""));
      cursor += match[0].length;
    }
    const rest = sticky(TAG_END, xml, cursor);
    if (rest === null) throw new OoxmlShapeError({ reason: "malformed start tag" });
    const end = cursor + rest[0].length;
    const empty = rest[1] === "/";
    tokens.push({ kind: empty ? "empty" : "open", name, attributes, start: lt, end });
    if (!empty) open.push(name);
    else if (open.length === 0) rootClosed = true;
    index = end;
  }
  if (open.length !== 0) throw new OoxmlShapeError({ reason: "unclosed element" });
  return tokens;
}

/** The index of the token that closes the element opened at `openIndex`. */
export function matchingClose(tokens: ReadonlyArray<XmlToken>, openIndex: number): number {
  const opened = tokens[openIndex];
  if (opened?.kind === "empty") return openIndex;
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "open") depth += 1;
    else if (token.kind === "close") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new OoxmlShapeError({ reason: "unclosed element" });
}

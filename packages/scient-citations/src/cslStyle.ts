/** A CSL style's ID as the style repository names it, e.g. `nature` or `plos-one`. */
export const CSL_STYLE_ID_PATTERN = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/u;

export interface CslStyleInfo {
  readonly id: string;
  readonly title: string;
  readonly titleShort: string | null;
  /** The independent style whose layout a dependent style uses; null for an independent style. */
  readonly parentId: string | null;
  readonly defaultLocale: string | null;
}

const CSL_NAMESPACE = "http://purl.org/net/xbiblio/csl";

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXmlEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (entity, decimal, hex, name) => {
    if (name) return XML_ENTITIES[name] ?? entity;
    const codePoint = decimal ? Number(decimal) : Number.parseInt(hex, 16);
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
  });
}

/** The last path segment of a style URL such as `http://www.zotero.org/styles/nature`. */
function cslStyleIdFromUrl(url: string): string | null {
  const id = /\/styles\/([^/?#]+)\/?$/u.exec(url.trim())?.[1] ?? null;
  return id !== null && CSL_STYLE_ID_PATTERN.test(id) ? id : null;
}

const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu;

type Attributes = ReadonlyMap<string, string>;

interface CslMarkup {
  readonly root: {
    readonly attributes: Attributes;
    /** Where each attribute sits in the text, and where the root's name ends. */
    readonly spans: ReadonlyMap<string, readonly [start: number, end: number]>;
    readonly nameEnd: number;
  };
  /** The text of the `title`, `title-short` and `id` children of the root's `info`. */
  readonly info: ReadonlyMap<string, string>;
  readonly links: ReadonlyArray<Attributes>;
  readonly hasCitation: boolean;
}

const XML_ASIDES = [
  ["<!--", "-->"],
  ["<?", "?>"],
  ["<![CDATA[", "]]>"],
] as const;
// Sticky, so a tag that fails to match costs one pass over it however it is padded.
const XML_TAG_NAME = /<(\/?)([A-Za-z_][\w:.-]*)/uy;
const XML_ATTRIBUTE = /(\s+)([^\s=<>"'/]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/uy;
const XML_TAG_END = /\s*(\/?)>/uy;
const INFO_TEXT = new Set(["title", "title-short", "id"]);

/**
 * Reads a style's text in one pass, or null when it is not one `style` element whose elements
 * all close in order and whose named macros are all defined, in every branch. citeproc-js
 * accepts a style that fails either: it renders markup Pandoc rejects, and prints nothing for
 * an undefined macro. Names and values are compared as XML reads them.
 */
function scanCslMarkup(xml: string): CslMarkup | null {
  const open: string[] = [];
  const definedMacros = new Set<string>();
  const namedMacros: string[] = [];
  const info = new Map<string, string>();
  const links: Attributes[] = [];
  let root: CslMarkup["root"] | null = null;
  let hasCitation = false;
  let collecting: string | null = null;
  let collected = "";
  let position = 0;
  while (position < xml.length) {
    const next = xml.indexOf("<", position);
    const text = xml.slice(position, next < 0 ? xml.length : next);
    if (open.length === 0 && text.trim() !== "") return null;
    if (collecting !== null) collected += decodeXmlEntities(text);
    if (next < 0) break;
    const aside = XML_ASIDES.find(([start]) => xml.startsWith(start, next));
    if (aside) {
      const [start, end] = aside;
      const close = xml.indexOf(end, next + start.length);
      if (close < 0) return null;
      if (start === "<![CDATA[") {
        if (open.length === 0) return null;
        if (collecting !== null) collected += xml.slice(next + start.length, close);
      }
      position = close + end.length;
      continue;
    }
    XML_TAG_NAME.lastIndex = next;
    const tag = XML_TAG_NAME.exec(xml);
    if (tag === null) return null;
    const closing = tag[1] !== "";
    const name = tag[2]!;
    const nameEnd = XML_TAG_NAME.lastIndex;
    const attributes = new Map<string, string>();
    const spans = new Map<string, readonly [number, number]>();
    position = nameEnd;
    for (;;) {
      XML_ATTRIBUTE.lastIndex = position;
      const attribute = XML_ATTRIBUTE.exec(xml);
      if (attribute === null) break;
      const attributeName = attribute[2]!;
      if (attributes.has(attributeName)) return null;
      const value = (attribute[3] ?? attribute[4] ?? "").replace(/[\t\n\r]/gu, " ");
      attributes.set(attributeName, decodeXmlEntities(value));
      spans.set(attributeName, [attribute.index + attribute[1]!.length, XML_ATTRIBUTE.lastIndex]);
      position = XML_ATTRIBUTE.lastIndex;
    }
    XML_TAG_END.lastIndex = position;
    const tagEnd = XML_TAG_END.exec(xml);
    if (tagEnd === null) return null;
    position = XML_TAG_END.lastIndex;
    const selfClosing = tagEnd[1] !== "";
    if (closing) {
      if (selfClosing || attributes.size > 0 || open.pop() !== name) return null;
      if (collecting !== null && open.length === 2) {
        info.set(collecting, collected.trim());
        collecting = null;
      }
      continue;
    }
    if (open.length === 0) {
      if (root !== null || name !== "style") return null;
      root = { attributes, spans, nameEnd };
    }
    const localName = name.slice(name.indexOf(":") + 1);
    const macro = attributes.get(localName === "macro" ? "name" : "macro");
    if (macro !== undefined && localName === "macro") definedMacros.add(macro);
    else if (macro !== undefined && (localName === "text" || localName === "key")) {
      namedMacros.push(macro);
    }
    if (open.length === 1 && name === "citation") hasCitation = true;
    if (open.length === 2 && open[1] === "info") {
      if (name === "link") links.push(attributes);
      else if (!selfClosing && INFO_TEXT.has(name) && !info.has(name)) {
        collecting = name;
        collected = "";
      }
    }
    if (!selfClosing) open.push(name);
  }
  if (root === null || open.length > 0) return null;
  if (!namedMacros.every((name) => definedMacros.has(name))) return null;
  return { root, info, links, hasCitation };
}

/**
 * Reads a CSL style's identity, or null when the text is not a complete CSL style: an
 * independent style must define its citation layout, a dependent one must name its parent.
 */
export function readCslStyle(xml: string): CslStyleInfo | null {
  const markup = scanCslMarkup(xml);
  if (markup?.root.attributes.get("xmlns") !== CSL_NAMESPACE) return null;
  const title = markup.info.get("title");
  const id = cslStyleIdFromUrl(markup.info.get("id") ?? "");
  if (title === undefined || id === null) return null;
  const parentLink = markup.links.find((link) => link.get("rel") === "independent-parent");
  const parentId = parentLink ? cslStyleIdFromUrl(parentLink.get("href") ?? "") : null;
  if (parentLink && parentId === null) return null;
  if (parentId === null && !markup.hasCitation) return null;
  const locale = markup.root.attributes.get("default-locale") ?? "";
  return {
    id,
    title,
    titleShort: markup.info.get("title-short") ?? null,
    parentId,
    defaultLocale: LOCALE_PATTERN.exec(locale)?.[0] ?? null,
  };
}

/**
 * The style both engines render: the parent's layout with the dependent style's locale, which
 * is how citeproc processors apply a dependent style. Neither engine fetches a parent itself.
 */
export function renderableCslStyle(style: string, parent: string | null): string {
  if (parent === null) return style;
  const locale = readCslStyle(style)?.defaultLocale ?? null;
  const root = locale === null ? null : (scanCslMarkup(parent)?.root ?? null);
  if (locale === null || root === null) return parent;
  const [start, end] = root.spans.get("default-locale") ?? [root.nameEnd, root.nameEnd];
  const attribute = `default-locale="${locale}"`;
  return parent.slice(0, start) + (start === end ? ` ${attribute}` : attribute) + parent.slice(end);
}

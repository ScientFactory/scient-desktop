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

function decodeXmlText(text: string): string {
  return decodeXmlEntities(text).trim();
}

/** The last path segment of a style URL such as `http://www.zotero.org/styles/nature`. */
function cslStyleIdFromUrl(url: string): string | null {
  const id = /\/styles\/([^/?#]+)\/?$/u.exec(url.trim())?.[1] ?? null;
  return id !== null && CSL_STYLE_ID_PATTERN.test(id) ? id : null;
}

const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu;

function styleStartTag(xml: string): string | null {
  return /<style\b[^>]*>/u.exec(xml)?.[0] ?? null;
}

const XML_ASIDE = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/gu;
const XML_ATTRIBUTES = String.raw`(?:\s(?:"[^"]*"|'[^']*'|[^>"'])*?)?`;
const XML_TAG = new RegExp(String.raw`<(\/?)([A-Za-z_][\w:.-]*)(${XML_ATTRIBUTES})(\/?)>`, "gu");
const XML_LINK = new RegExp(String.raw`<link\b(${XML_ATTRIBUTES})\/?>`, "gu");
const XML_ATTRIBUTE = /\s([^\s=<>"'/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;

/**
 * A tag's attributes with their values decoded, or null when the text is not XML attributes.
 * Names are compared as XML reads them, so `macro = "a&#38;b"` names the macro `a&amp;b`.
 */
function readAttributes(text: string): Map<string, string> | null {
  const attributes = new Map<string, string>();
  let repeated = false;
  const rest = text.replace(
    XML_ATTRIBUTE,
    (_attribute, name: string, double?: string, single?: string) => {
      repeated ||= attributes.has(name);
      attributes.set(name, decodeXmlEntities((double ?? single ?? "").replace(/[\t\n\r]/gu, " ")));
      return "";
    },
  );
  return repeated || rest.trim() !== "" ? null : attributes;
}

/**
 * Whether every element closes in order and every macro a layout names is defined, in every
 * branch. citeproc-js accepts a style that fails either: it renders markup Pandoc rejects, and
 * prints nothing for an undefined macro.
 */
function isCompleteMarkup(markup: string): boolean {
  const open: string[] = [];
  const defined = new Set<string>();
  const named: string[] = [];
  let wellFormed = true;
  const text = markup.replace(
    XML_TAG,
    (_tag, closing: string, name: string, attributeText: string, selfClosing: string) => {
      const attributes = readAttributes(attributeText);
      if (attributes === null) wellFormed = false;
      else if (closing) wellFormed &&= !selfClosing && attributes.size === 0 && open.pop() === name;
      else {
        if (!selfClosing) open.push(name);
        const macro = attributes.get(name === "macro" ? "name" : "macro");
        if (macro !== undefined && name === "macro") defined.add(macro);
        else if (macro !== undefined && (name === "text" || name === "key")) named.push(macro);
      }
      return "";
    },
  );
  if (!wellFormed || open.length > 0 || text.includes("<")) return false;
  return named.every((macro) => defined.has(macro));
}

/**
 * Reads a CSL style's identity, or null when the text is not a complete CSL style: an
 * independent style must define its citation layout, a dependent one must name its parent.
 */
export function readCslStyle(xml: string): CslStyleInfo | null {
  const markup = xml.replace(XML_ASIDE, "");
  const start = styleStartTag(markup);
  const attributes = start === null ? null : readAttributes(start.slice("<style".length, -1));
  if (attributes?.get("xmlns") !== CSL_NAMESPACE) return null;
  if (!/<\/style>\s*$/u.test(markup) || !isCompleteMarkup(markup)) return null;
  const info = /<info>([\s\S]*?)<\/info>/u.exec(markup)?.[1];
  if (info === undefined) return null;
  const title = /<title>([\s\S]*?)<\/title>/u.exec(info)?.[1];
  const idUrl = /<id>([\s\S]*?)<\/id>/u.exec(info)?.[1];
  const id = idUrl === undefined ? null : cslStyleIdFromUrl(decodeXmlText(idUrl));
  if (title === undefined || id === null) return null;
  const parentLink = Array.from(info.matchAll(XML_LINK), (link) => readAttributes(link[1]!)).find(
    (link) => link?.get("rel") === "independent-parent",
  );
  const parentId = parentLink ? cslStyleIdFromUrl(parentLink.get("href") ?? "") : null;
  if (parentLink && parentId === null) return null;
  if (parentId === null && !/<citation\b/u.test(markup)) return null;
  const titleShort = /<title-short>([\s\S]*?)<\/title-short>/u.exec(info)?.[1];
  return {
    id,
    title: decodeXmlText(title),
    titleShort: titleShort === undefined ? null : decodeXmlText(titleShort),
    parentId,
    defaultLocale: LOCALE_PATTERN.exec(attributes.get("default-locale") ?? "")?.[0] ?? null,
  };
}

const DEFAULT_LOCALE_ATTRIBUTE = /\bdefault-locale\s*=\s*(?:"[^"]*"|'[^']*')/u;

/**
 * The style both engines render: the parent's layout with the dependent style's locale, which
 * is how citeproc processors apply a dependent style. Neither engine fetches a parent itself.
 */
export function renderableCslStyle(style: string, parent: string | null): string {
  if (parent === null) return style;
  const locale = readCslStyle(style)?.defaultLocale ?? null;
  const start = styleStartTag(parent);
  if (locale === null || start === null) return parent;
  const localized = DEFAULT_LOCALE_ATTRIBUTE.test(start)
    ? start.replace(DEFAULT_LOCALE_ATTRIBUTE, `default-locale="${locale}"`)
    : start.replace(/^<style\b/u, `<style default-locale="${locale}"`);
  return parent.replace(start, () => localized);
}

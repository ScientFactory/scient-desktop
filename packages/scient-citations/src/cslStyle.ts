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

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXmlText(text: string): string {
  return text
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (entity, decimal, hex, name) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      return XML_ENTITIES[name] ?? entity;
    })
    .trim();
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
const XML_TAG = /<(\/?)([A-Za-z_][\w:.-]*)(?:\s(?:"[^"]*"|'[^']*'|[^>"'])*?)?(\/?)>/gu;

/** Whether every element closes, in order. citeproc-js renders markup that Pandoc rejects. */
function elementsClose(xml: string): boolean {
  const open: string[] = [];
  let inOrder = true;
  const text = xml
    .replace(XML_ASIDE, "")
    .replace(XML_TAG, (_tag, closing: string, name: string, selfClosing: string) => {
      if (closing) inOrder &&= open.pop() === name;
      else if (!selfClosing) open.push(name);
      return "";
    });
  return inOrder && open.length === 0 && !text.includes("<");
}

/**
 * Reads a CSL style's identity, or null when the text is not a complete CSL style: an
 * independent style must define its citation layout, a dependent one must name its parent.
 */
export function readCslStyle(xml: string): CslStyleInfo | null {
  const start = styleStartTag(xml);
  if (start === null || !start.includes('xmlns="http://purl.org/net/xbiblio/csl"')) return null;
  if (!/<\/style>\s*$/u.test(xml) || !elementsClose(xml)) return null;
  const info = /<info>([\s\S]*?)<\/info>/u.exec(xml)?.[1];
  if (info === undefined) return null;
  const title = /<title>([\s\S]*?)<\/title>/u.exec(info)?.[1];
  const idUrl = /<id>([\s\S]*?)<\/id>/u.exec(info)?.[1];
  const id = idUrl === undefined ? null : cslStyleIdFromUrl(decodeXmlText(idUrl));
  if (title === undefined || id === null) return null;
  const parentLink = /<link\b[^>]*\brel="independent-parent"[^>]*>/u.exec(info)?.[0];
  const parentHref = parentLink ? /\bhref="([^"]+)"/u.exec(parentLink)?.[1] : undefined;
  const parentId = parentHref === undefined ? null : cslStyleIdFromUrl(decodeXmlText(parentHref));
  if (parentLink !== undefined && parentId === null) return null;
  if (parentId === null && !/<citation\b/u.test(xml)) return null;
  const titleShort = /<title-short>([\s\S]*?)<\/title-short>/u.exec(info)?.[1];
  return {
    id,
    title: decodeXmlText(title),
    titleShort: titleShort === undefined ? null : decodeXmlText(titleShort),
    parentId,
    defaultLocale:
      LOCALE_PATTERN.exec(/\bdefault-locale="([^"]+)"/u.exec(start)?.[1] ?? "")?.[0] ?? null,
  };
}

/**
 * The style both engines render: the parent's layout with the dependent style's locale, which
 * is how citeproc processors apply a dependent style. Neither engine fetches a parent itself.
 */
export function renderableCslStyle(style: string, parent: string | null): string {
  if (parent === null) return style;
  const locale = readCslStyle(style)?.defaultLocale ?? null;
  const start = styleStartTag(parent);
  if (locale === null || start === null) return parent;
  const localized = /\bdefault-locale="[^"]*"/u.test(start)
    ? start.replace(/\bdefault-locale="[^"]*"/u, `default-locale="${locale}"`)
    : start.replace(/^<style\b/u, `<style default-locale="${locale}"`);
  return parent.replace(start, () => localized);
}

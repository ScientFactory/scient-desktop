import { srcSetCandidateUrls } from "../presentation/remoteImageAddress";
import { decodeCssEscapes, fetchesInCss } from "./cssResources";

/** Elements whose presence would make a renderer fetch, embed, or run something. */
export const FETCHING_ELEMENTS = new Set([
  "audio",
  "base",
  "embed",
  "feimage",
  "frame",
  "iframe",
  "image",
  "img",
  "link",
  "meta",
  "object",
  "picture",
  "script",
  "source",
  "track",
  "video",
]);
/** Attributes that name a resource to load. `href` is judged separately. */
export const RESOURCE_ATTRIBUTES = new Set([
  "action",
  "background",
  "data",
  "formaction",
  "poster",
  "src",
  "srcset",
]);
/** Elements that embed, run, or reconfigure the page whatever they point at. */
const ALWAYS_REMOVED = new Set([
  "base",
  "embed",
  "frame",
  "iframe",
  "link",
  "meta",
  "object",
  "script",
]);

/** The bytes are already here, or the reference stays inside the SVG. */
const isLocalAddress = (address: string) => /^\s*(?:#|data:|blob:)/iu.test(address);

/** Addresses a CSS value names: `url()` arguments and the strings inside image functions. */
function cssAddresses(css: string): { addresses: string[]; unresolved: boolean } {
  const text = decodeCssEscapes(css);
  const addresses: string[] = [];
  for (const match of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/giu)) {
    addresses.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  const imageFunction = /(?:image-set|image|cross-fade|src)\(([^)]*)\)/giu;
  for (const match of text.matchAll(imageFunction)) {
    for (const quoted of (match[1] ?? "").matchAll(/"([^"]*)"|'([^']*)'/gu)) {
      addresses.push(quoted[1] ?? quoted[2] ?? "");
    }
  }
  const unresolved =
    /@import|element\(/iu.test(text) || (addresses.length === 0 && fetchesInCss(css));
  return { addresses, unresolved };
}

/** Whether CSS text would load something from outside the SVG, and what. */
function externalCss(css: string, blocked: string[]): boolean {
  if (!fetchesInCss(css)) return false;
  const { addresses, unresolved } = cssAddresses(css);
  const external = addresses.filter((address) => !isLocalAddress(address));
  blocked.push(...external);
  return unresolved || external.length > 0;
}

/** Drops each declaration that loads from outside; false when the result is still unsafe. */
function stripDeclarations(style: CSSStyleDeclaration, blocked: string[]): boolean {
  for (const property of Array.from(style)) {
    if (externalCss(style.getPropertyValue(property), blocked)) style.removeProperty(property);
  }
  return !externalCss(style.cssText, []);
}

function stripRules(rules: CSSRuleList, blocked: string[]): boolean {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]!;
    const parent = rule.parentRule ?? rule.parentStyleSheet;
    const remove = () =>
      parent && "deleteRule" in parent ? (parent as CSSStyleSheet).deleteRule(index) : undefined;
    if ("style" in rule && rule.style instanceof CSSStyleDeclaration) {
      if (!stripDeclarations(rule.style, blocked)) remove();
    } else if (!("cssRules" in rule) && externalCss(rule.cssText, blocked)) {
      // @import and @font-face (its src is not a style property here) go whole.
      remove();
    }
    if ("cssRules" in rule && !stripRules((rule as CSSGroupingRule).cssRules, blocked)) remove();
  }
  return Array.from(rules).every((rule) => !externalCss(rule.cssText, []));
}

/** A `<style>` element's text without the rules that load from outside, or null if it cannot be made safe. */
function strippedStyleSheet(text: string, blocked: string[]): string | null {
  if (typeof CSSStyleSheet === "undefined" || !("replaceSync" in CSSStyleSheet.prototype)) {
    externalCss(text, blocked);
    return null;
  }
  if (/@import/iu.test(decodeCssEscapes(text))) externalCss(text, blocked);
  const sheet = new CSSStyleSheet();
  try {
    // `replaceSync` drops `@import` rules itself.
    sheet.replaceSync(text);
  } catch {
    return null;
  }
  if (!stripRules(sheet.cssRules, blocked)) return null;
  return Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
}

/** Every address an element would load: `src`, `href`, `srcset` candidates, and the like. */
function elementAddresses(element: Element): string[] {
  const addresses: string[] = [];
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.localName.toLowerCase();
    if (name === "srcset") addresses.push(...srcSetCandidateUrls(attribute.value));
    else if (name === "href" || RESOURCE_ATTRIBUTES.has(name))
      addresses.push(attribute.value.trim());
  }
  return addresses.filter((address) => address.length > 0);
}

/**
 * A rendered diagram with everything that would load from outside it removed, and the
 * addresses it named. Images, icons, and styles that point elsewhere are dropped (a picture
 * drawn from `data:` stays); the rest of the markup is left exactly as Mermaid drew it, so
 * an ordinary diagram comes back unchanged.
 */
export function stripSvgExternalResources(svg: string): {
  readonly svg: string;
  readonly blocked: ReadonlyArray<string>;
} {
  const template = document.createElement("template");
  template.innerHTML = svg;
  const blocked: string[] = [];
  let changed = false;
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    // A descendant of an element already removed.
    if (!template.content.contains(element)) continue;
    const name = element.localName.toLowerCase();
    if (FETCHING_ELEMENTS.has(name) && name !== "picture") {
      const external = elementAddresses(element).filter((address) => !isLocalAddress(address));
      if (ALWAYS_REMOVED.has(name) || external.length > 0) {
        blocked.push(...external);
        element.remove();
        changed = true;
        continue;
      }
    } else if (ALWAYS_REMOVED.has(name)) {
      element.remove();
      changed = true;
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.localName.toLowerCase();
      const value = attribute.value.trim();
      const external = value.length > 0 && !isLocalAddress(value);
      if (
        attributeName.startsWith("on") ||
        (attributeName === "href" && name !== "a" && external) ||
        (RESOURCE_ATTRIBUTES.has(attributeName) && external)
      ) {
        if (!attributeName.startsWith("on")) blocked.push(value);
        element.removeAttributeNode(attribute);
        changed = true;
      } else if (attributeName === "style" && externalCss(value, [])) {
        const style = (element as HTMLElement | SVGElement).style;
        if (!style || !stripDeclarations(style, blocked)) element.removeAttribute("style");
        changed = true;
      }
    }
    if (name === "style" && externalCss(element.textContent ?? "", [])) {
      const text = strippedStyleSheet(element.textContent ?? "", blocked);
      if (text === null) element.remove();
      else element.textContent = text;
      changed = true;
    }
  }
  return {
    svg: changed ? template.innerHTML : svg,
    blocked: [...new Set(blocked.filter((address) => address.length > 0))],
  };
}

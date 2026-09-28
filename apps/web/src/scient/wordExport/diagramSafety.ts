/**
 * Which Mermaid diagrams Word export may render without the browser fetching
 * anything.
 *
 * Mermaid draws into the live page (to measure text) before Scient sees its
 * SVG, so whatever makes the browser load a resource during that draw has to
 * be refused beforehand. In strict mode that is limited to: markup in labels
 * that loads a URL (an `<img>`, a `style` attribute, ...), CSS that loads one
 * (`url()`, `image-set()`, `@import`) in `style`, `classDef`, or theme
 * settings, a node's `img` shape, and a sequence actor's `icon`. Mermaid's
 * configuration is checked as Mermaid itself read it, so JSON and YAML escapes
 * cannot hide a key or a value. Everything else renders: math, URLs written
 * as text, `%%{init}%%` theme and layout settings. After rendering, the
 * rasteriser (`mermaidExport.ts`) inspects the SVG before drawing it.
 */

/** Elements that load a URL, or carry markup or CSS that can. */
const FETCHING_ELEMENTS = new Set([
  "applet",
  "audio",
  "base",
  "body",
  "embed",
  "feimage",
  "fencedframe",
  "frame",
  "frameset",
  "iframe",
  "image",
  "img",
  "input",
  "link",
  "meta",
  "object",
  "picture",
  "portal",
  "script",
  "source",
  "style",
  "svg",
  "track",
  "use",
  "video",
]);

/** A tag as the HTML parser would start one: `<` directly followed by a letter. */
const TAG = /<\/?([A-Za-z][^\s/>]*)([^>]*)/gu;
/** CSS that loads a resource, once CSS escapes are decoded. */
const FETCHING_CSS =
  /(?:^|[^\w-])(?:-(?:webkit|moz|o|ms)-)?(?:url|image|image-set|cross-fade|element|src)\s*\(|@import/iu;

/** Decodes CSS escapes (`\75`, `\72 `, `\(`) so an escaped `url(` is still seen. */
function decodeCssEscapes(text: string): string {
  return text.replace(/\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|([^\n\r\f0-9a-f]))/giu, (_, hex, char) => {
    if (typeof char === "string") return char;
    const code = Number.parseInt(hex as string, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
      ? "�"
      : String.fromCodePoint(code);
  });
}

function textFetchRisk(text: string): string | null {
  for (const [, name = "", rest = ""] of text.matchAll(TAG)) {
    const element = name.toLowerCase().replace(/^.*:/u, "");
    if (FETCHING_ELEMENTS.has(element)) return `the diagram contains <${element}> markup`;
    // Every URL-bearing attribute (src, href, style, background, ...) needs a value.
    if (rest.includes("=")) return "the diagram contains markup with attributes";
  }
  if (FETCHING_CSS.test(decodeCssEscapes(text))) {
    return "the diagram's styles refer to an outside resource";
  }
  return null;
}

/** Each `@{ … }` shape-data block, ending where Mermaid's lexer ends it (outside double quotes). */
function shapeDataBlocks(source: string): string[] {
  const blocks: string[] = [];
  for (let start = source.indexOf("@{"); start !== -1; start = source.indexOf("@{", start + 2)) {
    let quoted = false;
    let end = start + 2;
    while (end < source.length && (quoted || source[end] !== "}")) {
      if (source[end] === '"') quoted = !quoted;
      end += 1;
    }
    blocks.push(source.slice(start, end + 1));
  }
  return blocks;
}

/** Why rendering `source` could fetch a resource, or null when it cannot. */
export function mermaidSourceFetchRisk(source: string): string | null {
  const markup = textFetchRisk(source);
  if (markup !== null) return markup;
  // Shape data is YAML; an escape could spell `img` or a URL without writing it.
  if (shapeDataBlocks(source).some((block) => /img|\\/iu.test(block))) {
    return "a diagram node shows an image";
  }
  if (/^[ \t]*properties\b[^\n]*(?:icon|\\)/imu.test(source)) {
    return "a sequence actor shows an icon";
  }
  return null;
}

/**
 * The configuration keys a diagram may set through front matter or
 * `%%{init}%%`: the theme and its colours, the look and layout, and each
 * diagram type's own options. CSS-bearing keys (`themeCSS`, `fontFamily`)
 * and anything else are refused.
 */
const SAFE_CONFIG_KEYS = new Set([
  "theme",
  "themeVariables",
  "look",
  "layout",
  "darkMode",
  "fontSize",
  "handDrawnSeed",
  "wrap",
  "markdownAutoWrap",
  "flowchart",
  "sequence",
  "gantt",
  "journey",
  "timeline",
  "class",
  "state",
  "er",
  "pie",
  "quadrantChart",
  "xyChart",
  "requirement",
  "architecture",
  "mindmap",
  "kanban",
  "gitGraph",
  "c4",
  "sankey",
  "packet",
  "block",
  "radar",
  "treemap",
]);
const MAX_CONFIG_DEPTH = 4;

function configValueRisk(value: unknown, depth: number): string | null {
  if (value === null || typeof value === "number" || typeof value === "boolean") return null;
  if (typeof value === "string") {
    return value.includes("<") || value.includes("\\")
      ? "a setting contains markup"
      : textFetchRisk(value);
  }
  if (depth >= MAX_CONFIG_DEPTH || typeof value !== "object") return "a setting is not supported";
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const risk = configValueRisk(nested, depth + 1);
    if (risk !== null) return risk;
  }
  return null;
}

/** Why the configuration Mermaid read from the diagram could fetch a resource, or null. */
export function mermaidConfigFetchRisk(config: unknown): string | null {
  if (config === null || config === undefined) return null;
  if (typeof config !== "object" || Array.isArray(config)) return "a setting is not supported";
  for (const [key, value] of Object.entries(config)) {
    if (!SAFE_CONFIG_KEYS.has(key)) return `the diagram sets ${key}`;
    const risk = configValueRisk(value, 1);
    if (risk !== null) return risk;
  }
  return null;
}

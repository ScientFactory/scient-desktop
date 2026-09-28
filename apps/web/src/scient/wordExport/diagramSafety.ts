/**
 * A second line of defence for Word diagram capture, behind the network
 * isolation of `isolatedMermaid.ts`: diagrams whose styles or settings refer
 * to an outside resource are refused before they are drawn at all.
 *
 * Only CSS-bearing constructs are read — `style`, `classDef`, `linkStyle`,
 * and `cssClass` statements, and the configuration Mermaid parsed from front
 * matter and `%%{init}%%` — so label text that mentions `url(` or a web
 * address exports normally.
 */

/** CSS that loads a resource, once CSS escapes are decoded. */
const FETCHING_CSS =
  /(?:^|[^\w-])(?:-(?:webkit|moz|o|ms)-)?(?:url|image|image-set|cross-fade|element|src)\s*\(|@import/iu;
const STYLE_STATEMENT = /^\s*(?:style|classDef|linkStyle|cssClass)\b/iu;
/** A CSS declaration (`background: …`) that a `;` inside a style list introduced. */
const CSS_DECLARATION = /^\s*-?[a-z][a-z0-9-]*\s*:(?!:)/iu;

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

const fetchesInCss = (css: string) => FETCHING_CSS.test(decodeCssEscapes(css));

/** A line's statements: split at each `;` that is not inside a double-quoted string. */
function statementsOf(line: string): string[] {
  const statements: string[] = [];
  let quoted = false;
  let start = 0;
  for (let at = 0; at < line.length; at += 1) {
    if (line[at] === '"') quoted = !quoted;
    else if (line[at] === ";" && !quoted) {
      statements.push(line.slice(start, at));
      start = at + 1;
    }
  }
  statements.push(line.slice(start));
  return statements;
}

/**
 * Why the diagram's styling statements could fetch a resource, or null when
 * they cannot. Each statement ends at a newline or an unquoted `;`, except
 * that the declarations of a style list some diagram types read to the end
 * of the line (`fill:red; background:url(…)`) stay part of it. Labels in
 * later statements are not inspected.
 */
export function mermaidStyleFetchRisk(source: string): string | null {
  for (const line of source.split(/\r\n?|\n/u)) {
    const statements = statementsOf(line);
    for (const [index, statement] of statements.entries()) {
      if (!STYLE_STATEMENT.test(statement)) continue;
      let css = statement;
      for (const next of statements.slice(index + 1)) {
        if (!CSS_DECLARATION.test(next) || STYLE_STATEMENT.test(next)) break;
        css += `;${next}`;
      }
      if (fetchesInCss(css)) return "the diagram's styles refer to an outside resource";
    }
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
    // Setting values become CSS and attributes; none needs markup or escapes.
    return value.includes("<") || value.includes("\\") || fetchesInCss(value)
      ? "a setting refers to an outside resource"
      : null;
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

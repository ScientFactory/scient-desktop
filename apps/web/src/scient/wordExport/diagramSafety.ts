/**
 * Word capture refuses authored styles/settings outside its supported subset.
 * The shared Pele renderer separately disables resources and sanitizes its SVG.
 *
 * Only CSS-bearing constructs are read — `style`, `classDef`, `linkStyle`,
 * and `cssClass` statements, and configuration decoded from front
 * matter and `%%{init}%%` — so label text that mentions `url(` or a web
 * address exports normally.
 */

import { fetchesInCss } from "../diagrams/cssResources";
import { mermaidCssStatements } from "../diagrams/mermaidStyles";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";

/**
 * Why the diagram's styling statements could fetch a resource, or null when
 * they cannot. Each statement ends at a newline or an unquoted `;`, except
 * that the declarations of a style list some diagram types read to the end
 * of the line (`fill:red; background:url(…)`) stay part of it. Labels in
 * later statements are not inspected.
 */
export function mermaidStyleFetchRisk(source: string): string | null {
  return mermaidCssStatements(source).some(fetchesInCss)
    ? "the diagram's styles refer to an outside resource"
    : null;
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

const decodeYaml = Schema.decodeUnknownSync(fromYaml(Schema.Unknown));

/** Inspect each authored config independently so a later override cannot hide an unsafe value. */
export function mermaidSourceConfigFetchRisk(source: string): string | null {
  try {
    const frontmatter = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*---(?=\s|$)/u.exec(source);
    if (frontmatter) {
      const parsed = decodeYaml(frontmatter[1]);
      if (parsed !== null && typeof parsed === "object" && "config" in parsed) {
        const risk = mermaidConfigFetchRisk(parsed.config);
        if (risk !== null) return risk;
      }
    }
    for (const directive of source.matchAll(/%%\{\s*(init|initialize)\s*:\s*([\s\S]*?)\}%%/giu)) {
      // Pele accepts JSON directives with single quotes as well as double quotes.
      const config: unknown = JSON.parse(directive[2]!.replaceAll("'", '"'));
      const risk = mermaidConfigFetchRisk(config);
      if (risk !== null) return risk;
    }
    return null;
  } catch {
    return "the diagram's settings could not be checked";
  }
}

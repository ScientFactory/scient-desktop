import type { DiagramModel } from "pele/lazy";
import { blockedCssResources, stripSvgExternalResources } from "./svgExternalResources";
import { mermaidCssStatements } from "./mermaidStyles";

/** Only parsed resource fields count; quoted prose and comments are not node data. */
export function mermaidModelResources(model: DiagramModel): readonly string[] {
  const values: unknown[] = [];
  if (model.type === "flowchart") {
    for (const node of model.nodes.values()) values.push(node.img, node.icon);
  } else if (model.type === "sequence") {
    for (const actor of model.actors.values()) values.push(actor.properties.get("icon"));
  }
  return values.filter(
    (value): value is string =>
      typeof value === "string" && value.length > 0 && !/^\s*(?:#|data:|blob:)/iu.test(value),
  );
}

/** Pele omits resources before emitting SVG, so notices must also inspect the inert source. */
export function blockedMermaidResources(
  source: string,
  modelResources: readonly string[] = [],
): readonly string[] {
  const configText = [
    ...source.matchAll(/%%\{[\s\S]*?\}%%/gu),
    ...source.matchAll(/^\s*---[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*---(?=\s|$)/gu),
  ].map((match) => match[0]);
  const addresses = [
    ...modelResources,
    ...stripSvgExternalResources(source).blocked,
    ...[...mermaidCssStatements(source), ...configText].flatMap(blockedCssResources),
  ];
  return [...new Set(addresses)];
}

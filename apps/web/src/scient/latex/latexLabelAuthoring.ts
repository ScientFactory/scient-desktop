import {
  latexSourceArgument as arg,
  latexSourceCommands,
  patchLatexSource,
  latexSourcePatches,
} from "./latexSourceSyntax";
import { latexLiteralBlock } from "./latexLiteral";
import type { LatexSourceEdit } from "./latexSourceEditPlan";

let inventoryCache: { source: string; inventory: ReturnType<typeof readLabelInventory> } | null =
  null;

/** Labels and references in `source`. Every object toolbar asks for the same
 * source; one scan per source version serves all of them. Treat as read-only.
 */
export function latexLabelInventory(source: string) {
  if (inventoryCache?.source !== source)
    inventoryCache = { source, inventory: readLabelInventory(source) };
  return inventoryCache.inventory;
}

function readLabelInventory(source: string) {
  const targets: { key: string; from: number; to: number; uses: number; duplicate: boolean }[] = [];
  const references: { from: number; to: number; keys: string[] }[] = [];
  let incomplete = false;
  for (const command of latexSourceCommands(source)) {
    if (command.name === "begin") {
      const listing = latexLiteralBlock(source, command.from);
      const label = listing?.environment === "lstlisting" ? listing.options.get("label") : null;
      if (label) {
        if (!/^[^{}\\%\s#$&~^,]+$/u.test(label.value)) incomplete = true;
        targets.push({
          key: label.value,
          from: label.from,
          to: label.to,
          uses: 0,
          duplicate: false,
        });
      }
    }
    if (["input", "include", "csname", "catcode"].includes(command.name)) incomplete = true;
    const label = command.name === "label" ? arg(source, command.to) : null;
    if (label)
      targets.push({ key: label.value, from: label.from, to: label.to, uses: 0, duplicate: false });
    const reference =
      command.name === "hyperref"
        ? arg(source, command.to, "[", "]")
        : ["ref", "eqref", "pageref", "autoref", "nameref", "cref", "Cref", "subref"].includes(
              command.name,
            )
          ? arg(source, command.to + (source[command.to] === "*" ? 1 : 0))
          : null;
    if (reference)
      references.push({
        from: reference.from,
        to: reference.to,
        keys: reference.value.split(",").map((key) => key.trim()),
      });
  }
  const uses = new Map<string, number>();
  for (const reference of references)
    for (const key of new Set(reference.keys)) uses.set(key, (uses.get(key) ?? 0) + 1);
  const definitions = new Map<string, number>();
  for (const target of targets) definitions.set(target.key, (definitions.get(target.key) ?? 0) + 1);
  for (const target of targets) {
    target.uses = uses.get(target.key) ?? 0;
    target.duplicate = definitions.get(target.key)! > 1;
  }
  return {
    targets,
    references,
    incomplete,
    unresolved: [...uses.keys()].filter((key) => !definitions.has(key)),
  };
}

export function renameLatexLabel(
  source: string,
  before: string,
  after: string,
): { source: string; edit: LatexSourceEdit } | { error: string } {
  const inventory = latexLabelInventory(source);
  if (!/^[^{}\\%\s#$&~^,]+$/u.test(after))
    return { error: "Use a label without spaces or LaTeX control characters." };
  if (before === after) return { source, edit: { source, patches: [] } };
  if (inventory.incomplete)
    return {
      error:
        "This document includes other files or dynamic labels. A rename needs coordinated edits in those source files.",
    };
  const target = inventory.targets.find((target) => target.key === before);
  if (!target || target.duplicate || inventory.targets.some((target) => target.key === after))
    return { error: "The old label must be unique and the new label must be unused." };
  const patches = [
    { from: target.from, to: target.to, value: after },
    ...inventory.references
      .filter((reference) => reference.keys.includes(before))
      .map((reference) => ({
        from: reference.from,
        to: reference.to,
        value: source
          .slice(reference.from, reference.to)
          .split(",")
          .map((part) => (part.trim() === before ? part.replace(before, after) : part))
          .join(","),
      })),
  ];
  const next = patchLatexSource(source, patches);
  return next === null
    ? { error: "The reference ranges overlap." }
    : { source: next, edit: { source, patches: latexSourcePatches(source, patches) } };
}

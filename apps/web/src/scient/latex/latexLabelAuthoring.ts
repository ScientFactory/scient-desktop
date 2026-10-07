import {
  latexSourceArgument as arg,
  latexSourceCommands,
  patchLatexSource,
} from "./latexSourceSyntax";

export function latexLabelInventory(source: string) {
  const targets: { key: string; from: number; to: number; uses: number; duplicate: boolean }[] = [];
  const references: { from: number; to: number; keys: string[] }[] = [];
  let incomplete = false;
  for (const command of latexSourceCommands(source)) {
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
  for (const target of targets) {
    target.uses = references.filter((ref) => ref.keys.includes(target.key)).length;
    target.duplicate = targets.filter((other) => other.key === target.key).length > 1;
  }
  return {
    targets,
    references,
    incomplete,
    unresolved: [...new Set(references.flatMap((ref) => ref.keys))].filter(
      (key) => !targets.some((target) => target.key === key),
    ),
  };
}

export function renameLatexLabel(
  source: string,
  before: string,
  after: string,
): { source: string } | { error: string } {
  const inventory = latexLabelInventory(source);
  if (!/^[^{}\\%\s#$&~^,]+$/u.test(after))
    return { error: "Use a label without spaces or LaTeX control characters." };
  if (before === after) return { source };
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
  return next === null ? { error: "The reference ranges overlap." } : { source: next };
}

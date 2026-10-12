import { latexSourceArgument, latexSourceCommands } from "./latexSourceSyntax";
import { latexLayoutLength } from "./latexPageLayouts";
import { latexWithoutComments, latexPreambleEnd } from "./latexSourceSyntax";

const sizes = new Set([
  "tiny",
  "scriptsize",
  "footnotesize",
  "small",
  "normalsize",
  "large",
  "Large",
  "LARGE",
  "huge",
  "Huge",
]);

/** Literal declarations are scoped by their owning group, never executed as TeX. */
export function latexContentDeclarations(source: string, start = 0) {
  let at = start;
  const style: Record<string, string | number> = {};
  for (let count = 0; count < 32; count++) {
    const trivia = /^(?:\s|%[^\r\n]*(?:\r?\n|$))*/u.exec(source.slice(at))![0];
    const next = at + trivia.length;
    const command = /^\\([A-Za-z]+)\b/u.exec(source.slice(next));
    if (!command) break;
    const name = command[1]!;
    let end = next + command[0].length;
    if (sizes.has(name)) style.size = name;
    else if (
      [
        "bfseries",
        "mdseries",
        "itshape",
        "upshape",
        "slshape",
        "centering",
        "noindent",
        "selectfont",
      ].includes(name)
    ) {
      if (name === "bfseries" || name === "mdseries")
        style.weight = name === "bfseries" ? 700 : 400;
      if (["itshape", "slshape", "upshape"].includes(name))
        style.fontStyle = name === "upshape" ? "normal" : "italic";
      if (name === "centering") style.alignment = "center";
    } else if (name === "color") {
      const color = latexSourceArgument(source, end);
      if (
        !color ||
        !/^[A-Za-z][A-Za-z0-9-]*(?:!\d+(?:\.\d+)?(?:![A-Za-z][A-Za-z0-9-]*)?)*$/u.test(color.value)
      )
        break;
      style.color = color.value;
      end = color.end;
    } else if (name === "fontsize") {
      const size = latexSourceArgument(source, end);
      const leading = size && latexSourceArgument(source, size.end);
      if (
        !size ||
        !leading ||
        !/^\d+(?:\.\d+)?(?:pt)?$/u.test(size.value) ||
        !/^\d+(?:\.\d+)?(?:pt)?$/u.test(leading.value)
      )
        break;
      const points = parseFloat(size.value),
        baseline = parseFloat(leading.value);
      if (points <= 0 || points > 100 || baseline <= 0 || baseline > 150) break;
      style.points = points;
      style.leading = baseline / points;
      end = leading.end;
    } else break;
    at = end;
  }
  return { from: at, style };
}

export function latexContentWrapper(source: string) {
  const colored = /^\\textcolor\b/u.exec(source);
  if (colored) {
    const color = latexSourceArgument(source, colored[0].length);
    const body = color && latexSourceArgument(source, color.end);
    if (body && !source.slice(body.end).trim() && /\\(?:rule|par|begin)\b/u.test(body.value))
      return {
        from: body.from,
        to: body.to,
        layout: { kind: "contentGroup", color: color!.value },
      };
  }
  const group = latexSourceArgument(source, 0);
  if (group?.open === 0 && !source.slice(group.end).trim()) {
    const declarations = latexContentDeclarations(source, group.from);
    return {
      from: declarations.from,
      to: group.to,
      layout: { kind: "contentGroup", ...declarations.style },
    };
  }
  const noindent = /^\\noindent\b\s*/u.exec(source);
  if (noindent)
    return { from: noindent[0].length, to: source.length, layout: { kind: "contentGroup" } };
  const declarations = latexContentDeclarations(source);
  if (declarations.from > 0 && declarations.from < source.trimEnd().length)
    return {
      from: declarations.from,
      to: source.length,
      layout: { kind: "contentGroup", ...declarations.style },
    };
  const paragraph = /^\\parbox\b/u.exec(source);
  if (paragraph) {
    const width = latexSourceArgument(source, paragraph[0].length);
    const body = width && latexSourceArgument(source, width.end);
    const css = width && latexLayoutLength(width.value);
    if (body && css && !source.slice(body.end).trim())
      return { from: body.from, to: body.to, layout: { kind: "contentGroup", width: css } };
  }
  const columns = /^\\twocolumn\b/u.exec(source);
  const title = columns && latexSourceArgument(source, columns[0].length, "[", "]");
  if (title && !source.slice(title.end).trim())
    return { from: title.from, to: title.to, layout: { kind: "fullWidthTitle" } };
  return null;
}

/** Only prefix metadata is consumed; every character after it belongs to the body. */
export function latexContentFloat(source: string) {
  const opening = /^\\begin\{(figure\*?|table\*?)\}(?:\[[htbpH!]*\])?/u.exec(source);
  if (!opening) return null;
  const closing = `\\end{${opening[1]}}`;
  if (!source.endsWith(closing)) return null;
  const to = source.length - closing.length;
  let at = opening[0].length;
  let caption: ReturnType<typeof latexSourceArgument> = null;
  let label: ReturnType<typeof latexSourceArgument> = null;
  let centered = false;
  for (let count = 0; count < 8; count++) {
    const next = at + /^(?:\s|%[^\r\n]*(?:\r?\n|$))*/u.exec(source.slice(at))![0].length;
    const command = /^\\(centering|caption|label)\b/u.exec(source.slice(next));
    if (!command) break;
    if (command[1] === "centering") {
      centered = true;
      at = next + command[0].length;
      continue;
    }
    const value = latexSourceArgument(source, next + command[0].length);
    if (!value || (command[1] === "caption" ? caption : label)) return null;
    if (command[1] === "caption") caption = value;
    else label = value;
    at = value.end;
  }
  // Metadata outside the owned prefix needs the dedicated float adapter.
  if (
    latexSourceCommands(source.slice(at, to)).some(
      (c) => ["caption", "label"].includes(c.name) && c.depth === 0,
    )
  )
    return null;
  return {
    from: at,
    to,
    caption,
    label,
    environment: opening[1]!,
    layout: {
      kind: "contentFloat",
      floatType: opening[1]!.startsWith("table") ? "table" : "figure",
      captioned: !!caption,
      centered,
    },
  };
}

/** One literal argument, styled exactly once. Additional TeX or parameters stay opaque. */
export function latexContentHeadingMacros(source: string) {
  const preamble = source.slice(0, latexPreambleEnd(source));
  const macros = new Map<
    string,
    {
      style: Record<string, string | number>;
      before: string;
      after: string;
      rule: boolean;
      ruleColor: string;
      ruleHeight: string;
    }
  >();
  let conditional = 0;
  for (const command of latexSourceCommands(preamble)) {
    if (!command.depth && command.name.startsWith("if")) conditional++;
    if (!command.depth && command.name === "fi") conditional = Math.max(0, conditional - 1);
    if (command.depth || !["newcommand", "renewcommand"].includes(command.name)) continue;
    const name = latexSourceArgument(preamble, command.to);
    const count = name && latexSourceArgument(preamble, name.end, "[", "]");
    const body = count && latexSourceArgument(preamble, count.end);
    if (!name || !/^\\[A-Za-z]+$/u.test(name.value) || count?.value.trim() !== "1" || !body)
      continue;
    const key = name.value.slice(1);
    macros.delete(key);
    if (conditional || body.value.length > 4096) continue;
    const definition = latexWithoutComments(body.value).trim();
    const contentAt = definition.indexOf("#1");
    if (
      contentAt < 0 ||
      definition.indexOf("#1", contentAt + 2) >= 0 ||
      /#(?:[2-9]|[^1])/u.test(definition)
    )
      continue;
    // Permit only local typography, paragraph spacing, and a literal separator rule.
    if (
      latexSourceCommands(definition).some(
        (c) =>
          ![
            ...sizes,
            "par",
            "vspace",
            "noindent",
            "bfseries",
            "mdseries",
            "itshape",
            "upshape",
            "slshape",
            "color",
            "textcolor",
            "rule",
            "columnwidth",
            "linewidth",
            "textwidth",
          ].includes(c.name),
      )
    )
      continue;
    const stripped = definition.replace(
      /\\vspace\{[^{}]+\}|\\textcolor\{[^{}]+\}\{\\rule\{\\(?:columnwidth|linewidth|textwidth)\}\{[^{}]+\}\}|\\par\b|\\noindent\b/gu,
      "",
    );
    const scope = /^\s*\{([\s\S]*)\}\s*$/u.exec(stripped)?.[1] ?? stripped;
    const declarations = latexContentDeclarations(scope);
    if (scope.slice(declarations.from).trim() !== "#1") continue;
    const lengths = [...definition.matchAll(/\\vspace\{([^{}]+)\}/gu)];
    if (lengths.some((m) => !latexLayoutLength(m[1]!))) continue;
    const rule =
      /\\textcolor\{([^{}]+)\}\{\\rule\{\\(?:columnwidth|linewidth|textwidth)\}\{([^{}]+)\}\}/u.exec(
        definition,
      );
    if (rule && !latexLayoutLength(rule[2]!)) continue;
    macros.set(key, {
      style: declarations.style,
      before: latexLayoutLength(lengths.find((m) => m.index! < contentAt)?.[1] ?? "0pt")!,
      after: latexLayoutLength(lengths.findLast((m) => m.index! > contentAt)?.[1] ?? "0pt")!,
      rule: !!rule,
      ruleColor: rule?.[1] ?? "",
      ruleHeight: rule ? latexLayoutLength(rule[2]!)! : "0px",
    });
  }
  return macros;
}

export function latexContentHeading(
  source: string,
  macros: ReturnType<typeof latexContentHeadingMacros>,
) {
  const command = /^\\([A-Za-z]+)\b/u.exec(source);
  const macro = command && macros.get(command[1]!);
  const argument = macro && latexSourceArgument(source, command![0].length);
  return argument && !source.slice(argument.end).trim()
    ? {
        from: argument.from,
        to: argument.to,
        layout: {
          kind: "macroHeading",
          ...macro.style,
          before: macro.before,
          after: macro.after,
          rule: macro.rule,
          ruleColor: macro.ruleColor,
          ruleHeight: macro.ruleHeight,
        },
      }
    : null;
}

export function latexContentBoundary(
  source: string,
  macros?: ReturnType<typeof latexContentHeadingMacros>,
  calls?: ReadonlyMap<string, number>,
) {
  const column = /^\\(?:twocolumn|onecolumn)\b/u.exec(source);
  if (column)
    return latexSourceArgument(source, column[0].length, "[", "]")?.end ?? column[0].length;
  const length = /^\\(?:vspace\*?|rule)\b/u.exec(source);
  if (length) {
    const first = latexSourceArgument(source, length[0].length);
    return length[0].includes("rule")
      ? first && latexSourceArgument(source, first.end)?.end
      : first?.end;
  }
  const command = /^\\([A-Za-z]+)\b/u.exec(source);
  if (command && macros?.has(command[1]!))
    return latexSourceArgument(source, command[0].length)?.end;
  if (command && calls?.has(command[1]!)) {
    let end = command[0].length;
    for (let argument = 0; argument < calls.get(command[1]!)!; argument++) {
      const value = latexSourceArgument(source, end);
      if (!value) return undefined;
      end = value.end;
    }
    if (/^[\t ]*(?:%[^\r\n]*)?\r?\n/u.test(source.slice(end))) return end;
  }
  return undefined;
}

/** Argument ownership can be known even when a macro's appearance is unsupported. */
export function latexContentCallCounts(source: string) {
  const calls = new Map<string, number>();
  const preamble = source.slice(0, latexPreambleEnd(source));
  let conditional = 0;
  for (const command of latexSourceCommands(preamble)) {
    if (command.depth) continue;
    if (command.name.startsWith("if")) conditional++;
    if (command.name === "fi") conditional = Math.max(0, conditional - 1);
    if (!["newcommand", "renewcommand"].includes(command.name)) continue;
    const name = latexSourceArgument(preamble, command.to);
    if (!name || !/^\\[A-Za-z]+$/u.test(name.value)) continue;
    const key = name.value.slice(1);
    calls.delete(key);
    const count = latexSourceArgument(preamble, name.end, "[", "]");
    const body = latexSourceArgument(preamble, count?.end ?? name.end);
    if (!conditional && body && (!count || /^[0-9]$/u.test(count.value.trim())))
      calls.set(key, count ? Number(count.value) : 0);
  }
  return calls;
}

import {
  latexSourceArgument as arg,
  latexSourceCommands,
  patchLatexSource,
} from "./latexSourceSyntax";
import { latexLayoutLength, latexMinipageSeparator } from "./latexPageLayouts";

/** Replace one literal key, retaining all other options and the body verbatim. */
export function setLatexEnvironmentOption(
  source: string,
  environment: string,
  key: string,
  value: string | null,
): { source: string } | { error: string } {
  const opening = `\\begin{${environment}}`;
  if (!source.startsWith(opening)) return { error: "This environment has a custom opening." };
  const options = arg(source, opening.length, "[", "]");
  const raw = options?.value ?? "";
  const pieces: string[] = [];
  let start = 0,
    depth = 0;
  for (let at = 0; at <= raw.length; at++) {
    if (raw[at] === "\\") at++;
    else if (raw[at] === "{") depth++;
    else if (raw[at] === "}") depth--;
    else if ((!depth && raw[at] === ",") || at === raw.length) {
      pieces.push(raw.slice(start, at));
      start = at + 1;
    }
  }
  const indexes = pieces.flatMap((part, index) =>
    part.trim().split(/\s*=/u)[0] === key ? [index] : [],
  );
  if (indexes.length > 1)
    return { error: "This option is repeated. Resolve its source before changing it." };
  const entry = value === null ? "" : value === "" ? key : `${key}=${value}`;
  if (indexes[0] !== undefined) pieces[indexes[0]] = entry;
  else if (entry) pieces.push(entry);
  const next = pieces.filter((part) => part.trim()).join(",");
  const from = options?.open ?? opening.length;
  const to = options?.end ?? opening.length;
  return { source: source.slice(0, from) + (next ? `[${next}]` : "") + source.slice(to) };
}

export function setLatexLayoutOpening(
  source: string,
  options: {
    columns?: number;
    width?: string;
    alignment?: string;
    height?: string;
    innerAlignment?: string;
  },
): { source: string } | { error: string } {
  if (source.startsWith("\\begin{multicols}")) {
    const count = arg(source, "\\begin{multicols}".length);
    if (
      !count ||
      !Number.isInteger(options.columns) ||
      options.columns! < 2 ||
      options.columns! > 10
    )
      return { error: "Choose between two and ten columns." };
    return { source: source.slice(0, count.from) + options.columns + source.slice(count.to) };
  }
  const opening = "\\begin{minipage}";
  if (!source.startsWith(opening))
    return { error: "Select an individual panel to edit its dimensions." };
  let at = opening.length;
  for (let index = 0; index < 3; index++) {
    const optional = arg(source, at, "[", "]");
    if (!optional) break;
    at = optional.end;
  }
  const width = arg(source, at);
  if (!width) return { error: "This panel has a custom width." };
  if (
    !/^(?:\d+(?:\.\d+)?|\.\d+)(?:mm|cm|in|pt|em|\\linewidth)$/u.test(options.width ?? "") ||
    !/^[tcb]$/u.test(options.alignment ?? "")
  )
    return { error: "Choose an alignment and a width such as 0.46\\linewidth or 60mm." };
  if (options.height && !/^(?:\d+(?:\.\d+)?|\.\d+)(?:mm|cm|in|pt|em)$/u.test(options.height))
    return { error: "Use a fixed height such as 30mm, or leave it empty." };
  return {
    source: `${opening}[${options.alignment}]${options.height ? `[${options.height}][${options.innerAlignment ?? "t"}]` : ""}{${options.width}}${source.slice(width.end)}`,
  };
}

export function setLatexPanelRow(
  source: string,
  ratios: readonly number[],
  gap: string,
): { source: string } | { error: string } {
  if (
    ratios.length < 2 ||
    ratios.length > 6 ||
    ratios.some((value) => !Number.isFinite(value) || value <= 0)
  )
    return { error: "Use two to six positive panel ratios." };
  if (gap !== "auto" && (!latexLayoutLength(gap) || latexLayoutLength(gap)!.endsWith("%")))
    return { error: "Choose an automatic gap or a fixed spacing." };
  const panels: { from: number; to: number; width: NonNullable<ReturnType<typeof arg>> }[] = [];
  let depth = 0,
    from = 0;
  let width: ReturnType<typeof arg> = null;
  for (const command of latexSourceCommands(source)) {
    if (!["begin", "end"].includes(command.name) || command.depth !== 0) continue;
    const env = arg(source, command.to);
    if (env?.value !== "minipage") continue;
    if (command.name === "begin") {
      if (depth++ > 0) continue;
      from = command.from;
      let at = env.end;
      for (let i = 0; i < 3; i++) {
        const option = arg(source, at, "[", "]");
        if (option) at = option.end;
      }
      width = arg(source, at);
      if (!width) return { error: "This panel has a custom opening." };
    } else if (--depth === 0 && width) panels.push({ from, to: env.end, width });
  }
  if (depth || !panels.length || panels.length > ratios.length)
    return { error: "Remove an unwanted panel explicitly before reducing the panel count." };
  if (source.slice(0, panels[0]!.from).trim() || source.slice(panels.at(-1)!.to).trim())
    return { error: "Select the side-by-side region to change its layout." };
  const patches: { from: number; to: number; value: string }[] = [];
  const total = ratios.reduce((sum, value) => sum + value, 0);
  const size = (i: number) => `${Number(((0.92 * ratios[i]!) / total).toFixed(5))}\\linewidth`;
  const separator = gap === "auto" ? "\\hfill\n" : `\\hspace{${gap}}\n`;
  panels.forEach((panel, i) => {
    patches.push({ from: panel.width.from, to: panel.width.to, value: size(i) });
  });
  for (let i = 1; i < panels.length; i++) {
    const from = panels[i - 1]!.to,
      to = panels[i]!.from;
    const between = source.slice(from, to);
    if (!latexMinipageSeparator(source.slice(from)))
      return { error: "The space between these panels contains custom layout source." };
    const comments = [...between.matchAll(/%[^\r\n]*(?:\r?\n|$)/gu)]
      .map((match) => match[0])
      .join("");
    patches.push({ from, to, value: separator + comments });
  }
  if (ratios.length > panels.length)
    patches.push({
      from: source.length,
      to: source.length,
      value: ratios
        .slice(panels.length)
        .map(
          (_ratio, i) =>
            `${separator}\\begin{minipage}[t]{${size(panels.length + i)}}\n\n\\end{minipage}`,
        )
        .join(""),
    });
  const next = patchLatexSource(source, patches);
  return next === null ? { error: "The panel ranges overlap." } : { source: next };
}

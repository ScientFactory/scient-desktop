import { latexLayoutLength } from "./latexPageLayouts";
import { latexSourceCommands, latexSourceArgument } from "./latexSourceSyntax";
/** Literal xcolor expressions and a bounded tcolorbox adapter; no TeX execution. */
const basic: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#00ff00",
  blue: "#0000ff",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  yellow: "#ffff00",
  gray: "#808080",
  darkgray: "#404040",
  lightgray: "#bfbfbf",
  brown: "#bf8040",
  lime: "#bfff00",
  olive: "#808000",
  orange: "#ff8000",
  pink: "#ffbfbf",
  purple: "#bf0040",
  teal: "#008080",
  violet: "#800080",
};

export function latexDocumentColors(source: string): Record<string, string> {
  const colors = { ...basic };
  const preamble = source.split("\\begin{document}")[0]!.replace(/(?<!\\)%[^\r\n]*/gu, "");
  let conditional = 0,
    through = 0;
  for (const command of latexSourceCommands(preamble)) {
    if (command.depth !== 0 || command.from < through) continue;
    if (command.name === "newif") {
      through = command.to + (/^\s*\\\w+/u.exec(preamble.slice(command.to))?.[0].length ?? 0);
      continue;
    }
    if (command.name.startsWith("if")) {
      conditional++;
      continue;
    }
    if (command.name === "fi") {
      conditional = Math.max(0, conditional - 1);
      continue;
    }
    if (conditional || !["definecolor", "providecolor", "colorlet"].includes(command.name))
      continue;
    const named = latexSourceArgument(preamble, command.to);
    const mode = named && latexSourceArgument(preamble, named.end);
    if (!named || !mode || !/^[A-Za-z][A-Za-z0-9-]*$/u.test(named.value)) continue;
    const name = named.value;
    if (command.name === "providecolor" && colors[name]) continue;
    if (command.name === "colorlet") {
      const value = latexColorCss(mode.value, colors);
      if (value)
        colors[name] = value.replace(
          /var\(--scient-color-([A-Za-z0-9-]+)\)/gu,
          (_match, name: string) => colors[name]!,
        );
      continue;
    }
    const literal = latexSourceArgument(preamble, mode.end);
    if (!literal || !["HTML", "rgb", "RGB", "gray"].includes(mode.value)) continue;
    const model = mode.value,
      value = literal.value;
    if (model === "HTML" && /^[a-fA-F0-9]{6}$/u.test(value!.trim()))
      colors[name!] = `#${value!.trim()}`;
    else if (model !== "HTML") {
      const parts = value!.split(",").map(Number);
      const maximum = model === "RGB" ? 255 : 1;
      if (
        parts.length !== (model === "gray" ? 1 : 3) ||
        parts.some((part) => !Number.isFinite(part) || part < 0 || part > maximum)
      )
        continue;
      const rgb = model === "gray" ? [parts[0]!, parts[0]!, parts[0]!] : parts;
      colors[name!] = `rgb(${rgb.map((part) => Math.round((part / maximum) * 255)).join(" ")})`;
    }
  }
  return colors;
}

export function latexColorCss(expression: string, known?: Record<string, string>): string | null {
  const parts = expression.trim().split("!");
  const color = (name: string) =>
    /^[A-Za-z][A-Za-z0-9-]*$/u.test(name) && (!known || Object.hasOwn(known, name))
      ? `var(--scient-color-${name})`
      : null;
  let result = color(parts[0] ?? "");
  if (!result) return null;
  for (let index = 1; index < parts.length; index += 2) {
    const percent = parts[index]!;
    const mixed = color(parts[index + 1] ?? "white");
    if (!/^\d+(?:\.\d+)?$/u.test(percent) || Number(percent) > 100 || !mixed) return null;
    result = `color-mix(in srgb, ${result} ${percent}%, ${mixed})`;
  }
  return result;
}

function argument(source: string, at: number) {
  while (/\s/u.test(source[at] ?? "")) at++;
  if (source[at] !== "{") return null;
  let depth = 1;
  for (let to = at + 1; to < source.length; to++) {
    if (source[to] === "\\") to++;
    else if (source[to] === "{") depth++;
    else if (source[to] === "}" && --depth === 0)
      return { from: at + 1, to, end: to + 1, value: source.slice(at + 1, to) };
  }
  return null;
}

export function latexInlineColor(source: string, at: number) {
  const command = /^\\(textcolor|colorbox|fcolorbox|fbox)\b/u.exec(source.slice(at));
  if (!command) return null;
  const first = argument(source, at + command[0].length);
  if (command[1] === "fbox" && first)
    return { body: first, attrs: { command: "fbox", color: "black", background: "" } };
  const second = first && argument(source, first.end);
  const body = command[1] === "fcolorbox" ? second && argument(source, second.end) : second;
  if (
    !first ||
    !second ||
    !body ||
    !latexColorCss(first.value) ||
    (command[1] === "fcolorbox" && !latexColorCss(second.value))
  )
    return null;
  return {
    body,
    attrs: {
      command: command[1]!,
      color: first.value,
      background: command[1] === "fcolorbox" ? second.value : "",
    },
  };
}

export function latexColorMarkSource(
  attrs: Record<string, unknown> | undefined,
  text: string,
): string | null {
  const command = String(attrs?.command ?? "");
  const color = String(attrs?.color ?? "");
  const background = String(attrs?.background ?? "");
  if (command === "fbox") return `\\fbox{${text}}`;
  if (
    !["textcolor", "colorbox", "fcolorbox"].includes(command) ||
    !latexColorCss(color) ||
    (command === "fcolorbox" && !latexColorCss(background))
  )
    return null;
  return `\\${command}{${color}}${command === "fcolorbox" ? `{${background}}` : ""}{${text}}`;
}

export function latexColorBoxOpening(source: string) {
  const opening = /^\\begin\{tcolorbox\}/u.exec(source);
  if (!opening || !source.endsWith("\\end{tcolorbox}")) return null;
  let from = opening[0].length;
  while (/\s/u.test(source[from] ?? "")) from++;
  const layout = {
    kind: "colorBox",
    colback: "black!5",
    colframe: "black!75",
    coltitle: "white",
    breakable: false,
    padding: "3mm",
    borderWidth: "0.5mm",
    radius: "1mm",
    boldTitle: false,
    shadow: false,
    frameHidden: false,
    borderSide: "all",
    borderStyle: "solid",
    borderColor: "",
    colbacklower: "",
    titleAfterBreak: "",
    alignment: "left",
  };
  let title = "";
  let titleRange: { from: number; to: number } | null = null;
  if (source[from] === "[") {
    const start = ++from;
    let depth = 0,
      itemStart = start;
    const entries: { from: number; to: number }[] = [];
    for (; from < source.length; from++) {
      const ch = source[from];
      if (ch === "\\") from++;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (!depth && (ch === "," || ch === "]")) {
        entries.push({ from: itemStart, to: from });
        itemStart = from + 1;
        if (ch === "]") break;
      }
    }
    if (source[from] !== "]") return null;
    for (const entry of entries) {
      const text = source.slice(entry.from, entry.to).trim();
      if (!text) continue;
      if (text === "breakable") {
        layout.breakable = true;
        continue;
      }
      if (text === "enhanced" || text === "bicolor") continue;
      if (text === "sharp corners") {
        layout.radius = "0px";
        continue;
      }
      if (text === "drop shadow") {
        layout.shadow = true;
        continue;
      }
      if (text === "frame hidden") {
        layout.frameHidden = true;
        continue;
      }
      const border = /^borderline( west)?\s*=\s*/u.exec(text);
      if (border) {
        const value = text.slice(border[0].length);
        const width = argument(value, 0);
        const offset = width && argument(value, width.end);
        const paint = offset && argument(value, offset.end);
        const cssWidth = width && latexLayoutLength(width.value);
        const cssOffset = offset && latexLayoutLength(offset.value);
        const color =
          paint &&
          /^([^,]+)(?:,\s*dash pattern=on ([\d.]+pt) off ([\d.]+pt))?$/u.exec(paint.value.trim());
        if (
          !cssWidth ||
          cssWidth.endsWith("%") ||
          cssOffset !== "0in" ||
          !paint ||
          value.slice(paint.end).trim() ||
          !color ||
          !latexColorCss(color[1]!)
        )
          return null;
        layout.borderWidth = cssWidth;
        layout.borderColor = color[1]!.trim();
        layout.borderSide = border[1] ? "west" : "all";
        layout.borderStyle = color[2] ? "dashed" : "solid";
        continue;
      }
      const key =
        /^(title after break|title|colbacklower|colback|colframe|coltitle|boxsep|boxrule|arc|fonttitle)\s*=\s*/u.exec(
          text,
        );
      if (!key) return null;
      let value = text.slice(key[0].length).trim();
      const valueAt = entry.from + source.slice(entry.from, entry.to).indexOf(text) + key[0].length;
      const grouped = argument(source, valueAt);
      if (value.startsWith("{")) {
        if (!grouped || source.slice(grouped.end, entry.to).trim()) return null;
        value = grouped.value;
      }
      if (key[1] === "title after break") {
        layout.titleAfterBreak = value;
      } else if (key[1] === "title") {
        title = value;
        titleRange = grouped
          ? { from: grouped.from, to: grouped.to }
          : { from: valueAt, to: valueAt + value.length };
      } else if (["boxsep", "boxrule", "arc"].includes(key[1]!)) {
        const length = latexLayoutLength(value);
        if (!length || length.endsWith("%")) return null;
        if (key[1] === "boxsep") layout.padding = length;
        if (key[1] === "boxrule") layout.borderWidth = length;
        if (key[1] === "arc") layout.radius = length;
      } else if (key[1] === "fonttitle") {
        if (!["\\bfseries", "\\mdseries"].includes(value)) return null;
        layout.boldTitle = value === "\\bfseries";
      } else {
        if (!latexColorCss(value)) return null;
        layout[key[1] as "colback" | "colframe" | "coltitle" | "colbacklower"] = value;
      }
    }
    from++;
  }
  const centered = /^\s*\\centering\b\s*/u.exec(source.slice(from));
  if (centered) {
    from += centered[0].length;
    layout.alignment = "center";
  }
  return { from, to: source.length - "\\end{tcolorbox}".length, title, titleRange, layout };
}

/** The separator belongs to this box, never to a nested environment or argument. */
export function latexColorBoxSplit(source: string) {
  let environments = 0;
  let split: { from: number; to: number } | null = null;
  for (const command of latexSourceCommands(source)) {
    if (command.depth !== 0) continue;
    if (command.name === "begin") {
      const environment = latexSourceArgument(source, command.to)?.value;
      // The command scanner already skips literal bodies and their closing tokens.
      if (!/^(?:verbatim\*?|lstlisting|tcblisting|minted|Verbatim)$/u.test(environment ?? ""))
        environments++;
    } else if (command.name === "end") environments--;
    else if (command.name === "tcblower" && environments === 0) {
      if (split) return null;
      split = { from: command.from, to: command.to };
    }
  }
  return split;
}

/** Recognize only the literal increment-and-repeat form; never evaluate arbitrary TeX. */
export function expandColorBoxLoop(source: string) {
  if (!/\\(?:loop|newcount)\b/u.test(source)) return { source, loop: null };
  const match =
    /\\newcount\s*\\([A-Za-z]+)\s*\\\1\s*=\s*(\d+)\s*\\loop\s*\\advance\s*\\\1\s+by\s+1\s*([\s\S]*?)\\ifnum\s*\\\1\s*<\s*(\d+)\s*\\repeat/u.exec(
      source,
    );
  if (!match) return null;
  const start = Number(match[2]),
    end = Number(match[4]);
  if (start >= end || end - start > 100 || end > 10000) return null;
  const template = match[3]!;
  const counter = new RegExp(`\\\\the\\\\${match[1]}(?![A-Za-z])`, "gu");
  if (/\\(?:loop|repeat|newcount|advance|ifnum)\b/u.test(template)) return null;
  const expanded = Array.from({ length: end - start }, (_, index) =>
    template.replace(counter, String(start + index + 1)),
  ).join("\n");
  if (expanded.length > 100000) return null;
  const next =
    source.slice(0, match.index) + expanded + source.slice(match.index + match[0].length);
  if (/\\(?:loop|repeat|newcount|advance|ifnum)\b/u.test(next)) return null;
  return { source: next, loop: { raw: match[0], expanded } };
}

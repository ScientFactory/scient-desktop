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
  for (const match of preamble.matchAll(
    /\\definecolor\s*\{([A-Za-z][A-Za-z0-9-]*)\}\s*\{(HTML|rgb|RGB|gray)\}\s*\{([^{}]+)\}/gu,
  )) {
    const [, name, model, value] = match;
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
  const command = /^\\(textcolor|colorbox|fcolorbox)\b/u.exec(source.slice(at));
  if (!command) return null;
  const first = argument(source, at + command[0].length);
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
      const key = /^(title|colback|colframe|coltitle)\s*=\s*/u.exec(text);
      if (!key) return null;
      let value = text.slice(key[0].length).trim();
      const valueAt = entry.from + source.slice(entry.from, entry.to).indexOf(text) + key[0].length;
      const grouped = argument(source, valueAt);
      if (value.startsWith("{")) {
        if (!grouped || source.slice(grouped.end, entry.to).trim()) return null;
        value = grouped.value;
      }
      if (key[1] === "title") {
        if (/[\\{}%#$&_^~]/u.test(value)) return null;
        title = value;
        titleRange = grouped
          ? { from: grouped.from, to: grouped.to }
          : { from: valueAt, to: valueAt + value.length };
      } else {
        if (!latexColorCss(value)) return null;
        layout[key[1] as "colback" | "colframe" | "coltitle"] = value;
      }
    }
    from++;
  }
  return { from, to: source.length - "\\end{tcolorbox}".length, title, titleRange, layout };
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

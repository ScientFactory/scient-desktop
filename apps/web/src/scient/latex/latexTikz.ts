/** A bounded TikZ adapter. Unsupported commands/options keep the whole object in Source. */
interface SourceValue {
  from: number;
  to: number;
  value: string;
}
export interface TikzPoint {
  x: SourceValue;
  y: SourceValue;
}
export interface TikzShape {
  kind: "line" | "point";
  points: TikzPoint[];
  color: string;
  width: number;
  arrow: string;
  radius: number;
  label: (SourceValue & { placement: "right" | "left" | "above" | "below" }) | null;
}
const number = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
const coordinate = new RegExp(`^\\(\\s*(${number})\\s*,\\s*(${number})\\s*\\)`, "u");
const numeric = new RegExp(`^${number}$`, "u");
const colors: Record<string, string> = {
  black: "#000",
  blue: "#00f",
  red: "#f00",
  green: "#0f0",
  gray: "#808080",
  orange: "#ff8000",
  purple: "#bf0040",
};

function skip(source: string, at: number): number {
  while (at < source.length) {
    if (/\s/u.test(source[at]!)) at++;
    else if (source[at] === "%") {
      const newline = source.indexOf("\n", at);
      at = newline < 0 ? source.length : newline + 1;
    } else break;
  }
  return at;
}

function group(source: string, at: number, open = "{", close = "}") {
  at = skip(source, at);
  if (source[at] !== open) return null;
  const from = at + 1;
  let depth = 1;
  for (let end = from; end < source.length; end++) {
    if (source[end] === "\\") end++;
    else if (source[end] === "%") {
      const newline = source.indexOf("\n", end);
      if (newline < 0) return null;
      end = newline;
    } else if (source[end] === open) depth++;
    else if (source[end] === close && --depth === 0)
      return { from, to: end, value: source.slice(from, end), end: end + 1 };
  }
  return null;
}

function point(source: string, at: number) {
  const match = coordinate.exec(source.slice(at));
  if (!match) return null;
  const xAt = at + match[0].indexOf(match[1]!);
  const yAt = at + match[0].indexOf(match[2]!, match[0].indexOf(",") + 1);
  const x = { from: xAt, to: xAt + match[1]!.length, value: match[1]! };
  const y = { from: yAt, to: yAt + match[2]!.length, value: match[2]! };
  if (Math.abs(Number(x.value)) > 1000 || Math.abs(Number(y.value)) > 1000) return null;
  return { point: { x, y }, end: at + match[0].length };
}

function style(options: string) {
  let color = colors.black!,
    width = 0.4,
    arrow = "";
  for (const option of options
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    if (colors[option]) color = colors[option]!;
    else if (["->", "<-", "<->", "-"].includes(option)) arrow = option;
    else if (option === "thick") width = 0.8;
    else if (option === "very thick") width = 1.2;
    else if (option === "thin") width = 0.4;
    else if (option === "very thin") width = 0.2;
    else return null;
  }
  return { color, width, arrow };
}

export function parseLatexTikz(source: string) {
  if (source.length > 50_000) return null;
  const opening = /^\\begin\{tikzpicture\}/u.exec(source);
  if (!opening) return null;
  let at = skip(source, opening[0].length);
  const options = group(source, at, "[", "]");
  let scale = 1;
  let scaleRange: SourceValue | null = null;
  if (options) {
    const match = new RegExp(`^\\s*scale\\s*=\\s*(${number})\\s*$`, "u").exec(options.value);
    if (!match) return null;
    scale = Number(match[1]);
    if (scale <= 0 || scale > 10) return null;
    const from = options.from + options.value.indexOf(match[1]!, options.value.indexOf("=") + 1);
    scaleRange = { from, to: from + match[1]!.length, value: match[1]! };
    at = skip(source, options.end);
  }
  const shapes: TikzShape[] = [];
  while (!source.startsWith("\\end{tikzpicture}", at)) {
    if (shapes.length >= 300) return null;
    const loop = /^\\foreach\s+\\([A-Za-z]+)\s*\/\s*\\([A-Za-z]+)\s+in\s*/u.exec(source.slice(at));
    if (loop) {
      const values = group(source, at + loop[0].length);
      const body = values && group(source, values.end);
      if (!values || !body) return null;
      const fill =
        /^\s*\\fill\s*\(\s*\\([A-Za-z]+)\s*,\s*\\([A-Za-z]+)\s*\)\s*circle\s*\(\s*([\d.]+)pt\s*\)\s*;\s*$/u.exec(
          body.value,
        );
      if (!fill || fill[1] !== loop[1] || fill[2] !== loop[2] || !numeric.test(fill[3]!))
        return null;
      const radius = Number(fill[3]);
      if (radius <= 0 || radius > 100) return null;
      let offset = values.from;
      for (const entry of values.value.split(",")) {
        const pair = new RegExp(`^\\s*(${number})\\s*/\\s*(${number})\\s*$`, "u").exec(entry);
        if (!pair || shapes.length >= 300) return null;
        const xAt = offset + entry.indexOf(pair[1]!);
        const yAt = offset + entry.indexOf(pair[2]!, entry.indexOf("/") + 1);
        if (Math.abs(Number(pair[1])) > 1000 || Math.abs(Number(pair[2])) > 1000) return null;
        shapes.push({
          kind: "point",
          points: [
            {
              x: { from: xAt, to: xAt + pair[1]!.length, value: pair[1]! },
              y: { from: yAt, to: yAt + pair[2]!.length, value: pair[2]! },
            },
          ],
          color: colors.black!,
          width: 0,
          arrow: "",
          radius,
          label: null,
        });
        offset += entry.length + 1;
      }
      at = skip(source, body.end);
      continue;
    }
    const command = /^\\(draw|fill)\b/u.exec(source.slice(at));
    if (!command) return null;
    at = skip(source, at + command[0].length);
    const options = group(source, at, "[", "]");
    const presentation = style(options?.value ?? "");
    if (!presentation) return null;
    if (options) at = skip(source, options.end);
    const start = point(source, at);
    if (!start) return null;
    const points = [start.point];
    at = skip(source, start.end);
    if (command[1] === "fill") {
      if (presentation.arrow) return null;
      const circle = new RegExp(`^circle\\s*\\(\\s*(${number})pt\\s*\\)\\s*;`, "u").exec(
        source.slice(at),
      );
      if (!circle || Number(circle[1]) <= 0 || Number(circle[1]) > 100) return null;
      shapes.push({
        kind: "point",
        points,
        ...presentation,
        radius: Number(circle[1]),
        label: null,
      });
      at = skip(source, at + circle[0].length);
      continue;
    }
    while (source.startsWith("--", at)) {
      at = skip(source, at + 2);
      const next = point(source, at);
      if (!next || points.length >= 300) return null;
      points.push(next.point);
      at = skip(source, next.end);
    }
    if (points.length < 2) return null;
    let label: TikzShape["label"] = null;
    const node = /^node\s*\[\s*(right|left|above|below)\s*\]/u.exec(source.slice(at));
    if (node) {
      const text = group(source, at + node[0].length);
      if (!text) return null;
      const value = text.value;
      if (!/^\$[^$]+\$$/u.test(value) && /[\\{}$%&#_^]/u.test(value)) return null;
      label = {
        from: text.from,
        to: text.to,
        value,
        placement: node[1] as "right" | "left" | "above" | "below",
      };
      at = skip(source, text.end);
    }
    if (source[at] !== ";") return null;
    shapes.push({ kind: "line", points, ...presentation, radius: 0, label });
    at = skip(source, at + 1);
  }
  if (!shapes.length || skip(source, at + "\\end{tikzpicture}".length) !== source.length)
    return null;
  return { scale, scaleRange, shapes };
}

/** Patch one numeric argument or label and reject any edit outside the supported grammar. */
export function patchLatexTikz(source: string, range: SourceValue, value: string): string | null {
  if (source.slice(range.from, range.to) !== range.value) return null;
  const result = source.slice(0, range.from) + value + source.slice(range.to);
  return parseLatexTikz(result) ? result : null;
}

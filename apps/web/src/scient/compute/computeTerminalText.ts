/** A run of text with one SGR style; `fg`/`bg` are a 16-colour palette index or a CSS colour. */
export interface TerminalStyle {
  readonly fg?: number | string;
  readonly bg?: number | string;
  readonly bold?: true;
  readonly dim?: true;
  readonly italic?: true;
  readonly underline?: true;
}

export interface TerminalRun {
  /** Offset of the run in `text`; stable for identical output. */
  readonly offset: number;
  readonly text: string;
  readonly style: TerminalStyle | null;
}

export interface TerminalText {
  /** What a terminal would show, without control sequences. */
  readonly text: string;
  readonly runs: ReadonlyArray<TerminalRun>;
}

const CONTROL = /[\u001b\r\b]/u;
const CSI_FINAL = /[@-~]/u;

function cubeColor(index: number): string {
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }
  const cube = index - 16;
  const channel = (value: number) => (value === 0 ? 0 : 55 + value * 40);
  return `rgb(${channel(Math.floor(cube / 36))}, ${channel(Math.floor(cube / 6) % 6)}, ${channel(cube % 6)})`;
}

function extendedColor(params: ReadonlyArray<number>, index: number) {
  const mode = params[index + 1];
  if (mode === 5) {
    const value = params[index + 2] ?? 0;
    return { color: value < 16 ? value : cubeColor(Math.min(255, value)), consumed: 2 };
  }
  if (mode === 2) {
    const [red = 0, green = 0, blue = 0] = params.slice(index + 2, index + 5);
    return { color: `rgb(${red}, ${green}, ${blue})`, consumed: 4 };
  }
  return { color: undefined, consumed: 0 };
}

function applySgr(current: TerminalStyle, params: ReadonlyArray<number>): TerminalStyle {
  let next: { -readonly [K in keyof TerminalStyle]: TerminalStyle[K] } = { ...current };
  const codes = params.length === 0 ? [0] : params;
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
    else if (code === 39) delete next.fg;
    else if (code >= 40 && code <= 47) next.bg = code - 40;
    else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
    else if (code === 49) delete next.bg;
    else if (code === 38 || code === 48) {
      const { color, consumed } = extendedColor(codes, index);
      index += consumed;
      if (color === undefined) continue;
      if (code === 38) next.fg = color;
      else next.bg = color;
    }
  }
  return next;
}

function sameStyle(left: TerminalStyle | null, right: TerminalStyle | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.fg === right.fg &&
    left.bg === right.bg &&
    left.bold === right.bold &&
    left.dim === right.dim &&
    left.italic === right.italic &&
    left.underline === right.underline
  );
}

/**
 * Interprets stream text the way a terminal would: SGR colours, carriage return and backspace
 * overwrite (tqdm progress), erase-in-line and cursor up/down. Other escape sequences are dropped.
 */
export function renderTerminalText(source: string): TerminalText {
  const text = source.endsWith("\n") ? source.slice(0, -1) : source;
  if (!CONTROL.test(text)) {
    return { text, runs: text.length === 0 ? [] : [{ offset: 0, text, style: null }] };
  }

  const styles: TerminalStyle[] = [];
  const styleIds = new Map<string, number>();
  const styleId = (style: TerminalStyle) => {
    if (Object.keys(style).length === 0) return -1;
    const key = JSON.stringify(style);
    let id = styleIds.get(key);
    if (id === undefined) {
      id = styles.push(style) - 1;
      styleIds.set(key, id);
    }
    return id;
  };
  const lines: Array<{ chars: string[]; styles: number[] }> = [{ chars: [], styles: [] }];
  let row = 0;
  let column = 0;
  let style: TerminalStyle = {};
  let currentStyleId = -1;
  const line = () => {
    while (lines.length <= row) lines.push({ chars: [], styles: [] });
    return lines[row]!;
  };

  let index = 0;
  while (index < text.length) {
    const code = text.codePointAt(index)!;
    const char = String.fromCodePoint(code);
    index += char.length;
    if (char === "\u001b") {
      const kind = text[index];
      if (kind === "[") {
        let end = index + 1;
        while (end < text.length && !CSI_FINAL.test(text[end]!)) end += 1;
        const final = text[end];
        const params = text
          .slice(index + 1, end)
          .split(";")
          .filter((part) => /^\d+$/u.test(part))
          .map(Number);
        index = end + 1;
        const count = Math.max(1, params[0] ?? 1);
        if (final === "m") {
          style = applySgr(style, params);
          currentStyleId = styleId(style);
        } else if (final === "K") {
          const target = line();
          const mode = params[0] ?? 0;
          if (mode === 0) {
            target.chars.length = Math.min(target.chars.length, column);
            target.styles.length = target.chars.length;
          } else if (mode === 2) {
            target.chars = [];
            target.styles = [];
          } else {
            for (let cell = 0; cell < Math.min(column, target.chars.length); cell += 1) {
              target.chars[cell] = " ";
              target.styles[cell] = -1;
            }
          }
        } else if (final === "A") row = Math.max(0, row - count);
        else if (final === "B") row += count;
        else if (final === "C") column += count;
        else if (final === "D") column = Math.max(0, column - count);
        else if (final === "G") column = count - 1;
      } else if (kind === "]") {
        let end = index + 1;
        while (
          end < text.length &&
          text[end] !== "\u0007" &&
          text.slice(end, end + 2) !== "\u001b\\"
        )
          end += 1;
        index = text[end] === "\u0007" ? end + 1 : end + 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (char === "\r") column = 0;
    else if (char === "\n") {
      row += 1;
      column = 0;
      line();
    } else if (char === "\b") column = Math.max(0, column - 1);
    else if (code >= 0x20 || char === "\t") {
      const target = line();
      while (target.chars.length < column) {
        target.chars.push(" ");
        target.styles.push(-1);
      }
      target.chars[column] = char;
      target.styles[column] = currentStyleId;
      column += 1;
    }
  }

  const runs: TerminalRun[] = [];
  let output = "";
  const append = (value: string, id: number) => {
    const runStyle = id < 0 ? null : (styles[id] ?? null);
    const previous = runs.at(-1);
    if (previous !== undefined && sameStyle(previous.style, runStyle)) {
      runs[runs.length - 1] = { ...previous, text: previous.text + value };
    } else {
      runs.push({ offset: output.length, text: value, style: runStyle });
    }
    output += value;
  };
  lines.forEach((current, lineIndex) => {
    if (lineIndex > 0) append("\n", -1);
    let start = 0;
    for (let cell = 1; cell <= current.chars.length; cell += 1) {
      if (cell === current.chars.length || current.styles[cell] !== current.styles[start]) {
        append(current.chars.slice(start, cell).join(""), current.styles[start] ?? -1);
        start = cell;
      }
    }
  });
  return { text: output, runs: runs.filter((run) => run.text.length > 0) };
}

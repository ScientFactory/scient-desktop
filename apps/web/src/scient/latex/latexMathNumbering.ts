interface NumberingCommand {
  from: number;
  to: number;
}

interface MathRow {
  source: string;
  separator: string;
  commands: NumberingCommand[];
  visible: string;
  positions: number[];
}

function argumentEnd(source: string, from: number): number | null {
  if (source[from] !== "{") return null;
  let depth = 1;
  for (let at = from + 1; at < source.length; at++) {
    if (source[at] === "\\") at++;
    else if (source[at] === "%") return null;
    else if (source[at] === "{") depth++;
    else if (source[at] === "}" && --depth === 0) return at + 1;
  }
  return null;
}

/** Separate outer equation rows without splitting rows in matrices or braced arguments. */
function mathRows(body: string): MathRow[] | null {
  const rows: MathRow[] = [];
  let start = 0;
  let depth = 0;
  const environments: string[] = [];
  let commands: NumberingCommand[] = [];
  const addRow = (to: number, separator: string) => {
    const source = body.slice(start, to);
    const positions: number[] = [];
    let visible = "";
    let commandIndex = 0;
    for (let at = 0; at < source.length;) {
      const command = commands[commandIndex];
      if (command?.from === at) {
        at = command.to;
        commandIndex++;
      } else {
        positions.push(at);
        visible += source[at++];
      }
    }
    rows.push({ source, separator, commands, visible, positions });
    commands = [];
    start = to + separator.length;
  };
  for (let at = 0; at < body.length;) {
    const char = body[at];
    if (char === "%") return null;
    if (char !== "\\") {
      if (char === "{") depth++;
      else if (char === "}" && --depth < 0) return null;
      at++;
      continue;
    }
    if (body[at + 1] === "\\") {
      if (depth === 0 && environments.length === 0) {
        const separator = /^\\\\\*?(?:[\t ]*\[[^[\]\r\n]*\])?/u.exec(body.slice(at))![0];
        addRow(at, separator);
        at += separator.length;
      } else at += 2;
      continue;
    }
    const environment = /^\\(begin|end)\s*\{([^{}]+)\}/u.exec(body.slice(at));
    if (environment) {
      if (environment[1] === "begin") environments.push(environment[2]!);
      else if (environments.pop() !== environment[2]) return null;
      at += environment[0].length;
      continue;
    }
    const command = /^\\([A-Za-z]+)/u.exec(body.slice(at));
    if (!command) {
      at += 2;
      continue;
    }
    const name = command[1]!;
    if (!["label", "tag", "notag", "nonumber"].includes(name)) {
      at += command[0].length;
      continue;
    }
    if (depth !== 0 || environments.length !== 0) return null;
    let end = at + command[0].length;
    if (name === "label" || name === "tag") {
      if (name === "tag" && body[end] === "*") end++;
      while (/\s/u.test(body[end] ?? "") && end < body.length) end++;
      const argument = argumentEnd(body, end);
      if (argument === null) return null;
      end = argument;
    }
    commands.push({ from: at - start, to: end - start });
    at = end;
  }
  if (depth !== 0 || environments.length !== 0) return null;
  addRow(body.length, "");
  return rows;
}

export function projectMathNumbering(body: string): {
  tex: string;
  commands: string[][];
} | null {
  const rows = mathRows(body);
  if (!rows) return null;
  return {
    tex: rows.map((row) => row.visible.trim()).join(" \\\\\n"),
    commands: rows.map((row) =>
      row.commands.map((command) => row.source.slice(command.from, command.to)),
    ),
  };
}

function patchRow(row: MathRow, value: string): string | null {
  const before = row.visible.trim();
  const after = value.trim();
  if (before === after) return row.source;
  const offset = row.visible.length - row.visible.trimStart().length;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix++;
  const from =
    prefix < before.length
      ? row.positions[offset + prefix]!
      : before.length
        ? row.positions[offset + before.length - 1]! + 1
        : (row.commands[0]?.from ?? offset);
  const to =
    before.length - suffix > prefix
      ? row.positions[offset + before.length - suffix - 1]! + 1
      : from;
  if (row.commands.some((command) => command.from < to && command.to > from)) return null;
  return (
    row.source.slice(0, from) + after.slice(prefix, after.length - suffix) + row.source.slice(to)
  );
}

/** Preserve equation commands and row separators while patching only changed math. */
export function patchNumberedMathSource(source: string, tex: string): string | null {
  const environment = /^\\begin\{([^}]+)\}/u.exec(source);
  const head =
    environment?.[0] ?? (source.startsWith("\\[") ? "\\[" : source.startsWith("$$") ? "$$" : null);
  const tail = environment ? `\\end{${environment[1]}}` : head === "\\[" ? "\\]" : "$$";
  if (!head || !source.endsWith(tail)) return null;
  const rows = mathRows(source.slice(head.length, -tail.length));
  const next = mathRows(tex);
  if (!rows || !next || rows.length !== next.length || next.some((row) => row.commands.length > 0))
    return null;
  const changed = rows.map((row, index) => patchRow(row, next[index]!.visible));
  if (changed.some((row) => row === null)) return null;
  return head + changed.map((row, index) => row + rows[index]!.separator).join("") + tail;
}

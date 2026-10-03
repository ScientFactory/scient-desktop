/** Literal algpseudocode structure. Unknown commands/layouts stay in Source. */
export const algorithmKeywords: Record<string, { prefix: string; suffix: string }> = {
  Require: { prefix: "Require:", suffix: "" },
  Ensure: { prefix: "Ensure:", suffix: "" },
  State: { prefix: "", suffix: "" },
  Statex: { prefix: "", suffix: "" },
  Return: { prefix: "return", suffix: "" },
  For: { prefix: "for", suffix: "do" },
  ForAll: { prefix: "for all", suffix: "do" },
  While: { prefix: "while", suffix: "do" },
  If: { prefix: "if", suffix: "then" },
  ElsIf: { prefix: "else if", suffix: "then" },
  Else: { prefix: "else", suffix: "" },
  EndFor: { prefix: "end for", suffix: "" },
  EndWhile: { prefix: "end while", suffix: "" },
  EndIf: { prefix: "end if", suffix: "" },
  Repeat: { prefix: "repeat", suffix: "" },
  Until: { prefix: "until", suffix: "" },
  Loop: { prefix: "loop", suffix: "" },
  EndLoop: { prefix: "end loop", suffix: "" },
};
const argumentsRequired = new Set(["For", "ForAll", "While", "If", "ElsIf", "Until"]);
const empty = new Set(["Else", "EndFor", "EndWhile", "EndIf", "Repeat", "Loop", "EndLoop"]);

function argument(source: string, at: number) {
  while (/\s/u.test(source[at] ?? "")) at++;
  if (source[at] !== "{") return null;
  let depth = 1;
  for (let end = at + 1; end < source.length; end++) {
    if (source[end] === "\\") end++;
    else if (source[end] === "%") {
      const newline = source.indexOf("\n", end);
      if (newline < 0) return null;
      end = newline;
    } else if (source[end] === "{") depth++;
    else if (source[end] === "}" && --depth === 0)
      return { from: at + 1, to: end, end: end + 1, value: source.slice(at + 1, end) };
  }
  return null;
}

/** Match commands only outside groups, math and comments. */
function commands(source: string, names: ReadonlySet<string>) {
  const result: { name: string; from: number; end: number }[] = [];
  let depth = 0,
    math = "";
  for (let at = 0; at < source.length; at++) {
    if (source[at] === "%") {
      const newline = source.indexOf("\n", at);
      if (newline < 0) break;
      at = newline;
      continue;
    }
    if (source[at] === "$" && (!math || math === "$")) {
      math = math ? "" : "$";
      continue;
    }
    if (source[at] === "\\") {
      if (source.startsWith("\\(", at) && !math) {
        math = "\\)";
        at++;
        continue;
      }
      if (math && source.startsWith(math, at)) {
        math = "";
        at++;
        continue;
      }
      const command = /^\\([A-Za-z]+)\b/u.exec(source.slice(at));
      if (command) {
        if (!depth && !math && names.has(command[1]!))
          result.push({ name: command[1]!, from: at, end: at + command[0].length });
        at += command[0].length - 1;
      } else at++;
    } else if (!math && source[at] === "{") depth++;
    else if (!math && source[at] === "}") depth--;
  }
  return result;
}

export function algorithmLineLayout(names: readonly string[], interval: number) {
  const stack: { name: string; otherwise: boolean }[] = [];
  let line = 0;
  const rows: { indent: number; number: string }[] = [];
  for (const name of names) {
    if (!Object.hasOwn(algorithmKeywords, name)) return null;
    const endings: Readonly<Record<string, string>> = {
      EndFor: "For",
      EndWhile: "While",
      EndIf: "If",
      Until: "Repeat",
      EndLoop: "Loop",
    };
    const closing = endings[name];
    if (closing && stack.pop()?.name !== closing) return null;
    const branch = name === "Else" || name === "ElsIf";
    if (branch && (stack.at(-1)?.name !== "If" || stack.at(-1)?.otherwise)) return null;
    if (name === "Else") stack.at(-1)!.otherwise = true;
    const numbered = !["Require", "Ensure", "Statex"].includes(name);
    if (numbered) line++;
    rows.push({
      indent: Math.max(0, stack.length - (branch ? 1 : 0)),
      number: numbered && interval > 0 && line % interval === 0 ? `${line}:` : "",
    });
    if (["For", "ForAll", "While", "If", "Repeat", "Loop"].includes(name))
      stack.push({ name: name === "ForAll" ? "For" : name, otherwise: false });
  }
  return stack.length ? null : rows;
}

export function parseLatexAlgorithm(source: string) {
  if (source.length > 100000) return null;
  const opening = /^\\begin\{algorithm\}(?:\[([htbpH!]+)\])?\s*/u.exec(source);
  if (!opening || !source.endsWith("\\end{algorithm}")) return null;
  let at = opening[0].length;
  let caption: ReturnType<typeof argument> = null,
    label: ReturnType<typeof argument> = null;
  for (;;) {
    const command = /^\\(caption|label)\b/u.exec(source.slice(at));
    if (!command) break;
    const value = argument(source, at + command[0].length);
    if (!value) return null;
    if (command[1] === "caption") {
      if (caption) return null;
      caption = value;
    } else {
      if (!caption || label || /[{}\\%\s#$&~^]/u.test(value.value)) return null;
      label = value;
    }
    at = value.end;
    while (/\s/u.test(source[at] ?? "")) at++;
  }
  const fontSize =
    /^\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\b\s*/u.exec(
      source.slice(at),
    );
  if (fontSize) at += fontSize[0].length;
  const inner = /^\\begin\{algorithmic\}(?:\[(\d+)\])?/u.exec(source.slice(at));
  if (!inner) return null;
  const interval = Number(inner[1] ?? 0);
  if (interval > 100) return null;
  const from = at + inner[0].length;
  const to = source.indexOf("\\end{algorithmic}", from);
  if (to < from || !/^\s*\\end\{algorithm\}$/u.test(source.slice(to + "\\end{algorithmic}".length)))
    return null;
  const body = source.slice(from, to);
  const starts = commands(
    body,
    new Set(Object.keys(algorithmKeywords).filter((name) => name !== "Return")),
  );
  if (!starts.length || starts.length > 500 || body.slice(0, starts[0]!.from).trim()) return null;
  const rows = [];
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1]?.from ?? body.length;
    let text = body.slice(start.end, end).trim();
    let command = start.name;
    if (command === "State" && /^\\Return\b/u.test(text)) {
      command = "Return";
      text = text.slice("\\Return".length).trim();
    }
    const comments = commands(text, new Set(["Comment"]));
    if (comments.length > 1) return null;
    let comment: string | null = null;
    if (comments[0]) {
      const value = argument(text, comments[0].end);
      if (!value || text.slice(value.end).trim()) return null;
      comment = value.value;
      text = text.slice(0, comments[0].from).trimEnd();
    }
    if (argumentsRequired.has(command)) {
      const value = argument(text, 0);
      if (!value || text.slice(value.end).trim()) return null;
      text = value.value;
    } else if (empty.has(command) && text) return null;
    const raw = body.slice(start.from, end).trimEnd();
    rows.push({
      command,
      body: text,
      comment,
      from: from + start.from,
      to: from + start.from + raw.length,
    });
  }
  if (
    !algorithmLineLayout(
      rows.map((row) => row.command),
      interval,
    )
  )
    return null;
  return {
    from,
    to,
    rows,
    caption,
    label,
    layout: {
      kind: "algorithm",
      fontSize: fontSize?.[1] ?? null,
      interval,
      placement: opening[1] ?? "",
      captioned: caption !== null,
      label: label?.value ?? "",
    },
  };
}

export function algorithmLineSource(
  command: string,
  body: string,
  comment: string | null,
): string | null {
  if (!Object.hasOwn(algorithmKeywords, command) || (empty.has(command) && body.trim()))
    return null;
  const prefix = command === "Return" ? "\\State \\Return" : `\\${command}`;
  return (
    prefix +
    (argumentsRequired.has(command) ? `{${body}}` : body ? ` ${body}` : "") +
    (comment === null ? "" : ` \\Comment{${comment}}`)
  );
}

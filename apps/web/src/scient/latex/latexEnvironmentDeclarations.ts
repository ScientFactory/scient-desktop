import { latexCommands, latexPackageInventory, latexWithoutComments } from "./latexPackages";

export interface LatexEnvironmentDeclaration {
  name: string;
  title: string;
  kind: "theorem" | "quote";
  style: "plain" | "definition" | "remark";
  counter: string | null;
  within: "section" | "chapter" | null;
  boldPrefix: boolean;
}

function argument(source: string, from: number, opening = "{", closing = "}") {
  let at = from;
  while (/\s/u.test(source[at] ?? "") && at < source.length) at++;
  if (source[at] !== opening) return null;
  const start = ++at;
  let depth = 1;
  let braces = 0;
  for (; at < source.length; at++) {
    if (source[at] === "\\") at++;
    else if (opening === "[" && source[at] === "{") braces++;
    else if (opening === "[" && source[at] === "}") braces--;
    else if (braces === 0 && source[at] === opening) depth++;
    else if (braces === 0 && source[at] === closing && --depth === 0)
      return { value: source.slice(start, at), end: at + 1 };
  }
  return null;
}

function literalText(value: string): boolean {
  return !/[\\{}%#$&_^~]/u.test(value);
}

/** Bounded source adapters, never execution of arbitrary environment definitions. */
export function latexEnvironmentDeclarations(source: string) {
  const inventory = latexPackageInventory(source);
  const preamble = latexWithoutComments(source.slice(0, inventory.end));
  const environments = new Map<string, LatexEnvironmentDeclaration>();
  const unsupported = new Set<string>();
  const tokens = /\\([A-Za-z]+|[^\r\n])|[{}]/gu;
  let depth = 0;
  let conditional = 0;
  let style: string = "plain";
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(preamble))) {
    const command = token[1];
    if (token[0] === "{" || command === "begingroup") {
      depth++;
      continue;
    }
    if (token[0] === "}" || command === "endgroup") {
      depth--;
      continue;
    }
    if (depth !== 0) continue;
    if (command === "newif") {
      const name = /^\s*\\[A-Za-z]+/u.exec(preamble.slice(tokens.lastIndex));
      if (name) tokens.lastIndex += name[0].length;
      continue;
    }
    if (command?.startsWith("if")) {
      conditional++;
      continue;
    }
    if (command === "fi") {
      conditional = Math.max(0, conditional - 1);
      continue;
    }
    if (command === "theoremstyle") {
      const value = argument(preamble, tokens.lastIndex);
      if (value) {
        style = conditional ? "unsupported" : value.value;
        tokens.lastIndex = value.end;
      }
      continue;
    }
    if (!command || !["newtheorem", "newenvironment", "renewenvironment"].includes(command))
      continue;
    let at = tokens.lastIndex;
    const star = /^\s*\*/u.exec(preamble.slice(at));
    if (star) at += star[0].length;
    const name = argument(preamble, at);
    if (!name || !/^[A-Za-z]+\*?$/u.test(name.value)) continue;
    at = name.end;
    // Any unsupported declaration must also block the built-in adapter for that name.
    unsupported.add(name.value);
    environments.delete(name.value);
    if (command === "newtheorem") {
      const shared = argument(preamble, at, "[", "]");
      if (shared) at = shared.end;
      const title = argument(preamble, at);
      if (!title) continue;
      at = title.end;
      const within = argument(preamble, at, "[", "]");
      if (within) at = within.end;
      tokens.lastIndex = at;
      const sharedDefinition = shared ? environments.get(shared.value) : null;
      if (
        conditional ||
        !["plain", "definition", "remark"].includes(style) ||
        !literalText(title.value) ||
        !title.value.trim() ||
        (star && (shared || within)) ||
        (shared && (!sharedDefinition?.counter || sharedDefinition.kind !== "theorem" || within)) ||
        (within && !["section", "chapter"].includes(within.value))
      )
        continue;
      environments.set(name.value, {
        name: name.value,
        title: title.value,
        kind: "theorem",
        style: style as LatexEnvironmentDeclaration["style"],
        counter: star ? null : shared ? sharedDefinition!.counter : name.value,
        within: shared
          ? sharedDefinition!.within
          : ((within?.value as "section" | "chapter" | undefined) ?? null),
        boldPrefix: style !== "remark",
      });
    } else {
      const count = argument(preamble, at, "[", "]");
      if (count) at = count.end;
      const defaultValue = argument(preamble, at, "[", "]");
      if (defaultValue) at = defaultValue.end;
      const begin = argument(preamble, at);
      if (!begin) continue;
      const end = argument(preamble, begin.end);
      if (!end) continue;
      tokens.lastIndex = end.end;
      if (
        conditional ||
        star ||
        defaultValue ||
        (count && count.value !== "0") ||
        end.value.trim() !== "\\end{quote}"
      )
        continue;
      const prefix = /^\s*\\begin\{quote\}\s*(.*)$/su.exec(begin.value)?.[1]?.trim();
      if (prefix === undefined) continue;
      const bold = /^\\textbf\{([^{}\\]*)\}$/u.exec(prefix);
      const title = bold?.[1] ?? prefix;
      if (!literalText(title)) continue;
      environments.set(name.value, {
        name: name.value,
        title,
        kind: "quote",
        style: "definition",
        counter: null,
        within: null,
        boldPrefix: !!bold,
      });
    }
    unsupported.delete(name.value);
  }
  const defaultProofEnd =
    (inventory.loaded.has("amsthm") ||
      /\\documentclass\s*(?:\[[^\]]*\])?\s*\{ams(?:art|book|proc)\}/u.test(preamble)) &&
    !environments.has("proof") &&
    !unsupported.has("proof") &&
    !latexCommands(preamble).some((match) =>
      ["qed", "qedsymbol", "pushQED", "popQED"].includes(match[1]!),
    );
  return { environments, unsupported, defaultProofEnd };
}

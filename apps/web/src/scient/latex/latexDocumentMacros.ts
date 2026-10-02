import { latexCommands, latexPackageInventory } from "./latexPackages";
import { MATH_SYMBOLS } from "./mathSymbols";

export interface DocumentMathMacro {
  def: string;
  args: number;
  expand: false;
  captureSelection: true;
}

function skipSpace(source: string, at: number): number {
  while (at < source.length && /\s/u.test(source[at]!)) at++;
  return at;
}

function group(source: string, from: number) {
  const opening = skipSpace(source, from);
  if (source[opening] !== "{") return null;
  let depth = 1;
  for (let at = opening + 1; at < source.length; at++) {
    if (source[at] === "\\") at++;
    else if (source[at] === "{") depth++;
    else if (source[at] === "}" && --depth === 0)
      return { body: source.slice(opening + 1, at), end: at + 1 };
  }
  return null;
}

function macroName(source: string, from: number) {
  const at = skipSpace(source, from);
  const braced = group(source, at);
  const match = /^\\([A-Za-z]+)\s*$/u.exec(braced?.body ?? "");
  if (braced) return match ? { name: match[1]!, end: braced.end } : null;
  const token = /^\\([A-Za-z]+)/u.exec(source.slice(at));
  return token ? { name: token[1]!, end: at + token[0].length } : null;
}

function optionalArgumentEnd(source: string, from: number): number | null {
  let depth = 0;
  for (let at = from + 1; at < source.length; at++) {
    if (source[at] === "\\") at++;
    else if (source[at] === "{") depth++;
    else if (source[at] === "}") depth--;
    else if (source[at] === "]" && depth === 0) return at + 1;
  }
  return null;
}

/** Literal preamble definitions only; this adapter does not execute TeX or package code. */
export function latexDocumentMathSetup(source: string) {
  const packages = latexPackageInventory(source);
  // TeX comments consume their newline. In operator names that affects spacing.
  const preamble = source
    .slice(0, packages.end)
    .replace(/\\(?:[A-Za-z]+|[^\r\n])|%[^\r\n]*(?:\r?\n[\t ]*)?/gu, (token) =>
      token.startsWith("%") ? "" : token,
    );
  const candidates = new Map<string, DocumentMathMacro>();
  const predefined = new Set(
    MATH_SYMBOLS.filter(
      (symbol) =>
        /^\\[A-Za-z]+$/u.test(symbol.command) &&
        symbol.packages.every((name) => packages.loaded.has(name)),
    ).map((symbol) => symbol.command.slice(1)),
  );
  const unsupported = new Set<string>();
  const declared = new Set<string>();
  let depth = 0;
  let conditional = 0;
  const tokens = /\\([A-Za-z]+|[^\r\n])|[{}]/gu;
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
      const name = macroName(preamble, tokens.lastIndex);
      if (name) tokens.lastIndex = name.end;
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
    if (
      !command ||
      ![
        "DeclareMathOperator",
        "DeclareRobustCommand",
        "newcommand",
        "renewcommand",
        "providecommand",
        "def",
        "gdef",
        "edef",
        "xdef",
        "let",
        "NewDocumentCommand",
        "RenewDocumentCommand",
        "ProvideDocumentCommand",
        "DeclarePairedDelimiter",
        "DeclarePairedDelimiterX",
        "DeclarePairedDelimiterXPP",
      ].includes(command)
    )
      continue;
    let at = skipSpace(preamble, tokens.lastIndex);
    const starred = preamble[at] === "*";
    if (starred) at++;
    const named = macroName(preamble, at);
    if (!named) continue;
    const { name } = named;
    if (
      [
        "let",
        "NewDocumentCommand",
        "RenewDocumentCommand",
        "ProvideDocumentCommand",
        "DeclarePairedDelimiter",
        "DeclarePairedDelimiterX",
        "DeclarePairedDelimiterXPP",
      ].includes(command)
    ) {
      unsupported.add(name);
      declared.add(name);
      candidates.delete(name);
      tokens.lastIndex = named.end;
      continue;
    }
    let args = 0;
    let supported = conditional === 0 && !["edef", "xdef"].includes(command);
    at = skipSpace(preamble, named.end);
    if (["def", "gdef", "edef", "xdef"].includes(command)) {
      const opening = preamble.indexOf("{", at);
      if (opening < 0) continue;
      const parameters = preamble.slice(at, opening);
      args = parameters.length / 2;
      supported &&=
        Number.isInteger(args) &&
        args <= 9 &&
        parameters === Array.from({ length: args }, (_, index) => `#${index + 1}`).join("");
      at = opening;
    } else if (preamble[at] === "[") {
      const count = /^\[\s*([0-9])\s*\]/u.exec(preamble.slice(at));
      if (!count) {
        unsupported.add(name);
        declared.add(name);
        candidates.delete(name);
        continue;
      }
      args = Number(count[1]);
      at = skipSpace(preamble, at + count[0].length);
      // Optional arguments need TeX's argument rules, which this adapter does not infer.
      if (preamble[at] === "[") {
        supported = false;
        const end = optionalArgumentEnd(preamble, at);
        if (end === null) {
          unsupported.add(name);
          declared.add(name);
          candidates.delete(name);
          continue;
        }
        at = skipSpace(preamble, end);
      }
    }
    const body = group(preamble, at);
    if (!body) {
      unsupported.add(name);
      declared.add(name);
      candidates.delete(name);
      continue;
    }
    tokens.lastIndex = body.end;
    if (command === "providecommand" && (declared.has(name) || predefined.has(name))) {
      declared.add(name);
      continue;
    }
    if (declared.has(name) && !["renewcommand", "def", "gdef", "edef", "xdef"].includes(command))
      supported = false;
    declared.add(name);
    const definition =
      command === "DeclareMathOperator"
        ? `\\operatorname${starred ? "*" : ""}{${body.body}}`
        : body.body;
    const parameters = definition.replace(/\\(?:[A-Za-z]+|[^\r\n])/gu, "");
    supported &&=
      definition.length <= 4096 &&
      !/\\(?:if[A-Za-z]*|else|fi|csname|endcsname|catcode|let|newcommand|renewcommand|providecommand|def|gdef|edef|xdef|input|include|usepackage|RequirePackage|label|tag|notag|nonumber|setcounter|addtocounter)\b/u.test(
        definition,
      ) &&
      !/\\(?:begin|end)\s*\{(?:equation|align|gather|multline|document)\*?\}/u.test(definition) &&
      !/#(?![1-9])/u.test(parameters) &&
      ![...parameters.matchAll(/#([1-9])/gu)].some((match) => Number(match[1]) > args);
    candidates.delete(name);
    unsupported.delete(name);
    if (supported)
      candidates.set(name, { def: definition, args, expand: false, captureSelection: true });
    else unsupported.add(name);
  }
  // Bound expansion and reject both recursive definitions and aliases to them.
  const costs = new Map<string, number>();
  const cost = (name: string, path: Set<string>): number => {
    const cached = costs.get(name);
    if (cached !== undefined) return cached;
    if (unsupported.has(name) || path.has(name) || path.size >= 32) return Infinity;
    const macro = candidates.get(name);
    if (!macro) return 0;
    const nextPath = new Set(path).add(name);
    let size = macro.def.length;
    for (const command of latexCommands(macro.def)) {
      size += cost(command[1]!, nextPath);
      if (size > 16384) break;
    }
    costs.set(name, size);
    return size;
  };
  const macros: Record<string, DocumentMathMacro> = {};
  for (const [name, macro] of candidates) {
    if (cost(name, new Set()) > 16384) unsupported.add(name);
    else macros[name] = macro;
  }
  return { macros, unsupported: [...unsupported], declarations: [...declared], packages };
}

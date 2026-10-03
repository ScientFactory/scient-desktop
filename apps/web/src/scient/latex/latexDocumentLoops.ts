import { inlineLatexLiteral } from "./latexLiteral";
import { latexWithoutComments } from "./latexPackages";
import type { DocumentMathMacro } from "./latexDocumentMacros";

export interface DocumentLoopExpansion {
  from: number;
  to: number;
  raw: string;
  expanded: string;
}

/** Locate one literal loop at document scope; nested environments own their adapters. */
export function expandLatexDocumentLoop(
  source: string,
  macros: Readonly<Record<string, DocumentMathMacro>>,
): DocumentLoopExpansion | null {
  const begin = source.indexOf("\\begin{document}");
  if (begin < 0 || source.length > 1000000) return null;
  const bodyFrom = begin + "\\begin{document}".length;
  if ([...latexWithoutComments(source.slice(bodyFrom)).matchAll(/\\loop\b/gu)].length !== 1)
    return null;
  const preamble = latexWithoutComments(source.slice(0, begin));
  if (/\\(?:catcode|let|def|gdef|edef|xdef)\b/u.test(preamble)) return null;
  const counts = new Set(
    [...preamble.matchAll(/\\newcount\s*\\([A-Za-z]+)\b/gu)].map((match) => match[1]!),
  );
  if (!counts.size) return null;
  const environments: string[] = [];
  let braces = 0;
  for (let at = bodyFrom; at < source.length; at++) {
    const literal = inlineLatexLiteral(source, at);
    if (literal) {
      at = literal.end - 1;
      continue;
    }
    if (source[at] === "%") {
      const end = source.indexOf("\n", at);
      if (end < 0) break;
      at = end;
      continue;
    }
    if (source[at] === "{") {
      braces++;
      continue;
    }
    if (source[at] === "}") {
      braces--;
      continue;
    }
    if (source[at] !== "\\") continue;
    const environment = /^\\(begin|end)\{([^{}]+)\}/u.exec(source.slice(at));
    if (environment) {
      if (environment[2] === "document") break;
      if (environment[1] === "begin") environments.push(environment[2]!);
      else if (environments.pop() !== environment[2]) return null;
      at += environment[0].length - 1;
      continue;
    }
    const command = /^\\([A-Za-z]+|[^\r\n])/u.exec(source.slice(at));
    if (!command) continue;
    if (!braces && !environments.length && counts.has(command[1]!)) {
      const match =
        /^\\([A-Za-z]+)\s*=\s*(\d+)\s*\\loop\s*\\advance\s*\\\1\s+by\s+1\s*([\s\S]*?)\\ifnum\s*\\\1\s*<\s*(\d+)\s*\\repeat\b/u.exec(
          source.slice(at),
        );
      if (!match) return null;
      const start = Number(match[2]),
        end = Number(match[4]);
      if (start >= end || end - start > 100 || end > 10000) return null;
      const after = source.slice(at + match[0].length);
      // Expanding an isolated loop must not change a later use of its register.
      const counter = new RegExp(`\\\\${match[1]}(?![A-Za-z])`, "u");
      if (counter.test(latexWithoutComments(source.slice(bodyFrom, at) + after))) return null;
      let template = match[3]!;
      const unsupported =
        /\\(?:loop|repeat|advance|if[A-Za-z]*|else|fi|newcount|newcommand|renewcommand|def|gdef|let|catcode|input|include|verb|begin\{(?:verbatim|lstlisting))\b/u;
      if (unsupported.test(template)) return null;
      // Expand only safe, zero-argument paragraph macros. Math macros stay in MathLive.
      for (let depth = 0; depth < 8; depth++) {
        let changed = false;
        template = template.replace(/\\([A-Za-z]+)\b[\t ]*/gu, (token, name: string) => {
          const macro = macros[name];
          if (!macro || macro.args !== 0 || !/\\par\b/u.test(macro.def)) return token;
          changed = true;
          return macro.def + "\n";
        });
        if (template.length > 20000) return null;
        if (!changed) break;
        if (depth === 7) return null;
      }
      if (unsupported.test(template)) return null;
      const readCounter = new RegExp(`\\\\the\\s*\\\\${match[1]}(?![A-Za-z])`, "gu");
      const expanded = Array.from({ length: end - start }, (_, index) =>
        template.replace(readCounter, String(start + index + 1)),
      ).join("\n");
      if (expanded.length > 250000 || counter.test(expanded)) return null;
      return { from: at, to: at + match[0].length, raw: match[0], expanded };
    }
    at += command[0].length - 1;
  }
  return null;
}

/** A generated block points to its owning loop, never to invented physical offsets. */
export function documentLoopSourceRange(
  expansion: DocumentLoopExpansion,
  from: number,
  to: number,
) {
  const virtualEnd = expansion.from + expansion.expanded.length;
  if (to <= expansion.from) return { from, to };
  if (from >= virtualEnd) {
    const delta = expansion.to - virtualEnd;
    return { from: from + delta, to: to + delta };
  }
  return { from: expansion.from, to: expansion.to };
}

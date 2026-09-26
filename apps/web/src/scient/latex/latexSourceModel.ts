/** Navigation scans never execute TeX or rewrite the source. Offsets stay exact. */
export function maskLatexNonCode(source: string): string {
  const blank = (text: string) => text.replace(/[^\r\n]/gu, " ");
  return source.replace(
    /\\(?:verb\*?)([^A-Za-z\s])[^\r\n]*?\1|\\begin\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}[^]*?(?:\\end\{\2\}|$)|\\[^]|%[^\r\n]*/gu,
    (token) =>
      token.startsWith("%") || token.startsWith("\\verb") || token.startsWith("\\begin{")
        ? blank(token)
        : token,
  );
}

export interface SourceSection {
  title: string;
  level: number;
  from: number;
  headingEnd: number;
  to: number;
}
export interface SourceEnvironment {
  name: string;
  from: number;
  body: number;
  to: number;
}
export interface SourceLabel {
  key: string;
  from: number;
}
export interface SourceCommand {
  name: string;
  arguments: number;
  from: number;
}

function braceEnd(source: string, opening: number): number {
  let depth = 1;
  for (let at = opening + 1; at < source.length; at++) {
    if (source[at] === "\\") at++;
    else if (source[at] === "{") depth++;
    else if (source[at] === "}" && --depth === 0) return at;
  }
  return -1;
}

export function indexLatexSource(source: string) {
  const code = maskLatexNonCode(source);
  const sections: SourceSection[] = [];
  const environments: SourceEnvironment[] = [];
  const labels: SourceLabel[] = [];
  const commands: SourceCommand[] = [];
  const customEnvironments: string[] = [];
  const stack: { name: string; from: number; body: number }[] = [];
  const levels = [
    "part",
    "chapter",
    "section",
    "subsection",
    "subsubsection",
    "paragraph",
    "subparagraph",
  ];
  const tokens =
    /\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\s*\{|\\(begin|end)\s*\{([^{}]+)\}|\\label\s*\{([^{}]+)\}|\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z@]+)\}?(?:\s*\[(\d)\])?|\\(?:providecommand|DeclareMathOperator)\*?\s*\{\\([A-Za-z@]+)\}|\\(?:newenvironment|renewenvironment|newtheorem)\*?\s*\{([^{}]+)\}/gu;
  for (const token of code.matchAll(tokens)) {
    const from = token.index;
    if (token[1]) {
      if (token[1] === "begin") stack.push({ name: token[2]!, from, body: from + token[0].length });
      else {
        const at = stack.findLastIndex((entry) => entry.name === token[2]);
        if (at >= 0) {
          const opening = stack[at]!;
          stack.splice(at);
          environments.push({ ...opening, to: from });
        }
      }
    } else if (token[3]) labels.push({ key: token[3], from });
    else if (token[4] || token[6])
      commands.push({ name: token[4] ?? token[6]!, arguments: Number(token[5] ?? 0), from });
    else if (token[7]) customEnvironments.push(token[7]);
    else {
      const opening = from + token[0].length - 1;
      const end = braceEnd(code, opening);
      if (end < 0) continue;
      const command = /^\\([A-Za-z]+)/u.exec(token[0])![1]!;
      sections.push({
        from,
        headingEnd: end + 1,
        to: code.length,
        level: levels.indexOf(command),
        title:
          source
            .slice(opening + 1, end)
            .replace(/\\[A-Za-z]+\*?/gu, "")
            .replace(/[{}]/gu, "")
            .replace(/\s+/gu, " ")
            .trim() || "Untitled section",
      });
    }
  }
  const openSections: SourceSection[] = [];
  for (const section of sections) {
    while (openSections.length && openSections.at(-1)!.level >= section.level)
      openSections.pop()!.to = section.from;
    openSections.push(section);
  }
  return {
    code,
    sections,
    environments: environments.sort((a, b) => a.from - b.from),
    labels,
    commands,
    customEnvironments,
  };
}

/** Resolve a literal project path without allowing a path outside the workspace. */
export function resolveLatexPath(file: string, argument: string, extension = ""): string | null {
  if (!argument || /[\\{}%#$~^]/u.test(argument) || /^(?:[A-Za-z]:|\/)/u.test(argument))
    return null;
  const parts = file.replaceAll("\\", "/").split("/").slice(0, -1);
  for (const part of argument.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  let path = parts.join("/");
  if (extension && !/\.[^/]+$/u.test(path)) path += extension;
  return path || null;
}

export function linkedLatexFiles(source: string, file: string): string[] {
  return [
    ...new Set(
      [...maskLatexNonCode(source).matchAll(/\\(?:input|include|subfile)\s*\{([^{}]+)\}/gu)]
        .map((match) => resolveLatexPath(file, match[1]!.trim(), ".tex"))
        .filter((path): path is string => path !== null),
    ),
  ];
}

export function relativeLatexPath(fromFile: string, toFile: string): string {
  const from = fromFile.replaceAll("\\", "/").split("/").slice(0, -1);
  const to = toFile.replaceAll("\\", "/").split("/");
  while (from.length && to.length && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  return [...from.map(() => ".."), ...to].join("/");
}

/** TeX resolves inputs from the compiling document; subfiles changes that base. */
export function latexSourcePathBase(source: string, file: string, rootFile: string): string {
  return /\\documentclass(?:\[[^\]]*\])?\s*\{subfiles\}/u.test(maskLatexNonCode(source))
    ? file
    : rootFile;
}

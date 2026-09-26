export interface LatexReferenceChoice {
  key: string;
  title: string;
  detail: string;
  command: "ref" | "eqref" | "cite";
}

export function withoutComments(source: string) {
  return source
    .split(/\r?\n/u)
    .map((line) => {
      for (let index = 0; index < line.length; index++) {
        if (line[index] === "\\") index++;
        else if (line[index] === "%") return line.slice(0, index);
      }
      return line;
    })
    .join("\n");
}

export function documentReferenceChoices(source: string): LatexReferenceChoice[] {
  const text = withoutComments(source);
  return [...text.matchAll(/\\label\s*\{([^{}]+)\}/gu)].map((match) => {
    const before = text.slice(0, match.index);
    const heading = [
      ...before.matchAll(
        /\\(?:section|subsection|subsubsection|chapter)\*?(?:\[[^\]]*\])?\s*\{([^{}]+)\}/gu,
      ),
    ].at(-1);
    const caption = [...before.matchAll(/\\caption(?:\[[^\]]*\])?\s*\{([^{}]+)\}/gu)].at(-1);
    const environments: { name: string; index: number }[] = [];
    for (const token of before.matchAll(/\\(begin|end)\s*\{([^{}]+)\}/gu)) {
      if (token[1] === "begin") environments.push({ name: token[2]!, index: token.index });
      else {
        const index = environments.findLastIndex((entry) => entry.name === token[2]);
        if (index >= 0) environments.splice(index);
      }
    }
    const equation = environments.some((entry) =>
      /^(?:equation|align|gather|multline|flalign)\*?$/u.test(entry.name),
    );
    const float = environments.findLast((entry) => /^(?:figure|table)\*?$/u.test(entry.name));
    const nearest = float && caption && caption.index > float.index ? caption : heading;
    return {
      key: match[1]!,
      title: equation ? "Equation" : (nearest?.[1] ?? match[1]!),
      detail: match[1]!,
      command: equation ? "eqref" : "ref",
    };
  });
}

function groupEnd(source: string, start: number, opener: string, closer: string): number {
  let depth = 1;
  let braceDepth = 0;
  let quoted = false;
  for (let cursor = start + 1; cursor < source.length; cursor++) {
    if (source[cursor] === "\\") cursor++;
    else if (opener === "(" && source[cursor] === "{") braceDepth++;
    else if (opener === "(" && source[cursor] === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (opener === "(" && braceDepth === 0 && source[cursor] === '"') quoted = !quoted;
    else if (opener === "(" && (braceDepth > 0 || quoted)) continue;
    else if (source[cursor] === closer && --depth === 0) return cursor;
    else if (source[cursor] === opener) depth++;
  }
  return -1;
}

function quoteEnd(source: string, start: number): number {
  let braces = 0;
  for (let cursor = start + 1; cursor < source.length; cursor++) {
    if (source[cursor] === "\\") cursor++;
    else if (source[cursor] === "{") braces++;
    else if (source[cursor] === "}") braces = Math.max(0, braces - 1);
    else if (source[cursor] === '"' && braces === 0) return cursor;
  }
  return -1;
}

/** Literal BibTeX fields only. String macros remain visible instead of guessed. */
export function bibliographyChoices(source: string, file: string): LatexReferenceChoice[] {
  const entries: LatexReferenceChoice[] = [];
  const pattern = /@(?!comment\b|string\b|preamble\b)[A-Za-z]+\s*([({])\s*([^,\s]+)\s*,/giu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) && entries.length < 2000) {
    const start = match.index + match[0].indexOf(match[1]!);
    const end = groupEnd(source, start, match[1]!, match[1] === "{" ? "}" : ")");
    if (end < 0) break;
    const body = source.slice(pattern.lastIndex, end);
    const fields = new Map<string, string>();
    const fieldPattern = /([A-Za-z]+)\s*=\s*/gu;
    let field: RegExpExecArray | null;
    while ((field = fieldPattern.exec(body))) {
      const from = fieldPattern.lastIndex;
      const opening = body[from];
      let to =
        opening === "{"
          ? groupEnd(body, from, "{", "}")
          : opening === '"'
            ? quoteEnd(body, from)
            : body.indexOf(",", from);
      if (to < 0) to = body.length;
      const value = body
        .slice(opening === "{" || opening === '"' ? from + 1 : from, to)
        .replace(/[{}]/gu, "")
        .replace(/\s+/gu, " ")
        .trim();
      fields.set(field[1]!.toLowerCase(), value);
      fieldPattern.lastIndex = to + 1;
    }
    entries.push({
      key: match[2]!,
      title: fields.get("title") || match[2]!,
      detail: [fields.get("author"), fields.get("year"), file].filter(Boolean).join(" · "),
      command: "cite",
    });
    pattern.lastIndex = end + 1;
  }
  return entries;
}

export function bibliographyPaths(source: string, relativePath: string) {
  const parent = relativePath.replaceAll("\\", "/").split("/").slice(0, -1);
  const paths: string[] = [];
  for (const match of withoutComments(source).matchAll(
    /\\(?:bibliography|addbibresource)(?:\[[^\]]*\])?\s*\{([^{}]+)\}/gu,
  )) {
    for (const item of match[1]!.split(",")) {
      let name = item.trim().replaceAll("\\", "/");
      if (!name || name.startsWith("/") || name.includes(":")) continue;
      if (!/\.bib$/iu.test(name)) name += ".bib";
      const parts = [...parent];
      let valid = true;
      for (const part of name.split("/")) {
        if (part === "..") {
          if (!parts.length) {
            valid = false;
            break;
          }
          parts.pop();
        } else if (part && part !== ".") parts.push(part);
      }
      if (valid) paths.push(parts.join("/"));
    }
  }
  return [...new Set(paths)];
}

export function inlineBibliographyChoices(source: string): LatexReferenceChoice[] {
  return [
    ...withoutComments(source).matchAll(
      /\\bibitem(?:\[[^\]]*\])?\{([^{}]+)\}([^]*?)(?=\\bibitem|\\end\{thebibliography\}|$)/gu,
    ),
  ].map((match) => ({
    key: match[1]!,
    title: match[2]!.replace(/\s+/gu, " ").trim().slice(0, 200),
    detail: match[1]!,
    command: "cite",
  }));
}

import {
  bibliographyEntryTitle,
  bibtexEntries,
  manualBibliography,
} from "./latexBibliographyModel";

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
    const float = environments.findLast((entry) =>
      /^(?:figure|table|algorithm)\*?$/u.test(entry.name),
    );
    const statement = environments.findLast((entry) =>
      /^(?:theorem|lemma|proposition|corollary|claim|definition|example|remark|proof)\*?$/u.test(
        entry.name,
      ),
    );
    const statementType = statement
      ? statement.name[0]!.toUpperCase() + statement.name.slice(1).replace(/\*$/u, "")
      : null;
    const statementTitle = statement
      ? /^\\begin\s*\{[^{}]+\}\s*\[([^\]]+)\]/u.exec(before.slice(statement.index))?.[1]
      : null;
    const nearest = float && caption && caption.index > float.index ? caption : heading;
    return {
      key: match[1]!,
      title: equation
        ? "Equation"
        : statementType
          ? [statementType, statementTitle].filter(Boolean).join(": ")
          : (nearest?.[1] ?? match[1]!),
      detail: match[1]!,
      command: equation ? "eqref" : "ref",
    };
  });
}

/** Literal fields and exact expressions share the manager's entry parser. */
export function bibliographyChoices(source: string, file: string): LatexReferenceChoice[] {
  return bibtexEntries(source).entries.map((entry) => {
    const fieldText = (name: string) => {
      const field = entry.fields.find((field) => field.name === name);
      return field
        ? (field.text ?? source.slice(field.valueFrom, field.valueTo))
            .replace(/[{}]/gu, "")
            .replace(/\s+/gu, " ")
            .trim()
        : "";
    };
    return {
      key: entry.key,
      title: fieldText("title") || entry.key,
      detail: [fieldText("author"), fieldText("year"), file].filter(Boolean).join(" · "),
      command: "cite",
    };
  });
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
  return manualBibliography(source).entries.map((entry) => ({
    key: entry.key,
    title: bibliographyEntryTitle(entry),
    detail: entry.key,
    command: "cite",
  }));
}

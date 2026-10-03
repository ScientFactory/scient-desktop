import { latexWithoutComments } from "./latexPackages";

export interface VisualProjectFile {
  contents: string;
  revision: string;
  truncated: boolean;
}
interface SourceSpan {
  from: number;
  to: number;
  path: string | null;
  sourceFrom: number;
}
export interface VisualProjectDocument {
  source: string;
  spans: SourceSpan[];
  paths: string[];
  missing: string[];
  errors: string[];
}

const directory = (path: string) => path.split("/").slice(0, -1).join("/");
function resolvePath(base: string, target: string): string | null {
  if (!target || /[\\#{}$]|^(?:[A-Za-z]:|\/)/u.test(target)) return null;
  const parts = base.split("/").filter(Boolean);
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/** Mask literals without changing offsets used to route edits back to files. */
function dependencySource(source: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const token of source.matchAll(/\\([A-Za-z]+|[^\r\n])|%/gu)) {
    const from = token.index;
    if (from < cursor) continue;
    let end = from;
    if (token[0] === "%") {
      const newline = source.indexOf("\n", from);
      end = newline < 0 ? source.length : newline;
    } else if (token[1] === "verb") {
      const opening = from + token[0].length + Number(source[from + token[0].length] === "*");
      const delimiter = source[opening];
      if (delimiter && !/\s/u.test(delimiter)) {
        const closing = source.indexOf(delimiter, opening + 1);
        const newline = source.indexOf("\n", opening + 1);
        if (closing >= 0 && (newline < 0 || closing < newline)) end = closing + 1;
      }
    } else if (token[1] === "begin") {
      const environment = /^\s*\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}/u.exec(
        source.slice(from + token[0].length),
      );
      if (environment) {
        const closing = `\\end{${environment[1]}}`;
        const position = source.indexOf(closing, from + token[0].length + environment[0].length);
        end = position < 0 ? source.length : position + closing.length;
      }
    }
    if (end > from) {
      parts.push(
        source.slice(cursor, from),
        source.slice(from, end).replace(/[^\r\n]/gu, (character) => " ".repeat(character.length)),
      );
      cursor = end;
    }
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

export function assembleVisualProject(
  root: string,
  files: ReadonlyMap<string, VisualProjectFile>,
): VisualProjectDocument {
  const result: VisualProjectDocument = {
    source: "",
    spans: [],
    paths: [],
    missing: [],
    errors: [],
  };
  const rootDirectory = directory(root);
  const visited = new Set<string>();
  let includeOnly: Set<string> | null = null;
  let occurrences = 0;
  const append = (text: string, path: string | null, sourceFrom: number) => {
    const from = result.source.length;
    result.source += text;
    result.spans.push({ from, to: result.source.length, path, sourceFrom });
  };
  const expand = (
    path: string,
    stack: readonly string[],
    importBase: string | null,
    subfile: boolean,
  ) => {
    if (++occurrences > 256 || stack.length > 32 || result.source.length > 2_000_000) {
      result.errors.push(
        "This document exceeds the visual include limit. Use PDF preview for the full build.",
      );
      return;
    }
    if (stack.includes(path)) {
      result.errors.push(`Circular LaTeX include: ${[...stack, path].join(" → ")}`);
      return;
    }
    visited.add(path);
    const file = files.get(path);
    if (!file) {
      result.missing.push(path);
      return;
    }
    if (file.truncated) {
      result.errors.push(`${path} is too large to load completely for visual editing.`);
      return;
    }
    const source = file.contents;
    const clean = dependencySource(source);
    let start = 0,
      end = source.length;
    if (subfile) {
      const begin = /\\begin\s*\{document\}/u.exec(clean);
      if (begin) {
        start = begin.index + begin[0].length;
        const finish = /\\end\s*\{document\}/u.exec(clean.slice(start));
        if (finish) end = start + finish.index;
      }
    }
    let cursor = start;
    let depth = 0;
    let conditional = 0;
    const customConditions = new Set(
      [...clean.matchAll(/\\newif\s*\\(if[A-Za-z]+)/gu)].map((match) => match[1]!),
    );
    for (const token of clean.slice(start, end).matchAll(/\\([A-Za-z]+|[^\r\n])|[{}]/gu)) {
      const at = start + token.index;
      if (at < cursor) continue;
      if (token[0] === "{") {
        depth++;
        continue;
      }
      if (token[0] === "}") {
        depth--;
        continue;
      }
      const name = token[1]!;
      if (
        /^if(?:x|num|dim|odd|vmode|hmode|mmode|inner|cat|true|false|case|defined|csname|eof|void|hbox|vbox|incsname|pdf|XeTeX|LuaTeX|PDFTeX)?$/u.test(
          name,
        ) ||
        customConditions.has(name)
      )
        conditional++;
      if (name === "fi") conditional = Math.max(0, conditional - 1);
      if (name === "newif") {
        const declaration = /^\s*\\if[A-Za-z]+/u.exec(clean.slice(at + token[0].length));
        if (declaration) {
          append(source.slice(cursor, at + token[0].length + declaration[0].length), path, cursor);
          cursor = at + token[0].length + declaration[0].length;
        }
        continue;
      }
      if (
        name === "end" &&
        depth === 0 &&
        conditional === 0 &&
        /^\s*\{document\}/u.test(clean.slice(at + token[0].length))
      ) {
        // TeX ignores the remainder after the root's document environment.
        const closing = /^\s*\{document\}/u.exec(clean.slice(at + token[0].length))!;
        end = at + token[0].length + closing[0].length;
        break;
      }
      if (name === "endinput" && depth === 0 && conditional === 0) {
        end = at;
        break;
      }
      if (name === "includeonly" && depth === 0) {
        const args = /^\s*\{([^{}]*)\}/u.exec(clean.slice(at + token[0].length));
        if (args)
          includeOnly = new Set(
            args[1]!.split(",").map((item) => item.trim().replace(/\.tex$/u, "")),
          );
        continue;
      }
      if (/^(?:InputIfFileExists|(?:sub)?(?:input|include)from|subfileinclude)$/u.test(name)) {
        result.errors.push(
          `The ${name} command in ${path} needs TeX to resolve it. Use PDF preview for this document.`,
        );
        continue;
      }
      if (!["input", "include", "subfile", "import", "subimport"].includes(name)) continue;
      if (depth !== 0 || conditional !== 0) {
        result.errors.push(
          `An include in ${path} depends on a macro, group or condition. PDF preview remains authoritative.`,
        );
        continue;
      }
      const args =
        /^\s*\{([^{}]+)\}(?:\s*\{([^{}]+)\})?/u.exec(clean.slice(at + token[0].length)) ??
        (name === "input" ? /^\s+([^\s{}%\\]+)/u.exec(clean.slice(at + token[0].length)) : null);
      const imported = name === "import" || name === "subimport";
      if (!args || (imported && !args[2])) {
        result.errors.push(
          `Cannot resolve the ${name} command in ${path}. Use a literal file path.`,
        );
        continue;
      }
      // A second brace belongs to the document for ordinary input commands.
      const consumed =
        imported || !args[0].includes("}") ? args[0].length : args[0].indexOf("}") + 1;
      const target = (imported ? args[2]! : args[1]!).trim().replace(/^"|"$/gu, "");
      const parent = name === "import" ? rootDirectory : (importBase ?? rootDirectory);
      const nextBase = imported ? resolvePath(parent, args[1]!.trim()) : importBase;
      const base = nextBase ?? rootDirectory;
      const targetPath =
        imported && nextBase === null
          ? null
          : resolvePath(base, /\.[A-Za-z0-9]{1,8}$/u.test(target) ? target : `${target}.tex`);
      if (!targetPath) {
        result.errors.push(`The include path in ${path} cannot be resolved inside this workspace.`);
        continue;
      }
      append(source.slice(cursor, at), path, cursor);
      cursor = at + token[0].length + consumed;
      if (name === "include") append("\n\\clearpage\n", null, 0);
      if (name === "include" && includeOnly && !includeOnly.has(target.replace(/\.tex$/u, "")))
        continue;
      expand(
        targetPath,
        [...stack, path],
        name === "subfile" ? directory(targetPath) : nextBase,
        name === "subfile",
      );
      // File EOF ends a TeX input line, including an unterminated comment.
      if (!result.source.endsWith("\n")) append("\n", null, 0);
      if (name === "include") append("\n\\clearpage\n", null, 0);
    }
    append(source.slice(cursor, end), path, cursor);
  };
  expand(root, [], null, false);
  if (result.source.length > 2_000_000)
    result.errors.push(
      "This document exceeds the visual source size limit. Use PDF preview for the full build.",
    );
  result.paths = [...visited];
  result.missing = [...new Set(result.missing)];
  result.errors = [...new Set(result.errors)];
  return result;
}

interface SourceEdit {
  from: number;
  to: number;
  text: string;
}
function difference(before: string, after: string, offset: number): SourceEdit | null {
  if (before === after) return null;
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let tail = 0;
  while (
    tail < before.length - from &&
    tail < after.length - from &&
    before.at(-1 - tail) === after.at(-1 - tail)
  )
    tail++;
  return {
    from: offset + from,
    to: offset + before.length - tail,
    text: after.slice(from, after.length - tail),
  };
}
const bodyStart = (source: string) => {
  const match = /\\begin\s*\{document\}/u.exec(latexWithoutComments(source));
  return match ? match.index + match[0].length : 0;
};

/** Keep include directives in place; apply only edits owned by one physical span. */
export function planVisualProjectEdit(
  document: VisualProjectDocument,
  next: string,
  files: ReadonlyMap<string, VisualProjectFile>,
  root: string,
  preferredPath: string,
): { changes: Map<string, string>; error: string | null } {
  const changes = new Map<string, string>();
  const oldBody = bodyStart(document.source),
    newBody = bodyStart(next);
  const edits = [
    difference(document.source.slice(0, oldBody), next.slice(0, newBody), 0),
    difference(document.source.slice(oldBody), next.slice(newBody), oldBody),
  ].filter((edit): edit is SourceEdit => edit !== null);
  const byFile = new Map<string, SourceEdit[]>();
  for (const edit of edits) {
    const spans = document.spans.filter((span) =>
      edit.from === edit.to
        ? span.from <= edit.from && span.to >= edit.to
        : span.from < edit.to && span.to > edit.from,
    );
    let span: SourceSpan | undefined;
    if (edit.from === edit.to) {
      span =
        spans.find((item) => item.path && item.from < edit.from && item.to > edit.from) ??
        spans.find((item) => item.path === (edit.from < oldBody ? root : preferredPath)) ??
        spans.find((item) => item.path !== null && item.path !== root) ??
        spans.find((item) => item.path);
    } else {
      span = spans[0];
      for (let index = 1; index < spans.length; index++) {
        const previous = spans[index - 1]!,
          current = spans[index]!;
        if (
          current.path !== previous.path ||
          current.sourceFrom !== previous.sourceFrom + previous.to - previous.from
        )
          return {
            changes,
            error:
              "This edit crosses included-file boundaries. Edit each file's content separately.",
          };
      }
    }
    if (!span?.path)
      return {
        changes,
        error: "This page break belongs to an include command. Change that command in Source.",
      };
    const from = span.sourceFrom + edit.from - span.from;
    const to = from + edit.to - edit.from;
    const list = byFile.get(span.path) ?? [];
    list.push({ from, to, text: edit.text });
    byFile.set(span.path, list);
  }
  for (const [path, editsForFile] of byFile) {
    let source = files.get(path)!.contents;
    for (const edit of editsForFile.sort((a, b) => b.from - a.from))
      source = source.slice(0, edit.from) + edit.text + source.slice(edit.to);
    changes.set(path, source);
  }
  return { changes, error: null };
}

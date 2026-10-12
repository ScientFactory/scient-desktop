import {
  validateDocumentSourcePatches,
  DocumentSourcePatchError,
  type DocumentSourceEdit,
  type DocumentSourcePatch,
} from "@scientfactory/scient-document";
import type { LatexSourceEdit, LatexOwnedSourcePatch } from "./latexSourceEditPlan";
import { latexDocumentBoundary, maskLatexSource } from "./latexSourceSyntax";

export interface VisualProjectFile {
  contents: string;
  revision: string;
  truncated: boolean;
  /** Absent for presentation-only files; only a live session can authorize an edit. */
  owner?: { readonly documentId: string; readonly editVersion: number };
}
export interface SourceSpan {
  from: number;
  to: number;
  path: string | null;
  sourceFrom: number;
  occurrence: number;
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
  const append = (text: string, path: string | null, sourceFrom: number, occurrence: number) => {
    if (text.length === 0) return;
    const from = result.source.length;
    result.source += text;
    result.spans.push({ from, to: result.source.length, path, sourceFrom, occurrence });
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
    const occurrence = occurrences;
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
    const clean = maskLatexSource(source, { literals: true, opaqueEnvironments: ["comment"] });
    let start = 0,
      end = source.length;
    if (subfile) {
      const boundary = latexDocumentBoundary(source);
      if (boundary) {
        start = boundary.bodyFrom;
        end = boundary.bodyTo;
      }
    }
    let cursor = start;
    const firstSpan = result.spans.length;
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
          append(
            source.slice(cursor, at + token[0].length + declaration[0].length),
            path,
            cursor,
            occurrence,
          );
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
      append(source.slice(cursor, at), path, cursor, occurrence);
      cursor = at + token[0].length + consumed;
      if (name === "include") append("\n\\clearpage\n", null, 0, occurrence);
      if (name === "include" && includeOnly && !includeOnly.has(target.replace(/\.tex$/u, "")))
        continue;
      expand(
        targetPath,
        [...stack, path],
        name === "subfile" ? directory(targetPath) : nextBase,
        name === "subfile",
      );
      // File EOF ends a TeX input line, including an unterminated comment.
      if (!result.source.endsWith("\n")) append("\n", null, 0, occurrence);
      if (name === "include") append("\n\\clearpage\n", null, 0, occurrence);
    }
    append(source.slice(cursor, end), path, cursor, occurrence);
    if (result.spans.length === firstSpan) {
      const offset = result.source.length;
      result.spans.push({ from: offset, to: offset, path, sourceFrom: start, occurrence });
    }
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

export interface PhysicalLatexSourceEdit extends DocumentSourceEdit {
  readonly documentId: string;
}

export type VisualProjectEditPlan = {
  readonly edits: ReadonlyMap<string, PhysicalLatexSourceEdit>;
  readonly error: string | null;
};

function insertionSpan(
  document: VisualProjectDocument,
  offset: number,
  affinity: LatexOwnedSourcePatch["insertionAffinity"],
): SourceSpan | undefined {
  const interior = document.spans.find(
    (span) => span.path !== null && span.from < offset && offset < span.to,
  );
  if (interior) return interior;
  if (!affinity) return undefined;
  const spans = document.spans.filter(
    (span) =>
      span.path !== null && (affinity === "before" ? span.to === offset : span.from === offset),
  );
  // Empty includes can share an assembled offset. Never guess which occurrence owns it.
  return spans.length === 1 ? spans[0] : undefined;
}

/** Map already-owned original-coordinate patches; never infer an edit from a text diff. */
export function planVisualProjectEdit(
  document: VisualProjectDocument,
  edit: LatexSourceEdit,
  files: ReadonlyMap<string, VisualProjectFile>,
  root: string,
): VisualProjectEditPlan {
  const refused = (error: string): VisualProjectEditPlan => ({
    edits: new Map(),
    error,
  });
  if (edit.source !== document.source)
    return refused("The source changed while this edit was being prepared.");
  const byFile = new Map<string, DocumentSourcePatch[]>();
  const append = (path: string, patch: DocumentSourcePatch) => {
    const patches = byFile.get(path) ?? [];
    // One physical range can appear through repeated inputs. Apply an identical edit once.
    if (
      !patches.some(
        (previous) =>
          previous.start === patch.start &&
          previous.end === patch.end &&
          previous.replacement === patch.replacement &&
          previous.expected === patch.expected,
      )
    )
      patches.push(patch);
    byFile.set(path, patches);
  };
  try {
    validateDocumentSourcePatches(document.source, edit.patches);
    for (const patch of edit.patches) {
      let span: SourceSpan | undefined;
      if (patch.start === patch.end) {
        span = insertionSpan(document, patch.start, patch.insertionAffinity);
      } else {
        const spans = document.spans.filter(
          (item) => item.from < patch.end && item.to > patch.start,
        );
        span = spans[0];
        for (let index = 1; index < spans.length; index += 1) {
          const before = spans[index - 1]!;
          const after = spans[index]!;
          if (
            after.path !== before.path ||
            after.occurrence !== before.occurrence ||
            after.from !== before.to ||
            after.sourceFrom !== before.sourceFrom + before.to - before.from
          )
            return refused(
              "This edit crosses included-file boundaries. Edit each file's content separately.",
            );
        }
      }
      if (!span?.path || patch.start < span.from || patch.end > document.source.length)
        return refused(
          "This boundary belongs to an include command. Change that command in Source.",
        );
      const file = files.get(span.path);
      if (!file) return refused(`The source for ${span.path} is no longer available.`);
      const start = span.sourceFrom + patch.start - span.from;
      const end = start + patch.end - patch.start;
      const expected = document.source.slice(patch.start, patch.end);
      if (file.contents.slice(start, end) !== expected)
        return refused("The source map is no longer current. Reopen the document before editing.");
      append(span.path, { start, end, replacement: patch.replacement, expected });
    }
    if (edit.root) {
      const file = files.get(root);
      if (!file || file.contents !== edit.root.source)
        return refused("The root document changed while this edit was being prepared.");
      validateDocumentSourcePatches(file.contents, edit.root.patches);
      for (const patch of edit.root.patches)
        append(root, { ...patch, expected: file.contents.slice(patch.start, patch.end) });
    }
    for (const physical of edit.physical ?? []) {
      // A rename moves a stable document owner, not its history.
      const path = document.paths.find(
        (candidate) => files.get(candidate)?.owner?.documentId === physical.documentId,
      );
      const file = path === undefined ? undefined : files.get(path);
      if (!path || !file || file.contents !== physical.source)
        return refused("This source-history edit no longer belongs to the current document.");
      validateDocumentSourcePatches(file.contents, physical.patches);
      for (const patch of physical.patches)
        append(path, { ...patch, expected: file.contents.slice(patch.start, patch.end) });
    }
    if (byFile.size > 1)
      return refused(
        "This edit also changes another file. Add the required declaration in Source, then retry the edit.",
      );
    const edits = new Map<string, PhysicalLatexSourceEdit>();
    for (const [path, patches] of byFile) {
      const file = files.get(path)!;
      if (!file.owner) return refused(`Open ${path} to edit it.`);
      if (file.truncated) return refused(`${path} is not completely loaded for editing.`);
      validateDocumentSourcePatches(file.contents, patches);
      edits.set(path, {
        documentId: file.owner.documentId,
        basedOnVersion: file.owner.editVersion,
        patches,
      });
    }
    return { edits, error: null };
  } catch (error) {
    if (error instanceof DocumentSourcePatchError)
      return refused(`This edit no longer matches a safe source range (${error.problem}).`);
    throw error;
  }
}

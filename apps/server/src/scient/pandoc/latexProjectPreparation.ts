/** Bounded structural preparation before Pandoc's sandboxed LaTeX reader. */
import { parse } from "@unified-latex/unified-latex-util-parse";
import type { DocumentWarning } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

const INCLUDE = new Set(["input", "include", "subfile", "subfileinclude"]);
const DEFINITIONS = new Set([
  "newcommand",
  "renewcommand",
  "providecommand",
  "DeclareRobustCommand",
  "NewDocumentCommand",
  "RenewDocumentCommand",
  "ProvideDocumentCommand",
  "newenvironment",
  "renewenvironment",
  "NewDocumentEnvironment",
  "def",
  "gdef",
  "edef",
  "xdef",
]);
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_BIB_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 16;
const MAX_FILES = 256;
const SAFE_TARGET = /^[\p{L}\p{N}_./ -]+$/u;

type Macro = {
  type: string;
  content?: unknown;
  args?: ReadonlyArray<{ content?: unknown }>;
  position?: { start: { offset: number }; end: { offset: number } };
};
type Replacement = { start: number; end: number; text: string };

function braced(source: string, offset: number) {
  let start = offset;
  while (/[ \t\r\n]/u.test(source[start] ?? "")) start++;
  if (source[start] !== "{") return null;
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) {
      return { text: source.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

function macros(source: string) {
  const found: Array<{ name: string; start: number; end: number }> = [];
  const visit = (nodes: unknown, inDefinition = false): void => {
    if (!Array.isArray(nodes)) return;
    for (let index = 0; index < nodes.length; index++) {
      const candidate: unknown = nodes[index];
      if (typeof candidate !== "object" || candidate === null) continue;
      const node = candidate as Macro;
      if (node.type === "comment" || node.type === "verbatim" || node.type === "verb") continue;
      const name = node.type === "macro" && typeof node.content === "string" ? node.content : "";
      if (
        name &&
        !inDefinition &&
        node.position &&
        (INCLUDE.has(name) ||
          name === "includegraphics" ||
          name === "graphicspath" ||
          name === "bibliography" ||
          name === "addbibresource" ||
          name === "addglobalbib")
      ) {
        found.push({ name, start: node.position.start.offset, end: node.position.end.offset });
        continue;
      }
      const definition = inDefinition || DEFINITIONS.has(name);
      if (Array.isArray(node.content)) visit(node.content, definition);
      if (node.args) for (const arg of node.args) visit(arg.content, definition);
      if (["def", "gdef", "edef", "xdef"].includes(name)) {
        for (let next = index + 1; next < Math.min(nodes.length, index + 4); next++) {
          const sibling = nodes[next] as Macro | undefined;
          if (sibling?.type === "group") {
            visit(sibling.content, true);
            index = next;
            break;
          }
        }
      }
    }
  };
  visit(parse(source).content);
  return found;
}

const inside = (path: Path.Path, root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export interface PreparedLatexProject {
  readonly source: string;
  readonly baseDirectory: string;
  readonly files: ReadonlyArray<string>;
  readonly imageReferences: ReadonlyArray<string>;
  readonly bibliography: ReadonlyArray<{ readonly contents: string }>;
  readonly warnings: ReadonlyArray<DocumentWarning>;
}

export class LatexPreparationError extends Schema.TaggedError<LatexPreparationError>()(
  "LatexPreparationError",
  { message: Schema.String },
) {}

export const prepareLatexProject = Effect.fn("scient.pandoc.prepareLatexProject")(function* (
  rootFile: string,
  workspaceRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = path.resolve(workspaceRoot);
  const realWorkspace = yield* fs.realPath(workspace);
  const root = path.dirname(path.resolve(rootFile));
  const realRoot = yield* fs.realPath(root);
  if (!inside(path, workspace, root) || !inside(path, realWorkspace, realRoot)) {
    return yield* new LatexPreparationError({
      message: "The selected LaTeX document is outside the workspace.",
    });
  }
  const baseDirectory = root;
  const warnings: DocumentWarning[] = [];
  warnings.push({
    code: "unsupported-construct",
    message:
      "LaTeX equation numbering, references, layout commands, and project-local style macros may change in Word.",
  });
  const bibliography: Array<{ contents: string }> = [];
  const graphicPaths = [""];
  const files = new Set<string>();
  const imageReferences = new Set<string>();
  let totalBytes = 0;
  let bibliographyBytes = 0;
  let macroCount = 0;

  const warn = (message: string) => {
    if (warnings.length < 199) warnings.push({ code: "unsupported-construct", message });
    else if (warnings.length === 199) {
      warnings.push({
        code: "unsupported-construct",
        message: "Further LaTeX conversion notes were omitted.",
      });
    }
  };
  const resolve = (target: string, directory: string, extensions: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (!SAFE_TARGET.test(target) || path.isAbsolute(target) || /^[A-Za-z]:/u.test(target))
        return null;
      for (const ext of extensions) {
        const name = ext && !target.toLowerCase().endsWith(ext) ? `${target}${ext}` : target;
        const candidate = path.resolve(directory, name);
        if (!inside(path, root, candidate)) continue;
        const real = yield* fs.realPath(candidate).pipe(Effect.orElseSucceed(() => null));
        if (real === null || !inside(path, realRoot, real)) continue;
        const stat = yield* fs.stat(real).pipe(Effect.orElseSucceed(() => null));
        if (stat?.type === "File") return { real, lexical: candidate, size: Number(stat.size) };
      }
      return null;
    });

  const flatten = (
    file: string,
    depth: number,
    stack: ReadonlyArray<string>,
    isSubfile = false,
  ): Effect.Effect<string, PlatformError.PlatformError | LatexPreparationError> =>
    Effect.gen(function* () {
      if (depth > MAX_DEPTH || files.size >= MAX_FILES || stack.includes(file)) {
        warn("A LaTeX include exceeded the depth, file-count, or cycle limit.");
        return "\\emph{[Unresolved include]}";
      }
      const stat = yield* fs.stat(file);
      const size = Number(stat.size);
      totalBytes += size;
      if (size > MAX_SOURCE_BYTES || totalBytes > MAX_SOURCE_BYTES) {
        return yield* new LatexPreparationError({
          message: "LaTeX project exceeds the 20 MB source limit.",
        });
      }
      files.add(file);
      let source = yield* fs.readFileString(file);
      if (
        Buffer.byteLength(source) > size ||
        Buffer.byteLength(source) + totalBytes - size > MAX_SOURCE_BYTES
      ) {
        return yield* new LatexPreparationError({
          message: "LaTeX project changed or exceeds the 20 MB source limit.",
        });
      }
      if (isSubfile && /\\documentclass\b/u.test(source)) {
        const body = /\\begin\s*\{document\}([\s\S]*?)\\end\s*\{document\}/u.exec(source);
        if (body) source = body[1] ?? "";
      }
      const edits: Replacement[] = [];
      const commands = yield* Effect.try({
        try: () => macros(source),
        catch: () => new LatexPreparationError({ message: "LaTeX source could not be parsed." }),
      });
      macroCount += commands.length;
      if (macroCount > 8_192) {
        return yield* new LatexPreparationError({
          message: "LaTeX project has too many resource commands.",
        });
      }
      for (const macro of commands) {
        let argumentOffset = macro.end;
        if (macro.name === "includegraphics") {
          while (/\s/u.test(source[argumentOffset] ?? "")) argumentOffset++;
          if (source[argumentOffset] === "[") {
            const end = source.indexOf("]", argumentOffset + 1);
            if (end !== -1) argumentOffset = end + 1;
          }
        }
        const arg = braced(source, argumentOffset);
        if (macro.name === "graphicspath") {
          if (arg) {
            for (const match of arg.text.matchAll(/\{([^{}]*)\}/gu)) {
              if (match[1] && graphicPaths.length < 32) graphicPaths.push(match[1]);
            }
            edits.push({ start: macro.start, end: arg.end, text: "" });
          }
          continue;
        }
        if (
          macro.name === "bibliography" ||
          macro.name === "addbibresource" ||
          macro.name === "addglobalbib"
        ) {
          if (arg) {
            for (const target of arg.text
              .split(",")
              .map((part) => part.trim())
              .slice(0, 16)) {
              const result = yield* resolve(target, baseDirectory, [".bib", ""]);
              if (
                result &&
                result.size <= MAX_BIB_BYTES &&
                bibliography.length < 16 &&
                bibliographyBytes + result.size <= MAX_BIB_BYTES
              ) {
                const contents = yield* fs.readFileString(result.real);
                const bytes = Buffer.byteLength(contents);
                if (bibliographyBytes + bytes <= MAX_BIB_BYTES) {
                  bibliography.push({ contents });
                  bibliographyBytes += bytes;
                } else warn("A bibliography changed or exceeded the 4 MB limit and was omitted.");
              } else warn("A bibliography outside the project, missing, or over 4 MB was omitted.");
            }
            edits.push({ start: macro.start, end: arg.end, text: "" });
          } else {
            warn("A nonliteral bibliography declaration was omitted.");
            edits.push({ start: macro.start, end: macro.end, text: "" });
          }
          continue;
        }
        if (macro.name === "includegraphics") {
          const target = arg?.text.trim() ?? "";
          let resolved: { real: string; lexical: string; size: number } | null = null;
          for (const directory of graphicPaths) {
            resolved = yield* resolve(target, path.resolve(baseDirectory, directory), [
              "",
              ".png",
              ".jpg",
              ".jpeg",
              ".gif",
              ".svg",
            ]);
            if (resolved) break;
          }
          if (arg && resolved && resolved.size <= 25 * 1024 * 1024) {
            const relative = path
              .relative(baseDirectory, resolved.lexical)
              .split(path.sep)
              .join("/");
            imageReferences.add(relative);
            edits.push({ start: argumentOffset, end: arg.end, text: `{${relative}}` });
          } else {
            warn(
              "A LaTeX figure was unavailable or outside the project; a placeholder was inserted.",
            );
            edits.push({
              start: macro.start,
              end: arg?.end ?? macro.end,
              text: "\\emph{[Figure unavailable]}",
            });
          }
          continue;
        }
        if (!INCLUDE.has(macro.name)) continue;
        const target = arg?.text.trim() ?? "";
        const resolved = yield* resolve(target, baseDirectory, [".tex", ""]);
        let end = arg?.end ?? macro.end;
        if (!arg) {
          const bare = /^[ \t]*[^\s\\{}%]+/u.exec(source.slice(end));
          if (bare) end += bare[0].length;
        }
        if (!resolved) {
          warn(
            "A LaTeX include was missing, nonliteral, or outside the project; a placeholder was inserted.",
          );
          edits.push({ start: macro.start, end, text: "\\emph{[Unresolved include]}" });
        } else {
          const nested = yield* flatten(
            resolved.real,
            depth + 1,
            [...stack, file],
            macro.name.startsWith("subfile"),
          );
          edits.push({ start: macro.start, end, text: `\n${nested}\n` });
        }
      }
      for (const edit of edits.sort((left, right) => right.start - left.start)) {
        source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
      }
      return source;
    });

  const resolvedRoot = yield* resolve(path.relative(root, rootFile), root, [""]);
  if (!resolvedRoot)
    return yield* new LatexPreparationError({
      message: "The selected LaTeX root is outside the project or unreadable.",
    });
  const source = yield* flatten(resolvedRoot.real, 0, []);
  return {
    source,
    baseDirectory,
    files: [...files],
    imageReferences: [...imageReferences],
    bibliography,
    warnings,
  } satisfies PreparedLatexProject;
});

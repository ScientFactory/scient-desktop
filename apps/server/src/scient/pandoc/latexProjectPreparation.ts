/**
 * Bounded structural preparation before Pandoc's sandboxed LaTeX reader.
 *
 * Includes, figures, and bibliographies resolve relative to the root `.tex`
 * file's folder, as LaTeX resolves them, and are read only when they are
 * inside the Scient project the document belongs to, both as written and
 * after symbolic links are followed. Anything else becomes a visible
 * placeholder and a note. Every file is read through a handle bound to the
 * file that check saw (`verifiedWorkspaceRead.ts`), so a file or folder
 * swapped for a link after the check is refused rather than read.
 */
import { parse } from "@unified-latex/unified-latex-util-parse";
import type { DocumentWarning } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { sha256Digest } from "../documentExport/DocumentCapture.ts";
import {
  checkedFileIdentity,
  readCappedFile,
  readVerifiedWorkspaceFile,
  type CheckedFile,
} from "../documentExport/verifiedWorkspaceRead.ts";

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

/** Why a LaTeX export is refused where project files cannot be read through a bound handle. */
export const LATEX_UNVERIFIABLE_PLATFORM_MESSAGE =
  "On this platform, a LaTeX document can be exported to Word only as a single file open in the editor, without includes, figures, or bibliographies: Scient cannot otherwise confirm which files it read.";
const LATEX_CHANGED_MESSAGE = "A file in the LaTeX project changed while exporting. Try again.";

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

/** Why a named file was not read. */
type Unresolved = "outside-project" | "unavailable";

/**
 * `shown` is the file the editor showed and its saved revision. Where an open
 * file cannot be bound to the project (Windows), only that file is read, and
 * only when its bytes are that revision; any other project file refuses the
 * export.
 */
export const prepareLatexProject = Effect.fn("scient.pandoc.prepareLatexProject")(function* (
  rootFile: string,
  workspaceRoot: string,
  shown?: { readonly path: string; readonly revision: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
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
  const shownReal =
    shown === undefined
      ? null
      : yield* fs.realPath(shown.path).pipe(Effect.orElseSucceed(() => null));
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
      if (!SAFE_TARGET.test(target)) return { ok: false, reason: "unavailable" } as const;
      if (path.isAbsolute(target) || /^[A-Za-z]:/u.test(target)) {
        return { ok: false, reason: "outside-project" } as const;
      }
      let reason: Unresolved = "unavailable";
      for (const ext of extensions) {
        const name = ext && !target.toLowerCase().endsWith(ext) ? `${target}${ext}` : target;
        const candidate = path.resolve(directory, name);
        if (!inside(path, workspace, candidate)) {
          reason = "outside-project";
          continue;
        }
        const real = yield* fs.realPath(candidate).pipe(Effect.orElseSucceed(() => null));
        if (real === null) continue;
        if (!inside(path, realWorkspace, real)) {
          reason = "outside-project";
          continue;
        }
        const stat = yield* fs.stat(real).pipe(Effect.orElseSucceed(() => null));
        if (stat?.type === "File") {
          return {
            ok: true,
            lexical: candidate,
            checked: checkedFileIdentity(real, stat),
          } as const;
        }
      }
      return { ok: false, reason } as const;
    });

  /** Reads a resolved file only if it is still the file `resolve` checked. */
  const read = (checked: CheckedFile, maxBytes: number) =>
    Effect.gen(function* () {
      const verified = yield* readVerifiedWorkspaceFile(checked, realWorkspace, platform, maxBytes);
      if (verified._tag !== "unsupported-platform") return verified;
      if (shown === undefined || shownReal === null || checked.canonicalPath !== shownReal) {
        return yield* new LatexPreparationError({ message: LATEX_UNVERIFIABLE_PLATFORM_MESSAGE });
      }
      // Bytes equal to the editor's saved revision show nothing the user did not already have.
      const capped = yield* readCappedFile(checked, maxBytes);
      return capped._tag === "bytes" && sha256Digest(capped.bytes) !== shown.revision
        ? ({ _tag: "unreadable" } as const)
        : capped;
    });
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  const flatten = (
    checked: CheckedFile,
    depth: number,
    stack: ReadonlyArray<string>,
    isSubfile = false,
  ): Effect.Effect<string, PlatformError.PlatformError | LatexPreparationError> =>
    Effect.gen(function* () {
      const file = checked.canonicalPath;
      if (depth > MAX_DEPTH || files.size >= MAX_FILES || stack.includes(file)) {
        warn("A LaTeX include exceeded the depth, file-count, or cycle limit.");
        return "\\emph{[Unresolved include]}";
      }
      const tooLarge = () =>
        new LatexPreparationError({ message: "LaTeX project exceeds the 20 MB source limit." });
      const budget = MAX_SOURCE_BYTES - totalBytes;
      totalBytes += checked.size;
      if (checked.size > budget) return yield* tooLarge();
      files.add(file);
      const contents = yield* read(checked, budget);
      if (contents._tag === "too-large") return yield* tooLarge();
      if (contents._tag !== "bytes") {
        return yield* new LatexPreparationError({ message: LATEX_CHANGED_MESSAGE });
      }
      let source = decode(contents.bytes);
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
              if (!result.ok) {
                warn(
                  result.reason === "outside-project"
                    ? "A bibliography outside the project folder was omitted."
                    : "A bibliography that could not be found was omitted.",
                );
              } else if (
                result.checked.size <= MAX_BIB_BYTES &&
                bibliography.length < 16 &&
                bibliographyBytes + result.checked.size <= MAX_BIB_BYTES
              ) {
                const contents = yield* read(result.checked, MAX_BIB_BYTES - bibliographyBytes);
                if (contents._tag === "bytes") {
                  bibliography.push({ contents: decode(contents.bytes) });
                  bibliographyBytes += contents.bytes.byteLength;
                } else warn("A bibliography changed or exceeded the 4 MB limit and was omitted.");
              } else warn("A bibliography over the 4 MB or 16-file limit was omitted.");
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
          let resolved: Effect.Success<ReturnType<typeof resolve>> = {
            ok: false,
            reason: "unavailable",
          };
          let outside = false;
          for (const directory of graphicPaths) {
            resolved = yield* resolve(target, path.resolve(baseDirectory, directory), [
              "",
              ".png",
              ".jpg",
              ".jpeg",
              ".gif",
              ".svg",
            ]);
            if (resolved.ok) break;
            outside ||= resolved.reason === "outside-project";
          }
          if (arg && resolved.ok && resolved.checked.size <= 25 * 1024 * 1024) {
            const relative = path
              .relative(baseDirectory, resolved.lexical)
              .split(path.sep)
              .join("/");
            imageReferences.add(relative);
            edits.push({ start: argumentOffset, end: arg.end, text: `{${relative}}` });
          } else if (outside) {
            warn(
              "A LaTeX figure outside the project folder was left out; a placeholder was inserted.",
            );
            edits.push({
              start: macro.start,
              end: arg?.end ?? macro.end,
              text: "\\emph{[Figure outside the project folder]}",
            });
          } else {
            warn(
              "A LaTeX figure was missing, too large, or not named literally; a placeholder was inserted.",
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
        if (!resolved.ok && resolved.reason === "outside-project") {
          warn(
            "A LaTeX include outside the project folder was left out; a placeholder was inserted.",
          );
          edits.push({
            start: macro.start,
            end,
            text: "\\emph{[Include outside the project folder]}",
          });
        } else if (!resolved.ok) {
          warn("A LaTeX include was missing or not named literally; a placeholder was inserted.");
          edits.push({ start: macro.start, end, text: "\\emph{[Unresolved include]}" });
        } else {
          const nested = yield* flatten(
            resolved.checked,
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
  if (!resolvedRoot.ok)
    return yield* new LatexPreparationError({
      message: "The selected LaTeX root is outside the project or unreadable.",
    });
  const source = yield* flatten(resolvedRoot.checked, 0, []);
  return {
    source,
    baseDirectory,
    files: [...files],
    imageReferences: [...imageReferences],
    bibliography,
    warnings,
  } satisfies PreparedLatexProject;
});

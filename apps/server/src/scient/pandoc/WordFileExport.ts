/**
 * Project Markdown file → Word.
 *
 * An isolated adapter until the shared project-Markdown capture (conversation
 * export PR 2) produces document bundles: it reads the saved file through the
 * workspace file system, refuses when the file on disk is not the revision the
 * editor showed, and builds a `document`-profile bundle whose relative images
 * the converter resolves itself, only inside the project root. YAML CSL
 * references and allowlisted local bibliographies travel with the bundle.
 *
 * The Word file goes to the same temporary export location as conversation
 * exports and is read through a signed asset.
 */
import {
  ScientWordExportError,
  type DocumentBundle,
  type DocumentWarning,
  type ScientWordFileExportRequest,
  type ScientWordLatexExportRequest,
} from "@t3tools/contracts";
import { exportFileName } from "@scientfactory/conversation";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import {
  ConversationExportFiles,
  type ConversationExportFileError,
} from "../conversationExport/ConversationExportFiles.ts";
import { PandocWordConverter, type WordConversionFailureReason } from "./PandocWordConverter.ts";
import { LatexPreparationError, prepareLatexProject } from "./latexProjectPreparation.ts";
import { citationsFromCslJson, markdownReferenceDeclarations } from "./markdownWordReferences.ts";

const MARKDOWN_FILE = /\.(?:md|markdown|mdown|mkd)$/iu;
const isLatexPreparationError = Schema.is(LatexPreparationError);

export interface ProducedWordFile {
  readonly path: string;
  readonly fileName: string;
  readonly byteLength: number;
  readonly warnings: ReadonlyArray<DocumentWarning>;
}

export class WordFileExport extends Context.Service<
  WordFileExport,
  {
    readonly export: (
      request: ScientWordFileExportRequest,
    ) => Effect.Effect<ProducedWordFile, ScientWordExportError | ConversationExportFileError>;
    readonly exportLatex: (
      request: ScientWordLatexExportRequest,
    ) => Effect.Effect<ProducedWordFile, ScientWordExportError | ConversationExportFileError>;
  }
>()("t3/scient/pandoc/WordFileExport") {}

const WORD_FAILURE_REASON: Record<WordConversionFailureReason, ScientWordExportError["reason"]> = {
  unavailable: "unavailable",
  "too-large": "too-large",
  timeout: "too-large",
  failed: "conversion-failed",
};

const reject = (reason: ScientWordExportError["reason"], message: string) =>
  Effect.fail(new ScientWordExportError({ reason, message }));

const make = Effect.gen(function* () {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceFiles = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const files = yield* ConversationExportFiles;
  const words = yield* PandocWordConverter;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;

  const exportFile: WordFileExport["Service"]["export"] = Effect.fn("WordFileExport.export")(
    function* (request) {
      if (path.isAbsolute(request.relativePath) || !MARKDOWN_FILE.test(request.relativePath)) {
        return yield* reject(
          "not-markdown",
          "Only Markdown files in the project can be exported to Word.",
        );
      }
      const unreadable = () =>
        new ScientWordExportError({
          reason: "file-unreadable",
          message: "Scient could not read this file from the project.",
        });
      const root = yield* workspacePaths
        .normalizeWorkspaceRoot(request.cwd)
        .pipe(Effect.mapError(unreadable));
      const target = yield* workspacePaths
        .resolveRelativePathWithinRoot({ workspaceRoot: root, relativePath: request.relativePath })
        .pipe(Effect.mapError(unreadable));
      const read = yield* workspaceFiles
        .readFile({ cwd: root, relativePath: target.relativePath })
        .pipe(Effect.mapError(unreadable));
      if (read.truncated) {
        return yield* reject("too-large", "This file is too large to export to Word.");
      }
      if (read.revision !== request.revision) {
        return yield* reject(
          "file-changed",
          "The file on disk is not the version shown in the editor. Save it, then export again.",
        );
      }

      const title = path.basename(target.relativePath).replace(MARKDOWN_FILE, "") || "Document";
      const declared = markdownReferenceDeclarations(read.contents);
      const citations = [...declared.citations];
      const warnings = [...declared.warnings];
      const bibliographySources: Array<{ format: "bibtex"; contents: string }> = [];
      for (const name of declared.bibliographyPaths) {
        if (path.isAbsolute(name) || /^(?:[a-z][a-z\d+.-]*:|\\\\)/iu.test(name)) {
          warnings.push({
            code: "resource-unresolved",
            message:
              "An absolute or remote bibliography was not used; its citation keys remain as written.",
          });
          continue;
        }
        const relativePath = path.join(path.dirname(target.relativePath), name);
        const bibliography = yield* workspacePaths
          .resolveRelativePathWithinRoot({ workspaceRoot: root, relativePath })
          .pipe(Effect.option);
        const loaded =
          bibliography._tag === "Some"
            ? yield* workspaceFiles
                .readFile({ cwd: root, relativePath: bibliography.value.relativePath })
                .pipe(Effect.option)
            : null;
        if (loaded === null || loaded._tag === "None" || loaded.value.truncated) {
          warnings.push({
            code: "resource-unresolved",
            message: `Bibliography “${path.basename(name)}” could not be read inside this project; its citation keys remain as written.`,
          });
          continue;
        }
        if (/\.bib$/iu.test(name)) {
          bibliographySources.push({ format: "bibtex", contents: loaded.value.contents });
          continue;
        }
        const entries = citationsFromCslJson(loaded.value.contents);
        if (entries === null) {
          warnings.push({
            code: "resource-unresolved",
            message: `Bibliography “${path.basename(name)}” is not valid CSL-JSON; its citation keys remain as written.`,
          });
        } else {
          citations.push(...entries);
        }
      }
      const bundle: DocumentBundle = {
        markdown: read.contents,
        profile: "document",
        metadata: {
          title,
          language: null,
          direction: "auto",
          createdAt: null,
          source: {
            _tag: "workspace-file",
            cwd: root,
            relativePath: target.relativePath,
            revision: read.revision,
          },
        },
        assets: [],
        citations,
        warnings,
      };
      const exportId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const fileName = exportFileName(title, ".docx");
      const reserved = yield* files.reserve({ exportId, fileName });
      const converted = yield* words
        .convert({
          bundle,
          bibliographySources,
          outputPath: reserved.path,
          files: { baseDirectory: path.dirname(target.absolutePath), allowRoots: [root] },
        })
        .pipe(
          Effect.catchTag("WordConversionError", (error) =>
            reject(WORD_FAILURE_REASON[error.reason], error.message),
          ),
        );
      return {
        path: reserved.path,
        fileName,
        byteLength: converted.byteLength,
        warnings: converted.warnings,
      };
    },
  );

  const exportLatex: WordFileExport["Service"]["exportLatex"] = Effect.fn(
    "WordFileExport.exportLatex",
  )(function* (request) {
    const unreadable = () =>
      new ScientWordExportError({
        reason: "file-unreadable",
        message: "Scient could not read this LaTeX project.",
      });
    if (
      path.isAbsolute(request.relativePath) ||
      path.isAbsolute(request.rootRelativePath) ||
      !/\.tex$/iu.test(request.relativePath) ||
      !/\.tex$/iu.test(request.rootRelativePath)
    ) {
      return yield* reject("file-unreadable", "Choose a LaTeX document inside the project.");
    }
    const root = yield* workspacePaths
      .normalizeWorkspaceRoot(request.cwd)
      .pipe(Effect.mapError(unreadable));
    const source = yield* workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: root,
        relativePath: request.relativePath,
      })
      .pipe(Effect.mapError(unreadable));
    const document = yield* workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: root,
        relativePath: request.rootRelativePath,
      })
      .pipe(Effect.mapError(unreadable));
    const shown = yield* workspaceFiles
      .readFile({ cwd: root, relativePath: source.relativePath })
      .pipe(Effect.mapError(unreadable));
    if (shown.truncated)
      return yield* reject("too-large", "This source file is too large to export.");
    if (shown.revision !== request.revision) {
      return yield* reject(
        "file-changed",
        "The file changed on disk. Save and reopen it before exporting.",
      );
    }
    const prepared = yield* prepareLatexProject(document.absolutePath, root).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (error) =>
          new ScientWordExportError({
            reason: "file-unreadable",
            message: isLatexPreparationError(error)
              ? error.message
              : "Scient could not prepare the LaTeX project.",
          }),
      ),
    );
    const sourceReal = yield* fileSystem
      .realPath(source.absolutePath)
      .pipe(Effect.mapError(unreadable));
    if (!prepared.files.includes(sourceReal)) {
      return yield* reject(
        "file-unreadable",
        "This source file is not part of the selected LaTeX document.",
      );
    }
    const title = path.basename(document.relativePath).replace(/\.tex$/iu, "") || "Document";
    const bundle: DocumentBundle = {
      markdown: "",
      profile: "document",
      metadata: {
        title,
        language: null,
        direction: "auto",
        createdAt: null,
        source: {
          _tag: "workspace-file",
          cwd: root,
          relativePath: document.relativePath,
          revision: shown.revision,
        },
      },
      assets: [],
      citations: [],
      warnings: [],
    };
    const exportId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const fileName = exportFileName(title, ".docx");
    const reserved = yield* files.reserve({ exportId, fileName });
    const converted = yield* words
      .convert({
        bundle,
        latex: prepared,
        outputPath: reserved.path,
        files: { baseDirectory: prepared.baseDirectory, allowRoots: [prepared.baseDirectory] },
      })
      .pipe(
        Effect.catchTag("WordConversionError", (error) =>
          reject(WORD_FAILURE_REASON[error.reason], error.message),
        ),
      );
    return {
      path: reserved.path,
      fileName,
      byteLength: converted.byteLength,
      warnings: converted.warnings,
    };
  });

  return WordFileExport.of({ export: exportFile, exportLatex });
});

export const layer = Layer.effect(WordFileExport, make);

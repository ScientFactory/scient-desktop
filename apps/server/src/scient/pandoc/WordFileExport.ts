/**
 * Project Markdown file → Word.
 *
 * An isolated adapter until the shared project-Markdown capture (conversation
 * export PR 2) produces document bundles: it reads the saved file through the
 * workspace file system, refuses when the file on disk is not the revision the
 * editor showed, and builds a `document`-profile bundle with bounded local
 * image bytes captured before conversion. The converter cannot reopen project
 * images; unmatched Pandoc image URLs become visible placeholders. YAML CSL
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
  type ScientWordDiagramPlan,
} from "@t3tools/contracts";
import { exportFileName } from "@scientfactory/conversation";
import { inspectMarkdownDocument } from "@scientfactory/scient-markdown";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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
import {
  checkedFileIdentity,
  readVerifiedWorkspaceFile,
} from "../documentExport/verifiedWorkspaceRead.ts";
import { PandocWordConverter, type WordConversionFailureReason } from "./PandocWordConverter.ts";
import {
  LATEX_UNVERIFIABLE_PLATFORM_MESSAGE,
  LatexPreparationError,
  prepareLatexProject,
} from "./latexProjectPreparation.ts";
import { citationsFromCslJson, markdownReferenceDeclarations } from "./markdownWordReferences.ts";
import { capturedWordDiagramAssets, planWordDiagrams } from "./wordDiagramCapture.ts";
import { captureWordImages } from "./wordImageSnapshot.ts";

const MARKDOWN_FILE = /\.(?:md|markdown|mdown|mkd)$/iu;
/** The most of one bibliography file a Markdown export reads, as for any project file read. */
const BIBLIOGRAPHY_MAX_BYTES = 1024 * 1024;
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
    readonly prepareDiagrams: (
      request: ScientWordFileExportRequest,
    ) => Effect.Effect<ScientWordDiagramPlan, ScientWordExportError>;
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

  const isInside = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };

  /**
   * Reads a bibliography the Markdown file names, only through a handle bound
   * to the file its path check saw (`verifiedWorkspaceRead.ts`), so a file or
   * folder swapped for a link out of the project after the check is not read.
   */
  const readBibliography = Effect.fn("WordFileExport.readBibliography")(function* (
    root: string,
    candidate: string,
  ) {
    const unreadable = { _tag: "unreadable" } as const;
    if (!isInside(root, candidate)) return unreadable;
    const canonicalRoot = yield* fileSystem.realPath(root).pipe(Effect.option);
    const canonical = yield* fileSystem.realPath(candidate).pipe(Effect.option);
    if (
      canonicalRoot._tag === "None" ||
      canonical._tag === "None" ||
      !isInside(canonicalRoot.value, canonical.value)
    )
      return unreadable;
    const info = yield* fileSystem.stat(canonical.value).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "File") return unreadable;
    if (Number(info.value.size) > BIBLIOGRAPHY_MAX_BYTES) return unreadable;
    const read = yield* readVerifiedWorkspaceFile(
      checkedFileIdentity(canonical.value, info.value),
      canonicalRoot.value,
      yield* HostProcessPlatform,
      BIBLIOGRAPHY_MAX_BYTES,
    );
    return read._tag === "bytes"
      ? ({ _tag: "contents", contents: new TextDecoder("utf-8").decode(read.bytes) } as const)
      : read._tag === "unsupported-platform"
        ? read
        : unreadable;
  });

  const readSavedMarkdown = Effect.fn("WordFileExport.readSavedMarkdown")(function* (
    request: ScientWordFileExportRequest,
  ) {
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
      .resolveRelativePathWithinRoot({
        workspaceRoot: root,
        relativePath: request.relativePath,
      })
      .pipe(Effect.mapError(unreadable));
    const read = yield* workspaceFiles
      .readFile({ cwd: root, relativePath: target.relativePath })
      .pipe(Effect.mapError(unreadable));
    if (read.truncated)
      return yield* reject("too-large", "This file is too large to export to Word.");
    if (read.revision !== request.revision) {
      return yield* reject(
        "file-changed",
        "The file on disk is not the version shown in the editor. Save it, then export again.",
      );
    }
    return { root, target, read };
  });

  const prepareDiagrams: WordFileExport["Service"]["prepareDiagrams"] = Effect.fn(
    "WordFileExport.prepareDiagrams",
  )(function* (request) {
    const { read } = yield* readSavedMarkdown(request);
    return yield* Effect.try({
      try: () => planWordDiagrams(read.contents, read.revision),
      catch: () =>
        new ScientWordExportError({
          reason: "too-large",
          message: "This file has too many or oversized Mermaid diagrams for Word export.",
        }),
    });
  });

  const exportFile: WordFileExport["Service"]["export"] = Effect.fn("WordFileExport.export")(
    function* (request) {
      const { root, target, read } = yield* readSavedMarkdown(request);

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
        const loaded = yield* readBibliography(
          root,
          path.resolve(path.dirname(target.absolutePath), name),
        );
        if (loaded._tag === "unsupported-platform") {
          warnings.push({
            code: "resource-unresolved",
            message: `Bibliography “${path.basename(name)}” was not used: this platform cannot safely verify workspace file paths during Word export; its citation keys remain as written.`,
          });
          continue;
        }
        if (loaded._tag !== "contents") {
          warnings.push({
            code: "resource-unresolved",
            message: `Bibliography “${path.basename(name)}” could not be read inside this project; its citation keys remain as written.`,
          });
          continue;
        }
        if (/\.bib$/iu.test(name)) {
          bibliographySources.push({ format: "bibtex", contents: loaded.contents });
          continue;
        }
        const entries = citationsFromCslJson(loaded.contents);
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
      const diagrams = yield* Effect.try({
        try: () => capturedWordDiagramAssets(bundle, read.revision, request.diagramCapture),
        catch: (cause) =>
          new ScientWordExportError({
            reason: "conversion-failed",
            message: cause instanceof Error ? cause.message : "The diagram capture is invalid.",
          }),
      });
      const imageSnapshot = yield* captureWordImages(
        inspectMarkdownDocument(read.contents).imageReferences,
        { baseDirectory: path.dirname(target.absolutePath), allowRoots: [root] },
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          () =>
            new ScientWordExportError({
              reason: "too-large",
              message: "This document names too many images for one Word export.",
            }),
        ),
      );
      yield* readSavedMarkdown(request);
      const exportId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const fileName = exportFileName(title, ".docx");
      const reserved = yield* files.reserve({ exportId, fileName });
      const converted = yield* words
        .convert({
          bundle: { ...bundle, assets: [...bundle.assets, ...diagrams] },
          bibliographySources,
          imageSnapshot,
          outputPath: reserved.path,
          files: { baseDirectory: path.dirname(target.absolutePath), allowRoots: [root] },
        })
        .pipe(
          Effect.catchTags({
            WordConversionError: (error) =>
              reject(WORD_FAILURE_REASON[error.reason], error.message),
          }),
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
    const prepared = yield* prepareLatexProject(document.absolutePath, root, {
      path: source.absolutePath,
      revision: shown.revision,
    }).pipe(
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
    // Figures resolve from the root file's folder, anywhere inside the project.
    const imageSnapshot = yield* captureWordImages(prepared.imageReferences, {
      baseDirectory: prepared.baseDirectory,
      allowRoots: [root],
      requireVerifiedReads: true,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((error) =>
        error.reason === "unverifiable-platform"
          ? new ScientWordExportError({
              reason: "file-unreadable",
              message: LATEX_UNVERIFIABLE_PLATFORM_MESSAGE,
            })
          : new ScientWordExportError({
              reason: "too-large",
              message: "This document names too many images for one Word export.",
            }),
      ),
    );
    const current = yield* workspaceFiles
      .readFile({ cwd: root, relativePath: source.relativePath })
      .pipe(Effect.mapError(unreadable));
    if (current.truncated || current.revision !== shown.revision) {
      return yield* reject(
        "file-changed",
        "The file changed on disk. Save and reopen it before exporting.",
      );
    }
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
          relativePath: source.relativePath,
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
        imageSnapshot,
        outputPath: reserved.path,
        files: { baseDirectory: prepared.baseDirectory, allowRoots: [root] },
      })
      .pipe(
        Effect.catchTags({
          WordConversionError: (error) => reject(WORD_FAILURE_REASON[error.reason], error.message),
        }),
      );
    return {
      path: reserved.path,
      fileName,
      byteLength: converted.byteLength,
      warnings: converted.warnings,
    };
  });

  return WordFileExport.of({ export: exportFile, prepareDiagrams, exportLatex });
});

export const layer = Layer.effect(WordFileExport, make);

/**
 * Document bundle → Word (.docx), through the managed Pandoc.
 *
 * The two-pass pipeline qualified for Word export (Pandoc qualification,
 * REPORT §4), with Scient's preparation between the passes:
 *
 * 1. **Read**, sandboxed: `pandoc --sandbox -f <Scient profile> -t json`, the
 *    bundle Markdown on stdin.
 * 2. **Prepare and secure**, in Scient: map Scient's Markdown profile
 *    (conversation structure, details, alerts, task lists, Mermaid, wide
 *    tables), turn citation groups with references into `Cite` nodes, then run
 *    the security pass (metadata, raw nodes, images, links) and mark text
 *    direction.
 * 3. **Write**, sandboxed: `pandoc --sandbox -f json -t docx` with Scient's
 *    reference document and, when the document cites references, a CSL-JSON
 *    bibliography and `--citeproc`; every file Pandoc may read is copied into
 *    the run's scratch directory under a fixed name first.
 *
 * Each pass is a separate Pandoc process with a fresh environment, a heap
 * limit, a timeout, and an output limit (`pandocProcess.ts`), and the whole
 * conversion shares one time budget ({@link SCIENT_WORD_CONVERSION_TIMEOUT_MS}),
 * which clients outwait. The Word file is
 * streamed to `<output>.partial` and renamed into place only when Pandoc
 * succeeded; interruption kills Pandoc and removes the partial file and the
 * scratch directory. Pandoc's options are Scient's alone: no filters, no
 * `--pdf-engine`, no user-supplied flags.
 */
import {
  SCIENT_WORD_CONVERSION_TIMEOUT_MS,
  type DocumentBundle,
  type DocumentWarning,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { decodePandocDocument, toPandocDocument } from "./pandocAst.ts";
import { applyCitations, bibliographyFromCitations } from "./pandocCitations.ts";
import { citationsFromCslJson } from "./markdownWordReferences.ts";
import { applyDirection } from "./pandocDirection.ts";
import { PandocManagedTool } from "./PandocManagedTool.ts";
import {
  applyScientStructure,
  conversionNotesBlocks,
  landscapeWideTables,
  unlistedWarnings,
} from "./pandocPreparation.ts";
import {
  makePandocScratch,
  runPandoc,
  type PandocLimits,
  type PandocRunError,
} from "./pandocProcess.ts";
import { securePandocDocument } from "./pandocResources.ts";
import { scientReferenceDocument } from "./scientReferenceDocument.ts";
import type { PreparedLatexProject } from "./latexProjectPreparation.ts";
import type { CapturedWorkspaceImage } from "./wordImageSnapshot.ts";

/**
 * Scient's document and chat profiles, read with CommonMark plus exactly the
 * extensions the profiles have: GFM tables, task lists, strikethrough, and
 * autolinks; alerts; `$…$` math; footnotes; wiki links; YAML front matter; raw
 * HTML (so `<details>` reaches preparation). Pandoc-only syntax (attributes,
 * fenced divs, bracketed spans, raw attributes, definition and fancy lists,
 * sub/superscript, smart punctuation, emoji, implicit header references) is
 * off, so text Scient shows literally is not reinterpreted.
 */
export const SCIENT_PANDOC_READER = [
  "commonmark_x",
  "-attributes",
  "-fenced_divs",
  "-bracketed_spans",
  "-raw_attribute",
  "-definition_lists",
  "-fancy_lists",
  "-subscript",
  "-superscript",
  "-smart",
  "-emoji",
  "-implicit_header_references",
  "+autolink_bare_uris",
  "+wikilinks_title_after_pipe",
].join("");

export const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const WORD_READ_LIMITS: PandocLimits = {
  timeout: "2 minutes",
  maxHeapMb: 1024,
  // The JSON tree runs 5–20× the size of the finished Word file.
  maxStdoutBytes: 256 * 1024 * 1024,
};
const WORD_WRITE_LIMITS: PandocLimits = {
  timeout: "2 minutes",
  maxHeapMb: 1024,
  maxStdoutBytes: 512 * 1024 * 1024,
};
const MAX_PANDOC_WARNINGS = 20;
/** Keep the first Pandoc read bounded before allocating a UTF-8 input buffer. */
export const MAX_WORD_SOURCE_BYTES = 8 * 1024 * 1024;

export const WordConversionFailureReason = Schema.Literals([
  "unavailable",
  "too-large",
  "timeout",
  "failed",
]);
export type WordConversionFailureReason = typeof WordConversionFailureReason.Type;

export class WordConversionError extends Schema.TaggedError<WordConversionError>()(
  "WordConversionError",
  {
    reason: WordConversionFailureReason,
    /** One line a user can act on. */
    message: Schema.String,
  },
) {}

export interface WordConversionInput {
  readonly bundle: DocumentBundle;
  /** Prepared, bounded project source. Never pass a workspace path to Pandoc. */
  readonly latex?: PreparedLatexProject;
  /** Where the Word file lands; written as `<outputPath>.partial` and renamed. */
  readonly outputPath: string;
  /** For callers without an image snapshot that resolve relative files during conversion. */
  readonly files?: {
    readonly baseDirectory: string;
    readonly allowRoots: ReadonlyArray<string>;
  } | null;
  /** Exact workspace image bytes captured with the source before conversion. */
  readonly imageSnapshot?: ReadonlyMap<string, CapturedWorkspaceImage>;
  /** A CSL style for the bibliography; Pandoc's built-in Chicago author-date otherwise. */
  readonly cslStyle?: string | null;
  /** Saved, project-allowlisted BibTeX bytes; Pandoc reads them from stdin. */
  readonly bibliographySources?: ReadonlyArray<{
    readonly format: "bibtex";
    readonly contents: string;
  }>;
  /** Overrides for tests of the limits. */
  readonly limits?: {
    readonly read?: PandocLimits;
    readonly write?: PandocLimits;
    /** The whole conversion's budget; {@link SCIENT_WORD_CONVERSION_TIMEOUT_MS} otherwise. */
    readonly totalMs?: number;
  };
}

export interface WordConversionResult {
  readonly byteLength: number;
  /** What this conversion could not carry, plus what Pandoc reported. */
  readonly warnings: ReadonlyArray<DocumentWarning>;
  readonly summary: {
    readonly embeddedImages: number;
    readonly placeholders: number;
    readonly workLogBlocks: number;
    readonly reasoningBlocks: number;
    readonly citedReferences: number;
    readonly rtlDocument: boolean;
    readonly landscapeTables: number;
  };
}

export interface WordAvailability {
  readonly available: boolean;
  /** Why Word export cannot run now; null when it can. */
  readonly reason: string | null;
  /** Installing Pandoc would make Word export available. */
  readonly installable: boolean;
}

export class PandocWordConverter extends Context.Service<
  PandocWordConverter,
  {
    readonly availability: Effect.Effect<WordAvailability>;
    readonly convert: (
      input: WordConversionInput,
    ) => Effect.Effect<WordConversionResult, WordConversionError>;
  }
>()("t3/scient/pandoc/PandocWordConverter") {}

const conversionTimeout = () =>
  new WordConversionError({
    reason: "timeout",
    message: "Converting to Word took too long and was stopped. Export a shorter range.",
  });

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function runFailure(error: PandocRunError): WordConversionError {
  switch (error.reason) {
    case "heap-limit":
      return new WordConversionError({
        reason: "too-large",
        message:
          "This document needs more memory than Word export allows. Export a shorter range or leave out the work log.",
      });
    case "output-limit":
      return new WordConversionError({
        reason: "too-large",
        message:
          "The Word file would be larger than Word export allows. Export a shorter range or fewer images.",
      });
    case "timeout":
      return conversionTimeout();
    case "parse-error":
      return new WordConversionError({
        reason: "failed",
        message: "Pandoc could not read the prepared document, so no Word file was written.",
      });
    case "fetch-refused":
      return new WordConversionError({
        reason: "failed",
        message:
          "Pandoc tried to fetch a resource, which Scient does not allow, so no Word file was written.",
      });
    case "spawn-failed":
      return new WordConversionError({
        reason: "unavailable",
        message: "Pandoc could not be started. Reinstall Pandoc, then export again.",
      });
    case "failed":
      return new WordConversionError({
        reason: "failed",
        message: "Pandoc could not write the Word file.",
      });
  }
}

const make = Effect.gen(function* () {
  const tool = yield* PandocManagedTool;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const hostEnvironment = yield* HostProcessEnvironment;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();

  const availability: PandocWordConverter["Service"]["availability"] = tool.status.pipe(
    Effect.map((status): WordAvailability => {
      if (status.installed) return { available: true, reason: null, installable: false };
      if (!status.canInstall) {
        return {
          available: false,
          reason: status.unavailableReason ?? "Word export is not available on this computer.",
          installable: false,
        };
      }
      return {
        available: false,
        reason:
          status.reinstallRequired === true
            ? "Pandoc could not be started. Reinstall it to export to Word."
            : `Word export needs Pandoc (${formatMegabytes(status.downloadBytes ?? 0)} download).`,
        installable: true,
      };
    }),
  );

  const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

  const convert: PandocWordConverter["Service"]["convert"] = Effect.fn(
    "scient.pandoc.convertToWord",
  )(function* (input) {
    const source = input.latex?.source ?? input.bundle.markdown;
    if (Buffer.byteLength(source, "utf8") > MAX_WORD_SOURCE_BYTES) {
      return yield* new WordConversionError({
        reason: "too-large",
        message: "The Word source exceeds 8 MB. Export a shorter range or leave out the work log.",
      });
    }
    const pandoc = yield* tool.command;
    if (pandoc === null) {
      const current = yield* availability;
      return yield* new WordConversionError({
        reason: "unavailable",
        message: current.reason ?? "Word export needs Pandoc.",
      });
    }
    const readLimits = input.limits?.read ?? WORD_READ_LIMITS;
    const writeLimits = input.limits?.write ?? WORD_WRITE_LIMITS;
    const partialPath = `${input.outputPath}.partial`;

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const scratch = yield* makePandocScratch(tool.scratchRoot);
        const scrub = (text: string) => text.split(scratch.root).join("").slice(0, 400);
        const run = (
          args: ReadonlyArray<string>,
          stdin: Uint8Array,
          limits: PandocLimits,
          stdoutPath?: string,
        ) =>
          runPandoc({
            pandoc,
            args,
            stdin,
            scratch,
            limits,
            platform,
            hostEnvironment,
            ...(stdoutPath === undefined ? {} : { stdoutPath }),
          }).pipe(
            Effect.tapError((error) =>
              error.reason === "spawn-failed" ? tool.discardUnstartable(pandoc) : Effect.void,
            ),
            Effect.mapError(runFailure),
          );

        // 1. Read. Tabs stay as written, as Scient's Markdown parser reads them
        // (and so Mermaid fences keep the identity their captured image has).
        const read = yield* run(
          input.latex
            ? ["--sandbox", "-f", "latex", "-t", "json"]
            : ["--sandbox", "--preserve-tabs", "-f", SCIENT_PANDOC_READER, "-t", "json"],
          new TextEncoder().encode(source),
          readLimits,
        );
        const decoded = yield* decodePandocDocument(new TextDecoder().decode(read.stdout)).pipe(
          Effect.mapError(
            () =>
              new WordConversionError({
                reason: "failed",
                message: "Pandoc returned a document Scient could not read.",
              }),
          ),
        );
        const document = toPandocDocument(decoded);
        // The bundle's own notes the Markdown does not already show go into the Word notes.
        const unlistedBundleWarnings = unlistedWarnings(document.blocks, input.bundle.warnings);

        // 2. Prepare and secure.
        const structure = applyScientStructure(document.blocks, {
          profile: input.bundle.profile,
          assets: input.bundle.assets,
        });
        const bibliography = new Map(bibliographyFromCitations(input.bundle.citations));
        const bibliographyWarnings: Array<DocumentWarning> = [];
        for (const [index, source] of (input.bibliographySources ?? []).entries()) {
          const parsed = yield* run(
            ["--sandbox", "-f", source.format, "-t", "csljson"],
            new TextEncoder().encode(source.contents),
            readLimits,
          ).pipe(Effect.option);
          const entries =
            parsed._tag === "Some"
              ? citationsFromCslJson(new TextDecoder().decode(parsed.value.stdout))
              : null;
          if (entries === null) {
            bibliographyWarnings.push({
              code: "resource-unresolved",
              message: `Bibliography ${index + 1} could not be parsed; its citation keys remain as written.`,
            });
            continue;
          }
          for (const [key, reference] of bibliographyFromCitations(entries)) {
            if (!bibliography.has(key)) bibliography.set(key, reference);
          }
        }
        const citations = applyCitations(document.blocks, bibliography);
        const security = yield* securePandocDocument(document, {
          assets: input.bundle.assets,
          files: input.imageSnapshot === undefined ? (input.files ?? null) : null,
          ...(input.imageSnapshot === undefined ? {} : { imageSnapshot: input.imageSnapshot }),
        });
        const direction = applyDirection(document, input.bundle.metadata.direction);
        if (input.bundle.metadata.language !== null) {
          document.meta.lang = { t: "MetaString", c: input.bundle.metadata.language };
        }
        const pandocWarnings = (warnings: ReadonlyArray<string>): Array<DocumentWarning> => {
          const listed = warnings.slice(0, MAX_PANDOC_WARNINGS).map((warning): DocumentWarning => ({
            code: "converter-reported",
            message: `Pandoc reported: ${scrub(warning) || "a problem without details"}`,
          }));
          return warnings.length > MAX_PANDOC_WARNINGS
            ? [
                ...listed,
                {
                  code: "converter-reported",
                  message: `Pandoc reported ${warnings.length - MAX_PANDOC_WARNINGS} more problems.`,
                },
              ]
            : listed;
        };
        const conversionWarnings = [
          ...(input.latex?.warnings ?? []),
          ...structure.warnings,
          ...bibliographyWarnings,
          ...citations.warnings,
          ...security.warnings,
          ...direction.warnings,
          ...pandocWarnings(read.warnings),
        ];
        const preparedBlocks = [...document.blocks];

        // 3. Write: only the files named below are readable inside the sandbox.
        const args = ["--sandbox", "-f", "json", "-t", "docx", "--reference-doc=reference.docx"];
        yield* fileSystem.writeFile(
          path.join(scratch.work, "reference.docx"),
          yield* scientReferenceDocument,
        );
        const cited = [...citations.citedKeys].flatMap((key) => {
          const item = bibliography.get(key);
          return item === undefined ? [] : [item];
        });
        if (cited.length > 0) {
          yield* fileSystem.writeFileString(
            path.join(scratch.work, "bibliography.json"),
            yield* encodeJson(cited).pipe(Effect.orDie),
          );
          args.push("--citeproc", "--bibliography=bibliography.json");
          if (input.cslStyle != null && input.cslStyle.trim().length > 0) {
            yield* fileSystem.writeFileString(path.join(scratch.work, "style.csl"), input.cslStyle);
            args.push("--csl=style.csl");
          }
        }
        if (input.latex && input.latex.bibliography.length > 0) {
          args.push("--citeproc");
          for (const [index, item] of input.latex.bibliography.entries()) {
            const name = `latex-bibliography-${index}.bib`;
            yield* fileSystem.writeFileString(path.join(scratch.work, name), item.contents);
            args.push(`--bibliography=${name}`);
          }
        }
        const notes = [...unlistedBundleWarnings, ...conversionWarnings];
        const writerWarnings: Array<DocumentWarning> = [];
        // The writer reports warnings only after producing bytes. Rebuild once with those notes.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          document.blocks = [...preparedBlocks, ...conversionNotesBlocks(notes)];
          // Scient's own page layout runs after the security pass removed source raw nodes.
          const landscapeTables = landscapeWideTables(document.blocks, direction.rtlDocument);
          const written = yield* run(
            args,
            new TextEncoder().encode(yield* encodeJson(document).pipe(Effect.orDie)),
            writeLimits,
            partialPath,
          );
          const newlyReported = pandocWarnings(written.warnings).filter(
            (warning) => !notes.some((note) => note.message === warning.message),
          );
          if (newlyReported.length === 0) {
            yield* fileSystem.rename(partialPath, input.outputPath);
            return {
              byteLength: written.stdoutBytes,
              warnings: [...input.bundle.warnings, ...conversionWarnings, ...writerWarnings],
              summary: {
                embeddedImages: security.embeddedImages,
                placeholders: security.placeholders,
                workLogBlocks: structure.workLogBlocks,
                reasoningBlocks: structure.reasoningBlocks,
                citedReferences: cited.length,
                rtlDocument: direction.rtlDocument,
                landscapeTables,
              },
            } satisfies WordConversionResult;
          }
          if (attempt === 1) {
            return yield* new WordConversionError({
              reason: "failed",
              message:
                "Pandoc reported new warnings while writing the Word file. No file was saved.",
            });
          }
          writerWarnings.push(...newlyReported);
          notes.push(...newlyReported);
          yield* fileSystem.remove(partialPath, { force: true });
        }
        return yield* new WordConversionError({
          reason: "failed",
          message: "Pandoc could not finish the Word file.",
        });
      }),
    ).pipe(
      // Interrupting the conversion kills its Pandoc and removes its scratch.
      Effect.timeoutOrElse({
        duration: input.limits?.totalMs ?? SCIENT_WORD_CONVERSION_TIMEOUT_MS,
        orElse: () => Effect.fail(conversionTimeout()),
      }),
      Effect.catchTag("PlatformError", (cause) =>
        Effect.logWarning("scient pandoc word conversion file error", { cause }).pipe(
          Effect.andThen(
            Effect.fail(
              new WordConversionError({
                reason: "failed",
                message: "Scient could not prepare the files for the Word conversion.",
              }),
            ),
          ),
        ),
      ),
      // A failed or interrupted conversion leaves no partial Word file.
      Effect.ensuring(fileSystem.remove(partialPath, { force: true }).pipe(Effect.ignoreCause())),
      Effect.provideContext(context),
    );
  });

  return PandocWordConverter.of({ availability, convert });
});

export const layer = Layer.effect(PandocWordConverter, make);

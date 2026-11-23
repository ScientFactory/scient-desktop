// @effect-diagnostics nodeBuiltinImport:off -- preview bytes are read from the retained result record.
import * as NodeFSP from "node:fs/promises";

import {
  ComputeSessionId,
  NotebookError,
  type NotebookAlternatives,
  type NotebookReadInput,
} from "@t3tools/contracts";
import { readResultValues } from "@t3tools/shared/computeResults";
import * as Effect from "effect/Effect";

import { notebookSourceDigest, recordedNotebookCells } from "./notebookRevisionSource.ts";
import type { NotebookStore } from "./NotebookStore.ts";
import type { ComputeRpcGateway } from "../compute/ComputeRpcGateway.ts";
import { parseCsv } from "../results/latexOutputs.ts";
import { isPublishedResultRevision, makeResultsReader } from "../results/resultRevisions.ts";

const RETAINED_ALTERNATIVES = 20;
const PREVIEW_BYTES = 512 * 1024;
const TOTAL_PREVIEW_BYTES = 8 * 1024 * 1024;
const previewFigure = (mediaType: string): "image/png" | "image/jpeg" | "image/svg+xml" | null =>
  mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "image/svg+xml"
    ? mediaType
    : null;

export function makeNotebookReader(
  computeDir: string,
  gateway: Pick<ComputeRpcGateway, "project" | "listAllExecutions">,
) {
  return Effect.fn("NotebookReader.alternatives")(function* (
    request: NotebookReadInput,
    currentSourceSha256?: string,
  ) {
    const project = yield* gateway
      .project({ cwd: request.cwd })
      .pipe(
        Effect.mapError(() => new NotebookError({ message: "The project could not be opened." })),
      );
    const reader = makeResultsReader({ computeDir }, project.projectId, project.root);
    const alternatives = yield* Effect.tryPromise({
      try: async (): Promise<NotebookAlternatives> => {
        const revisions = (await reader.revisions()).filter(
          (revision) =>
            revision.script.path === request.path &&
            revision.script.kind === "notebook" &&
            revision.outputs.length > 0,
        );
        const published = revisions.find(isPublishedResultRevision);
        const compatible =
          currentSourceSha256 === undefined
            ? undefined
            : revisions.find(
                ({ script }) =>
                  script.notebookDigestVersion !== undefined &&
                  script.codeSha256 === currentSourceSha256,
              );
        const preferred = [...new Set([published, compatible])].filter(
          (entry) => entry !== undefined,
        );
        const retained = [
          ...preferred,
          ...revisions.filter((entry) => !preferred.includes(entry)),
        ].slice(0, RETAINED_ALTERNATIVES);
        let budget = TOTAL_PREVIEW_BYTES;
        const runs = [];
        for (const revision of retained) {
          const outputs = [];
          const values = [];
          for (const output of revision.outputs) {
            if (!["values", "figure", "table"].includes(output.kind)) continue;
            const file =
              output.size > Math.min(PREVIEW_BYTES, budget)
                ? null
                : await reader.outputFile(revision, output.name);
            const bytes =
              file === null ? null : await NodeFSP.readFile(file.path).catch(() => null);
            if (bytes !== null) budget -= bytes.byteLength;
            if (output.kind === "values") {
              if (bytes === null) {
                outputs.push({ name: output.name, preview: null });
                continue;
              }
              const leaves = readResultValues(bytes.toString("utf8")) ?? [];
              values.push(
                ...leaves.map((leaf) => ({
                  output: output.name,
                  pointer: leaf.pointer,
                  value: leaf.value,
                })),
              );
              continue;
            }
            const rows =
              output.kind === "table" && bytes !== null ? parseCsv(bytes.toString("utf8")) : null;
            const figure = previewFigure(output.mediaType);
            const preview =
              rows !== null
                ? {
                    _tag: "table" as const,
                    rows: rows.slice(0, 30).map((row) => row.slice(0, 20)),
                    partial: rows.length > 30 || rows.some((row) => row.length > 20),
                  }
                : bytes !== null && figure !== null
                  ? { _tag: "figure" as const, mediaType: figure, data: bytes.toString("base64") }
                  : null;
            outputs.push({ name: output.name, preview });
          }
          const source = await reader.notebookSource(revision);
          runs.push({
            revision: revision.revision,
            finishedAt: revision.run.finishedAt,
            ...(revision.script.codeSha256 === undefined
              ? {}
              : { codeSha256: revision.script.codeSha256 }),
            ...(revision.script.notebookDigestVersion === undefined
              ? {}
              : { notebookDigestVersion: revision.script.notebookDigestVersion }),
            ...(source === undefined ? {} : { source }),
            parameters: revision.parameters ?? [],
            values,
            outputs,
          });
        }
        return {
          runs,
          publishedRevision: published?.revision ?? null,
          prunedRuns: revisions.length - runs.length,
        };
      },
      catch: () =>
        new NotebookError({ message: "The notebook's saved results could not be read." }),
    });
    const runs = yield* Effect.forEach(alternatives.runs, (run) => {
      if (run.source !== undefined) {
        return Effect.succeed(run);
      }
      return retainedReaderSource(reader, gateway, project.root, run.revision).pipe(
        Effect.map((source) => (source === undefined ? run : { ...run, source })),
      );
    });
    return { ...alternatives, runs };
  });
}

const retainedReaderSource = Effect.fn("NotebookReader.retainedSource")(function* (
  reader: ReturnType<typeof makeResultsReader>,
  gateway: Pick<ComputeRpcGateway, "listAllExecutions">,
  cwd: string,
  id: string,
) {
  const revision = (yield* Effect.promise(() => reader.revisions())).find(
    (entry) => entry.revision === id,
  );
  if (revision === undefined) return undefined;
  const history = yield* gateway
    .listAllExecutions({ cwd, sessionId: ComputeSessionId.make(revision.run.sessionId) })
    .pipe(Effect.orElseSucceed(() => []));
  const cells = recordedNotebookCells(revision, history);
  return cells === undefined
    ? undefined
    : {
        language: revision.script.language,
        cells: cells.map((source, index) => ({
          id: String(index),
          cellType: "code" as const,
          source,
        })),
      };
});

export const readNotebookWithAlternatives = Effect.fn(
  "NotebookReader.readNotebookWithAlternatives",
)(function* (
  request: NotebookReadInput,
  read: NotebookStore["Service"]["read"],
  alternatives: ReturnType<typeof makeNotebookReader>,
) {
  const notebook = yield* read(request);
  if (notebook === null || !request.includeAlternatives) return notebook;
  const currentSourceSha256 = notebookSourceDigest(notebook);
  return {
    ...notebook,
    alternatives: { ...(yield* alternatives(request, currentSourceSha256)), currentSourceSha256 },
  };
});

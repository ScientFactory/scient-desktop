// @effect-diagnostics nodeBuiltinImport:off -- preview bytes are read from the retained result record.
import * as NodeFSP from "node:fs/promises";

import {
  NotebookError,
  type NotebookAlternatives,
  type NotebookReadInput,
} from "@t3tools/contracts";
import { readResultValues } from "@t3tools/shared/computeResults";
import * as Effect from "effect/Effect";

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
  gateway: Pick<ComputeRpcGateway, "project">,
) {
  return Effect.fn("NotebookReader.alternatives")(function* (request: NotebookReadInput) {
    const project = yield* gateway
      .project({ cwd: request.cwd })
      .pipe(
        Effect.mapError(() => new NotebookError({ message: "The project could not be opened." })),
      );
    const reader = makeResultsReader({ computeDir }, project.projectId, project.root);
    return yield* Effect.tryPromise({
      try: async (): Promise<NotebookAlternatives> => {
        const revisions = (await reader.revisions()).filter(
          (revision) =>
            revision.script.path === request.path && revision.script.kind === "notebook",
        );
        const published = revisions.find(isPublishedResultRevision);
        const retained =
          published === undefined
            ? revisions.slice(0, RETAINED_ALTERNATIVES)
            : [
                published,
                ...revisions
                  .filter((entry) => entry !== published)
                  .slice(0, RETAINED_ALTERNATIVES - 1),
              ];
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
          runs.push({
            revision: revision.revision,
            finishedAt: revision.run.finishedAt,
            ...(revision.script.codeSha256 === undefined
              ? {}
              : { codeSha256: revision.script.codeSha256 }),
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
  });
}

export const readNotebookWithAlternatives = Effect.fn(
  "NotebookReader.readNotebookWithAlternatives",
)(function* (
  request: NotebookReadInput,
  read: NotebookStore["Service"]["read"],
  alternatives: ReturnType<typeof makeNotebookReader>,
) {
  const notebook = yield* read(request);
  if (notebook === null || !request.includeAlternatives) return notebook;
  return { ...notebook, alternatives: yield* alternatives(request) };
});

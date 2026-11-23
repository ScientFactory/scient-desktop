// @effect-diagnostics nodeBuiltinImport:off -- revision source is hashed on the server.
import * as NodeCrypto from "node:crypto";

import type {
  ComputeExecutionRecord,
  ComputeResultRevision,
  NotebookRevisionSource,
} from "@t3tools/contracts";

export const NOTEBOOK_DIGEST_VERSION = 1;

const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function notebookSourceDigest({ language, cells }: NotebookRevisionSource): string {
  return digest([
    NOTEBOOK_DIGEST_VERSION,
    language,
    cells
      .filter((cell) => !cell.injectedParameters)
      .map(({ cellType, source, parameterCell }) => [cellType, source, parameterCell === true]),
  ]);
}

export function notebookExecutionDigest(cells: ReadonlyArray<string>): string {
  return digest([NOTEBOOK_DIGEST_VERSION, cells]);
}

export function executedNotebookCells({ cells }: NotebookRevisionSource): ReadonlyArray<string> {
  return cells
    .filter(({ cellType, source }) => cellType === "code" && source.trim() !== "")
    .map(({ source }) => source);
}

export function recordedNotebookCells(
  revision: ComputeResultRevision,
  history: ReadonlyArray<ComputeExecutionRecord>,
): ReadonlyArray<string> | undefined {
  const receipt = history.find(({ request }) => request.executionId === revision.run.executionId);
  if (receipt === undefined || receipt.request.source._tag !== "document") return undefined;
  const batch = receipt.request.source.notebookBatch;
  const entries = (batch === undefined ? [receipt] : history)
    .flatMap(({ request, result }, index) => {
      const { source } = request;
      return request.generation === receipt.request.generation &&
        result?.status === "succeeded" &&
        source._tag === "document" &&
        source.origin === "cell" &&
        source.path === revision.script.path &&
        (batch === undefined || source.notebookBatch?.id === batch.id)
        ? [{ index: source.notebookBatch?.index ?? index, code: request.code }]
        : [];
    })
    .toSorted((left, right) => left.index - right.index);
  if (
    entries.length === 0 ||
    (batch !== undefined &&
      (entries.length !== batch.count || entries.some((entry, index) => entry.index !== index)))
  )
    return undefined;
  const cells = entries.map(({ code }) => code);
  const sha256 =
    revision.script.notebookDigestVersion === NOTEBOOK_DIGEST_VERSION
      ? notebookExecutionDigest(cells)
      : NodeCrypto.createHash("sha256").update(cells.join("\n")).digest("hex");
  return sha256 === revision.script.sha256 ? cells : undefined;
}

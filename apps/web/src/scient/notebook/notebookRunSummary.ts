import {
  computeNotebookCellNotRun,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type ComputeExecutionRecord,
  type ComputeSessionRecord,
  type NotebookCellView,
} from "@t3tools/contracts";
import { definedNames } from "@t3tools/shared/notebookStaleness";

export interface NotebookBatchFailureSummary {
  readonly batchId: string;
  readonly cellId: string;
  readonly cellNumber: number;
  readonly skippedCount: number;
}

export interface NotebookDefiningCell {
  readonly name: string;
  readonly cellId: string;
  readonly cellNumber: number;
  readonly status: "failed" | "not-run" | "ran";
}

const UNDEFINED_NAME_PATTERN = /^name '([^'\r\n]+)' is not defined$/;

export function extractUndefinedName(errorName: unknown, message: unknown): string | null {
  if (errorName !== "NameError" || typeof message !== "string") return null;
  return UNDEFINED_NAME_PATTERN.exec(message)?.[1] ?? null;
}

/**
 * Summarizes the latest settled failed multi-cell notebook batch for the current
 * session generation, clearing automatically once the failed cell succeeds or
 * the session restarts.
 */
export function notebookBatchFailureSummary(input: {
  readonly executions: ReadonlyArray<ComputeExecutionRecord>;
  readonly cellRuns: ReadonlyMap<string, ComputeExecutionRecord>;
  readonly path: string;
  readonly order: ReadonlyArray<string>;
  readonly cells: Readonly<Record<string, NotebookCellView>>;
  readonly lastNotebookBatch?: ComputeSessionRecord["lastNotebookBatch"] | undefined;
  readonly liveSessionGeneration: number | null;
}): NotebookBatchFailureSummary | null {
  const { executions, cellRuns, path, order, cells, lastNotebookBatch, liveSessionGeneration } =
    input;
  const batches = new Map<
    string,
    { latestSubmittedAt: string; records: ComputeExecutionRecord[] }
  >();
  for (const execution of executions) {
    const { source, generation, submittedAt } = execution.request;
    if (
      source._tag !== "document" ||
      source.path !== path ||
      source.cell === undefined ||
      source.notebookBatch === undefined
    )
      continue;
    if (liveSessionGeneration !== null && generation !== liveSessionGeneration) continue;
    const id = source.notebookBatch.id;
    const entry = batches.get(id);
    if (entry === undefined) {
      batches.set(id, { latestSubmittedAt: submittedAt, records: [execution] });
    } else {
      entry.records.push(execution);
      if (submittedAt > entry.latestSubmittedAt) entry.latestSubmittedAt = submittedAt;
    }
  }
  if (batches.size === 0) return null;

  let latestId: string | null = null;
  let latestSubmittedAt = "";
  for (const [id, entry] of batches) {
    if (latestId === null || entry.latestSubmittedAt >= latestSubmittedAt) {
      latestId = id;
      latestSubmittedAt = entry.latestSubmittedAt;
    }
  }
  if (latestId === null) return null;
  const records = batches.get(latestId)?.records ?? [];
  const settled = records.every(
    (record) =>
      record.result !== null && TERMINAL_COMPUTE_EXECUTION_STATUSES.has(record.result.status),
  );
  if (!settled) return null;

  let firstFailed: { readonly cellId: string; readonly batchIndex: number } | null = null;
  let skippedCount = 0;
  for (const record of records) {
    const source = record.request.source;
    if (source._tag !== "document" || source.cell === undefined || !source.notebookBatch) continue;
    if (computeNotebookCellNotRun(record)) {
      skippedCount += 1;
    }
    if (record.result?.status === "failed") {
      if (firstFailed === null || source.notebookBatch.index < firstFailed.batchIndex) {
        firstFailed = { cellId: source.cell, batchIndex: source.notebookBatch.index };
      }
    }
  }
  const durableFailure =
    lastNotebookBatch?.id === latestId && lastNotebookBatch.status === "failed"
      ? lastNotebookBatch.firstFailure
      : undefined;
  const cellId =
    firstFailed?.cellId ??
    (durableFailure !== undefined &&
    durableFailure.path === path &&
    durableFailure.generation === liveSessionGeneration
      ? durableFailure.cell
      : undefined);
  if (cellId === undefined) return null;

  const latestForCell = cellRuns.get(cellId);
  if (latestForCell !== undefined && latestForCell.result?.status !== "failed") return null;

  const codeOrder = order.filter((id) => cells[id]?.cellType === "code");
  const codeIndex = codeOrder.indexOf(cellId);
  if (codeIndex < 0) return null;

  const summaryNotRun = lastNotebookBatch?.id === latestId ? (lastNotebookBatch.notRun ?? 0) : 0;

  return {
    batchId: latestId,
    cellId,
    cellNumber: codeIndex + 1,
    skippedCount: Math.max(skippedCount, summaryNotRun),
  };
}

/**
 * Finds the latest earlier code cell defining `name` and reports its live status
 * in the current session generation.
 */
export function notebookDefiningCell(input: {
  readonly order: ReadonlyArray<string>;
  readonly cells: Readonly<Record<string, NotebookCellView>>;
  readonly targetCellId: string;
  readonly name: string;
  readonly cellRuns: ReadonlyMap<string, ComputeExecutionRecord>;
  readonly liveSessionGeneration: number | null;
}): NotebookDefiningCell | null {
  const { order, cells, targetCellId, name, cellRuns, liveSessionGeneration } = input;
  const targetIndex = order.indexOf(targetCellId);
  if (targetIndex <= 0) return null;

  let codeNumber = 0;
  let match: { readonly cellId: string; readonly cellNumber: number } | null = null;
  for (let index = 0; index < targetIndex; index += 1) {
    const id = order[index];
    if (id === undefined) continue;
    const cell = cells[id];
    if (cell?.cellType !== "code") continue;
    codeNumber += 1;
    if (definedNames(cell.source).has(name)) {
      match = { cellId: id, cellNumber: codeNumber };
    }
  }
  if (match === null) return null;

  const run = cellRuns.get(match.cellId);
  const inCurrentSession =
    run !== undefined &&
    (liveSessionGeneration === null || run.request.generation === liveSessionGeneration);
  const status: NotebookDefiningCell["status"] =
    inCurrentSession && run.result?.status === "failed"
      ? "failed"
      : inCurrentSession && run.result?.status === "succeeded"
        ? "ran"
        : "not-run";

  return { name, cellId: match.cellId, cellNumber: match.cellNumber, status };
}

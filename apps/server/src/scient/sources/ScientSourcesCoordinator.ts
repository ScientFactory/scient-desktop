import { sourceMetadataDiagnostics, assessSourceDuplicate } from "@scientfactory/scient-sources";
import {
  cancelSourceImportOperation,
  createSourceImportOperation,
  importScientSource,
  inspectScientSources,
  listScientSourceRecords,
  readSourceImportOperation,
  updateSourceImportOperationItem,
  sourceAttachmentAbsolutePath,
} from "@scientfactory/scient-sources/store";

import {
  getZoteroItem,
  getZoteroImportMaterial,
  inspectZoteroConnection,
  listZoteroLibrary,
} from "./ZoteroLocalAdapter.ts";

const operationLanes = new Map<string, Promise<unknown>>();

async function withOperationLane<A>(key: string, run: () => Promise<A>): Promise<A> {
  const previous = operationLanes.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  operationLanes.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release?.();
    if (operationLanes.get(key) === tail) operationLanes.delete(key);
  }
}

export { inspectZoteroConnection, listZoteroLibrary };

export async function getScientSourcesOverview(root: string) {
  const overview = await inspectScientSources(root);
  return {
    ...overview,
    recordDiagnostics: overview.records.map((record) => ({
      sourceId: record.sourceId,
      diagnostics: sourceMetadataDiagnostics(record),
    })),
    attachmentLocations: overview.records.flatMap((record) =>
      record.attachments.map((attachment) => ({
        attachmentId: attachment.attachmentId,
        absolutePath: sourceAttachmentAbsolutePath(root, attachment),
      })),
    ),
  };
}

export async function preflightZoteroImport(input: {
  readonly root: string;
  readonly itemKeys: ReadonlyArray<string>;
}) {
  const records = await listScientSourceRecords(input.root);
  const items = [];
  for (const itemKey of new Set(input.itemKeys)) {
    const candidate = await getZoteroItem(itemKey);
    items.push({
      candidate,
      duplicate: assessSourceDuplicate({ candidate, existing: records }),
      metadataDiagnostics: sourceMetadataDiagnostics(candidate),
    });
  }
  return { items };
}

export async function beginZoteroImport(input: {
  readonly root: string;
  readonly operationId: string;
  readonly itemKeys: ReadonlyArray<string>;
}) {
  return createSourceImportOperation(input);
}

export async function advanceZoteroImport(input: {
  readonly root: string;
  readonly operationId: string;
}) {
  return withOperationLane(`${input.root}\0${input.operationId}`, async () => {
    const operation = await readSourceImportOperation(input.root, input.operationId);
    if (!operation) throw new Error("The source import operation was not found.");
    if (operation.state !== "running") return operation;
    const pending = operation.items.find((item) => item.state === "pending");
    if (!pending) return operation;
    try {
      const { candidate, pdfPath } = await getZoteroImportMaterial(pending.itemKey);
      const result = await importScientSource({
        root: input.root,
        operationId: input.operationId,
        candidate,
        ...(pdfPath ? { pdfPath } : {}),
      });
      return updateSourceImportOperationItem({
        root: input.root,
        operationId: input.operationId,
        itemKey: pending.itemKey,
        state: result.outcome === "imported" ? "imported" : "skipped",
        ...(result.record ? { sourceId: result.record.sourceId } : {}),
        message: result.duplicate.reason,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The source could not be imported.";
      return updateSourceImportOperationItem({
        root: input.root,
        operationId: input.operationId,
        itemKey: pending.itemKey,
        state: "failed",
        message,
      });
    }
  });
}

export async function cancelZoteroImport(input: {
  readonly root: string;
  readonly operationId: string;
}) {
  return withOperationLane(`${input.root}\0${input.operationId}`, () =>
    cancelSourceImportOperation(input.root, input.operationId),
  );
}

import {
  discardLocalPdfImportMaterial,
  getLocalPdfImportMaterial,
  prepareLocalPdfSource,
} from "./LocalPdfSourceAdapter.ts";
import {
  sourceMetadataDiagnostics,
  assessSourceDuplicate,
  type ScientSourceCandidate,
  type ScientSourceDuplicateAssessment,
  type ScientSourceRecord,
} from "@scientfactory/scient-sources";
import {
  cancelSourceImportOperation,
  canonicalizeScientSourceRoot,
  createSourceImportOperation,
  importScientSource,
  inspectScientSourcePdf,
  inspectScientSources,
  listScientSourceRecords,
  readSourceImportOperation,
  removeScientSource,
  updateSourceImportOperationItem,
  updateScientSourceMetadata,
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
  };
}

export async function getScientSourceAttachmentPreviewMaterial(input: {
  readonly root: string;
  readonly attachmentId: string;
}) {
  const records = await listScientSourceRecords(input.root);
  for (const record of records) {
    const attachment = record.attachments.find(
      (candidate) => candidate.attachmentId === input.attachmentId,
    );
    if (!attachment) continue;
    return {
      absolutePath: sourceAttachmentAbsolutePath(input.root, attachment),
      attachment,
    };
  }
  throw new Error("The source attachment was not found in this project.");
}

export async function updateScientSource(input: Parameters<typeof updateScientSourceMetadata>[0]) {
  return updateScientSourceMetadata(input);
}

export async function removeSource(input: Parameters<typeof removeScientSource>[0]) {
  return removeScientSource(input);
}

export async function assessSourcePreflightDuplicate(input: {
  readonly candidate: ScientSourceCandidate;
  readonly existing: ReadonlyArray<ScientSourceRecord>;
  readonly pdfPath: string | null;
}): Promise<ScientSourceDuplicateAssessment> {
  const preliminary = assessSourceDuplicate({
    candidate: input.candidate,
    existing: input.existing,
  });
  if (
    !input.pdfPath ||
    (preliminary.kind !== "new" && preliminary.kind !== "possible-metadata-match")
  ) {
    return preliminary;
  }
  const pdf = await inspectScientSourcePdf(input.pdfPath);
  return assessSourceDuplicate({
    candidate: input.candidate,
    existing: input.existing,
    pdfSha256: pdf.sha256,
  });
}

export async function preflightZoteroImport(input: {
  readonly root: string;
  readonly itemKeys: ReadonlyArray<string>;
}) {
  const records = await listScientSourceRecords(input.root);
  const hasImportedPdf = records.some((record) =>
    record.attachments.some((attachment) => attachment.kind === "pdf"),
  );
  const items = [];
  for (const itemKey of new Set(input.itemKeys)) {
    const { candidate, pdfPath } = hasImportedPdf
      ? await getZoteroImportMaterial(itemKey)
      : { candidate: await getZoteroItem(itemKey), pdfPath: null };
    const duplicate = await assessSourcePreflightDuplicate({
      candidate,
      existing: records,
      pdfPath,
    });
    items.push({
      candidate,
      duplicate,
      metadataDiagnostics: sourceMetadataDiagnostics(candidate),
    });
  }
  return { items };
}

export async function beginZoteroImport(input: {
  readonly root: string;
  readonly operationId: string;
  readonly itemKeys: ReadonlyArray<string>;
  readonly possibleMetadataMatchOverrides: ReadonlyArray<string>;
}) {
  return createSourceImportOperation({ ...input, adapter: "zotero" });
}

export async function uploadLocalPdfSource(input: {
  readonly root: string;
  readonly sourcePath: string;
  readonly fileName: string;
}) {
  return { item: await prepareLocalPdfSource(input) };
}

export async function beginLocalPdfImport(input: {
  readonly root: string;
  readonly operationId: string;
  readonly itemKeys: ReadonlyArray<string>;
  readonly possibleMetadataMatchOverrides: ReadonlyArray<string>;
}) {
  for (const sourceKey of new Set(input.itemKeys)) {
    await getLocalPdfImportMaterial(input.root, sourceKey);
  }
  return createSourceImportOperation({ ...input, adapter: "local-files" });
}

export async function discardLocalPdfSources(input: {
  readonly root: string;
  readonly itemKeys: ReadonlyArray<string>;
}) {
  const keys = [...new Set(input.itemKeys)];
  await Promise.all(keys.map((sourceKey) => discardLocalPdfImportMaterial(input.root, sourceKey)));
  return { discarded: keys.length };
}

export async function advanceSourceImport(input: {
  readonly root: string;
  readonly operationId: string;
}) {
  const root = await canonicalizeScientSourceRoot(input.root);
  return withOperationLane(`${root}\0${input.operationId}`, async () => {
    const operation = await readSourceImportOperation(root, input.operationId);
    if (!operation) throw new Error("The source import operation was not found.");
    if (operation.state !== "running") return operation;
    const pending = operation.items.find((item) => item.state === "pending");
    if (!pending) return operation;
    try {
      const { candidate, pdfPath, expectedPdf } =
        operation.adapter === "zotero"
          ? { ...(await getZoteroImportMaterial(pending.itemKey)), expectedPdf: undefined }
          : await getLocalPdfImportMaterial(root, pending.itemKey);
      const result = await importScientSource({
        root,
        operationId: input.operationId,
        candidate,
        ...(pdfPath ? { pdfPath } : {}),
        ...(expectedPdf ? { expectedPdf } : {}),
        allowPossibleMetadataMatch: pending.allowPossibleMetadataMatch ?? false,
      });
      const updated = await updateSourceImportOperationItem({
        root,
        operationId: input.operationId,
        itemKey: pending.itemKey,
        state: result.outcome === "imported" ? "imported" : "skipped",
        ...(result.record ? { sourceId: result.record.sourceId } : {}),
        message: result.duplicate.reason,
      });
      if (operation.adapter === "local-files") {
        await discardLocalPdfImportMaterial(root, pending.itemKey);
      }
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The source could not be imported.";
      const updated = await updateSourceImportOperationItem({
        root,
        operationId: input.operationId,
        itemKey: pending.itemKey,
        state: "failed",
        message,
      });
      if (operation.adapter === "local-files") {
        await discardLocalPdfImportMaterial(root, pending.itemKey).catch(() => undefined);
      }
      return updated;
    }
  });
}

export async function cancelSourceImport(input: {
  readonly root: string;
  readonly operationId: string;
}) {
  const root = await canonicalizeScientSourceRoot(input.root);
  return withOperationLane(`${root}\0${input.operationId}`, async () => {
    const operation = await readSourceImportOperation(root, input.operationId);
    if (!operation) throw new Error("The source import operation was not found.");
    const cancelled = await cancelSourceImportOperation(root, input.operationId);
    if (operation.adapter === "local-files") {
      await Promise.all(
        operation.items
          .filter((item) => item.state === "pending")
          .map((item) => discardLocalPdfImportMaterial(root, item.itemKey).catch(() => undefined)),
      );
    }
    return cancelled;
  });
}

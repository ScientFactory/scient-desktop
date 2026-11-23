// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Write tokens and PDF hashes are content digests; sync state records ISO times like the store.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import {
  editableMetadataFromRecord,
  normalizeScientSourceEditableMetadata,
  scientLibraryIdentityProblem,
  workLevelIdentifierKey,
  type ScientSourceCandidate,
  type ScientSourceActor,
  type ScientSourceExternalReference,
  type ScientSourceNotBrought,
  type ScientSourceRecord,
  type ScientSourceZoteroRefreshItem,
  type ScientSourceZoteroRefreshResult,
  type ScientSourceZoteroSendItem,
  type ScientSourceZoteroSync,
  type ZoteroConnection,
  zoteroGroupIdOfLibrary,
  zoteroGroupLibraryId,
} from "@scientfactory/scient-sources";
import {
  attachScientSourcePdf,
  inspectScientSourcePdf,
  listScientSourceRecords,
  readScientSourceRecord,
  readScientSourceZoteroSync,
  sourceAttachmentAbsolutePath,
  updateScientSourceExternalReferences,
  updateScientSourceMetadata,
  updateScientSourceNote,
  writeScientSourceZoteroSync,
} from "@scientfactory/scient-sources/store";
import type { ScientSourceStoreLocation } from "@scientfactory/scient-sources/library-root";

import {
  inspectZotero,
  listZoteroGroups,
  zoteroTransport,
  zoteroWebLibrary,
  type ZoteroAccess,
} from "./ZoteroConnections.ts";
import { bringZoteroAnnotations } from "./ZoteroAnnotations.ts";
import {
  addNotBrought,
  decodeZoteroRawItem,
  zoteroItemMaterial,
  zoteroNoteOriginals,
  type ZoteroItemMaterial,
  type ZoteroRawItem,
} from "./ZoteroItems.ts";
import {
  readZoteroAttachmentFiles,
  readZoteroItemChildren,
  readZoteroItemMaterial,
  type ZoteroTransport,
} from "./ZoteroLibraryReader.ts";
import { zoteroNotesMarkdown } from "./ZoteroNoteMarkdown.ts";
import {
  planZoteroRefresh,
  refreshedFieldProvenance,
  type ZoteroRefreshChoices,
} from "./ZoteroRefreshPlan.ts";
import type { ZoteroWebLibrary } from "./ZoteroWebAdapter.ts";
import {
  zoteroCreateFields,
  zoteroDataFromRecord,
  zoteroItemTypeFor,
  zoteroNoteHtml,
  zoteroPatchFor,
} from "./ZoteroWrite.ts";

const MAX_REFRESH_SOURCES = 500;
/** How many sources one request of a whole-Library refresh reads again from Zotero. */
const REFRESH_BATCH_SOURCES = 200;

/** The first link is the library most recently sent to or imported from. */
function zoteroReference(
  record: Pick<ScientSourceRecord, "externalReferences">,
): ScientSourceExternalReference | undefined {
  return record.externalReferences.find((reference) => reference.system === "zotero");
}

function sameZoteroLibrary(left: string, right: string, verifiedLocalOwner?: string): boolean {
  if (left === "0" || right === "0") {
    return (
      verifiedLocalOwner !== undefined &&
      verifiedLocalOwner !== "0" &&
      (left === "0" ? right === verifiedLocalOwner : left === verifiedLocalOwner)
    );
  }
  return left === right;
}

const libraryIdOfWeb = (library: ZoteroWebLibrary): string =>
  library.groupId ? zoteroGroupLibraryId(library.groupId) : library.account.userId;

function corroboratedLegacyOwner(
  record: ScientSourceRecord,
  reference: ScientSourceExternalReference,
  candidate: ScientSourceCandidate,
  base: ScientSourceZoteroSync | null,
): string | undefined {
  const current = zoteroReference(candidate);
  if (
    reference.libraryId !== "0" ||
    !current ||
    current.itemKey !== reference.itemKey ||
    !/^[1-9][0-9]*$/u.test(current.libraryId)
  )
    return undefined;
  if (base?.itemKey === current.itemKey && base.libraryId !== "0") {
    return base.libraryId === current.libraryId ? current.libraryId : undefined;
  }
  if (scientLibraryIdentityProblem(record, candidate) !== null) return undefined;
  const known = new Set(
    record.identifiers.flatMap((identifier) => {
      const key = workLevelIdentifierKey(identifier.scheme, identifier.value);
      return key === null ? [] : [key];
    }),
  );
  return candidate.identifiers.some((identifier) => {
    const key = workLevelIdentifierKey(identifier.scheme, identifier.value);
    return key !== null && known.has(key);
  })
    ? current.libraryId
    : undefined;
}

async function verifiedLegacyOwner(
  access: ZoteroAccess,
  reference: ScientSourceExternalReference,
  root: ScientSourceStoreLocation,
  record: ScientSourceRecord,
): Promise<string | undefined> {
  if (reference.libraryId !== "0") return undefined;
  try {
    const local = await zoteroTransport(access, "local");
    const item = await readTransportItem(local, reference.itemKey);
    if (item?.library.type !== "user") return undefined;
    return corroboratedLegacyOwner(
      record,
      reference,
      zoteroItemMaterial(item, []).candidate,
      await readScientSourceZoteroSync(root, record.sourceId),
    );
  } catch {
    return undefined;
  }
}

export async function verifyZoteroItemOwner(input: {
  readonly root: ScientSourceStoreLocation;
  readonly record: ScientSourceRecord;
  readonly candidate: ScientSourceCandidate;
  readonly base: ScientSourceZoteroSync | null;
  readonly connection: ZoteroTransport["connection"];
  readonly verifiedLocalOwner?: string | undefined;
  readonly zotero?: ZoteroAccess;
  readonly action: "refresh" | "resume";
}): Promise<string | undefined> {
  const reference = zoteroReference(input.record);
  const current = zoteroReference(input.candidate);
  const past = input.action === "refresh" ? "refreshed" : "resumed";
  if (!reference || !current || reference.itemKey !== current.itemKey) {
    throw new Error(
      `This Zotero source is not the item originally imported. No source was ${past}.`,
    );
  }
  const verifiedLocalOwner =
    input.connection === "local"
      ? corroboratedLegacyOwner(input.record, reference, input.candidate, input.base)
      : (input.verifiedLocalOwner ??
        (input.zotero
          ? await verifiedLegacyOwner(input.zotero, reference, input.root, input.record)
          : undefined));
  if (
    current.libraryId === "0" ||
    (reference.libraryId === "0" && verifiedLocalOwner === undefined)
  ) {
    throw new Error(`This Zotero library's owner could not be verified. No source was ${past}.`);
  }
  if (!sameZoteroLibrary(reference.libraryId, current.libraryId, verifiedLocalOwner)) {
    throw new Error(
      `This Zotero source belongs to another library. Connect its owner to ${input.action} it.`,
    );
  }
  return verifiedLocalOwner;
}

/** Records what Zotero held when a source was imported, so a later refresh has a base. */
export async function recordZoteroSync(input: {
  readonly root: ScientSourceStoreLocation;
  readonly record: ScientSourceRecord;
  readonly material: ZoteroItemMaterial;
  readonly attachmentKeys: ReadonlyArray<string>;
  readonly pdfs: Readonly<Record<string, string>> | undefined;
  readonly annotationLibraryId?: string;
  /** The notes of an earlier base, kept when what was written to Zotero had none. */
  readonly notes?: Pick<ScientSourceZoteroSync, "note" | "zoteroNote" | "notes">;
  /** The originating import operation when this write is the import's initial sync write. */
  readonly initialImportOperationId?: string;
}): Promise<{ readonly omittedOriginalNoteHtmlCount: number }> {
  const reference = zoteroReference(input.material.candidate);
  if (!reference) return { omittedOriginalNoteHtmlCount: 0 };
  const notes = input.notes ?? input.material;
  const zoteroNote = input.notes?.zoteroNote;
  const { citationKey: _key, ...metadata } = normalizeScientSourceEditableMetadata({
    ...input.material.candidate,
    customType: input.material.candidate.customType ?? null,
  });
  return writeScientSourceZoteroSync(
    input.root,
    {
      formatVersion: 1,
      sourceId: input.record.sourceId,
      libraryId: reference.libraryId,
      ...(input.annotationLibraryId !== undefined &&
      input.annotationLibraryId !== reference.libraryId
        ? { annotationLibraryId: input.annotationLibraryId }
        : {}),
      itemKey: reference.itemKey,
      itemVersion: reference.itemVersion,
      syncedAt: new Date().toISOString(),
      metadata,
      note: notes.note,
      ...(zoteroNote !== undefined ? { zoteroNote } : {}),
      ...(notes.notes ? { notes: [...notes.notes] } : {}),
      ...(input.record.origin?.operationId !== undefined
        ? { importOperationId: input.record.origin.operationId }
        : {}),
      attachmentKeys: [...input.attachmentKeys],
      ...(input.pdfs ? { pdfs: { ...input.pdfs } } : {}),
    },
    ...(input.initialImportOperationId !== undefined
      ? [{ initialImportOperationId: input.initialImportOperationId }]
      : []),
  );
}

/** The connection to use: the one asked for, else whichever is ready now. */
async function readyZoteroConnection(
  access: ZoteroAccess,
  connection?: ZoteroConnection,
): Promise<ZoteroConnection> {
  if (connection) return connection;
  const status = await inspectZotero(access);
  if (status.state !== "ready") throw new Error(status.message);
  return status.connection ?? "local";
}

/** Zotero's own explanations are shown; anything else may hold a local path, so it is not. */
const SAFE_MESSAGE_STARTS = [
  "Zotero",
  "zotero.org",
  "The Zotero",
  "Open Zotero",
  "In Zotero",
  "This Zotero",
  "Add your Zotero",
  "Scient could not reach",
  "Another source import",
  "Choose",
  "Refresh at most",
];

export function safeZoteroMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const looksLikePath = /(?:^|[\s"'(])(?:\/|[A-Za-z]:\\|~\/)[^\s]*/u.test(message);
  return SAFE_MESSAGE_STARTS.some((start) => message.startsWith(start)) && !looksLikePath
    ? message
    : "Zotero could not be read.";
}

function isMissingItem(error: unknown): boolean {
  return error instanceof Error && /was not found/u.test(error.message);
}

async function attachNewPdfs(input: {
  readonly root: ScientSourceStoreLocation;
  readonly transport: ZoteroTransport;
  readonly record: ScientSourceRecord;
  readonly material: ZoteroItemMaterial;
  readonly knownKeys: ReadonlySet<string>;
  readonly actor: ScientSourceActor;
}) {
  const fresh = input.material.pdfs.filter((pdf) => !input.knownKeys.has(pdf.key));
  const files = await readZoteroAttachmentFiles(input.transport, fresh);
  // Only a PDF with highlights is hashed; one that gets some later is learnt by the refresh.
  const highlighted = new Set(input.material.annotations.map((entry) => entry.attachmentKey));
  let record = input.record;
  let added = 0;
  const handled: string[] = [];
  const pdfs = new Map<string, string>();
  try {
    for (const file of files) {
      const result = await attachScientSourcePdf({
        root: input.root,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
        pdfPath: file.path,
        ...(file.fileName ? { fileName: file.fileName } : {}),
        actor: input.actor,
      });
      if (result.outcome === "stale") break;
      if (result.outcome === "attached") added += 1;
      record = result.record;
      handled.push(file.attachmentKey);
      if (highlighted.has(file.attachmentKey)) {
        pdfs.set(file.attachmentKey, (await inspectScientSourcePdf(file.path)).sha256);
      }
    }
  } finally {
    await Promise.all(files.map((file) => file.release().catch(() => undefined)));
  }
  return { record, added, keys: [...input.knownKeys, ...handled], pdfs };
}

/**
 * Which PDF here each Zotero file with highlights is. One not known yet (it had none at import,
 * or was imported before this was kept) is learnt by reading that file from Zotero once more.
 */
async function zoteroPdfsHere(input: {
  readonly transport: ZoteroTransport;
  readonly material: ZoteroItemMaterial;
  readonly known: Readonly<Record<string, string>>;
  readonly attachedKeys: ReadonlyArray<string>;
}): Promise<ReadonlyMap<string, string>> {
  const pdfs = new Map(Object.entries(input.known));
  const highlighted = new Set(input.material.annotations.map((entry) => entry.attachmentKey));
  for (const pdf of input.material.pdfs) {
    if (pdfs.has(pdf.key) || !highlighted.has(pdf.key)) continue;
    if (!input.attachedKeys.includes(pdf.key)) continue;
    const file = await input.transport.attachmentFile(pdf);
    if (!file) continue;
    try {
      pdfs.set(pdf.key, (await inspectScientSourcePdf(file.path)).sha256);
    } finally {
      await file.release().catch(() => undefined);
    }
  }
  return pdfs;
}

async function refreshOne(input: {
  readonly root: ScientSourceStoreLocation;
  readonly record: ScientSourceRecord;
  readonly transport: ZoteroTransport;
  readonly actor: ScientSourceActor;
  readonly libraryId?: string;
  readonly verifiedLocalOwner?: string | undefined;
  readonly choices: ZoteroRefreshChoices;
}): Promise<ScientSourceZoteroRefreshItem> {
  const reference = zoteroReference(input.record);
  const summary = { sourceId: input.record.sourceId, title: input.record.title };
  const empty = { changedFields: [], addedPdfCount: 0, conflicts: [] };
  if (!reference) {
    return { ...summary, ...empty, outcome: "failed", message: "Not linked to Zotero." };
  }
  if (
    input.libraryId !== undefined &&
    reference.libraryId === "0" &&
    input.verifiedLocalOwner === undefined
  ) {
    throw new Error("This Zotero library's owner could not be verified. No source was refreshed.");
  }
  if (
    input.libraryId !== undefined &&
    !sameZoteroLibrary(reference.libraryId, input.libraryId, input.verifiedLocalOwner)
  ) {
    throw new Error(
      "This Zotero source belongs to another library. Connect its owner to refresh it.",
    );
  }
  let material: ZoteroItemMaterial;
  try {
    material = await readZoteroItemMaterial(input.transport, reference.itemKey);
  } catch (error) {
    if (isMissingItem(error)) {
      return { ...summary, ...empty, outcome: "missing", message: "No longer in Zotero." };
    }
    throw error;
  }
  const currentReference = zoteroReference(material.candidate);
  const savedBase = await readScientSourceZoteroSync(input.root, input.record.sourceId);
  const verifiedLocalOwner = await verifyZoteroItemOwner({
    root: input.root,
    record: input.record,
    candidate: material.candidate,
    base: savedBase,
    connection: input.transport.connection,
    verifiedLocalOwner: input.verifiedLocalOwner,
    action: "refresh",
  });
  const currentLibraryId = currentReference!.libraryId;
  // A "0" baseline stamped by this record's originating import is its own: the concrete
  // reference was published only after that owner was verified for this same item.
  const legacyOwnBase =
    savedBase?.libraryId === "0" &&
    savedBase.importOperationId !== undefined &&
    savedBase.importOperationId === input.record.origin?.operationId;
  const base =
    savedBase?.itemKey === reference.itemKey &&
    (sameZoteroLibrary(savedBase.libraryId, currentLibraryId, verifiedLocalOwner) || legacyOwnBase)
      ? savedBase
      : null;
  const annotationLibraryId = base?.annotationLibraryId ?? base?.libraryId ?? reference.libraryId;
  const plan = planZoteroRefresh({
    record: input.record,
    base,
    zotero: material,
    choices: input.choices,
  });
  let record = input.record;
  const changedFields: string[] = [];
  if (plan.takenFields.size > 0) {
    const result = await updateScientSourceMetadata({
      root: input.root,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      metadata: plan.metadata,
      fieldProvenance: refreshedFieldProvenance({
        current: record.fieldProvenance,
        zotero: material.candidate.fieldProvenance,
        // Each further detail by its own name, so only the ones taken become Zotero's.
        takenFields: new Set([
          ...[...plan.takenFields].filter((field) => field !== "more"),
          ...[...plan.takenMore].map((name) => `more.${name}`),
        ]),
      }),
      allowPossibleMetadataMatch: true,
      allowExistingValidationIssues: true,
      actor: input.actor,
    });
    if (result.outcome === "stale") {
      return {
        ...summary,
        ...empty,
        outcome: "stale",
        message: "This source changed during the refresh. Refresh again.",
      };
    }
    if (result.outcome === "duplicate") {
      return {
        ...summary,
        ...empty,
        outcome: "failed",
        message: "Zotero's identifier belongs to another source in this project.",
      };
    }
    if (result.outcome === "updated") changedFields.push(...plan.takenFields);
    record = result.record;
  }
  if (plan.note) {
    // Against the note the plan read, so an edit elsewhere in the source does not refuse it.
    const result = await updateScientSourceNote({
      root: input.root,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      expectedNote: input.record.note ?? null,
      note: plan.note.value,
      actor: input.actor,
    });
    // No base is written, so the next refresh still sees Zotero's note as new.
    if (result.outcome === "stale") {
      return {
        ...summary,
        ...empty,
        changedFields,
        outcome: "stale",
        message: "This source changed during the refresh. Refresh again.",
      };
    }
    if (result.outcome === "updated") changedFields.push("note");
    record = result.record;
  }
  const attached = await attachNewPdfs({
    root: input.root,
    transport: input.transport,
    record,
    material,
    knownKeys: new Set(base?.attachmentKeys ?? []),
    actor: input.actor,
  });
  record = attached.record;
  const pdfs = await zoteroPdfsHere({
    transport: input.transport,
    material,
    known: { ...base?.pdfs, ...Object.fromEntries(attached.pdfs) },
    attachedKeys: attached.keys,
  });
  const current = currentReference;
  if (
    current &&
    (current.itemVersion !== reference.itemVersion || current.libraryId !== reference.libraryId)
  ) {
    const references = record.externalReferences.map((entry) =>
      entry === zoteroReference(record) ? current : entry,
    );
    record = (
      await updateScientSourceExternalReferences({
        root: input.root,
        sourceId: record.sourceId,
        expectedRevision: record.revision,
        externalReferences: references,
        actor: input.actor,
      })
    ).record;
  }
  const savedSync = await writeScientSourceZoteroSync(input.root, {
    formatVersion: 1,
    sourceId: record.sourceId,
    libraryId: currentLibraryId,
    ...(annotationLibraryId !== currentLibraryId ? { annotationLibraryId } : {}),
    itemKey: reference.itemKey,
    itemVersion: current?.itemVersion ?? reference.itemVersion,
    syncedAt: new Date().toISOString(),
    metadata: plan.base.metadata,
    note: plan.base.note,
    ...(plan.base.zoteroNote !== undefined ? { zoteroNote: plan.base.zoteroNote } : {}),
    ...(plan.base.notes ? { notes: [...plan.base.notes] } : {}),
    ...(record.origin?.operationId !== undefined
      ? { importOperationId: record.origin.operationId }
      : {}),
    attachmentKeys: attached.keys,
    pdfs: Object.fromEntries(pdfs),
  });
  // Last, so a failure here leaves the rest saved; each one comes once, so a retry is safe. A
  // Zotero file whose PDF was removed here is not brought back for its highlights: they are said.
  const highlights = await bringZoteroAnnotations({
    root: input.root,
    record,
    annotationLibraryId,
    annotations: material.annotations,
    pdfs,
    now: new Date().toISOString(),
  });
  if (highlights.added > 0) changedFields.push("highlights");
  const notBrought: ScientSourceNotBrought[] = [];
  addNotBrought(notBrought, "highlights", highlights.unplaced, "unplaced");
  addNotBrought(notBrought, "highlights", highlights.elsewhere, "no-file");
  addNotBrought(notBrought, "highlights", highlights.tooLong, "too-long");
  if (
    savedSync.omittedOriginalNoteHtmlCount > 0 ||
    plan.base.notes?.some((entry) => entry.html === undefined)
  ) {
    addNotBrought(notBrought, "note-cut", 1, "original");
  }
  const updated = changedFields.length > 0 || attached.added > 0;
  return {
    ...summary,
    outcome: updated ? "updated" : "unchanged",
    changedFields,
    addedPdfCount: attached.added,
    conflicts: plan.conflicts,
    message: null,
    ...(notBrought.length > 0 ? { notBrought } : {}),
  };
}

/**
 * Brings Zotero's changes into imported sources, keeping edits made here: the `sourceIds`
 * asked for, or every source from Zotero (of `among`, for a project's). With `after`, the
 * batch in ID order that follows that source (null: the first); the result names the source
 * the next batch follows, so one added or removed meanwhile moves no other.
 */
export async function refreshZoteroSources(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceIds?: ReadonlyArray<string>;
  readonly among?: ReadonlyArray<string>;
  readonly after?: string | null;
  /** Tests only: a smaller batch. */
  readonly batchSize?: number;
  readonly connection?: ZoteroConnection;
  readonly actor: ScientSourceActor;
  readonly choices?: ZoteroRefreshChoices;
  readonly zotero: ZoteroAccess;
}): Promise<ScientSourceZoteroRefreshResult> {
  const byIds = async (sourceIds: ReadonlyArray<string>) =>
    (
      await Promise.all(
        [...new Set(sourceIds)].map((sourceId) => readScientSourceRecord(input.root, sourceId)),
      )
    ).flatMap((record) => (record ? [record] : []));
  const fromZotero = input.sourceIds
    ? null
    : (input.among ? await byIds(input.among) : await listScientSourceRecords(input.root))
        .filter((record) => zoteroReference(record))
        .toSorted((left, right) => left.sourceId.localeCompare(right.sourceId));
  const { after } = input;
  const following =
    after === undefined || after === null
      ? (fromZotero ?? [])
      : (fromZotero ?? []).filter((record) => record.sourceId.localeCompare(after) > 0);
  const records = input.sourceIds
    ? await byIds(input.sourceIds)
    : after === undefined
      ? following
      : following.slice(0, input.batchSize ?? REFRESH_BATCH_SOURCES);
  if (records.length > MAX_REFRESH_SOURCES) {
    throw new Error(`Refresh at most ${MAX_REFRESH_SOURCES} sources at a time.`);
  }
  const connection = await readyZoteroConnection(input.zotero, input.connection);
  // Each source is read again from the library it came from: My Library or its group.
  const transports = new Map<
    string,
    Promise<{
      readonly transport: ZoteroTransport;
      readonly libraryId?: string;
    }>
  >();
  const transportFor = (record: ScientSourceRecord) => {
    const reference = zoteroReference(record);
    const groupId = reference ? zoteroGroupIdOfLibrary(reference.libraryId) : null;
    let transport = transports.get(groupId ?? "");
    if (!transport) {
      transport =
        connection === "web"
          ? zoteroWebLibrary(input.zotero, groupId ? { groupId } : {}).then((library) => ({
              transport: library.transport,
              libraryId: libraryIdOfWeb(library),
            }))
          : zoteroTransport(input.zotero, connection, groupId ?? undefined).then((transport) => ({
              transport,
            }));
      transports.set(groupId ?? "", transport);
    }
    return transport;
  };
  const items: ScientSourceZoteroRefreshItem[] = [];
  for (const record of records) {
    try {
      items.push(
        await refreshOne({
          root: input.root,
          record,
          ...(await transportFor(record)),
          verifiedLocalOwner:
            connection === "web" && zoteroReference(record)
              ? await verifiedLegacyOwner(
                  input.zotero,
                  zoteroReference(record)!,
                  input.root,
                  record,
                )
              : undefined,
          actor: input.actor,
          choices: input.choices ?? {},
        }),
      );
    } catch (error) {
      items.push({
        sourceId: record.sourceId,
        title: record.title,
        outcome: "failed",
        changedFields: [],
        addedPdfCount: 0,
        conflicts: [],
        message: safeZoteroMessage(error),
      });
    }
  }
  if (!fromZotero || after === undefined) return { connection, items };
  const last = records.at(-1);
  return {
    connection,
    items,
    total: fromZotero.length,
    ...(last && records.length < following.length ? { next: last.sourceId } : {}),
  };
}

const CHANGED_IN_ZOTERO =
  "This item changed in Zotero since Scient last read it. Refresh from Zotero, then send again.";

async function readTransportItem(
  transport: ZoteroTransport,
  itemKey: string,
): Promise<ZoteroRawItem | null> {
  const response = await transport.get(`/items/${itemKey}?format=json`);
  if (response.status === 404) return null;
  if (response.status !== 200) throw new Error(`zotero.org returned HTTP ${response.status}.`);
  return decodeZoteroRawItem(JSON.parse(response.body));
}

function writeToken(record: ScientSourceRecord, purpose: string): string {
  return NodeCrypto.createHash("sha256")
    .update([record.projectId, record.sourceId, record.revision, purpose].join("\0"))
    .digest("hex")
    .slice(0, 32);
}

/** Stale answers in a row before a Send stops trying to link the source to its item. */
const LINK_ATTEMPTS = 5;

/**
 * Links the source to its item and moves the base only by what this Send wrote: Zotero's values
 * when the item is still at `sentVersion`, so a change made there meanwhile stays for Refresh,
 * and the earlier base's notes for an item that was only updated, as no note was sent to it:
 * none when that base is another item's, so Refresh compares the item's notes as new.
 */
async function syncAfterSend(input: {
  readonly root: ScientSourceStoreLocation;
  readonly library: ZoteroWebLibrary;
  readonly record: ScientSourceRecord;
  readonly itemKey: string;
  /** The item's version once this Send's write landed, or as read when nothing was written. */
  readonly sentVersion: number;
  /** Present when this Send created the item; records the parent item and note base acknowledged by create. */
  readonly created?: {
    readonly item?: ZoteroRawItem;
    readonly notes: Pick<ScientSourceZoteroSync, "note" | "zoteroNote" | "notes">;
  };
  readonly actor: ScientSourceActor;
  readonly reference?: ScientSourceExternalReference;
  readonly verifiedLocalOwner?: string | undefined;
}): Promise<void> {
  const material = await readZoteroItemMaterial(input.library.transport, input.itemKey);
  const fresh = zoteroReference(material.candidate);
  if (!fresh) return;
  const linked = { ...fresh, itemVersion: input.sentVersion };
  let record = input.record;
  // Against the record as it is now: an edit made during the Send keeps itself and the link.
  for (let attempt = 1; ; attempt += 1) {
    const others = record.externalReferences.filter(
      (entry) =>
        !(
          entry.system === "zotero" &&
          ((entry.libraryId === fresh.libraryId && entry.itemKey === fresh.itemKey) ||
            (input.reference &&
              entry.libraryId === input.reference.libraryId &&
              entry.itemKey === input.reference.itemKey))
        ),
    );
    const result = await updateScientSourceExternalReferences({
      root: input.root,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      externalReferences: [linked, ...others],
      actor: input.actor,
    });
    record = result.record;
    if (result.outcome !== "stale") break;
    if (attempt === LINK_ATTEMPTS) {
      throw new Error(
        `Zotero has item ${fresh.itemKey} from this Send, but Scient could not link this source to it while the source kept changing. Look for the item in Zotero before you send this source again.`,
      );
    }
  }
  if (fresh.itemVersion !== input.sentVersion) {
    if (!input.created) return;
    // Parent changed in Zotero before readback; record the acknowledged creation baseline
    // fenced at `sentVersion` from Zotero's saved parent object so Refresh sees no false conflict.
    const createdCandidate = input.created.item
      ? zoteroItemMaterial(input.created.item, []).candidate
      : null;
    const { citationKey: _key, ...metadata } = normalizeScientSourceEditableMetadata(
      createdCandidate
        ? { ...createdCandidate, customType: createdCandidate.customType ?? null }
        : editableMetadataFromRecord(input.record),
    );
    const annotationLibraryId = input.reference?.libraryId ?? fresh.libraryId;
    await writeScientSourceZoteroSync(input.root, {
      formatVersion: 1,
      sourceId: record.sourceId,
      libraryId: fresh.libraryId,
      ...(annotationLibraryId !== fresh.libraryId ? { annotationLibraryId } : {}),
      itemKey: fresh.itemKey,
      itemVersion: input.sentVersion,
      syncedAt: new Date().toISOString(),
      metadata,
      note: input.created.notes.note,
      ...(input.created.notes.zoteroNote !== undefined
        ? { zoteroNote: input.created.notes.zoteroNote }
        : {}),
      ...(input.created.notes.notes ? { notes: [...input.created.notes.notes] } : {}),
      ...(record.origin?.operationId !== undefined
        ? { importOperationId: record.origin.operationId }
        : {}),
      attachmentKeys: [],
    });
    return;
  }
  const previous = await readScientSourceZoteroSync(input.root, record.sourceId);
  const same =
    previous?.itemKey === fresh.itemKey &&
    sameZoteroLibrary(previous.libraryId, fresh.libraryId, input.verifiedLocalOwner);
  await recordZoteroSync({
    root: input.root,
    record,
    material,
    attachmentKeys: same ? previous.attachmentKeys : [],
    pdfs: same ? previous.pdfs : undefined,
    annotationLibraryId: same
      ? (previous.annotationLibraryId ?? previous.libraryId)
      : (input.reference?.libraryId ?? fresh.libraryId),
    notes: same ? previous : (input.created?.notes ?? { note: null, notes: [] }),
  });
}

type ZoteroSendPdf = NonNullable<ScientSourceZoteroSendItem["pdfs"]>[number];

const PDF_NOT_SENT = {
  full: "The Zotero storage is full.",
  busy: "zotero.org is busy. Send again in a minute.",
  failed: "It did not reach zotero.org. Send again to finish.",
  linked: "Zotero links to a file of that name on your computer.",
} as const;

function noFilesMessage(library: ZoteroWebLibrary): string {
  return library.groupId
    ? "This group does not let the key in Accounts add files."
    : "The Zotero key in Accounts does not allow files.";
}

const itemSends = new Map<string, Promise<unknown>>();

/**
 * One PDF Send at a time for each Zotero item in this server: two that overlap would both find
 * no attachment and each make one. A Send from another computer is not kept out.
 */
async function oneSendPerItem<A>(key: string, run: () => Promise<A>): Promise<A> {
  const current = (itemSends.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  itemSends.set(key, current);
  try {
    return await current;
  } finally {
    if (itemSends.get(key) === current) itemSends.delete(key);
  }
}

/**
 * Each PDF of the source that the item lacks, through Zotero's file upload. An attachment left
 * without its file by an earlier Send is filled, not doubled; one this Send made and Zotero
 * then refused a file for is deleted again. Never replaces or removes a file in Zotero.
 */
async function sendPdfs(input: {
  readonly root: ScientSourceStoreLocation;
  readonly record: ScientSourceRecord;
  readonly library: ZoteroWebLibrary;
  readonly itemKey: string;
}): Promise<ReadonlyArray<ZoteroSendPdf>> {
  const { record, library } = input;
  const results: ZoteroSendPdf[] = [];
  const attachments =
    record.attachments.length === 0
      ? []
      : await readZoteroItemChildren(library.transport, input.itemKey).then(
          (children) => children.filter((child) => child.data.itemType === "attachment"),
          () => null,
        );
  for (const attachment of record.attachments) {
    const { fileName } = attachment;
    const notSent = (message: string) => results.push({ fileName, outcome: "not-sent", message });
    if (!attachments) {
      notSent(PDF_NOT_SENT.failed);
      continue;
    }
    try {
      const path = sourceAttachmentAbsolutePath(input.root, attachment);
      const hash = NodeCrypto.createHash("md5");
      for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk as Buffer);
      const md5 = hash.digest("hex");
      if (attachments.some((child) => child.fields?.md5 === md5)) {
        results.push({ fileName, outcome: "in-zotero", message: null });
        continue;
      }
      // Zotero keeps only a path for a linked file, so its name is all there is to compare.
      const linked = attachments.some(
        (child) =>
          child.data.linkMode === "linked_file" &&
          (child.data.filename ?? child.fields?.path?.split(/[\\/:]/u).at(-1)) === fileName,
      );
      if (linked) {
        notSent(PDF_NOT_SENT.linked);
        continue;
      }
      if (!library.canAddFiles) {
        notSent(noFilesMessage(library));
        continue;
      }
      const empty = attachments.find(
        (child) =>
          child.data.linkMode === "imported_file" &&
          !child.fields?.md5 &&
          child.data.filename === fileName,
      );
      const [made] = empty
        ? [null]
        : await library.createItems(
            [
              {
                itemType: "attachment",
                parentItem: input.itemKey,
                linkMode: "imported_file",
                title: fileName,
                contentType: "application/pdf",
                filename: fileName,
              },
            ],
            // Fresh each time: Zotero refuses a token used in the last 12 hours, and an
            // attachment deleted after a refusal must be made again when the person retries.
            NodeCrypto.randomUUID().replaceAll("-", ""),
          );
      const target = empty?.key ?? made?.key;
      if (!target) {
        notSent(PDF_NOT_SENT.failed);
        continue;
      }
      const { size, mtimeMs } = await NodeFSP.stat(path);
      const upload = await library.uploadFile(target, {
        path,
        fileName,
        md5,
        size,
        mtime: Math.trunc(mtimeMs),
      });
      if (upload === "sent") {
        results.push({ fileName, outcome: "sent", message: null });
        continue;
      }
      if (made && (upload === "forbidden" || upload === "full")) {
        await library.deleteItem(made.key, made.version).catch(() => false);
      }
      notSent(upload === "forbidden" ? noFilesMessage(library) : PDF_NOT_SENT[upload]);
    } catch {
      notSent(PDF_NOT_SENT.failed);
    }
  }
  return results;
}

async function sendOne(input: {
  readonly root: ScientSourceStoreLocation;
  readonly record: ScientSourceRecord;
  readonly library: ZoteroWebLibrary;
  readonly actor: ScientSourceActor;
  readonly zotero: ZoteroAccess;
}): Promise<ScientSourceZoteroSendItem> {
  const { record, library } = input;
  const summary = { sourceId: record.sourceId, title: record.title };
  const libraryId = libraryIdOfWeb(library);
  let verifiedLocalOwner: string | undefined;
  let reference = record.externalReferences.find(
    (entry) => entry.system === "zotero" && sameZoteroLibrary(entry.libraryId, libraryId),
  );
  if (!reference && !library.groupId) {
    const legacy = record.externalReferences.find(
      (entry) => entry.system === "zotero" && entry.libraryId === "0",
    );
    if (legacy) {
      verifiedLocalOwner = await verifiedLegacyOwner(input.zotero, legacy, input.root, record);
      if (sameZoteroLibrary(legacy.libraryId, libraryId, verifiedLocalOwner)) reference = legacy;
    }
  }
  const current = reference ? await readTransportItem(library.transport, reference.itemKey) : null;
  if (reference && current) {
    const base = await readScientSourceZoteroSync(input.root, record.sourceId);
    const lastRead =
      base?.itemKey === reference.itemKey &&
      sameZoteroLibrary(base.libraryId, libraryId, verifiedLocalOwner)
        ? base.itemVersion
        : reference.itemVersion;
    if (current.version !== lastRead) {
      return {
        ...summary,
        outcome: "changed-in-zotero",
        itemKey: current.key,
        message: CHANGED_IN_ZOTERO,
      };
    }
    const patch = zoteroPatchFor({ record, current });
    if (Object.keys(patch).length === 0) {
      if (reference !== zoteroReference(record) || reference.libraryId === "0") {
        await syncAfterSend({
          ...input,
          reference,
          verifiedLocalOwner,
          itemKey: current.key,
          sentVersion: current.version,
        });
      }
      return { ...summary, outcome: "unchanged", itemKey: current.key, message: null };
    }
    const result = await library.updateItem(current.key, current.version, patch);
    if (result.outcome === "changed") {
      return {
        ...summary,
        outcome: "changed-in-zotero",
        itemKey: current.key,
        message: CHANGED_IN_ZOTERO,
      };
    }
    await syncAfterSend({
      ...input,
      reference,
      verifiedLocalOwner,
      itemKey: current.key,
      sentVersion: result.version,
    });
    return { ...summary, outcome: "updated", itemKey: current.key, message: null };
  }
  const itemType = zoteroItemTypeFor(record);
  // Zotero says which fields and roles the type has, so every detail goes where it belongs.
  const template = await library.itemTemplate(itemType);
  const data = {
    itemType,
    ...zoteroDataFromRecord({
      record,
      itemType,
      fields: template?.fields ?? zoteroCreateFields(itemType),
      ...(template ? { roles: template.roles } : {}),
      creating: true,
    }),
  };
  const [created] = await library.createItems([data], writeToken(record, "item"));
  if (!created) {
    return {
      ...summary,
      outcome: "failed",
      itemKey: null,
      message: "zotero.org did not accept this source.",
    };
  }
  let createdItem = created.item;
  if (!createdItem) {
    try {
      createdItem = decodeZoteroRawItem({
        key: created.key,
        version: created.version,
        library: library.groupId
          ? { type: "group", id: Number(library.groupId) }
          : { type: "user", id: Number(library.account.userId) },
        data: { ...data, key: created.key, version: created.version },
      });
    } catch {
      createdItem = undefined;
    }
  }
  let createdNotes: Pick<ScientSourceZoteroSync, "note" | "zoteroNote" | "notes"> = {
    note: null,
    notes: [],
  };
  if (record.note?.trim()) {
    const noteHtml = zoteroNoteHtml(record.note);
    const [createdNote] = await library.createItems(
      [{ itemType: "note", parentItem: created.key, note: noteHtml }],
      writeToken(record, "note"),
    );
    if (createdNote) {
      const savedHtml = createdNote.item?.data.note ?? noteHtml;
      const convertedNote = zoteroNotesMarkdown([
        { itemKey: createdNote.key, html: savedHtml },
      ]).markdown;
      createdNotes = {
        note: record.note,
        ...(convertedNote !== record.note ? { zoteroNote: convertedNote } : {}),
        notes: zoteroNoteOriginals([
          {
            key: createdNote.key,
            data: { itemType: "note", note: savedHtml },
          },
        ]),
      };
    }
  }
  await syncAfterSend({
    ...input,
    itemKey: created.key,
    sentVersion: created.version,
    created: { ...(createdItem ? { item: createdItem } : {}), notes: createdNotes },
  });
  return { ...summary, outcome: "created", itemKey: created.key, message: null };
}

/**
 * One-way: creates or updates each source's item in the user's zotero.org library, or in a
 * group the key may write to. A source linked to another library gets a new item here and is
 * linked to it. An item changed in Zotero since Scient last read it is left alone and reported.
 */
export async function sendSourcesToZotero(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceIds: ReadonlyArray<string>;
  readonly groupId?: string;
  /** Also each PDF the item lacks, for a source whose details were sent or already there. */
  readonly pdfs?: boolean;
  readonly actor: ScientSourceActor;
  readonly zotero: ZoteroAccess;
}): Promise<{ readonly items: ReadonlyArray<ScientSourceZoteroSendItem> }> {
  const { groupId } = input;
  if (groupId) {
    const groups = await listZoteroGroups(input.zotero, "web", { fresh: true });
    if (!groups.find((group) => group.groupId === groupId)?.canWrite) {
      throw new Error(
        "The Zotero key in Accounts cannot write to this group. It needs write access to the group, and the group must let you edit its library.",
      );
    }
  }
  const library = await zoteroWebLibrary(input.zotero, groupId ? { groupId } : { fresh: true });
  if (!groupId && !library.account.canWrite) {
    throw new Error(
      "The Zotero key in Accounts can only read. Create a zotero.org key that can write, then save it in Accounts.",
    );
  }
  const items: ScientSourceZoteroSendItem[] = [];
  const sourceIds = [...new Set(input.sourceIds)];
  // Said, not cut: a list past the limit used to lose its tail without a word.
  if (sourceIds.length > MAX_REFRESH_SOURCES) {
    throw new Error(`Send at most ${MAX_REFRESH_SOURCES} sources at a time.`);
  }
  for (const sourceId of sourceIds) {
    const record = await readScientSourceRecord(input.root, sourceId);
    if (!record) {
      items.push({
        sourceId,
        title: null,
        outcome: "failed",
        itemKey: null,
        message: "Not found.",
      });
      continue;
    }
    try {
      const item = await sendOne({
        root: input.root,
        record,
        library,
        actor: input.actor,
        zotero: input.zotero,
      });
      const placed =
        item.outcome === "created" || item.outcome === "updated" || item.outcome === "unchanged";
      const { itemKey } = item;
      const libraryId = libraryIdOfWeb(library);
      items.push(
        input.pdfs && placed && itemKey
          ? {
              ...item,
              pdfs: await oneSendPerItem(`${libraryId}\0${itemKey}`, () =>
                sendPdfs({ root: input.root, record, library, itemKey }),
              ),
            }
          : item,
      );
    } catch (error) {
      items.push({
        sourceId,
        title: record.title,
        outcome: "failed",
        itemKey: null,
        message: safeZoteroMessage(error),
      });
    }
  }
  return { items };
}

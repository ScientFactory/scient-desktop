// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Write tokens are content digests; sync state records ISO times like the store.
import * as NodeCrypto from "node:crypto";

import {
  normalizeScientSourceEditableMetadata,
  type ScientSourceActor,
  type ScientSourceExternalReference,
  type ScientSourceRecord,
  type ScientSourceZoteroRefreshItem,
  type ScientSourceZoteroRefreshResult,
  type ScientSourceZoteroSendItem,
  type ZoteroConnection,
  zoteroGroupIdOfLibrary,
} from "@scientfactory/scient-sources";
import {
  attachScientSourcePdf,
  listScientSourceRecords,
  readScientSourceRecord,
  readScientSourceZoteroSync,
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
import { decodeZoteroRawItem, type ZoteroItemMaterial, type ZoteroRawItem } from "./ZoteroItems.ts";
import {
  readZoteroAttachmentFiles,
  readZoteroItemMaterial,
  type ZoteroTransport,
} from "./ZoteroLibraryReader.ts";
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

/** Zotero item keys are per library; local "0" and the zotero.org user ID name the same one. */
function zoteroReference(
  record: Pick<ScientSourceRecord, "externalReferences">,
): ScientSourceExternalReference | undefined {
  return record.externalReferences.find((reference) => reference.system === "zotero");
}

/** Records what Zotero held when a source was imported, so a later refresh has a base. */
export async function recordZoteroSync(input: {
  readonly root: ScientSourceStoreLocation;
  readonly record: ScientSourceRecord;
  readonly material: ZoteroItemMaterial;
  readonly attachmentKeys: ReadonlyArray<string>;
}): Promise<void> {
  const reference = zoteroReference(input.material.candidate);
  if (!reference) return;
  const { citationKey: _key, ...metadata } = normalizeScientSourceEditableMetadata({
    ...input.material.candidate,
    customType: input.material.candidate.customType ?? null,
  });
  await writeScientSourceZoteroSync(input.root, {
    formatVersion: 1,
    sourceId: input.record.sourceId,
    libraryId: reference.libraryId,
    itemKey: reference.itemKey,
    itemVersion: reference.itemVersion,
    syncedAt: new Date().toISOString(),
    metadata,
    note: input.material.note,
    attachmentKeys: [...input.attachmentKeys],
  });
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
  let record = input.record;
  let added = 0;
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
    }
  } finally {
    await Promise.all(files.map((file) => file.release().catch(() => undefined)));
  }
  return {
    record,
    added,
    keys: [...input.knownKeys, ...files.map((file) => file.attachmentKey)],
  };
}

async function refreshOne(input: {
  readonly root: ScientSourceStoreLocation;
  readonly record: ScientSourceRecord;
  readonly transport: ZoteroTransport;
  readonly actor: ScientSourceActor;
  readonly choices: ZoteroRefreshChoices;
}): Promise<ScientSourceZoteroRefreshItem> {
  const reference = zoteroReference(input.record);
  const summary = { sourceId: input.record.sourceId, title: input.record.title };
  const empty = { changedFields: [], addedPdfCount: 0, conflicts: [] };
  if (!reference) {
    return { ...summary, ...empty, outcome: "failed", message: "Not linked to Zotero." };
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
  const base = await readScientSourceZoteroSync(input.root, input.record.sourceId);
  const plan = planZoteroRefresh({
    record: input.record,
    base,
    zotero: { candidate: material.candidate, note: material.note },
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
        takenFields: plan.takenFields,
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
    const result = await updateScientSourceNote({
      root: input.root,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      note: plan.note.value,
      actor: input.actor,
    });
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
  const current = zoteroReference(material.candidate);
  if (current && current.itemVersion !== reference.itemVersion) {
    const references = record.externalReferences.map((entry) =>
      entry === zoteroReference(record) ? { ...entry, itemVersion: current.itemVersion } : entry,
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
  await writeScientSourceZoteroSync(input.root, {
    formatVersion: 1,
    sourceId: record.sourceId,
    libraryId: reference.libraryId,
    itemKey: reference.itemKey,
    itemVersion: current?.itemVersion ?? reference.itemVersion,
    syncedAt: new Date().toISOString(),
    metadata: plan.base.metadata,
    note: plan.base.note,
    attachmentKeys: attached.keys,
  });
  const updated = changedFields.length > 0 || attached.added > 0;
  return {
    ...summary,
    outcome: updated ? "updated" : "unchanged",
    changedFields,
    addedPdfCount: attached.added,
    conflicts: plan.conflicts,
    message: null,
  };
}

/** Brings Zotero's changes into imported sources, keeping edits made here. */
export async function refreshZoteroSources(input: {
  readonly root: ScientSourceStoreLocation;
  readonly sourceIds?: ReadonlyArray<string>;
  readonly connection?: ZoteroConnection;
  readonly actor: ScientSourceActor;
  readonly choices?: ZoteroRefreshChoices;
  readonly zotero: ZoteroAccess;
}): Promise<ScientSourceZoteroRefreshResult> {
  const records = input.sourceIds
    ? (
        await Promise.all(
          [...new Set(input.sourceIds)].map((sourceId) =>
            readScientSourceRecord(input.root, sourceId),
          ),
        )
      ).flatMap((record) => (record ? [record] : []))
    : (await listScientSourceRecords(input.root)).filter((record) => zoteroReference(record));
  if (records.length > MAX_REFRESH_SOURCES) {
    throw new Error(`Refresh at most ${MAX_REFRESH_SOURCES} sources at a time.`);
  }
  const connection = await readyZoteroConnection(input.zotero, input.connection);
  // Each source is read again from the library it came from: My Library or its group.
  const transports = new Map<string, Promise<ZoteroTransport>>();
  const transportFor = (record: ScientSourceRecord) => {
    const reference = zoteroReference(record);
    const groupId = reference ? zoteroGroupIdOfLibrary(reference.libraryId) : null;
    let transport = transports.get(groupId ?? "");
    if (!transport) {
      transport = zoteroTransport(input.zotero, connection, groupId ?? undefined);
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
          transport: await transportFor(record),
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
  return { connection, items };
}

const CHANGED_IN_ZOTERO =
  "This item changed in Zotero since Scient last read it. Refresh from Zotero, then send again.";

async function readWebItem(
  library: ZoteroWebLibrary,
  itemKey: string,
): Promise<ZoteroRawItem | null> {
  const response = await library.transport.get(`/items/${itemKey}?format=json`);
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

async function syncAfterSend(input: {
  readonly root: ScientSourceStoreLocation;
  readonly library: ZoteroWebLibrary;
  readonly record: ScientSourceRecord;
  readonly itemKey: string;
  readonly actor: ScientSourceActor;
}): Promise<void> {
  const material = await readZoteroItemMaterial(input.library.transport, input.itemKey);
  const fresh = zoteroReference(material.candidate);
  if (!fresh) return;
  const others = input.record.externalReferences.filter((entry) => entry.system !== "zotero");
  const updated = await updateScientSourceExternalReferences({
    root: input.root,
    sourceId: input.record.sourceId,
    expectedRevision: input.record.revision,
    externalReferences: [...others, fresh],
    actor: input.actor,
  });
  const previous = await readScientSourceZoteroSync(input.root, input.record.sourceId);
  const same = previous?.itemKey === fresh.itemKey && previous.libraryId === fresh.libraryId;
  await recordZoteroSync({
    root: input.root,
    record: updated.record,
    material,
    attachmentKeys: same ? previous.attachmentKeys : [],
  });
}

async function sendOne(input: {
  readonly root: ScientSourceStoreLocation;
  readonly record: ScientSourceRecord;
  readonly library: ZoteroWebLibrary;
  readonly actor: ScientSourceActor;
}): Promise<ScientSourceZoteroSendItem> {
  const { record, library } = input;
  const summary = { sourceId: record.sourceId, title: record.title };
  const linked = zoteroReference(record);
  // A link to another library is not this library's item, even with the same key.
  const reference =
    linked && zoteroGroupIdOfLibrary(linked.libraryId) === library.groupId ? linked : undefined;
  const current = reference ? await readWebItem(library, reference.itemKey) : null;
  if (reference && current) {
    const base = await readScientSourceZoteroSync(input.root, record.sourceId);
    const lastRead = base?.itemKey === reference.itemKey ? base.itemVersion : reference.itemVersion;
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
    await syncAfterSend({ ...input, itemKey: current.key });
    return { ...summary, outcome: "updated", itemKey: current.key, message: null };
  }
  const itemType = zoteroItemTypeFor(record);
  const data = {
    itemType,
    ...zoteroDataFromRecord({
      record,
      itemType,
      fields: zoteroCreateFields(itemType),
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
  if (record.note?.trim()) {
    await library.createItems(
      [{ itemType: "note", parentItem: created.key, note: zoteroNoteHtml(record.note) }],
      writeToken(record, "note"),
    );
  }
  await syncAfterSend({ ...input, itemKey: created.key });
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
  for (const sourceId of [...new Set(input.sourceIds)].slice(0, MAX_REFRESH_SOURCES)) {
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
      items.push(await sendOne({ root: input.root, record, library, actor: input.actor }));
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

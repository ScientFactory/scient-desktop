import { sha256 } from "@noble/hashes/sha2";

/**
 * Visual input crosses two durability boundaries: the optimistic editor buffer,
 * then the revision-checked workspace write. The journal therefore owns the
 * complete intended `.tex` source, not only the textarea for the most recently
 * visited block.
 */
const drafts = new Map<string, StoredVisualDraft>();
const STORAGE_PREFIX = "scient:latex-visual-draft:v3:";
const V2_STORAGE_PREFIX = "scient:latex-visual-draft:v2:";
const V1_STORAGE_PREFIX = "scient:latex-visual-draft:v1:";
const LEGACY_STORAGE_PREFIX = "scient:latex-visual-draft:";
const SHA256_HEX = /^[0-9a-f]{64}$/u;

interface VisualDraftCheckpoint {
  /** Exact optimistic source accepted by the shared editor buffer. */
  readonly source: string;
  readonly sourceSha256: string;
  /** Textarea value which produced `source`; restores an abandoned unchanged block. */
  readonly text: string;
}

interface StoredVisualDraft {
  readonly schemaVersion: 3;
  /** Most recent native-input value. Legacy records may have only this field. */
  readonly text: string;
  /** Complete intended source, including every earlier block in this transaction. */
  readonly source?: string;
  readonly baseRevision?: string;
  readonly baseSourceSha256?: string;
  readonly checkpoint?: VisualDraftCheckpoint;
}

interface VisualDraftSourceState {
  readonly source: string;
  readonly revision: string;
}

export interface VisualDraftInput {
  readonly text: string;
  readonly source: string;
  readonly baseSource: string;
  readonly baseRevision: string;
}

export interface VisualDraftDiscardIdentity {
  readonly source: string;
  readonly baseRevision: string;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function digest(value: string): string {
  return Array.from(sha256(new TextEncoder().encode(value)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function legacyRecord(text: string): StoredVisualDraft {
  return { schemaVersion: 3, text };
}

function decode(raw: string): StoredVisualDraft | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    decoded = raw;
  }
  // Earlier candidates stored either a raw string or a paragraph-only record.
  // Preserve that text, but never promote it to transaction-complete source.
  if (typeof decoded === "string") return legacyRecord(decoded);
  if (typeof decoded !== "object" || decoded === null || !("text" in decoded)) return null;
  if (typeof decoded.text !== "string") return null;
  const schemaVersion = "schemaVersion" in decoded ? decoded.schemaVersion : undefined;
  if (schemaVersion !== 3)
    return schemaVersion === 1 || schemaVersion === 2 ? legacyRecord(decoded.text) : null;
  if (!("source" in decoded) || decoded.source === undefined) return legacyRecord(decoded.text);
  if (
    typeof decoded.source !== "string" ||
    !("baseRevision" in decoded) ||
    typeof decoded.baseRevision !== "string" ||
    !("baseSourceSha256" in decoded) ||
    typeof decoded.baseSourceSha256 !== "string" ||
    !SHA256_HEX.test(decoded.baseSourceSha256)
  )
    return null;
  if (!("checkpoint" in decoded) || decoded.checkpoint === undefined)
    return {
      schemaVersion: 3,
      text: decoded.text,
      source: decoded.source,
      baseRevision: decoded.baseRevision,
      baseSourceSha256: decoded.baseSourceSha256,
    };
  const checkpoint = decoded.checkpoint;
  if (
    typeof checkpoint !== "object" ||
    checkpoint === null ||
    !("text" in checkpoint) ||
    typeof checkpoint.text !== "string" ||
    !("source" in checkpoint) ||
    typeof checkpoint.source !== "string" ||
    !("sourceSha256" in checkpoint) ||
    typeof checkpoint.sourceSha256 !== "string" ||
    !SHA256_HEX.test(checkpoint.sourceSha256) ||
    digest(checkpoint.source) !== checkpoint.sourceSha256
  )
    return null;
  return {
    schemaVersion: 3,
    text: decoded.text,
    source: decoded.source,
    baseRevision: decoded.baseRevision,
    baseSourceSha256: decoded.baseSourceSha256,
    checkpoint: {
      text: checkpoint.text,
      source: checkpoint.source,
      sourceSha256: checkpoint.sourceSha256,
    },
  };
}

function load(key: string): StoredVisualDraft | null {
  const memory = drafts.get(key);
  if (memory !== undefined) return memory;
  try {
    const persistentStorage = storage();
    const raw =
      persistentStorage?.getItem(`${STORAGE_PREFIX}${key}`) ??
      persistentStorage?.getItem(`${V2_STORAGE_PREFIX}${key}`) ??
      persistentStorage?.getItem(`${V1_STORAGE_PREFIX}${key}`) ??
      persistentStorage?.getItem(`${LEGACY_STORAGE_PREFIX}${key}`) ??
      null;
    if (raw === null) return null;
    const persisted = decode(raw);
    if (persisted !== null) drafts.set(key, persisted);
    return persisted;
  } catch {
    return null;
  }
}

function store(key: string, value: StoredVisualDraft): void {
  drafts.set(key, value);
  try {
    storage()?.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value));
  } catch {
    // An in-memory recovery is still better than dropping input in a locked-down WebView.
  }
}

function completeCheckpoint(record: StoredVisualDraft): VisualDraftCheckpoint | null {
  const checkpoint = record.checkpoint;
  if (
    checkpoint === undefined ||
    record.source === undefined ||
    record.source !== checkpoint.source ||
    record.text !== checkpoint.text ||
    digest(checkpoint.source) !== checkpoint.sourceSha256
  )
    return null;
  return checkpoint;
}

function recoveryText(record: StoredVisualDraft): string {
  return record.source ?? record.text;
}

function baseIdentity(previous: StoredVisualDraft | null, input: VisualDraftInput) {
  return previous?.source !== undefined && previous.baseRevision === input.baseRevision
    ? {
        baseRevision: previous.baseRevision,
        baseSourceSha256: previous.baseSourceSha256!,
        ...(previous.checkpoint === undefined ? {} : { checkpoint: previous.checkpoint }),
      }
    : {
        baseRevision: input.baseRevision,
        baseSourceSha256: digest(input.baseSource),
      };
}

/**
 * Return only a draft which still needs recovery. A complete checkpoint already
 * present in the optimistic source stays silent until its disk revision lands.
 */
export function readVisualDraft(key: string, current?: VisualDraftSourceState): string | null {
  const record = load(key);
  if (record === null) return null;
  const checkpoint = completeCheckpoint(record);
  if (current !== undefined && checkpoint?.source === current.source) return null;
  return recoveryText(record);
}

/** Remove a complete checkpoint proven durable by a newer on-disk revision. */
export function reconcileVisualDraft(key: string, current: VisualDraftSourceState): string | null {
  const record = load(key);
  if (record === null) return null;
  const checkpoint = completeCheckpoint(record);
  if (checkpoint?.source !== current.source) return recoveryText(record);
  if (record.baseRevision !== undefined && current.revision !== record.baseRevision)
    clearVisualDraft(key);
  return null;
}

/** Preserve immediate input as a complete transaction source before any debounce. */
export function retainVisualDraft(key: string, input: VisualDraftInput): void {
  const previous = load(key);
  store(key, {
    schemaVersion: 3,
    text: input.text,
    source: input.source,
    ...baseIdentity(previous, input),
  });
}

/** Mark the complete optimistic source checkpoint without claiming that it reached disk. */
export function checkpointVisualDraft(
  key: string,
  text: string,
  before: string,
  after: string,
  baseRevision: string,
): void {
  const previous = load(key);
  const identity = baseIdentity(previous, {
    text,
    source: after,
    baseSource: before,
    baseRevision,
  });
  store(key, {
    schemaVersion: 3,
    text,
    source: after,
    baseRevision: identity.baseRevision,
    baseSourceSha256: identity.baseSourceSha256,
    checkpoint: { text, source: after, sourceSha256: digest(after) },
  });
}

/**
 * Abandoning an unchanged block restores the preceding transaction checkpoint;
 * it must not erase edits accepted in earlier blocks of the same session.
 */
export function clearUncheckpointedVisualDraft(key: string, currentSource: string): void {
  const record = load(key);
  if (record === null) return;
  const checkpoint = record.checkpoint;
  if (checkpoint?.source === currentSource) {
    store(key, {
      ...record,
      text: checkpoint.text,
      source: checkpoint.source,
    });
    return;
  }
  if (checkpoint === undefined && record.source === currentSource) clearVisualDraft(key);
}

/** Clear only a complete latest checkpoint after that exact source reaches disk. */
export function confirmVisualDraft(key: string, confirmedContents: string): boolean {
  const record = load(key);
  const checkpoint = record === null ? null : completeCheckpoint(record);
  if (checkpoint?.source !== confirmedContents) return false;
  clearVisualDraft(key);
  return true;
}

/**
 * Discard is explicit authority to remove only the journal which owns the
 * discarded optimistic source and base revision. A later draft at the same key
 * is left untouched.
 */
export function discardVisualDraft(key: string, discarded: VisualDraftDiscardIdentity): boolean {
  const record = load(key);
  if (
    record === null ||
    record.baseRevision !== discarded.baseRevision ||
    (record.source !== discarded.source && record.checkpoint?.source !== discarded.source)
  )
    return false;
  clearVisualDraft(key);
  return true;
}

export function clearVisualDraft(key: string): void {
  drafts.delete(key);
  try {
    storage()?.removeItem(`${STORAGE_PREFIX}${key}`);
    storage()?.removeItem(`${V2_STORAGE_PREFIX}${key}`);
    storage()?.removeItem(`${V1_STORAGE_PREFIX}${key}`);
    storage()?.removeItem(`${LEGACY_STORAGE_PREFIX}${key}`);
  } catch {
    // The in-memory copy is already gone.
  }
}

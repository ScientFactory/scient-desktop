import { applyLatexVisualDocumentChange, projectLatexVisualDocument } from "./latexVisualDocument";
import {
  checkpointVisualDraft,
  flushVisualDraft,
  holdPersistedVisualDraft,
  readPersistedVisualDraft,
  releasePersistedVisualDraft,
  removePersistedVisualDraft,
  storeVisualDraftInFreeSlot,
} from "./visualDrafts";
import {
  discardTypingDraft,
  parseTypingDraft,
  readTypingDraft,
  typingDraftIdentity,
} from "./visualTyping";

type TypingDraft = NonNullable<ReturnType<typeof readTypingDraft>>;

/**
 * Unsaved work found when a document opened, waiting for the user's choice.
 *
 * It is normally parked in its own list, apart from the live draft slots, so
 * writing can continue without replacing it. When it cannot be parked it stays
 * in its live slot and the editor is kept read-only until the user chooses.
 */
export interface LatexVisualRecovery {
  readonly origin: "source" | "typing";
  /** The recovered document source; null when recovered writing cannot be converted to source. */
  readonly source: string | null;
  /** What the user can read or copy: the source, or the text of unconverted writing. */
  readonly text: string;
  /** The file revision the work was based on; null when only its base source is known. */
  readonly baseRevision: string | null;
  /** True when the work is in the parked list; false when it is still in its live slot. */
  readonly parked: boolean;
  /** Identifies this exact stored record, so later actions act on it only. */
  readonly identity: string;
}

interface ParkedEntry {
  readonly origin: "source" | "typing";
  readonly source: string | null;
  readonly text: string;
  readonly baseRevision: string | null;
  /**
   * The original typing snapshot, kept whole when the writing is offered as
   * extracted text, so the stored copy never depends on that extraction.
   */
  readonly snapshot: string | null;
}

export interface RecoveryDifference {
  /** 1-based line in the current file where the difference starts. */
  readonly line: number;
  readonly current: readonly string[];
  readonly recovered: readonly string[];
}

// Node attributes that hold what a person wrote or typed into a field.
const WRITING_ATTRIBUTES = [
  "title",
  "author",
  "date",
  "body",
  "tex",
  "numberingSource",
  "caption",
  "label",
  "referenceLabel",
  "argument",
  "text",
  "items",
  "rows",
  "path",
  "widestLabel",
  "figureWidth",
  "figurePlacement",
  "descriptionLeftMargin",
];
// Keys inside those values that identify or configure rather than hold writing.
const STRUCTURAL_KEY = /(?:^|[a-z])(?:id|ids|kind|type|mode|level|meta)$/iu;

function writtenStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) writtenStrings(item, into);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value))
      if (!STRUCTURAL_KEY.test(key)) writtenStrings(item, into);
  }
}

const typeOf = (node: unknown): string =>
  node && typeof node === "object" && typeof (node as { type?: unknown }).type === "string"
    ? (node as { type: string }).type
    : "";

const isInline = (node: unknown): boolean =>
  (!!node && typeof node === "object" && typeof (node as { text?: unknown }).text === "string") ||
  /inline|hardBreak/iu.test(typeOf(node));

function nodeText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const { text, attrs, content } = node as Record<string, unknown>;
  if (typeof text === "string") return text;
  const type = typeOf(node);
  if (type === "hardBreak") return "\n";
  const values = attrs && typeof attrs === "object" ? (attrs as Record<string, unknown>) : {};
  // Raw blocks and inline commands are their source; their other attributes are presentation.
  if (/rawBlock|inlineCommand/iu.test(type) && typeof values.raw === "string" && values.raw.trim())
    return values.raw;
  const children = Array.isArray(content) ? content : [];
  // Inline runs stay on one line; nested blocks, items and cells stay apart.
  const inner = children
    .map(nodeText)
    .filter((part, index) => part || isInline(children[index]))
    .join(children.every(isInline) ? "" : "\n");
  const written: string[] = [];
  for (const key of WRITING_ATTRIBUTES) {
    // A numbered formula's source already contains the formula.
    if (
      key === "tex" &&
      typeof values.tex === "string" &&
      typeof values.numberingSource === "string" &&
      values.numberingSource.includes(values.tex)
    )
      continue;
    writtenStrings(values[key], written);
  }
  if (written.length === 0 && !inner) writtenStrings(values.raw, written);
  return [inner, ...written].filter(Boolean).join("\n");
}

/**
 * What a person wrote in a snapshot: text, and the writing that rich blocks
 * keep in attributes (formulas, statement bodies, captions, cells, raw source).
 * Repeated values and block boundaries are kept. If nothing readable can be
 * extracted from a snapshot that has content, the snapshot itself is returned.
 * Tolerates malformed input.
 */
export function readableSnapshotText(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== "object") return "";
  const { content } = snapshot as Record<string, unknown>;
  const blocks = Array.isArray(content) ? content.map(nodeText).filter(Boolean) : [];
  if (blocks.length > 0) return blocks.join("\n\n");
  const own = nodeText(snapshot);
  if (own) return own;
  if (content === undefined || (Array.isArray(content) && content.length === 0)) return "";
  try {
    return JSON.stringify(snapshot, null, 2);
  } catch {
    return "";
  }
}

const parkedKey = (key: string) => `scient:latex-visual-draft:recovered:${key}`;

function isParkedEntry(value: unknown): value is ParkedEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    (entry.origin === "source" || entry.origin === "typing") &&
    (entry.source === null || typeof entry.source === "string") &&
    typeof entry.text === "string" &&
    (entry.baseRevision === null || typeof entry.baseRevision === "string") &&
    (entry.snapshot === null || typeof entry.snapshot === "string")
  );
}

/** Entries are compared by their serialized form, written in one fixed field order. */
const serialize = (entry: ParkedEntry) =>
  JSON.stringify({
    origin: entry.origin,
    source: entry.source,
    text: entry.text,
    baseRevision: entry.baseRevision,
    snapshot: entry.snapshot,
  });

const offered = (entry: ParkedEntry, identity: string, parked: boolean): LatexVisualRecovery => ({
  origin: entry.origin,
  source: entry.source,
  text: entry.text,
  baseRevision: entry.baseRevision,
  parked,
  identity,
});

function readParked(key: string): { entry: ParkedEntry; identity: string }[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(parkedKey(key)) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter(isParkedEntry).map((entry) => ({ entry, identity: serialize(entry) }));
  } catch {
    return [];
  }
}

function writeParked(key: string, identities: readonly string[]): boolean {
  try {
    if (identities.length === 0) localStorage.removeItem(parkedKey(key));
    else localStorage.setItem(parkedKey(key), `[${identities.join(",")}]`);
    return true;
  } catch {
    return false;
  }
}

/** Newest first. False when the entry could not be stored, so its original must be kept. */
function park(key: string, entry: ParkedEntry): boolean {
  const identity = serialize(entry);
  const existing = readParked(key);
  // The same recovered source is offered once, whatever revision each copy was based on.
  if (
    existing.some(
      (item) =>
        item.identity === identity || (entry.source !== null && item.entry.source === entry.source),
    )
  )
    return true;
  return writeParked(key, [identity, ...existing.map((item) => item.identity)]);
}

/** A typing snapshot holds editor content over an older source; recover it as source when possible. */
function typingEntry(draft: TypingDraft, snapshot: string): ParkedEntry {
  let source: string | null = null;
  try {
    source =
      applyLatexVisualDocumentChange(
        draft.baseSource,
        projectLatexVisualDocument(draft.baseSource),
        draft.content,
      )?.source ?? null;
  } catch {
    source = null;
  }
  return {
    origin: "typing",
    source,
    text: source ?? readableSnapshotText(draft.content),
    baseRevision: null,
    snapshot: source === null ? snapshot : null,
  };
}

// Identities of work still in a live slot are prefixed, so they never collide with parked ones.
const LIVE_SOURCE = "live-source:";
const LIVE_TYPING = "live-typing:";
// Work that could be stored nowhere and is held by the editor that offers it.
const UNSTORED = "unstored:";

/**
 * Decide what a document does with stored unsaved work when it opens.
 *
 * A typing snapshot is reinstalled only over the exact source it was typed on.
 * Anything else that differs from the file is moved to the parked list and
 * offered for an explicit choice, which frees the live draft slots so the user
 * can keep writing. The original is removed only after its parked copy is
 * stored, and only if it is still the record that was read. Work that cannot
 * be parked is offered from its live slot instead; the caller keeps the editor
 * read-only until it is resolved, then calls this again.
 *
 * Only persisted records are considered. This window's unwritten checkpoint is
 * the live draft of the current session and is left alone.
 */
export function readStartupRecovery(
  key: string,
  current: { readonly source: string },
): {
  readonly typing: TypingDraft | null;
  /** The stored snapshot `typing` was read from, so the editor that puts it back owns exactly it. */
  readonly typingIdentity: string | null;
  readonly recovery: LatexVisualRecovery | null;
} {
  // Read once: the identity and the content must be the same stored version.
  const stored = typingDraftIdentity(key);
  const typing = stored === null ? null : parseTypingDraft(stored);
  const reinstall = typing?.baseSource === current.source ? typing : null;
  let unparkedTyping: LatexVisualRecovery | null = null;
  let unparkedSource: LatexVisualRecovery | null = null;
  if (typing && !reinstall && stored !== null) {
    const identity = stored;
    const entry = typingEntry(typing, identity);
    // A snapshot that converts to what the editor already shows is left alone.
    if (entry.source !== current.source) {
      if (park(key, entry)) discardTypingDraft(key, identity);
      else unparkedTyping = offered(entry, LIVE_TYPING + identity, false);
    }
  }
  const draft = readPersistedVisualDraft(key);
  if (draft && draft.source !== current.source) {
    const entry: ParkedEntry = {
      origin: "source",
      source: draft.source,
      text: draft.source,
      baseRevision: draft.baseRevision,
      snapshot: null,
    };
    if (park(key, entry)) removePersistedVisualDraft(key, draft);
    else {
      // Offered from its slot, which this window's checkpoints must not replace.
      holdPersistedVisualDraft(key, draft);
      unparkedSource = offered(entry, LIVE_SOURCE + JSON.stringify(draft), false);
    }
  }
  // The source slot is resolved first: applying other work checkpoints into it.
  const unparked = unparkedSource ?? unparkedTyping;
  // Nothing is reinstalled while work waits in a live slot: typing would replace it.
  return unparked
    ? { typing: null, typingIdentity: null, recovery: unparked }
    : {
        typing: reinstall,
        typingIdentity: reinstall ? stored : null,
        recovery: readStoredRecovery(key),
      };
}

/**
 * A typing snapshot that could not be put back into the editor. It is parked,
 * as source when it converts and as readable text when it does not, so ordinary
 * editing cannot clear the only copy of it.
 */
export function parkUninstalledTypingDraft(key: string): LatexVisualRecovery | null {
  const typing = readTypingDraft(key);
  const identity = typingDraftIdentity(key);
  if (!typing || identity === null) return readStoredRecovery(key);
  const entry = typingEntry(typing, identity);
  if (!park(key, entry)) return offered(entry, LIVE_TYPING + identity, false);
  discardTypingDraft(key, identity);
  return readStoredRecovery(key);
}

/**
 * Source the editor produced but could not publish before the file changed
 * underneath it. It is parked like work found on opening; when it cannot be
 * parked it is written to the live source slot and offered from there.
 */
export function parkUnpublishedSource(
  key: string,
  source: string,
  baseRevision: string,
): LatexVisualRecovery | null {
  const entry: ParkedEntry = {
    origin: "source",
    source,
    text: source,
    baseRevision,
    snapshot: null,
  };
  if (park(key, entry)) return readStoredRecovery(key);
  // The live slot is used only when it is free: a different record there may
  // be the only copy of other unsaved work.
  const draft = { source, baseRevision };
  if (storeVisualDraftInFreeSlot(key, draft)) {
    holdPersistedVisualDraft(key, draft);
    return offered(entry, LIVE_SOURCE + JSON.stringify(draft), false);
  }
  // Nowhere to store it. It is offered from the editor's memory, and the user
  // is told that this document's recovery copy could not be stored. Whatever
  // occupies the slot is someone's unsaved work: this window's checkpoints,
  // including the one written when this offer is applied, stay out of it.
  const occupant = readPersistedVisualDraft(key);
  if (occupant) holdPersistedVisualDraft(key, occupant);
  window.dispatchEvent(new CustomEvent("scient-latex-recovery-error", { detail: key }));
  return offered(entry, UNSTORED + source, false);
}

/** The parked unsaved work to offer for this document, newest first. */
export function readStoredRecovery(key: string): LatexVisualRecovery | null {
  const first = readParked(key)[0];
  return first ? offered(first.entry, first.identity, true) : null;
}

/** Work that could be stored nowhere: it exists only while its editor stays open. */
export function isRecoveryUnstored(recovery: LatexVisualRecovery): boolean {
  return recovery.identity.startsWith(UNSTORED);
}

/** Whether storage still holds exactly the record this recovery was read from. */
export function isRecoveryStored(key: string, recovery: LatexVisualRecovery): boolean {
  if (recovery.parked) return readParked(key).some((item) => item.identity === recovery.identity);
  // Held by the editor showing it; there is no stored record to have changed.
  if (recovery.identity.startsWith(UNSTORED)) return true;
  if (recovery.identity.startsWith(LIVE_TYPING))
    return typingDraftIdentity(key) === recovery.identity.slice(LIVE_TYPING.length);
  const persisted = readPersistedVisualDraft(key);
  return (
    persisted !== null && JSON.stringify(persisted) === recovery.identity.slice(LIVE_SOURCE.length)
  );
}

/** Remove one recovered record, and only that one. False when it could not be removed. */
export function removeRecovery(key: string, recovery: LatexVisualRecovery): boolean {
  if (recovery.parked) {
    const identities = readParked(key).map((item) => item.identity);
    if (!identities.includes(recovery.identity)) return true;
    return writeParked(
      key,
      identities.filter((identity) => identity !== recovery.identity),
    );
  }
  if (recovery.identity.startsWith(UNSTORED)) return true;
  if (recovery.identity.startsWith(LIVE_TYPING))
    return discardTypingDraft(key, recovery.identity.slice(LIVE_TYPING.length));
  const persisted = readPersistedVisualDraft(key);
  if (!persisted || JSON.stringify(persisted) !== recovery.identity.slice(LIVE_SOURCE.length))
    return false;
  return removePersistedVisualDraft(key, persisted);
}

/**
 * After the host accepted recovered work as the document's source: keep it as
 * the live draft until its save is acknowledged, then drop the offered record.
 * False when the offered record is still the only stored copy and so stays.
 */
export function journalAppliedRecovery(
  key: string,
  recovery: LatexVisualRecovery & { readonly source: string },
  replaced: { readonly source: string; readonly revision: string },
): boolean {
  const inSourceSlot = !recovery.parked && recovery.identity.startsWith(LIVE_SOURCE);
  if (inSourceSlot) releasePersistedVisualDraft(key);
  checkpointVisualDraft(key, recovery.source, replaced.source, recovery.source, replaced.revision);
  const written = flushVisualDraft(key);
  // The source slot now holds the applied work as the live draft, or still the
  // same recovered source. Either way it is the journal and must not be removed
  // through the offered record, even when the two are identical.
  if (inSourceSlot) return true;
  // Unstored work has no record to keep: the host now holds it as its source.
  if (recovery.identity.startsWith(UNSTORED)) return true;
  return written && removeRecovery(key, recovery);
}

/**
 * Checked at the moment the user applies a recovery. The document must take a
 * whole-source replacement in one revision-checked save, and the file must be
 * the one the user compared against.
 */
export function canApplyRecovery(
  recovery: LatexVisualRecovery,
  comparedSource: string,
  file: { readonly source: string; readonly singleFile: boolean },
): boolean {
  return file.singleFile && recovery.source !== null && comparedSource === file.source;
}

const MAX_COMPARED_CELLS = 250_000;

/** Line differences between the current file and the recovered source, for display. */
export function compareRecoveredSource(current: string, recovered: string): RecoveryDifference[] {
  const a = current.split("\n");
  const b = recovered.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const left = a.slice(start, endA);
  const right = b.slice(start, endB);
  if (left.length === 0 && right.length === 0) return [];
  if (left.length * right.length > MAX_COMPARED_CELLS)
    return [{ line: start + 1, current: left, recovered: right }];

  // Longest common subsequence of the differing middle.
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--)
    for (let j = right.length - 1; j >= 0; j--)
      table[i * width + j] =
        left[i] === right[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);

  const differences: RecoveryDifference[] = [];
  let open: { line: number; current: string[]; recovered: string[] } | null = null;
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      if (open) differences.push(open);
      open = null;
      i++;
      j++;
      continue;
    }
    open ??= { line: start + i + 1, current: [], recovered: [] };
    if (
      j >= right.length ||
      (i < left.length && table[(i + 1) * width + j]! >= table[i * width + j + 1]!)
    )
      open.current.push(left[i++]!);
    else open.recovered.push(right[j++]!);
  }
  if (open) differences.push(open);
  return differences;
}

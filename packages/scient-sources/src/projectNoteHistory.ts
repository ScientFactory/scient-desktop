// @effect-diagnostics nodeBuiltinImport:off -- Note history is a file in the project folder.
// @effect-diagnostics globalDate:off -- Project files use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { ScientSourceActor } from "./model.ts";
import { atomicWriteJson, readBoundedJson, snapshot } from "./storeFiles.ts";

const NOTE_HISTORY_DIRECTORY = [".scient", "library", "note-history"] as const;
/** Kept besides the first version; `at least 20` is the project's promise (D2). */
export const SCIENT_PROJECT_NOTE_CHECKPOINTS = 20;
/** One editor's autosaves within this window are one checkpoint. */
const NOTE_SESSION_WINDOW_MS = 10 * 60 * 1000;
// 21 versions of a 100,000-character note, escaped.
const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
const SAFE_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * One version of a project note, oldest first. `original` is the first note this project kept;
 * `found` is a note the pins file held that the history had not seen (an edit by another tool or
 * an interrupted write), recorded before anything replaces it.
 */
export const ScientProjectNoteVersion = Schema.Struct({
  note: Schema.NullOr(Schema.String),
  at: Schema.String,
  kind: Schema.Literals(["original", "edit", "found"]),
  by: Schema.optionalKey(ScientSourceActor),
  /** An editor's autosave session; later saves of the same session within the window replace it. */
  session: Schema.optionalKey(Schema.String),
  /** When that session's first save landed. */
  since: Schema.optionalKey(Schema.String),
});
export type ScientProjectNoteVersion = typeof ScientProjectNoteVersion.Type;

const NoteHistoryFile = Schema.Struct({
  formatVersion: Schema.Literal(1),
  sourceId: Schema.String,
  versions: Schema.Array(ScientProjectNoteVersion),
});

const decodeNoteHistoryFile = Schema.decodeUnknownSync(NoteHistoryFile);

function historyPath(root: string, sourceId: string): string {
  const name = SAFE_FILE_ID.test(sourceId)
    ? sourceId
    : `id-${NodeCrypto.createHash("sha256").update(sourceId).digest("hex").slice(0, 32)}`;
  return NodePath.join(root, ...NOTE_HISTORY_DIRECTORY, `${name}.json`);
}

/** A pin's note history, oldest first; empty when the note never changed since this version. */
export async function readScientProjectNoteHistory(
  root: string,
  sourceId: string,
): Promise<ReadonlyArray<ScientProjectNoteVersion>> {
  const filePath = historyPath(root, sourceId);
  if ((await snapshot(filePath)) !== "file") return [];
  const file = await readBoundedJson(filePath, MAX_HISTORY_BYTES, NoteHistoryFile);
  return file.sourceId === sourceId ? file.versions : [];
}

/** The history as it must be before the pins file stops holding `current`; also what a reader shows. */
export function scientProjectNoteVersionsWithCurrent(
  versions: ReadonlyArray<ScientProjectNoteVersion>,
  current: string | null,
  pinnedAt: string,
  now: string,
): ReadonlyArray<ScientProjectNoteVersion> {
  if (versions.length === 0) {
    return current === null ? [] : [{ note: current, at: pinnedAt, kind: "original" }];
  }
  return versions.at(-1)!.note === current
    ? versions
    : [...versions, { note: current, at: now, kind: "found" }];
}

/** The first note ever accepted (however it was written) and the latest checkpoints. */
function pruned(
  versions: ReadonlyArray<ScientProjectNoteVersion>,
): ReadonlyArray<ScientProjectNoteVersion> {
  const tail = Math.max(0, versions.length - SCIENT_PROJECT_NOTE_CHECKPOINTS);
  const first = versions.findIndex((version) => (version.note ?? "").trim() !== "");
  return first >= 0 && first < tail
    ? [versions[first]!, ...versions.slice(tail)]
    : versions.slice(tail);
}

export interface ScientProjectNoteChange {
  readonly sourceId: string;
  readonly pinnedAt: string;
  /** The note `pins.json` holds now, before the change. */
  readonly current: string | null;
  /** The note it will hold; `undefined` only keeps the current one in the history (unpin). */
  readonly next?: string | null;
  readonly actor: ScientSourceActor;
  readonly session?: string;
  /** A new pin: `current` is not a note anyone saw, so it is not recorded. */
  readonly newPin?: boolean;
}

/**
 * Publishes the history a note change needs, before `pins.json` changes. The caller holds the
 * project's pins lock. A crash after this leaves the new text as the newest version; the next
 * change then records what `pins.json` still holds as `found`, so neither text is lost.
 */
export async function recordScientProjectNoteChange(
  root: string,
  change: ScientProjectNoteChange,
): Promise<void> {
  const now = new Date().toISOString();
  const before = await readScientProjectNoteHistory(root, change.sourceId);
  const kept = change.newPin
    ? before
    : scientProjectNoteVersionsWithCurrent(before, change.current, change.pinnedAt, now);
  let versions = kept;
  if (change.next !== undefined) {
    const last = kept.at(-1);
    const sameSession =
      change.session !== undefined &&
      last?.kind === "edit" &&
      last.session === change.session &&
      last.by === change.actor &&
      Date.parse(now) - Date.parse(last.since ?? last.at) < NOTE_SESSION_WINDOW_MS;
    const version: ScientProjectNoteVersion = {
      note: change.next,
      at: now,
      kind: "edit",
      by: change.actor,
      ...(change.session !== undefined
        ? { session: change.session, since: sameSession ? (last!.since ?? last!.at) : now }
        : {}),
    };
    versions = sameSession ? [...kept.slice(0, -1), version] : [...kept, version];
  }
  if (versions === before) return;
  await atomicWriteJson(
    historyPath(root, change.sourceId),
    { formatVersion: 1, sourceId: change.sourceId, versions: pruned(versions) },
    MAX_HISTORY_BYTES,
  );
}

/**
 * Keeps another copy's note for a pin (from an imported package) as a `found` version just before
 * the note the pin has now, so either can be restored. The caller holds the project's pins lock.
 */
export async function recordScientProjectNoteFromElsewhere(
  root: string,
  input: {
    readonly sourceId: string;
    readonly pinnedAt: string;
    readonly current: string;
    readonly other: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const kept = scientProjectNoteVersionsWithCurrent(
    await readScientProjectNoteHistory(root, input.sourceId),
    input.current,
    input.pinnedAt,
    now,
  );
  if (kept.some((version) => version.note === input.other)) return;
  const versions = [
    ...kept.slice(0, -1),
    { note: input.other, at: now, kind: "found" as const },
    kept.at(-1)!,
  ];
  await atomicWriteJson(
    historyPath(root, input.sourceId),
    { formatVersion: 1, sourceId: input.sourceId, versions: pruned(versions) },
    MAX_HISTORY_BYTES,
  );
}

const versionKey = (version: ScientProjectNoteVersion) =>
  JSON.stringify([version.note, version.at, version.kind, version.by ?? null]);

/**
 * Joins another copy's history of one pin (a package's file): every version either kept, once,
 * oldest first, with its kind, actor and time; this copy's newest stays newest. The caller holds
 * the project's pins lock. Answers how many versions were new here.
 */
export async function joinScientProjectNoteHistory(
  root: string,
  incoming: unknown,
): Promise<number> {
  const file = decodeNoteHistoryFile(incoming);
  const local = await readScientProjectNoteHistory(root, file.sourceId);
  const seen = new Set(local.map(versionKey));
  const added = file.versions.filter((version) => !seen.has(versionKey(version)));
  if (added.length === 0) return 0;
  const newest = local.at(-1);
  const joined = [...local.slice(0, -1), ...added].toSorted((left, right) =>
    left.at < right.at ? -1 : left.at > right.at ? 1 : 0,
  );
  await atomicWriteJson(
    historyPath(root, file.sourceId),
    {
      formatVersion: 1,
      sourceId: file.sourceId,
      versions: pruned(newest ? [...joined, newest] : joined),
    },
    MAX_HISTORY_BYTES,
  );
  return added.length;
}

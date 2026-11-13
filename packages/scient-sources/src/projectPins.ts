// @effect-diagnostics nodeBuiltinImport:off -- Pins are a file in the project folder.
// @effect-diagnostics globalDate:off -- Project files use interoperable ISO timestamps.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readScientProjectIdentity } from "@scientfactory/project-init";
import * as Schema from "effect/Schema";

import { assignCitationKey, citationKeyComparisonValue } from "./citationKeys.ts";
import { readScientLibraryAliases, resolveScientLibraryAlias } from "./libraryAliases.ts";
import {
  resolveScientProjectSources,
  scientSourceTypeFromSnapshot,
  type ScientProjectSourceResolution,
} from "./libraryInstanceMap.ts";
import { withScientFileLock, type ScientLibraryLockOptions } from "./libraryLock.ts";
import type { ScientLibraryLocation } from "./libraryRoot.ts";
import {
  ScientSourceActor,
  ScientSourceCitationKey,
  ScientSourceCreator,
  ScientSourceIdentifier,
  type ScientSourceRecord,
} from "./model.ts";
import {
  SCIENT_PIN_CITATION_TEXT_FIELDS,
  scientPinWorkIsComplete,
  scientPinWorkKeepingUnknown,
  scientRecordOnlyFromProjectFile,
  withKnownPinCitationValues,
} from "./pinCitation.ts";
import {
  readScientProjectNoteHistory,
  recordScientProjectNoteChange,
  recordScientProjectNoteFromElsewhere,
  scientProjectNoteVersionsWithCurrent,
  type ScientProjectNoteChange,
  type ScientProjectNoteVersion,
} from "./projectNoteHistory.ts";
import {
  listScientSourceRecords,
  readScientSourceRecord,
  scientSourceStoreInternals,
} from "./store.ts";
import { atomicWriteJson, snapshot } from "./storeFiles.ts";

const SCIENT_PROJECT_LIBRARY_PATH = [".scient", "library"] as const;
const SCIENT_PROJECT_PINS_PATH = [...SCIENT_PROJECT_LIBRARY_PATH, "pins.json"] as const;
/** The project's cross-process lock for `pins.json` and its note history; an empty file. */
const SCIENT_PROJECT_PINS_LOCK = "pins.lock";
// 20,000 pins with long author lists are about 26 MiB (scale gate); 16 MiB refused them.
const MAX_PINS_BYTES = 64 * 1024 * 1024;
const MAX_PIN_NOTE_LENGTH = 100_000;
const NonEmptyString = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());
const NullableText = Schema.NullOr(Schema.String);

/**
 * The pin's metadata snapshot: every citation input, so a collaborator with no Library cites the
 * same; never an abstract, note or PDF. A snapshot from before the optional fields lacks them:
 * unknown, never an instruction to empty them.
 */
export const ScientPinWork = Schema.Struct({
  // Plain text, so a type a newer Scient adds never hides the whole file.
  type: NonEmptyString,
  title: NullableText,
  creators: Schema.Array(ScientSourceCreator).pipe(Schema.check(Schema.isMaxLength(256))),
  issuedYear: Schema.NullOr(Schema.Int),
  identifiers: Schema.Array(ScientSourceIdentifier).pipe(Schema.check(Schema.isMaxLength(256))),
  containerTitle: NullableText,
  customType: Schema.optionalKey(NullableText),
  issuedRaw: Schema.optionalKey(NullableText),
  publisher: Schema.optionalKey(NullableText),
  volume: Schema.optionalKey(NullableText),
  issue: Schema.optionalKey(NullableText),
  pages: Schema.optionalKey(NullableText),
  language: Schema.optionalKey(NullableText),
  url: Schema.optionalKey(NullableText),
  tags: Schema.optionalKey(Schema.Array(Schema.String).pipe(Schema.check(Schema.isMaxLength(256)))),
});
export type ScientPinWork = typeof ScientPinWork.Type;

export const ScientProjectPin = Schema.Struct({
  /** The project key: copied from the library's preferred key once, then frozen. */
  citationKey: ScientSourceCitationKey,
  /** The project source ID; it resolves through this computer's instance map. */
  sourceId: NonEmptyString,
  pinnedAt: NonEmptyString,
  pinnedBy: ScientSourceActor,
  /** Why this project cites it; personal notes stay on the library record. */
  note: Schema.optionalKey(
    Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_PIN_NOTE_LENGTH))),
  ),
  work: ScientPinWork,
});
export type ScientProjectPin = typeof ScientProjectPin.Type;

const PinsFileHeader = Schema.Struct({
  formatVersion: Schema.Literal(1),
  pins: Schema.Array(Schema.Unknown),
});
const decodePinsHeader = Schema.decodeUnknownSync(PinsFileHeader);
const decodePin = Schema.decodeUnknownSync(ScientProjectPin);

type JsonObject = Readonly<Record<string, unknown>>;

/** A pin with the fields a newer Scient wrote, which every rewrite keeps. */
interface StoredPin {
  readonly pin: ScientProjectPin;
  readonly extra: JsonObject;
  readonly workExtra: JsonObject;
}

interface PinsDocument {
  readonly pins: ReadonlyArray<StoredPin>;
  readonly extra: JsonObject;
  /** The file's bytes as read, or null when there is no file. */
  readonly text: string | null;
}

const PIN_FIELDS = Object.keys(ScientProjectPin.fields);
const WORK_FIELDS = Object.keys(ScientPinWork.fields);
const FILE_FIELDS = Object.keys(PinsFileHeader.fields);

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function extraFields(value: unknown, known: ReadonlyArray<string>): JsonObject {
  if (!isJsonObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !known.includes(key)));
}

function sortedExtra(extra: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.keys(extra)
      .toSorted()
      .map((key) => [key, extra[key]]),
  );
}

function encodeWork(work: ScientPinWork, extra: JsonObject) {
  return {
    type: work.type,
    title: work.title,
    creators: work.creators.map((creator) => ({
      creatorType: creator.creatorType,
      givenName: creator.givenName,
      familyName: creator.familyName,
      literalName: creator.literalName,
    })),
    issuedYear: work.issuedYear,
    identifiers: work.identifiers.map((identifier) => ({
      scheme: identifier.scheme,
      value: identifier.value,
    })),
    containerTitle: work.containerTitle,
    ...Object.fromEntries(
      SCIENT_PIN_CITATION_TEXT_FIELDS.flatMap((field) =>
        work[field] !== undefined ? [[field, work[field]]] : [],
      ),
    ),
    ...(work.tags !== undefined ? { tags: [...work.tags] } : {}),
    ...sortedExtra(extra),
  };
}

function comparePins(left: ScientProjectPin, right: ScientProjectPin): number {
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return (
    order(
      citationKeyComparisonValue(left.citationKey),
      citationKeyComparisonValue(right.citationKey),
    ) ||
    order(left.citationKey, right.citationKey) ||
    order(left.sourceId, right.sourceId)
  );
}

/** Sorted by key, fields in a fixed order and unknown fields after them, so equal pins are equal bytes. */
function encodePins(document: Pick<PinsDocument, "pins" | "extra">) {
  return {
    formatVersion: 1,
    pins: document.pins
      .toSorted((left, right) => comparePins(left.pin, right.pin))
      .map(({ pin, extra, workExtra }) => ({
        citationKey: pin.citationKey,
        sourceId: pin.sourceId,
        pinnedAt: pin.pinnedAt,
        pinnedBy: pin.pinnedBy,
        ...(pin.note !== undefined ? { note: pin.note } : {}),
        work: encodeWork(pin.work, workExtra),
        ...sortedExtra(extra),
      })),
    ...sortedExtra(document.extra),
  };
}

function pinsPath(root: string): string {
  return NodePath.join(root, ...SCIENT_PROJECT_PINS_PATH);
}

async function readPinsDocument(root: string): Promise<PinsDocument> {
  const filePath = pinsPath(root);
  const state = await snapshot(filePath);
  if (state === "missing") return { pins: [], extra: {}, text: null };
  if (state !== "file") throw new Error("pins.json is not a safe regular file.");
  const stats = await NodeFSP.lstat(filePath);
  if (stats.size > MAX_PINS_BYTES) throw new Error("pins.json exceeds the safe size limit.");
  const text = await NodeFSP.readFile(filePath, "utf8");
  return { ...parsePinsText(text), text };
}

/** Writes only when the bytes would change, so an unchanged project never shows a git diff. */
async function writePinsDocument(
  root: string,
  current: PinsDocument,
  pins: ReadonlyArray<StoredPin>,
): Promise<boolean> {
  const encoded = encodePins({ pins, extra: current.extra });
  if (current.text === `${JSON.stringify(encoded, null, 2)}\n`) return false;
  await atomicWriteJson(pinsPath(root), encoded, MAX_PINS_BYTES);
  return true;
}

async function projectRootFor(projectRoot: string): Promise<string> {
  const root = await NodeFSP.realpath(projectRoot);
  await readScientProjectIdentity(root);
  return root;
}

/**
 * Every `pins.json` writer holds this, in this and any other Scient process using the same project
 * folder (two servers with different Libraries included). Taken before the library lock, never
 * inside one. It does not coordinate two synced copies of the folder or an older Scient.
 */
export function withScientProjectPinsLock<A>(
  projectRoot: string,
  run: () => Promise<A>,
  options: ScientLibraryLockOptions = {},
): Promise<A> {
  return scientSourceStoreInternals.withOperationLock(`${projectRoot}:pins-write`, async () => {
    const directory = NodePath.join(projectRoot, ...SCIENT_PROJECT_LIBRARY_PATH);
    await NodeFSP.mkdir(directory, { recursive: true });
    const lockPath = NodePath.join(await NodeFSP.realpath(directory), SCIENT_PROJECT_PINS_LOCK);
    return withScientFileLock(lockPath, run, options);
  });
}

const withPinsLock = <A>(root: string, run: () => Promise<A>) =>
  withScientProjectPinsLock(root, run);

/** Whether a writer that saw `base` may replace this pin's note; no base means "no note". */
function noteBaseMatches(pin: ScientProjectPin, base: string | null | undefined): boolean {
  return normalizePinNote(base) === pin.note;
}

function noteChange(
  pin: ScientProjectPin,
  next: string | undefined,
  actor: ScientSourceActor,
  session: string | undefined,
): ScientProjectNoteChange {
  return {
    sourceId: pin.sourceId,
    pinnedAt: pin.pinnedAt,
    current: pin.note ?? null,
    next: next ?? null,
    actor,
    ...(session !== undefined ? { session } : {}),
  };
}

export function scientPinWorkFromRecord(record: ScientSourceRecord): ScientPinWork {
  return {
    type: record.type,
    title: record.title,
    creators: record.creators,
    issuedYear: record.issuedYear,
    identifiers: record.identifiers,
    containerTitle: record.containerTitle,
    customType: record.customType ?? null,
    issuedRaw: record.issuedRaw,
    publisher: record.publisher,
    volume: record.volume,
    issue: record.issue,
    pages: record.pages,
    language: record.language,
    url: record.url,
    tags: record.tags,
  };
}

function normalizePinNote(note: string | null | undefined): string | undefined {
  const trimmed = note?.trim();
  return trimmed ? trimmed : undefined;
}

function findPin(pins: ReadonlyArray<StoredPin>, citationKey: string): StoredPin | undefined {
  const wanted = citationKeyComparisonValue(citationKey);
  return pins.find(({ pin }) => citationKeyComparisonValue(pin.citationKey) === wanted);
}

function resolvePinsRead(
  library: ScientLibraryLocation,
  root: string,
  pins: ReadonlyArray<StoredPin>,
): Promise<ReadonlyArray<ScientProjectSourceResolution>> {
  return resolveScientProjectSources({
    library,
    projectRoot: root,
    mode: "read",
    sources: pins.map(({ pin }) => ({ projectSourceId: pin.sourceId, work: pin.work })),
  });
}

/** The exact `pins.json` bytes for these pins, as every pin write produces them. */
export function scientProjectPinsText(
  pins: ReadonlyArray<ScientProjectPin>,
  extra: Readonly<Record<string, unknown>> = {},
): string {
  return `${JSON.stringify(
    encodePins({ pins: pins.map((pin) => ({ pin, extra: {}, workExtra: {} })), extra }),
    null,
    2,
  )}\n`;
}

function parsePinsText(text: string): Pick<PinsDocument, "pins" | "extra"> {
  const value: unknown = JSON.parse(text);
  const header = decodePinsHeader(value);
  return {
    pins: header.pins.map((raw) => ({
      pin: decodePin(raw),
      extra: extraFields(raw, PIN_FIELDS),
      workExtra: extraFields(isJsonObject(raw) ? raw["work"] : undefined, WORK_FIELDS),
    })),
    extra: extraFields(value, FILE_FIELDS),
  };
}

/** Decodes `pins.json` bytes; throws when they are not a pins file this version reads. */
export function decodeScientProjectPinsText(text: string): ReadonlyArray<ScientProjectPin> {
  return parsePinsText(text)
    .pins.map(({ pin }) => pin)
    .toSorted(comparePins);
}

/** `pins.json` bytes with more pins added; every existing pin keeps its bytes and newer fields. */
export function joinScientProjectPinsText(
  text: string,
  additions: ReadonlyArray<ScientProjectPin>,
): string {
  const document = parsePinsText(text);
  return `${JSON.stringify(
    encodePins({
      pins: [...document.pins, ...additions.map((pin) => ({ pin, extra: {}, workExtra: {} }))],
      extra: document.extra,
    }),
    null,
    2,
  )}\n`;
}

/** The project's pins, sorted by key. A project with no `pins.json` has none. */
export async function readScientProjectPins(
  projectRoot: string,
): Promise<ReadonlyArray<ScientProjectPin>> {
  const root = await projectRootFor(projectRoot);
  const document = await readPinsDocument(root);
  return document.pins.map(({ pin }) => pin).toSorted(comparePins);
}

export type ScientPinResult =
  | { readonly outcome: "pinned" | "existing"; readonly pin: ScientProjectPin }
  | { readonly outcome: "not-found" };

/**
 * Pins a library source into the project under the record's preferred key, with a suffix when the
 * project already uses that key. A source already pinned, under any ID that resolves to it,
 * returns that pin unchanged.
 */
export async function pinScientLibrarySource(input: {
  readonly projectRoot: string;
  readonly library: ScientLibraryLocation;
  readonly sourceId: string;
  readonly actor: ScientSourceActor;
  readonly note?: string | null;
}): Promise<ScientPinResult> {
  const root = await projectRootFor(input.projectRoot);
  return withPinsLock(root, async () => {
    const aliases = await readScientLibraryAliases(input.library);
    const record = await readScientSourceRecord(
      input.library,
      resolveScientLibraryAlias(aliases, input.sourceId),
    );
    if (!record) return { outcome: "not-found" };
    const document = await readPinsDocument(root);
    const sameId = document.pins.find(
      ({ pin }) => pin.sourceId === input.sourceId || pin.sourceId === record.sourceId,
    );
    if (sameId) return { outcome: "existing", pin: sameId.pin };
    const resolutions = await resolvePinsRead(input.library, root, document.pins);
    const resolvedIndex = resolutions.findIndex(
      (resolution) => resolution.kind === "resolved" && resolution.sourceId === record.sourceId,
    );
    if (resolvedIndex >= 0) return { outcome: "existing", pin: document.pins[resolvedIndex]!.pin };

    const taken = new Set(
      document.pins.map(({ pin }) => citationKeyComparisonValue(pin.citationKey)),
    );
    const note = normalizePinNote(input.note);
    const pin: ScientProjectPin = {
      citationKey: assignCitationKey({
        preferred: record.citationKey ?? null,
        creators: record.creators,
        issuedYear: record.issuedYear,
        title: record.title,
        taken,
      }),
      sourceId: record.sourceId,
      pinnedAt: new Date().toISOString(),
      pinnedBy: input.actor,
      ...(note !== undefined ? { note } : {}),
      work: scientPinWorkFromRecord(record),
    };
    if (note !== undefined) {
      await recordScientProjectNoteChange(root, {
        ...noteChange(pin, note, input.actor, undefined),
        current: null,
        newPin: true,
      });
    }
    await writePinsDocument(root, document, [...document.pins, { pin, extra: {}, workExtra: {} }]);
    return { outcome: "pinned", pin };
  });
}

export async function unpinScientLibrarySource(input: {
  readonly projectRoot: string;
  readonly citationKey: string;
  readonly actor: ScientSourceActor;
}): Promise<
  | { readonly outcome: "unpinned"; readonly pin: ScientProjectPin }
  | { readonly outcome: "not-pinned" }
> {
  const root = await projectRootFor(input.projectRoot);
  return withPinsLock(root, async () => {
    const document = await readPinsDocument(root);
    const found = findPin(document.pins, input.citationKey);
    if (!found) return { outcome: "not-pinned" };
    if (found.pin.note !== undefined) {
      const { next: _keep, ...kept } = noteChange(found.pin, undefined, input.actor, undefined);
      await recordScientProjectNoteChange(root, kept);
    }
    await writePinsDocument(
      root,
      document,
      document.pins.filter((stored) => stored !== found),
    );
    return { outcome: "unpinned", pin: found.pin };
  });
}

const PIN_READ_AHEAD = 64;

export type ScientPinChangeResult =
  | ScientPinResult
  | { readonly outcome: "unpinned"; readonly pin: ScientProjectPin }
  | { readonly outcome: "not-pinned" }
  /** A note change whose `noteBase` is not the pin's note now; `pin` holds the current note. */
  | { readonly outcome: "stale"; readonly pin: ScientProjectPin }
  | { readonly outcome: "refused"; readonly message: string };

export type ScientPinChange =
  | {
      readonly action: "pin";
      readonly sourceId: string;
      readonly note?: string | null;
      /** The note the writer saw on the pin; needed to replace or clear one. */
      readonly noteBase?: string | null;
    }
  | { readonly action: "unpin"; readonly citationKey: string };

/**
 * Pins and unpins in order, each with the outcome `pinScientLibrarySource` or
 * `unpinScientLibrarySource` gives it alone, reading and writing `pins.json` once. A note sent
 * for a source already pinned replaces its note when `noteBase` is the note it has, and is `stale`
 * otherwise. A change that cannot be made is `refused`.
 */
export async function changeScientProjectPins(input: {
  readonly projectRoot: string;
  readonly library: ScientLibraryLocation;
  readonly changes: ReadonlyArray<ScientPinChange>;
  readonly actor: ScientSourceActor;
}): Promise<ReadonlyArray<ScientPinChangeResult>> {
  const root = await projectRootFor(input.projectRoot);
  return withPinsLock(root, async () => {
    const document = await readPinsDocument(root);
    let changed = false;
    const taken = new Set(
      document.pins.map(({ pin }) => citationKeyComparisonValue(pin.citationKey)),
    );
    const pinning = input.changes.some((change) => change.action === "pin");
    const aliases = pinning ? await readScientLibraryAliases(input.library) : null;
    // Resolutions depend on the library only; pins added here are found by their own ID.
    const resolutions = pinning
      ? new Map(
          (await resolvePinsRead(input.library, root, document.pins)).map(
            (resolution, index) => [document.pins[index]!, resolution] as const,
          ),
        )
      : new Map<StoredPin, ScientProjectSourceResolution>();
    const pins = new OrderedPins(document.pins, resolutions);
    const prefetched = new Map<string, Promise<ScientSourceRecord | null>>();
    // Published before `pins.json`, in order, so a later change in the batch builds on an earlier.
    const history: ScientProjectNoteChange[] = [];
    // In order: a later change in this batch may give the pin's key to another source.
    const withNote = (
      stored: StoredPin,
      change: Extract<ScientPinChange, { readonly action: "pin" }>,
    ): ScientPinChangeResult => {
      if (change.note === undefined) return { outcome: "existing", pin: stored.pin };
      const note = normalizePinNote(change.note);
      if (note === stored.pin.note) return { outcome: "existing", pin: stored.pin };
      if (!noteBaseMatches(stored.pin, change.noteBase))
        return { outcome: "stale", pin: stored.pin };
      const { note: _previous, ...rest } = stored.pin;
      const pin: ScientProjectPin = note === undefined ? rest : { ...rest, note };
      history.push(noteChange(stored.pin, note, input.actor, undefined));
      pins.replace(stored, { ...stored, pin });
      changed = true;
      return { outcome: "existing", pin };
    };
    const pinChange = async (
      change: Extract<ScientPinChange, { readonly action: "pin" }>,
    ): Promise<ScientPinChangeResult> => {
      const record = await prefetched.get(change.sourceId)!;
      if (!record) return { outcome: "not-found" };
      const sameId = pins.firstWithSourceId(change.sourceId, record.sourceId);
      if (sameId) return withNote(sameId, change);
      const resolved = pins.firstResolvedTo(record.sourceId);
      if (resolved) return withNote(resolved, change);
      const note = normalizePinNote(change.note);
      const pin: ScientProjectPin = {
        citationKey: assignCitationKey({
          preferred: record.citationKey ?? null,
          creators: record.creators,
          issuedYear: record.issuedYear,
          title: record.title,
          taken,
        }),
        sourceId: record.sourceId,
        pinnedAt: new Date().toISOString(),
        pinnedBy: input.actor,
        ...(note !== undefined ? { note } : {}),
        work: scientPinWorkFromRecord(record),
      };
      if (note !== undefined) {
        history.push({ ...noteChange(pin, note, input.actor, undefined), newPin: true });
      }
      pins.add({ pin, extra: {}, workExtra: {} });
      changed = true;
      taken.add(citationKeyComparisonValue(pin.citationKey));
      return { outcome: "pinned", pin };
    };
    const results: ScientPinChangeResult[] = [];
    for (const [index, change] of input.changes.entries()) {
      // Reads only: the next records are read together, then applied one by one in order.
      if (index % PIN_READ_AHEAD === 0) {
        prefetched.clear();
        for (const next of input.changes.slice(index, index + PIN_READ_AHEAD)) {
          if (next.action !== "pin" || prefetched.has(next.sourceId)) continue;
          const read = readScientSourceRecord(
            input.library,
            resolveScientLibraryAlias(aliases!, next.sourceId),
          );
          read.catch(() => undefined);
          prefetched.set(next.sourceId, read);
        }
      }
      try {
        if (change.action === "pin") {
          results.push(await pinChange(change));
          continue;
        }
        const found = pins.firstWithKey(change.citationKey);
        if (!found) {
          results.push({ outcome: "not-pinned" });
          continue;
        }
        if (found.pin.note !== undefined) {
          const { next: _keep, ...kept } = noteChange(found.pin, undefined, input.actor, undefined);
          history.push(kept);
        }
        pins.remove(found);
        changed = true;
        taken.delete(citationKeyComparisonValue(found.pin.citationKey));
        results.push({ outcome: "unpinned", pin: found.pin });
      } catch (error) {
        results.push({
          outcome: "refused",
          message: error instanceof Error ? error.message : "The change could not be made.",
        });
      }
    }
    for (const change of history) await recordScientProjectNoteChange(root, change);
    if (changed) await writePinsDocument(root, document, pins.list());
    return results;
  });
}

/**
 * A batch's pins in file order, with the lookups `changeScientProjectPins` makes for every
 * change: each answers the first pin in order, as a scan would, without scanning 20,000 pins.
 */
class OrderedPins {
  private readonly slots: Array<StoredPin | null>;
  private readonly slotOf = new Map<StoredPin, number>();
  private readonly bySourceId = new Map<string, Set<StoredPin>>();
  private readonly byTarget = new Map<string, Set<StoredPin>>();
  private readonly byKey = new Map<string, Set<StoredPin>>();

  private readonly resolutions: Map<StoredPin, ScientProjectSourceResolution>;

  constructor(
    pins: ReadonlyArray<StoredPin>,
    resolutions: Map<StoredPin, ScientProjectSourceResolution>,
  ) {
    this.slots = [];
    this.resolutions = resolutions;
    for (const stored of pins) this.add(stored);
  }

  private static put(index: Map<string, Set<StoredPin>>, key: string, stored: StoredPin) {
    const entries = index.get(key) ?? new Set<StoredPin>();
    entries.add(stored);
    index.set(key, entries);
  }

  private static drop(index: Map<string, Set<StoredPin>>, key: string, stored: StoredPin) {
    index.get(key)?.delete(stored);
  }

  private target(stored: StoredPin): string | null {
    const resolution = this.resolutions.get(stored);
    return resolution?.kind === "resolved" ? resolution.sourceId : null;
  }

  private index(stored: StoredPin) {
    OrderedPins.put(this.bySourceId, stored.pin.sourceId, stored);
    OrderedPins.put(this.byKey, citationKeyComparisonValue(stored.pin.citationKey), stored);
    const target = this.target(stored);
    if (target !== null) OrderedPins.put(this.byTarget, target, stored);
  }

  private unindex(stored: StoredPin) {
    OrderedPins.drop(this.bySourceId, stored.pin.sourceId, stored);
    OrderedPins.drop(this.byKey, citationKeyComparisonValue(stored.pin.citationKey), stored);
    const target = this.target(stored);
    if (target !== null) OrderedPins.drop(this.byTarget, target, stored);
  }

  private first(candidates: ReadonlyArray<Set<StoredPin> | undefined>): StoredPin | undefined {
    let found: StoredPin | undefined;
    for (const entries of candidates) {
      for (const stored of entries ?? []) {
        if (!found || this.slotOf.get(stored)! < this.slotOf.get(found)!) found = stored;
      }
    }
    return found;
  }

  firstWithSourceId(...sourceIds: ReadonlyArray<string>): StoredPin | undefined {
    return this.first(sourceIds.map((sourceId) => this.bySourceId.get(sourceId)));
  }

  firstResolvedTo(sourceId: string): StoredPin | undefined {
    return this.first([this.byTarget.get(sourceId)]);
  }

  firstWithKey(citationKey: string): StoredPin | undefined {
    return this.first([this.byKey.get(citationKeyComparisonValue(citationKey))]);
  }

  add(stored: StoredPin) {
    this.slotOf.set(stored, this.slots.length);
    this.slots.push(stored);
    this.index(stored);
  }

  /** The same place in the file; a resolution carries over. */
  replace(stored: StoredPin, next: StoredPin) {
    const slot = this.slotOf.get(stored)!;
    this.unindex(stored);
    this.slotOf.delete(stored);
    const resolution = this.resolutions.get(stored);
    if (resolution) this.resolutions.set(next, resolution);
    this.slots[slot] = next;
    this.slotOf.set(next, slot);
    this.index(next);
  }

  remove(stored: StoredPin) {
    this.unindex(stored);
    this.slots[this.slotOf.get(stored)!] = null;
    this.slotOf.delete(stored);
  }

  list(): ReadonlyArray<StoredPin> {
    return this.slots.filter((stored): stored is StoredPin => stored !== null);
  }
}

/** A deliberate rename of a pin's project key; the caller rewrites this project's documents. */
export async function renameScientProjectPinKey(input: {
  readonly projectRoot: string;
  readonly citationKey: string;
  readonly to: string;
}): Promise<
  | { readonly outcome: "renamed" | "unchanged"; readonly pin: ScientProjectPin }
  | { readonly outcome: "not-pinned" | "taken" }
> {
  const root = await projectRootFor(input.projectRoot);
  return withPinsLock(root, async () => {
    const document = await readPinsDocument(root);
    const found = findPin(document.pins, input.citationKey);
    if (!found) return { outcome: "not-pinned" };
    if (found.pin.citationKey === input.to) return { outcome: "unchanged", pin: found.pin };
    const other = findPin(document.pins, input.to);
    if (other && other !== found) return { outcome: "taken" };
    const pin: ScientProjectPin = { ...found.pin, citationKey: input.to };
    await writePinsDocument(
      root,
      document,
      document.pins.map((stored) => (stored === found ? { ...stored, pin } : stored)),
    );
    return { outcome: "renamed", pin };
  });
}

/**
 * Sets or clears the project note on a pin (never the personal note). `base` is the note the writer
 * saw (absent: none); another note writes nothing and answers `stale` with it, for the writer to
 * reconcile. The note history is published before `pins.json`.
 */
export async function setScientProjectPinNote(input: {
  readonly projectRoot: string;
  readonly citationKey: string;
  readonly note: string | null;
  readonly base?: string | null;
  readonly actor: ScientSourceActor;
  /** An editor's autosave session: its saves within ten minutes are one history checkpoint. */
  readonly session?: string;
}): Promise<
  | { readonly outcome: "updated" | "unchanged" | "stale"; readonly pin: ScientProjectPin }
  | { readonly outcome: "not-pinned" }
> {
  const root = await projectRootFor(input.projectRoot);
  return withPinsLock(root, async () => {
    const document = await readPinsDocument(root);
    const found = findPin(document.pins, input.citationKey);
    if (!found) return { outcome: "not-pinned" };
    const note = normalizePinNote(input.note);
    if (note === found.pin.note) return { outcome: "unchanged", pin: found.pin };
    if (!noteBaseMatches(found.pin, input.base)) return { outcome: "stale", pin: found.pin };
    const { note: _previous, ...rest } = found.pin;
    const pin: ScientProjectPin = note === undefined ? rest : { ...rest, note };
    await recordScientProjectNoteChange(
      root,
      noteChange(found.pin, note, input.actor, input.session),
    );
    await writePinsDocument(
      root,
      document,
      document.pins.map((stored) => (stored === found ? { ...stored, pin } : stored)),
    );
    return { outcome: "updated", pin };
  });
}

/** A pin's project-note versions, oldest first, ending with the note it has now (if any). */
export async function readScientProjectPinNoteHistory(input: {
  readonly projectRoot: string;
  readonly citationKey: string;
}): Promise<ReadonlyArray<ScientProjectNoteVersion> | null> {
  const root = await projectRootFor(input.projectRoot);
  const found = findPin((await readPinsDocument(root)).pins, input.citationKey);
  if (!found) return null;
  return scientProjectNoteVersionsWithCurrent(
    await readScientProjectNoteHistory(root, found.pin.sourceId),
    found.pin.note ?? null,
    found.pin.pinnedAt,
    new Date().toISOString(),
  );
}

/**
 * Refreshes each resolvable pin's `work` from its library record, keeping a known value the record
 * lacks unless an edit emptied it. Keys and notes never change. Writes nothing when nothing did.
 */
export async function refreshScientProjectPinSnapshots(input: {
  readonly projectRoot: string;
  readonly library: ScientLibraryLocation;
}): Promise<{ readonly changed: boolean; readonly pins: ReadonlyArray<ScientProjectPin> }> {
  const root = await projectRootFor(input.projectRoot);
  return withPinsLock(root, async () => {
    const document = await readPinsDocument(root);
    const resolutions = await resolvePinsRead(input.library, root, document.pins);
    const records = new Map(
      (await listScientSourceRecords(input.library)).map((record) => [record.sourceId, record]),
    );
    const pins = document.pins.map((stored, index) => {
      const resolution = resolutions[index]!;
      const record = resolution.kind === "resolved" ? records.get(resolution.sourceId) : undefined;
      if (!record) return stored;
      const work = scientPinWorkKeepingUnknown(
        stored.pin.work,
        scientPinWorkFromRecord(withKnownPinCitationValues(record, stored.pin.work)),
        record,
      );
      return { ...stored, pin: { ...stored.pin, work } };
    });
    const changed = await writePinsDocument(root, document, pins);
    return { changed, pins: pins.map(({ pin }) => pin).toSorted(comparePins) };
  });
}

/**
 * Resolves the project's pins against the library. In `write` mode new resolutions are recorded
 * in the instance map and each pin nothing matches gets a library record built from its `work`.
 */
export async function resolveScientProjectPins(input: {
  readonly projectRoot: string;
  readonly library: ScientLibraryLocation;
  readonly mode: "read" | "write";
  readonly actor: ScientSourceActor;
}): Promise<
  ReadonlyArray<{
    readonly pin: ScientProjectPin;
    readonly resolution: ScientProjectSourceResolution;
  }>
> {
  const root = await projectRootFor(input.projectRoot);
  const pins = (await readPinsDocument(root)).pins.map(({ pin }) => pin).toSorted(comparePins);
  const resolutions = await resolveScientProjectSources({
    library: input.library,
    projectRoot: root,
    mode: input.mode,
    sources: pins.map((pin) => ({ projectSourceId: pin.sourceId, work: pin.work })),
    ...(input.mode === "write"
      ? {
          hydrate: {
            actor: input.actor,
            citationKeys: new Map(pins.map((pin) => [pin.sourceId, pin.citationKey])),
          },
        }
      : {}),
  });
  return pins.map((pin, index) => ({ pin, resolution: resolutions[index]! }));
}

/** One cited work for the managed bibliography, under the project's key. */
export interface ScientProjectPinnedWork {
  readonly citationKey: string;
  readonly projectSourceId: string;
  readonly from: "library" | "snapshot";
  /** The library record, or one built from the snapshot; `citationKey` is the project's key. */
  readonly record: ScientSourceRecord;
  readonly projectNote: string | null;
  readonly pinnedAt: string;
  /**
   * The citation comes only from a snapshot written before it held every citation input (the
   * snapshot itself, or a record hydrated from it): an earlier managed entry may be fuller.
   */
  readonly incompleteSnapshot: boolean;
}

function recordFromSnapshot(pin: ScientProjectPin): ScientSourceRecord {
  const { work } = pin;
  return {
    formatVersion: 2,
    sourceId: pin.sourceId,
    revision: 1,
    citationKey: pin.citationKey,
    type: scientSourceTypeFromSnapshot(work.type),
    ...(work.customType ? { customType: work.customType } : {}),
    title: work.title,
    creators: work.creators,
    issuedRaw: work.issuedRaw ?? (work.issuedYear === null ? null : String(work.issuedYear)),
    issuedYear: work.issuedYear,
    identifiers: work.identifiers,
    abstract: null,
    containerTitle: work.containerTitle,
    publisher: work.publisher ?? null,
    volume: work.volume ?? null,
    issue: work.issue ?? null,
    pages: work.pages ?? null,
    language: work.language ?? null,
    url: work.url ?? null,
    tags: work.tags ?? [],
    externalReferences: [],
    attachments: [],
    fieldProvenance: [],
    importedAt: pin.pinnedAt,
  };
}

/**
 * The project's pinned works for its bibliography: the library record when this library has
 * it, the pin's snapshot otherwise (no library at all, as on a collaborator's CI, is allowed).
 * Writes nothing. Personal notes are left out; the project note travels beside the record.
 */
export async function listScientProjectPinnedWorks(input: {
  readonly projectRoot: string;
  readonly library: ScientLibraryLocation | null;
}): Promise<ReadonlyArray<ScientProjectPinnedWork>> {
  const root = await projectRootFor(input.projectRoot);
  const pins = (await readPinsDocument(root)).pins.map(({ pin }) => pin).toSorted(comparePins);
  const library = input.library;
  const resolutions = library
    ? await resolveScientProjectSources({
        library,
        projectRoot: root,
        mode: "read",
        sources: pins.map((pin) => ({ projectSourceId: pin.sourceId, work: pin.work })),
      })
    : [];
  const records = library
    ? new Map((await listScientSourceRecords(library)).map((record) => [record.sourceId, record]))
    : new Map<string, ScientSourceRecord>();
  return pins.map((pin, index) => {
    const resolution = resolutions[index];
    const found = resolution?.kind === "resolved" ? records.get(resolution.sourceId) : undefined;
    const projectNote = pin.note ?? null;
    const incomplete = !scientPinWorkIsComplete(pin.work);
    if (!found) {
      return {
        citationKey: pin.citationKey,
        projectSourceId: pin.sourceId,
        from: "snapshot",
        record: recordFromSnapshot(pin),
        projectNote,
        pinnedAt: pin.pinnedAt,
        incompleteSnapshot: incomplete,
      };
    }
    const { note: _personal, ...record } = withKnownPinCitationValues(found, pin.work);
    return {
      citationKey: pin.citationKey,
      projectSourceId: pin.sourceId,
      from: "library",
      record: { ...record, citationKey: pin.citationKey },
      projectNote,
      pinnedAt: pin.pinnedAt,
      incompleteSnapshot: incomplete && scientRecordOnlyFromProjectFile(found),
    };
  });
}

export interface ScientProjectPinsJoin {
  readonly added: number;
  /** Pins this project had without a note, which took the incoming one. */
  readonly notesAdded: number;
  /** Pins whose own note stays; the incoming note is kept in its note history. */
  readonly notesKept: number;
  /** Incoming keys another source here already used, and the keys they got. */
  readonly renamedKeys: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

/**
 * Joins pins from another copy of a project (a package) into this one: a source pinned here
 * keeps its pin and note, an incoming note it lacks is added, a differing one goes into its note
 * history; a new source keeps its key unless another source here has it. Writes `pins.json` once.
 */
export async function joinScientProjectPins(input: {
  readonly projectRoot: string;
  readonly pins: ReadonlyArray<ScientProjectPin>;
}): Promise<ScientProjectPinsJoin> {
  const root = await projectRootFor(input.projectRoot);
  return withPinsLock(root, async () => {
    const document = await readPinsDocument(root);
    const pins = [...document.pins];
    const taken = new Set(pins.map(({ pin }) => citationKeyComparisonValue(pin.citationKey)));
    let added = 0;
    let notesAdded = 0;
    let notesKept = 0;
    const renamedKeys: Array<{ from: string; to: string }> = [];
    for (const incoming of input.pins) {
      const index = pins.findIndex(({ pin }) => pin.sourceId === incoming.sourceId);
      const existing = index >= 0 ? pins[index]! : undefined;
      if (existing) {
        if (incoming.note === undefined || incoming.note === existing.pin.note) continue;
        if (existing.pin.note === undefined) {
          await recordScientProjectNoteChange(root, {
            ...noteChange(existing.pin, incoming.note, incoming.pinnedBy, undefined),
          });
          pins[index] = { ...existing, pin: { ...existing.pin, note: incoming.note } };
          notesAdded += 1;
        } else {
          await recordScientProjectNoteFromElsewhere(root, {
            sourceId: existing.pin.sourceId,
            pinnedAt: existing.pin.pinnedAt,
            current: existing.pin.note,
            other: incoming.note,
          });
          notesKept += 1;
        }
        continue;
      }
      const clash = taken.has(citationKeyComparisonValue(incoming.citationKey));
      const citationKey = clash
        ? assignCitationKey({
            preferred: incoming.citationKey,
            creators: incoming.work.creators,
            issuedYear: incoming.work.issuedYear,
            title: incoming.work.title,
            taken,
          })
        : incoming.citationKey;
      if (clash) renamedKeys.push({ from: incoming.citationKey, to: citationKey });
      taken.add(citationKeyComparisonValue(citationKey));
      pins.push({ pin: { ...incoming, citationKey }, extra: {}, workExtra: {} });
      added += 1;
    }
    await writePinsDocument(root, document, pins);
    return { added, notesAdded, notesKept, renamedKeys };
  });
}

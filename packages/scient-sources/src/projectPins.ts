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
import type { ScientLibraryLocation } from "./libraryRoot.ts";
import {
  ScientSourceActor,
  ScientSourceCitationKey,
  ScientSourceCreator,
  ScientSourceIdentifier,
  type ScientSourceRecord,
} from "./model.ts";
import {
  listScientSourceRecords,
  readScientSourceRecord,
  scientSourceStoreInternals,
} from "./store.ts";
import { atomicWriteJson, snapshot } from "./storeFiles.ts";

const SCIENT_PROJECT_PINS_PATH = [".scient", "library", "pins.json"] as const;
const MAX_PINS_BYTES = 16 * 1024 * 1024;
const MAX_PIN_NOTE_LENGTH = 100_000;
const NonEmptyString = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());
const NullableText = Schema.NullOr(Schema.String);

/** The pin's metadata snapshot: enough to cite with no library, never an abstract, note or PDF. */
export const ScientPinWork = Schema.Struct({
  // Plain text, so a type a newer Scient adds never hides the whole file.
  type: NonEmptyString,
  title: NullableText,
  creators: Schema.Array(ScientSourceCreator).pipe(Schema.check(Schema.isMaxLength(256))),
  issuedYear: Schema.NullOr(Schema.Int),
  identifiers: Schema.Array(ScientSourceIdentifier).pipe(Schema.check(Schema.isMaxLength(256))),
  containerTitle: NullableText,
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
  const value: unknown = JSON.parse(text);
  const header = decodePinsHeader(value);
  return {
    pins: header.pins.map((raw) => ({
      pin: decodePin(raw),
      extra: extraFields(raw, PIN_FIELDS),
      workExtra: extraFields(isJsonObject(raw) ? raw["work"] : undefined, WORK_FIELDS),
    })),
    extra: extraFields(value, FILE_FIELDS),
    text,
  };
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

function withPinsLock<A>(root: string, run: () => Promise<A>): Promise<A> {
  return scientSourceStoreInternals.withOperationLock(`${root}:pins-write`, run);
}

function scientPinWorkFromRecord(record: ScientSourceRecord): ScientPinWork {
  return {
    type: record.type,
    title: record.title,
    creators: record.creators,
    issuedYear: record.issuedYear,
    identifiers: record.identifiers,
    containerTitle: record.containerTitle,
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
    await writePinsDocument(root, document, [...document.pins, { pin, extra: {}, workExtra: {} }]);
    return { outcome: "pinned", pin };
  });
}

export async function unpinScientLibrarySource(input: {
  readonly projectRoot: string;
  readonly citationKey: string;
}): Promise<
  | { readonly outcome: "unpinned"; readonly pin: ScientProjectPin }
  | { readonly outcome: "not-pinned" }
> {
  const root = await projectRootFor(input.projectRoot);
  return withPinsLock(root, async () => {
    const document = await readPinsDocument(root);
    const found = findPin(document.pins, input.citationKey);
    if (!found) return { outcome: "not-pinned" };
    await writePinsDocument(
      root,
      document,
      document.pins.filter((stored) => stored !== found),
    );
    return { outcome: "unpinned", pin: found.pin };
  });
}

/** Sets or clears the project note on a pin; the library record's personal note is untouched. */
export async function setScientProjectPinNote(input: {
  readonly projectRoot: string;
  readonly citationKey: string;
  readonly note: string | null;
}): Promise<
  | { readonly outcome: "updated" | "unchanged"; readonly pin: ScientProjectPin }
  | { readonly outcome: "not-pinned" }
> {
  const root = await projectRootFor(input.projectRoot);
  return withPinsLock(root, async () => {
    const document = await readPinsDocument(root);
    const found = findPin(document.pins, input.citationKey);
    if (!found) return { outcome: "not-pinned" };
    const note = normalizePinNote(input.note);
    if (note === found.pin.note) return { outcome: "unchanged", pin: found.pin };
    const { note: _previous, ...rest } = found.pin;
    const pin: ScientProjectPin = note === undefined ? rest : { ...rest, note };
    await writePinsDocument(
      root,
      document,
      document.pins.map((stored) => (stored === found ? { ...stored, pin } : stored)),
    );
    return { outcome: "updated", pin };
  });
}

/**
 * Refreshes each resolvable pin's `work` from its library record. Keys and notes never change.
 * Writes nothing when no snapshot changed.
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
      return record
        ? { ...stored, pin: { ...stored.pin, work: scientPinWorkFromRecord(record) } }
        : stored;
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
}

function recordFromSnapshot(pin: ScientProjectPin): ScientSourceRecord {
  const { work } = pin;
  return {
    formatVersion: 2,
    sourceId: pin.sourceId,
    revision: 1,
    citationKey: pin.citationKey,
    type: scientSourceTypeFromSnapshot(work.type),
    title: work.title,
    creators: work.creators,
    issuedRaw: work.issuedYear === null ? null : String(work.issuedYear),
    issuedYear: work.issuedYear,
    identifiers: work.identifiers,
    abstract: null,
    containerTitle: work.containerTitle,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: null,
    tags: [],
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
    if (!found) {
      return {
        citationKey: pin.citationKey,
        projectSourceId: pin.sourceId,
        from: "snapshot",
        record: recordFromSnapshot(pin),
        projectNote,
      };
    }
    const { note: _personal, ...record } = found;
    return {
      citationKey: pin.citationKey,
      projectSourceId: pin.sourceId,
      from: "library",
      record: { ...record, citationKey: pin.citationKey },
      projectNote,
    };
  });
}

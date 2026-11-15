// @effect-diagnostics nodeBuiltinImport:off -- The notice watch keeps one small file in the library.
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { editorialNoticeKind, editorialStatusFromNotices } from "./editorialStatus.ts";
import { withScientLibraryLock } from "./libraryLock.ts";
import type { ScientLibraryLocation } from "./libraryRoot.ts";
import type { ScientSourceEditorialNotice, ScientSourceRecord } from "./model.ts";
import { normalizePersistentIdentifier } from "./normalize.ts";
import { inspectScientLibrarySources, recordScientSourceCheck } from "./store.ts";
import { atomicWriteJson, readBoundedJson, snapshot } from "./storeFiles.ts";

const NOTICE_WATCH_FILE = "notice-watch.json";
const MAX_NOTICE_WATCH_BYTES = 16 * 1024 * 1024;
const NonEmptyString = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());

/** As the registry names the same notices, so a refresh that finds one changes nothing. */
const RETRACTION_WATCH = "retraction-watch";

/** The kinds the Retraction Watch file can say; a withdrawal is only ever the publisher's. */
const WatchedKind = Schema.Literals(["retraction", "expression-of-concern", "correction"]);
type WatchedKind = typeof WatchedKind.Type;

/** A notice the weekly check put on a source or took off it, and whether the person dismissed it. */
const ScientLibraryNoticeChange = Schema.Struct({
  sourceId: NonEmptyString,
  kind: WatchedKind,
  change: Schema.Literals(["added", "withdrawn"]),
  at: NonEmptyString,
  dismissed: Schema.optionalKey(Schema.Literal(true)),
});
type ScientLibraryNoticeChange = typeof ScientLibraryNoticeChange.Type;

const NoticeWatchFile = Schema.Struct({
  formatVersion: Schema.Literal(1),
  /** The last check that read the whole file, or learned it had not changed. */
  checkedAt: NonEmptyString,
  etag: Schema.optionalKey(NonEmptyString),
  /** One per source and kind: the last thing the check did there. */
  changes: Schema.Array(ScientLibraryNoticeChange),
});
type NoticeWatchFile = typeof NoticeWatchFile.Type;

/** What the last check left; a file that cannot be read counts as none, and the check starts over. */
export async function readScientLibraryNoticeWatch(
  library: ScientLibraryLocation,
): Promise<NoticeWatchFile | null> {
  const filePath = NodePath.join(library.root, NOTICE_WATCH_FILE);
  if ((await snapshot(filePath)) !== "file") return null;
  return readBoundedJson(filePath, MAX_NOTICE_WATCH_BYTES, NoticeWatchFile).catch(() => null);
}

function watchedIdentifiers(record: ScientSourceRecord): ReadonlyArray<string> {
  return record.identifiers.flatMap((identifier) => {
    const scheme = identifier.scheme.trim().toLowerCase();
    return scheme === "doi" || scheme === "pmid"
      ? [normalizePersistentIdentifier(scheme, identifier.value)]
      : [];
  });
}

/** The DOIs and PMIDs of the Library's sources, as the keys the file's rows are matched by. */
export async function scientLibraryWatchedIdentifiers(
  library: ScientLibraryLocation,
): Promise<ReadonlySet<string>> {
  const { records } = await inspectScientLibrarySources(library);
  return new Set(records.flatMap(watchedIdentifiers));
}

/** The fields of one CSV row; quotes inside a quoted field are doubled. */
function csvFields(row: string): ReadonlyArray<string> {
  const fields: string[] = [];
  let index = 0;
  while (index <= row.length) {
    if (row[index] === '"') {
      let end = index + 1;
      while (end < row.length && (row[end] !== '"' || row[end + 1] === '"')) {
        end += row[end] === '"' ? 2 : 1;
      }
      fields.push(row.slice(index + 1, end).replaceAll('""', '"'));
      index = end + 2;
    } else {
      const end = row.indexOf(",", index);
      fields.push(row.slice(index, end === -1 ? row.length : end));
      index = (end === -1 ? row.length : end) + 1;
    }
  }
  return fields;
}

const COLUMNS = [
  "RetractionDate",
  "RetractionDOI",
  "OriginalPaperDOI",
  "OriginalPaperPubMedID",
  "RetractionNature",
] as const;

/** The file writes dates as month/day/year with a time of day. */
function isoDate(value: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/u.exec(value.trim());
  return match ? `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}` : null;
}

/** What the file says about the papers asked for, by DOI or PMID key. */
export interface RetractionWatchNotices {
  /** Each paper asked for, with its notices; empty when the file has no notice for it. */
  readonly notices: ReadonlyMap<string, ReadonlyArray<ScientSourceEditorialNotice>>;
  /** The papers asked for that the file lists as reinstated. */
  readonly reinstated: ReadonlySet<string>;
}

/**
 * Reads the Retraction Watch file as it arrives and keeps the notices of the wanted papers, by
 * DOI or PMID key. The file counts only whole: `end` throws unless the first row names the
 * columns used and every row is as wide as the first, so a cut file is never read as withdrawals.
 */
export function retractionWatchReader(wanted: ReadonlySet<string>): {
  readonly push: (text: string) => void;
  readonly end: () => RetractionWatchNotices;
} {
  const found = new Map<string, ScientSourceEditorialNotice[]>([...wanted].map((key) => [key, []]));
  const reinstated = new Set<string>();
  let pending = "";
  let quoted = false;
  let width = 0;
  let columns: Readonly<Record<(typeof COLUMNS)[number], number>> | null = null;

  const takeRow = (text: string) => {
    const row = text.endsWith("\r") ? text.slice(0, -1) : text;
    const fields = csvFields(row);
    if (!columns) {
      const header = fields.map((name) => name.replace(/^﻿/u, "").trim());
      const at = (name: (typeof COLUMNS)[number]) => {
        const index = header.indexOf(name);
        if (index === -1) throw new Error(`The Retraction Watch file has no ${name} column.`);
        return index;
      };
      columns = {
        RetractionDate: at("RetractionDate"),
        RetractionDOI: at("RetractionDOI"),
        OriginalPaperDOI: at("OriginalPaperDOI"),
        OriginalPaperPubMedID: at("OriginalPaperPubMedID"),
        RetractionNature: at("RetractionNature"),
      };
      width = fields.length;
      return;
    }
    if (fields.length !== width) throw new Error("The Retraction Watch file has a cut row.");
    const nature = fields[columns.RetractionNature]!;
    const kind = editorialNoticeKind(nature);
    const reinstatement = nature.trim().toLowerCase() === "reinstatement";
    if (!kind && !reinstatement) return;
    const doi = fields[columns.OriginalPaperDOI]!.trim();
    const pmid = fields[columns.OriginalPaperPubMedID]!.trim();
    const keys = [
      ...(doi.startsWith("10.") ? [normalizePersistentIdentifier("doi", doi)] : []),
      ...(/^[1-9]\d*$/u.test(pmid) ? [normalizePersistentIdentifier("pmid", pmid)] : []),
    ].filter((key) => found.has(key));
    if (keys.length === 0) return;
    if (!kind) {
      for (const key of keys) reinstated.add(key);
      return;
    }
    const noticeDoi = fields[columns.RetractionDOI]!.trim().toLowerCase();
    const date = isoDate(fields[columns.RetractionDate]!);
    const notice: ScientSourceEditorialNotice = {
      kind,
      ...(noticeDoi.startsWith("10.") ? { doi: noticeDoi } : {}),
      ...(date ? { date } : {}),
      source: RETRACTION_WATCH,
    };
    for (const key of keys) found.get(key)?.push(notice);
  };

  return {
    push(text) {
      const buffer = pending + text;
      let start = 0;
      for (let index = pending.length; index < buffer.length; index += 1) {
        const code = buffer.charCodeAt(index);
        if (code === 34) quoted = !quoted;
        else if (code === 10 && !quoted) {
          takeRow(buffer.slice(start, index));
          start = index + 1;
        }
      }
      pending = buffer.slice(start);
    },
    end() {
      if (quoted) throw new Error("The Retraction Watch file ends inside a field.");
      if (pending.trim()) takeRow(pending);
      pending = "";
      if (!columns) throw new Error("The Retraction Watch file is empty.");
      return { notices: found, reinstated };
    },
  };
}

const changeKey = (change: Pick<ScientLibraryNoticeChange, "sourceId" | "kind">) =>
  `${change.sourceId}\0${change.kind}`;

async function writeNoticeWatch(library: ScientLibraryLocation, file: NoticeWatchFile) {
  await atomicWriteJson(
    NodePath.join(library.root, NOTICE_WATCH_FILE),
    file,
    MAX_NOTICE_WATCH_BYTES,
  );
}

/**
 * Brings the Library's sources in line with the Retraction Watch file, compared by kind: a kind
 * the file has is added; only a reinstatement takes Retraction Watch's retraction off, since a
 * missing row is no evidence. `found` is null when the file has not changed since the last check.
 */
export async function recordScientLibraryNoticeCheck(input: {
  readonly library: ScientLibraryLocation;
  readonly found: RetractionWatchNotices | null;
  readonly etag: string | null;
  readonly checkedAt: string;
}): Promise<{ readonly changedSources: number }> {
  const { records } = input.found
    ? await inspectScientLibrarySources(input.library)
    : { records: null };
  const made: Array<Pick<ScientLibraryNoticeChange, "sourceId" | "kind" | "change">> = [];
  let changedSources = 0;
  for (const record of records ?? []) {
    const keys = watchedIdentifiers(record);
    // A source added or re-identified while the file was read was not asked about: next check.
    if (keys.length === 0 || keys.some((key) => !input.found?.notices.has(key))) continue;
    const listed = keys.flatMap((key) => input.found?.notices.get(key) ?? []);
    const current = record.editorialStatus?.notices ?? [];
    const listedKinds = new Set(listed.map((notice) => notice.kind));
    const currentKinds = new Set(current.map((notice) => notice.kind));
    const added = listed.filter((notice) => !currentKinds.has(notice.kind));
    const reinstated =
      keys.some((key) => input.found?.reinstated.has(key)) && !listedKinds.has("retraction");
    const kept = current.filter(
      (notice) =>
        !(reinstated && notice.source === RETRACTION_WATCH && notice.kind === "retraction"),
    );
    if (added.length === 0 && kept.length === current.length) continue;
    const keptKinds = new Set(kept.map((notice) => notice.kind));
    // A source someone edited meanwhile answers "stale" and is matched by the next check.
    const written = await recordScientSourceCheck({
      root: input.library,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      ...(record.verification ? { verification: record.verification } : {}),
      editorialStatus: editorialStatusFromNotices([...kept, ...added], input.checkedAt),
      actor: "user",
    });
    if (written.outcome !== "updated") continue;
    changedSources += 1;
    for (const kind of WatchedKind.literals) {
      if (added.some((notice) => notice.kind === kind)) {
        made.push({ sourceId: record.sourceId, kind, change: "added" });
      } else if (currentKinds.has(kind) && !keptKinds.has(kind)) {
        made.push({ sourceId: record.sourceId, kind, change: "withdrawn" });
      }
    }
  }
  await withScientLibraryLock(input.library.root, async () => {
    const previous = await readScientLibraryNoticeWatch(input.library);
    const live = records ? new Set(records.map((record) => record.sourceId)) : null;
    const changes = new Map(
      (previous?.changes ?? [])
        .filter((change) => live?.has(change.sourceId) ?? true)
        .map((change) => [changeKey(change), change]),
    );
    for (const change of made) {
      // Put back after a refresh took it off: the source is corrected, the person is not told twice.
      if (changes.get(changeKey(change))?.change === change.change) continue;
      changes.set(changeKey(change), { ...change, at: input.checkedAt });
    }
    const etag = input.found ? input.etag : previous?.etag;
    await writeNoticeWatch(input.library, {
      formatVersion: 1,
      checkedAt: input.checkedAt,
      ...(etag ? { etag } : {}),
      changes: [...changes.values()],
    });
  });
  return { changedSources };
}

/** The changes the person has not dismissed, for the line above the Library list. */
export async function listScientLibraryNoticeChanges(
  library: ScientLibraryLocation,
): Promise<ReadonlyArray<Pick<ScientLibraryNoticeChange, "sourceId" | "kind" | "change">>> {
  const watch = await readScientLibraryNoticeWatch(library);
  return (watch?.changes ?? []).flatMap((change) =>
    change.dismissed
      ? []
      : [{ sourceId: change.sourceId, kind: change.kind, change: change.change }],
  );
}

/** Marks every listed change as seen; the sources keep their notices. */
export async function dismissScientLibraryNoticeChanges(
  library: ScientLibraryLocation,
): Promise<"dismissed" | "nothing-to-dismiss"> {
  return withScientLibraryLock(library.root, async () => {
    const watch = await readScientLibraryNoticeWatch(library);
    if (!watch || watch.changes.every((change) => change.dismissed)) return "nothing-to-dismiss";
    await writeNoticeWatch(library, {
      ...watch,
      changes: watch.changes.map((change) => ({ ...change, dismissed: true as const })),
    });
    return "dismissed";
  });
}

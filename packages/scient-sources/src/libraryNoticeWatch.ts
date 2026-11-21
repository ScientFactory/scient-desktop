// @effect-diagnostics nodeBuiltinImport:off -- The notice watch keeps one small file in the library.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { editorialNoticeKind, editorialStatusFromNotices } from "./editorialStatus.ts";
import { withScientLibraryLock } from "./libraryLock.ts";
import type { ScientLibraryLocation } from "./libraryRoot.ts";
import { ScientSourceEditorialNotice, type ScientSourceRecord } from "./model.ts";
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

/**
 * A notice the weekly check put on a source or took off it, and whether the person dismissed it.
 * `added` also when the file confirms a notice the source already had: the check keeps it then.
 */
const MatchedWatchNotice = Schema.Struct({
  notice: ScientSourceEditorialNotice,
  identifiers: Schema.Array(NonEmptyString),
});
type MatchedWatchNotice = typeof MatchedWatchNotice.Type;

const ScientLibraryNoticeChange = Schema.Struct({
  sourceId: NonEmptyString,
  kind: WatchedKind,
  change: Schema.Literals(["added", "withdrawn"]),
  at: NonEmptyString,
  dismissed: Schema.optionalKey(Schema.Literal(true)),
  /** Each file notice of this kind paired with the normalized identifiers that matched it. */
  matched: Schema.optionalKey(Schema.Array(MatchedWatchNotice)),
  /** Legacy v2 fields kept readable until the first v3 pass rewrites them as `matched`. */
  notices: Schema.optionalKey(Schema.Array(ScientSourceEditorialNotice)),
  identifiers: Schema.optionalKey(Schema.Array(NonEmptyString)),
});
type ScientLibraryNoticeChange = typeof ScientLibraryNoticeChange.Type;
type NoticeChangeMade = Omit<ScientLibraryNoticeChange, "at">;

const NoticeWatchFile = Schema.Struct({
  formatVersion: Schema.Literal(1),
  /** The last check that read the whole file, or learned it had not changed. */
  checkedAt: NonEmptyString,
  etag: Schema.optionalKey(NonEmptyString),
  /** The papers the last whole read matched, as `scientLibraryNoticeCoverage` names them. */
  covered: Schema.optionalKey(NonEmptyString),
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

/**
 * Names a set of watched papers. An unchanged file says nothing of a paper the last whole read
 * did not match, so the check asks for the file again whenever the set differs.
 */
/** Bumped when ownership rules change so an upgraded Library runs one full pass to backfill. */
const COVERAGE_VERSION = "v3";

export function scientLibraryNoticeCoverage(keys: Iterable<string>): string {
  return NodeCrypto.createHash("sha256")
    .update(`${COVERAGE_VERSION}\0${[...keys].toSorted().join("\n")}`)
    .digest("hex");
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
  const made: NoticeChangeMade[] = [];
  let changedSources = 0;
  let missed = false;
  // One locked change for the records read, the notices written and who keeps them.
  await withScientLibraryLock(input.library.root, async () => {
    const previous = await readScientLibraryNoticeWatch(input.library);
    const previousByKey = new Map(
      (previous?.changes ?? []).map((change) => [changeKey(change), change]),
    );
    const { records } = input.found
      ? await inspectScientLibrarySources(input.library)
      : { records: null };
    const currentIdentifiers = new Map<string, ReadonlySet<string>>();
    for (const record of records ?? []) {
      const keys = watchedIdentifiers(record);
      const keySet = new Set(keys);
      currentIdentifiers.set(record.sourceId, keySet);
      // A source added or re-identified while the file was read was not asked about: next check.
      if (keys.length === 0 || keys.some((key) => !input.found?.notices.has(key))) continue;
      // Group matched notices per kind with every identifier on this record that matched each row.
      const matchedByKind = new Map<WatchedKind, ReadonlyArray<MatchedWatchNotice>>();
      const listed: ScientSourceEditorialNotice[] = [];
      for (const kind of WatchedKind.literals) {
        const byNotice = new Map<
          string,
          { readonly notice: ScientSourceEditorialNotice; readonly identifiers: Set<string> }
        >();
        for (const key of keys) {
          for (const notice of input.found?.notices.get(key) ?? []) {
            if (notice.kind !== kind) continue;
            const nk = noticeIdentity(notice);
            const existing = byNotice.get(nk);
            if (existing) {
              existing.identifiers.add(key);
            } else {
              byNotice.set(nk, { notice, identifiers: new Set([key]) });
            }
          }
        }
        const entries = [...byNotice.values()].map(({ notice, identifiers }) => ({
          notice,
          identifiers: [...identifiers].toSorted(),
        }));
        matchedByKind.set(kind, entries);
        for (const entry of entries) listed.push(entry.notice);
      }
      const listedKeys = new Set(listed.map(noticeIdentity));
      const staleOwnedKeys = new Set(
        WatchedKind.literals.flatMap((kind) => {
          const prior = previousByKey.get(changeKey({ sourceId: record.sourceId, kind }));
          if (prior?.change !== "added") return [];
          if (prior.matched) {
            return prior.matched
              .filter((entry) => !entry.identifiers.some((id) => keySet.has(id)))
              .map((entry) => noticeIdentity(entry.notice));
          }
          if (
            prior.notices &&
            prior.identifiers &&
            !prior.identifiers.some((id) => keySet.has(id))
          ) {
            return prior.notices.map(noticeIdentity);
          }
          return [];
        }),
      );
      const current = record.editorialStatus?.notices ?? [];
      const listedKinds = new Set(listed.map((notice) => notice.kind));
      const currentKinds = new Set(current.map((notice) => notice.kind));
      const reinstated =
        keys.some((key) => input.found?.reinstated.has(key)) && !listedKinds.has("retraction");
      const kept = current.filter((notice) => {
        if (notice.source !== RETRACTION_WATCH) return true;
        if (reinstated && notice.kind === "retraction") return false;
        const nk = noticeIdentity(notice);
        if (staleOwnedKeys.has(nk) && !listedKeys.has(nk)) return false;
        return true;
      });
      const keptKinds = new Set(kept.map((notice) => notice.kind));
      const added = listed.filter((notice) => !keptKinds.has(notice.kind));
      const changes = WatchedKind.literals.flatMap(
        (kind): ReadonlyArray<Omit<NoticeChangeMade, "sourceId">> => {
          const matched = matchedByKind.get(kind) ?? [];
          if (added.some((notice) => notice.kind === kind)) {
            return [{ kind, change: "added", matched }];
          }
          if (currentKinds.has(kind) && !keptKinds.has(kind))
            return [{ kind, change: "withdrawn" }];
          // Not listed: the source shows the same as before.
          if (kind === "retraction" && reinstated) {
            return [{ kind, change: "withdrawn", dismissed: true }];
          }
          return matched.length > 0 ? [{ kind, change: "added", dismissed: true, matched }] : [];
        },
      );
      if (added.length > 0 || kept.length < current.length) {
        // A source someone edited meanwhile answers "stale" and is matched by the next check.
        const written = await recordScientSourceCheck({
          root: input.library,
          sourceId: record.sourceId,
          expectedRevision: record.revision,
          ...(record.verification ? { verification: record.verification } : {}),
          editorialStatus: editorialStatusFromNotices([...kept, ...added], input.checkedAt),
          actor: "user",
        });
        if (written.outcome !== "updated") {
          missed = true;
          continue;
        }
        changedSources += 1;
      }
      made.push(...changes.map((change) => ({ sourceId: record.sourceId, ...change })));
    }
    const live = records ? new Set(records.map((record) => record.sourceId)) : null;
    const changes = new Map<string, ScientLibraryNoticeChange>();
    for (const change of previous?.changes ?? []) {
      if (live && !live.has(change.sourceId)) continue;
      if (change.change === "added") {
        const ids = currentIdentifiers.get(change.sourceId);
        if (ids && change.matched) {
          const surviving = change.matched.flatMap((entry) => {
            const matchedIds = entry.identifiers.filter((id) => ids.has(id));
            return matchedIds.length > 0 ? [{ ...entry, identifiers: matchedIds }] : [];
          });
          if (surviving.length === 0) continue;
          changes.set(changeKey(change), { ...change, matched: surviving });
          continue;
        }
        if (ids && !change.matched && change.identifiers) {
          if (!change.identifiers.some((id) => ids.has(id))) continue;
        }
      }
      changes.set(changeKey(change), change);
    }
    for (const change of made) {
      const before = changes.get(changeKey(change));
      // Put back after a refresh took it off: the source is corrected, the person is not told twice.
      // Same-direction entries keep prior still-owned matches across partial feeds and drop v2 keys.
      if (before?.change === change.change) {
        if (change.matched) {
          const merged = new Map<string, MatchedWatchNotice>();
          for (const entry of before.matched ?? []) {
            merged.set(noticeIdentity(entry.notice), entry);
          }
          for (const entry of change.matched) {
            merged.set(noticeIdentity(entry.notice), entry);
          }
          const { notices: _legacyNotices, identifiers: _legacyIds, ...rest } = before;
          changes.set(changeKey(change), { ...rest, matched: [...merged.values()] });
        }
        continue;
      }
      if (change.dismissed && change.change === "withdrawn" && !before) continue;
      changes.set(changeKey(change), { ...change, at: input.checkedAt });
    }
    const etag = input.found ? input.etag : previous?.etag;
    // A source that did not take its notices: the next check reads the whole file again.
    const covered = !input.found
      ? previous?.covered
      : missed
        ? undefined
        : scientLibraryNoticeCoverage(input.found.notices.keys());
    await writeNoticeWatch(input.library, {
      formatVersion: 1,
      checkedAt: input.checkedAt,
      ...(etag ? { etag } : {}),
      ...(covered ? { covered } : {}),
      changes: [...changes.values()],
    });
  });
  return { changedSources };
}

function noticeIdentity(notice: ScientSourceEditorialNotice): string {
  return JSON.stringify([
    notice.kind,
    notice.doi ?? null,
    notice.date ?? null,
    notice.source ?? null,
  ]);
}

/**
 * Runs a registry check's write with the notices the weekly check keeps on the source, read under
 * the lock that check publishes them under. A registry check that does not report one keeps it:
 * only a reinstatement in the file takes one off.
 */
export function withScientLibraryWatchNotices<A>(
  library: ScientLibraryLocation,
  record: ScientSourceRecord,
  write: (notices: ReadonlyArray<ScientSourceEditorialNotice>) => Promise<A>,
): Promise<A> {
  return withScientLibraryLock(library.root, async () => {
    const watch = await readScientLibraryNoticeWatch(library);
    const currentIds = new Set(watchedIdentifiers(record));
    const held = (record.editorialStatus?.notices ?? []).filter(
      (notice) => notice.source === RETRACTION_WATCH,
    );
    return write(
      (watch?.changes ?? []).flatMap((change) => {
        if (change.sourceId !== record.sourceId || change.change !== "added") return [];
        if (change.matched) {
          const allowed = change.matched
            .filter((entry) => entry.identifiers.some((id) => currentIds.has(id)))
            .map((entry) => entry.notice);
          if (allowed.length === 0) return [];
          const allowedKeys = new Set(allowed.map(noticeIdentity));
          const matchingHeld = held.filter(
            (notice) => notice.kind === change.kind && allowedKeys.has(noticeIdentity(notice)),
          );
          const matchingHeldKeys = new Set(matchingHeld.map(noticeIdentity));
          return [
            ...matchingHeld,
            ...allowed.filter((notice) => !matchingHeldKeys.has(noticeIdentity(notice))),
          ];
        }
        if (change.notices) {
          if (change.identifiers && !change.identifiers.some((id) => currentIds.has(id))) {
            return [];
          }
          const matchingHeld = held.filter((notice) => notice.kind === change.kind);
          return matchingHeld.length > 0 ? matchingHeld : change.notices;
        }
        return held.filter((notice) => notice.kind === change.kind);
      }),
    );
  });
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

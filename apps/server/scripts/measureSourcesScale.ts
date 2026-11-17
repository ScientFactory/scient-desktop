// @effect-diagnostics nodeBuiltinImport:off -- A measurement script over real library folders.
// @effect-diagnostics globalDate:off globalTimers:off globalConsole:off -- It times with the wall clock.
/**
 * The Sources scale gate: writes the seeded test Library, then times each gate line in a fresh
 * Node process through the Library route functions, with peak memory and event-loop delay.
 *   node scripts/measureSourcesScale.ts --out <folder> [--rounds 3] [--records 20000] [--only a,b]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeProcess from "node:process";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { readScientProjectIdentity } from "@scientfactory/project-init";
import {
  ScientSourcesDuplicatesResult,
  ScientSourcesOverviewResult,
  ScientSystematicReviewResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { mergeScientLibraryDuplicates } from "@scientfactory/scient-sources/library-merge";
import {
  readScientLibraryMoveState,
  runScientLibraryMove,
} from "@scientfactory/scient-sources/library-move";
import { withScientLibraryLock } from "@scientfactory/scient-sources/library-lock";
import { warmScientLibraryRecordIndex } from "@scientfactory/scient-sources/store";
import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";

import {
  buildScaleLibrary,
  buildScaleMoveProject,
} from "../../../packages/scient-sources/scripts/scaleLibrary.ts";
import {
  filterScientSourceSearchIndex,
  indexScientSourceSummaries,
  sortScientSourceRecords,
  type ScientSourceSort,
} from "../../web/src/scient/sources/filterSources.ts";
import {
  bulkUpdateLibrarySources,
  libraryDuplicates,
  libraryOverview,
  libraryReview,
  libraryReviews,
  organizeLibrarySources,
} from "../src/scient/sources/LibrarySourcesRoutes.ts";
import { LIBRARY_WARM_MINIMUM_RECORDS } from "../src/scient/sources/LibraryIndexWarm.ts";
import type { ScientSourcesLibraryStore } from "../src/scient/sources/SourcesBackend.ts";

const SCRIPT = NodeURL.fileURLToPath(import.meta.url);
const PART = 100;
const PIN_CHANGES_PER_REQUEST = 2_000;
const WARM = 5;
const DELAY_RESOLUTION_MS = 10;
/** `start-during-warming` opens the list this long after the start-up warming begins. */
const OPEN_DURING_WARMING_MS = 250;

const LIBRARY_MEASURES = [
  "overview-library",
  "overview-project",
  "filters",
  "duplicates",
  "review",
  "merge-pass",
  "bulk-tag",
  "bulk-type",
  "change-pins",
  "start-cold",
  "start-warmed",
  "start-during-warming",
] as const;
const MOVE_MEASURES = ["move", "move-interrupt"] as const;
type Measure = (typeof LIBRARY_MEASURES)[number] | (typeof MOVE_MEASURES)[number];

interface Meta {
  readonly stateDir: string;
  readonly projects: { readonly thesis: string; readonly grant: string; readonly paper: string };
  readonly reviewId: string;
  readonly sourceIds: ReadonlyArray<string>;
  readonly pinned: {
    readonly thesis: ReadonlyArray<string>;
    readonly grant: ReadonlyArray<string>;
    readonly paper: ReadonlyArray<string>;
  };
  readonly collectionIds: ReadonlyArray<string>;
  readonly moveProject: string | null;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const mib = (bytes: number) => round2(bytes / 2 ** 20);
const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
};

function machine() {
  const cpus = NodeOS.cpus();
  return {
    platform: NodeProcess.platform,
    arch: NodeProcess.arch,
    os: `${NodeOS.type()} ${NodeOS.release()}`,
    cpu: cpus[0]?.model.trim() ?? "unknown",
    cores: cpus.length,
    ramGiB: Math.round(NodeOS.totalmem() / 2 ** 30),
    node: NodeProcess.version,
    // Windows has no load average.
    loadAverage:
      NodeProcess.platform === "win32" ? null : NodeOS.loadavg().map((value) => round2(value)),
  };
}

const time = async <A>(run: () => Promise<A>): Promise<{ ms: number; value: A }> => {
  const started = performance.now();
  const value = await run();
  return { ms: round2(performance.now() - started), value };
};

/** First call, then `WARM` more: the first is cold for the process (an OS file cache may be warm). */
async function coldWarm<A>(run: () => Promise<A>, warm = WARM) {
  const first = await time(run);
  const rest: number[] = [];
  for (let index = 0; index < warm; index += 1) rest.push((await time(run)).ms);
  return {
    first,
    summary: { coldMs: first.ms, warmMedianMs: median(rest), warmMaxMs: Math.max(...rest) },
  };
}

/** The answer on the wire: the server encodes it with its schema, the client parses and decodes it. */
function wireSize(value: unknown, schema?: Schema.Codec<unknown, unknown>) {
  const encodeStarted = performance.now();
  const encoded = schema ? Schema.encodeUnknownSync(schema)(value) : value;
  const encodeMs = round2(performance.now() - encodeStarted);
  const started = performance.now();
  const text = JSON.stringify(encoded);
  const stringifyMs = round2(performance.now() - started);
  const parseStarted = performance.now();
  const parsed: unknown = JSON.parse(text);
  const parseMs = round2(performance.now() - parseStarted);
  const decodeStarted = performance.now();
  if (schema) Schema.decodeUnknownSync(schema)(parsed);
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    ...(schema ? { encodeMs } : {}),
    stringifyMs,
    parseMs,
    ...(schema ? { decodeMs: round2(performance.now() - decodeStarted) } : {}),
  };
}

const wireMs = (wire: ReturnType<typeof wireSize>) =>
  (wire.encodeMs ?? 0) + wire.stringifyMs + wire.parseMs + (wire.decodeMs ?? 0);

/** Heap still in use once garbage is collected; the child runs with `--expose-gc`. */
function heapAfterCollection(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return NodeProcess.memoryUsage().heapUsed;
}

async function libraryStore(
  stateDir: string,
  projectRoot: string,
  access: "read" | "write",
): Promise<ScientSourcesLibraryStore> {
  const root = await NodeFSP.realpath(projectRoot);
  const library = scientLibraryLocation(scientLibraryRootFor(stateDir));
  const { projectId } = await readScientProjectIdentity(root);
  // What `resolveScientSourcesStoreFor` returns for a project already in the Library.
  return { kind: "library", projectId, root, library, store: library, access, exists: true };
}

/** Times each part of 100 through the bulk route, then its Undo newest first. */
async function bulkInParts(
  store: ScientSourcesLibraryStore,
  sourceIds: ReadonlyArray<string>,
  change: { readonly addTags: ReadonlyArray<string> } | { readonly type: "report" },
) {
  const edit: number[] = [];
  const batchIds: string[] = [];
  const outcomes = new Map<string, number>();
  const started = performance.now();
  for (let start = 0; start < sourceIds.length; start += PART) {
    const part = await time(() =>
      bulkUpdateLibrarySources(store, {
        change: { sourceIds: sourceIds.slice(start, start + PART), ...change },
      }),
    );
    edit.push(part.ms);
    if (part.value.undo) batchIds.push(part.value.undo.batchId);
    for (const entry of part.value.sources) {
      outcomes.set(entry.outcome, (outcomes.get(entry.outcome) ?? 0) + 1);
    }
  }
  const editMs = round2(performance.now() - started);
  const undo: number[] = [];
  const undoStarted = performance.now();
  for (const batchId of batchIds.toReversed()) {
    undo.push(
      (await time(() => bulkUpdateLibrarySources(store, { change: { undoBatchId: batchId } }))).ms,
    );
  }
  const undoMs = round2(performance.now() - undoStarted);
  return {
    selected: sourceIds.length,
    part: PART,
    outcomes: Object.fromEntries(outcomes),
    edit: {
      totalMs: editMs,
      firstProgressMs: edit[0],
      perSourceMs: round2(editMs / sourceIds.length),
      partMedianMs: median(edit),
      partMaxMs: Math.max(...edit),
    },
    undo: {
      totalMs: undoMs,
      firstProgressMs: undo[0],
      perSourceMs: round2(undoMs / sourceIds.length),
      partMedianMs: median(undo),
      partMaxMs: Math.max(...undo),
    },
  };
}

type ScientPinChangeRequest =
  | { readonly action: "pin"; readonly sourceId: string }
  | { readonly action: "unpin"; readonly citationKey: string };

const pinnedKeys = (result: Awaited<ReturnType<typeof organizeLibrarySources>>) =>
  ("pinChanges" in result ? (result.pinChanges ?? []) : []).flatMap((entry) =>
    entry.outcome === "pinned" && entry.pin ? [entry.pin.citationKey] : [],
  );

async function runLibraryMeasure(measure: Measure, meta: Meta): Promise<Record<string, unknown>> {
  const read = (projectRoot: string) => libraryStore(meta.stateDir, projectRoot, "read");
  const write = (projectRoot: string) => libraryStore(meta.stateDir, projectRoot, "write");
  switch (measure) {
    case "overview-library":
    case "overview-project": {
      const scope = measure === "overview-library" ? "library" : "project";
      const store = await read(meta.projects.thesis);
      // `background: false`: the panel's request also starts indexing and categorization.
      const listed = await coldWarm(() => libraryOverview(store, { scope, background: false }));
      const filtered = await coldWarm(() =>
        libraryOverview(store, { scope, background: false, readingStatus: "read" }),
      );
      return {
        scope,
        rows: listed.first.value.records.length,
        list: { ...listed.summary, ...wireSize(listed.first.value, ScientSourcesOverviewResult) },
        serverReadingFilter: {
          ...filtered.summary,
          rows: filtered.first.value.records.length,
          ...wireSize(filtered.first.value, ScientSourcesOverviewResult),
        },
      };
    }
    case "filters": {
      const store = await read(meta.projects.thesis);
      const overview = await libraryOverview(store, { scope: "library", background: false });
      const organization = overview.organization ?? { collections: [] };
      const index = await coldWarm(async () => indexScientSourceSummaries(overview.records));
      const entries = index.first.value;
      // The largest top-level collection, with its subcollections.
      const parents = organization.collections.filter(
        (collection) => !("parentCollectionId" in collection) || !collection.parentCollectionId,
      );
      const collection = parents.toSorted((a, b) => b.sourceIds.length - a.sourceIds.length)[0];
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly query?: string;
        readonly filter?: Parameters<typeof filterScientSourceSearchIndex>[2];
        readonly reading?: "read";
        readonly sort?: ScientSourceSort;
      }> = [
        { name: "none (sort only)" },
        { name: "text one term", query: "sepsis" },
        { name: "text three terms", query: "early fluid therapy" },
        { name: "text DOI prefix", query: "10.1" },
        { name: "tag", filter: { tags: ["learning"] } },
        {
          name: "collection with subcollections",
          filter: { collectionId: collection!.collectionId },
        },
        { name: "type", filter: { type: "preprint" } },
        { name: "has PDF", filter: { hasPdf: true } },
        { name: "reading state", reading: "read" },
        { name: "sort by year", sort: "publication-year" },
        { name: "sort by title", sort: "title" },
        { name: "sort by author", sort: "author" },
        {
          name: "tag + text + type",
          query: "trial",
          filter: { tags: ["learning"], type: "article" },
        },
      ];
      const results: Record<string, unknown> = {};
      for (const entry of cases) {
        const run = await coldWarm(async () =>
          sortScientSourceRecords(
            filterScientSourceSearchIndex(
              entries,
              entry.query ?? "",
              entry.filter,
              organization,
            ).filter(
              (record) => entry.reading === undefined || record.readingStatus === entry.reading,
            ),
            entry.sort ?? "last-added",
          ),
        );
        results[entry.name] = { ...run.summary, rows: run.first.value.length };
      }
      return {
        rows: overview.records.length,
        collection: { members: collection!.sourceIds.length },
        searchIndex: index.summary,
        filterAndSort: results,
      };
    }
    case "duplicates": {
      const store = await read(meta.projects.thesis);
      const run = await coldWarm(() => libraryDuplicates(store));
      return {
        checkouts: 3,
        pairs: run.first.value.pairs.length,
        pairsTotal: run.first.value.pairsTotal,
        merges: run.first.value.merges.length,
        mergesTotal: run.first.value.mergesTotal,
        read: { ...run.summary, ...wireSize(run.first.value, ScientSourcesDuplicatesResult) },
      };
    }
    case "review": {
      const store = await read(meta.projects.thesis);
      const list = await coldWarm(() => libraryReviews(store), 3);
      const open = await coldWarm(() => libraryReview(store, { reviewId: meta.reviewId }), 3);
      return {
        reviewRecords: open.first.value.records?.length ?? 0,
        list: { ...list.summary, ...wireSize(list.first.value) },
        openAndScreeningRead: {
          ...open.summary,
          ...wireSize(open.first.value, ScientSystematicReviewResult),
        },
      };
    }
    case "merge-pass": {
      const library = scientLibraryLocation(scientLibraryRootFor(meta.stateDir));
      const run = await coldWarm(() => mergeScientLibraryDuplicates({ library, actor: "user" }), 2);
      return {
        merged: run.first.value.mergedCount,
        possibleDuplicates: run.first.value.possibleDuplicates.length,
        pass: run.summary,
      };
    }
    case "bulk-tag":
      return bulkInParts(await write(meta.projects.thesis), meta.pinned.thesis.slice(0, 1_000), {
        addTags: ["scale gate"],
      });
    case "bulk-type":
      return bulkInParts(
        await write(meta.projects.thesis),
        meta.pinned.thesis.slice(1_000, 2_000),
        {
          type: "report",
        },
      );
    case "change-pins": {
      const store = await write(meta.projects.paper);
      const pinned = new Set(meta.pinned.paper);
      const others = meta.sourceIds.filter((sourceId) => !pinned.has(sourceId)).slice(0, 19_000);
      const pin = await time(() =>
        organizeLibrarySources(store, {
          change: {
            action: "change-pins",
            changes: others.map((sourceId) => ({ action: "pin" as const, sourceId })),
          },
        }),
      );
      const keys = pinnedKeys(pin.value);
      const unpin = await time(() =>
        organizeLibrarySources(store, {
          change: {
            action: "change-pins",
            changes: keys.map((citationKey) => ({ action: "unpin" as const, citationKey })),
          },
        }),
      );
      // Again in the panel's requests of 2,000 (`libraryActions.ts`).
      const inParts = async (changes: ReadonlyArray<ScientPinChangeRequest>) => {
        const requests: number[] = [];
        const started = performance.now();
        const pinned: string[] = [];
        for (let start = 0; start < changes.length; start += PIN_CHANGES_PER_REQUEST) {
          const part = await time(() =>
            organizeLibrarySources(store, {
              change: {
                action: "change-pins",
                changes: changes.slice(start, start + PIN_CHANGES_PER_REQUEST),
              },
            }),
          );
          requests.push(part.ms);
          pinned.push(...pinnedKeys(part.value));
        }
        return {
          value: pinned,
          summary: {
            requests: requests.length,
            totalMs: round2(performance.now() - started),
            slowestRequestMs: Math.max(...requests),
          },
        };
      };
      const pinParts = await inParts(
        others.map((sourceId) => ({ action: "pin" as const, sourceId })),
      );
      const unpinParts = await inParts(
        pinParts.value.map((citationKey) => ({ action: "unpin" as const, citationKey })),
      );
      return {
        clientTimeoutMs: 15_000,
        pin: { changes: others.length, pinned: keys.length, ms: pin.ms },
        unpin: { changes: keys.length, ms: unpin.ms },
        pinInRequests: pinParts.summary,
        unpinInRequests: unpinParts.summary,
      };
    }
    case "start-cold":
    case "start-warmed":
    case "start-during-warming": {
      const store = await read(meta.projects.thesis);
      const heapBefore = heapAfterCollection();
      const warm = () =>
        time(() =>
          warmScientLibraryRecordIndex(store.library, {
            minimumRecords: measure === "start-cold" ? Number.POSITIVE_INFINITY : 0,
          }),
        );
      const warming = measure === "start-cold" ? null : warm();
      if (measure === "start-warmed") await warming;
      if (measure === "start-during-warming") {
        await new Promise((resolve) => setTimeout(resolve, OPEN_DURING_WARMING_MS));
      }
      const heapWarmed = measure === "start-warmed" ? heapAfterCollection() : null;
      const first = await time(() =>
        libraryOverview(store, { scope: "library", background: false }),
      );
      const warmed = await warming;
      return {
        threshold: LIBRARY_WARM_MINIMUM_RECORDS,
        recordFiles: warmed?.value.recordFiles ?? null,
        rows: first.value.records.length,
        warmingMs: warmed?.ms ?? null,
        ...(measure === "start-during-warming" ? { listOpenedAtMs: OPEN_DURING_WARMING_MS } : {}),
        firstListMs: first.ms,
        firstListWithWireMs: round2(
          first.ms + wireMs(wireSize(first.value, ScientSourcesOverviewResult)),
        ),
        heldHeapMiB: {
          ...(heapWarmed === null ? {} : { afterWarming: mib(heapWarmed - heapBefore) }),
          afterFirstList: mib(heapAfterCollection() - heapBefore),
        },
      };
    }
    default:
      throw new Error(`Unknown measure ${measure}.`);
  }
}

/** The one-time move of the v1 project into an empty Library, with another writer on the lock. */
async function runMove(projectRoot: string, stateDir: string): Promise<Record<string, unknown>> {
  const libraryRoot = scientLibraryRootFor(stateDir);
  await ensureScientLibrary(libraryRoot);
  const before = await readScientLibraryMoveState({
    library: scientLibraryLocation(libraryRoot),
    projectRoot,
  });
  const run = { moving: true };
  let longestWait = 0;
  const writer = (async () => {
    while (run.moving) {
      const asked = performance.now();
      await withScientLibraryLock(libraryRoot, async () => undefined, { timeoutMs: 3_600_000 });
      longestWait = Math.max(longestWait, performance.now() - asked);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  const events: Array<{ phase: string; done: number; total: number; atMs: number }> = [];
  const started = performance.now();
  const result = await runScientLibraryMove({
    library: scientLibraryLocation(libraryRoot),
    projectRoot,
    actor: "user",
    onProgress: (progress) => {
      const atMs = round2(performance.now() - started);
      events.push({ ...progress, atMs });
      // The parent reads these to interrupt the move at a chosen point.
      NodeProcess.stdout.write(`PROGRESS ${JSON.stringify({ ...progress, atMs })}\n`);
    },
  });
  const totalMs = round2(performance.now() - started);
  run.moving = false;
  await writer;
  const phases = new Map<
    string,
    { firstMs: number; lastMs: number; events: number; maxGapMs: number }
  >();
  let previous = 0;
  let maxGapMs = 0;
  for (const event of events) {
    const gap = event.atMs - previous;
    maxGapMs = Math.max(maxGapMs, gap);
    const phase = phases.get(event.phase) ?? {
      firstMs: event.atMs,
      lastMs: event.atMs,
      events: 0,
      maxGapMs: 0,
    };
    phase.maxGapMs = Math.max(phase.maxGapMs, phase.events === 0 ? 0 : event.atMs - phase.lastMs);
    phase.lastMs = event.atMs;
    phase.events += 1;
    phases.set(event.phase, phase);
    previous = event.atMs;
  }
  return {
    startedFrom: before.journal?.state ?? "no journal",
    outcome: result.outcome,
    state: result.journal?.state ?? null,
    totalMs,
    longestLockWaitMs: round2(longestWait),
    progress: {
      events: events.length,
      firstMs: events[0]?.atMs ?? null,
      maxGapMs: round2(Math.max(maxGapMs, totalMs - previous)),
      phases: Object.fromEntries(
        [...phases].map(([name, phase]) => [
          name,
          {
            ...phase,
            spanMs: round2(phase.lastMs - phase.firstMs),
            maxGapMs: round2(phase.maxGapMs),
          },
        ]),
      ),
    },
  };
}

/** A fresh process for one measure: its numbers, peak memory and event-loop delay. */
async function child(
  measure: Measure,
  metaPath: string,
  resultPath: string,
  moveRoot: string | null,
) {
  const meta = JSON.parse(await NodeFSP.readFile(metaPath, "utf8")) as Meta;
  const delay = NodePerfHooks.monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
  const blocked = (nanoseconds: number) =>
    round2(Math.max(0, nanoseconds / 1e6 - DELAY_RESOLUTION_MS));
  delay.enable();
  const startRss = NodeProcess.memoryUsage().rss;
  let peakRss = startRss;
  let peakHeap = 0;
  const sampler = setInterval(() => {
    const usage = NodeProcess.memoryUsage();
    peakRss = Math.max(peakRss, usage.rss);
    peakHeap = Math.max(peakHeap, usage.heapUsed);
  }, 20);
  const started = performance.now();
  const numbers =
    measure === "move" || measure === "move-interrupt"
      ? await runMove(moveRoot!, NodePath.join(NodePath.dirname(moveRoot!), "state"))
      : await runLibraryMeasure(measure, meta);
  clearInterval(sampler);
  delay.disable();
  const usage = NodeProcess.memoryUsage();
  const result = {
    measure,
    machine: machine(),
    processMs: round2(performance.now() - started),
    ...numbers,
    memory: {
      startRssMiB: mib(startRss),
      peakRssSampledMiB: mib(Math.max(peakRss, usage.rss)),
      // The operating system's peak for the process, in KiB on every platform.
      maxRssMiB: round2(NodeProcess.resourceUsage().maxRSS / 1024),
      peakHeapUsedMiB: mib(Math.max(peakHeap, usage.heapUsed)),
    },
    // Each sample is the gap between 10 ms timer ticks, so the interval is taken off.
    eventLoopDelayMs: {
      p50: blocked(delay.percentile(50)),
      p99: blocked(delay.percentile(99)),
      max: blocked(delay.max),
    },
  };
  await NodeFSP.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

/** Runs a measure in a fresh Node process; `interrupt` kills it once progress passes that point. */
async function spawnMeasure(input: {
  readonly measure: Measure;
  readonly metaPath: string;
  readonly resultPath: string;
  readonly moveRoot?: string;
  readonly interrupt?: { readonly phase: string; readonly fraction: number };
  readonly heapMiB?: number | undefined;
}): Promise<{ readonly interruptedAt: unknown; readonly code: number | null }> {
  const args = [
    // A bound to test, not to tune: a measure that needs more heap fails instead of growing.
    ...(input.heapMiB ? [`--max-old-space-size=${input.heapMiB}`] : []),
    "--expose-gc",
    SCRIPT,
    "--child",
    input.measure,
    "--meta",
    input.metaPath,
    "--result",
    input.resultPath,
    ...(input.moveRoot ? ["--move-root", input.moveRoot] : []),
  ];
  const process = NodeChildProcess.spawn(NodeProcess.execPath, args, {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let interruptedAt: unknown = null;
  const lines = NodeReadline.createInterface({ input: process.stdout });
  lines.on("line", (line) => {
    if (!line.startsWith("PROGRESS ")) return;
    const progress = JSON.parse(line.slice("PROGRESS ".length)) as {
      phase: string;
      done: number;
      total: number;
    };
    const point = input.interrupt;
    if (
      point &&
      interruptedAt === null &&
      progress.phase === point.phase &&
      progress.done >= progress.total * point.fraction
    ) {
      interruptedAt = progress;
      // As a quit or crash would: no cleanup runs in the child.
      process.kill("SIGKILL");
    }
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", (exitCode) => resolve(exitCode));
  });
  if (!input.interrupt && code !== 0) throw new Error(`${input.measure} exited with ${code}.`);
  return { interruptedAt, code };
}

/** Median, minimum and maximum of every number at the same path across rounds. */
function summarize(runs: ReadonlyArray<Record<string, unknown>>) {
  const leaves = new Map<string, number[]>();
  const walk = (value: unknown, path: string) => {
    if (typeof value === "number") leaves.set(path, [...(leaves.get(path) ?? []), value]);
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, inner] of Object.entries(value)) walk(inner, path ? `${path}.${key}` : key);
    }
  };
  for (const run of runs) walk(run, "");
  return Object.fromEntries(
    [...leaves].map(([path, values]) => [
      path,
      {
        median: median(values),
        min: Math.min(...values),
        max: Math.max(...values),
        n: values.length,
      },
    ]),
  );
}

async function driver() {
  const { values } = NodeUtil.parseArgs({
    options: {
      out: { type: "string" },
      work: { type: "string" },
      rounds: { type: "string", default: "3" },
      records: { type: "string", default: "20000" },
      only: { type: "string" },
      label: { type: "string" },
      keep: { type: "boolean", default: false },
      "interrupt-phase": { type: "string", default: "files" },
      "heap-mib": { type: "string" },
    },
  });
  if (!values.out) throw new Error("Give --out <folder>.");
  const label = values.label ?? `${NodeProcess.platform}-${NodeProcess.arch}`;
  const out = NodePath.resolve(values.out, label);
  await NodeFSP.mkdir(out, { recursive: true });
  const rounds = Number.parseInt(values.rounds, 10);
  const records = Number.parseInt(values.records, 10);
  const only = values.only ? new Set(values.only.split(",")) : null;
  const wanted = (measure: Measure) => !only || only.has(measure);
  const heapMiB = values["heap-mib"] ? Number.parseInt(values["heap-mib"], 10) : undefined;
  const work = values.work
    ? NodePath.resolve(values.work)
    : await NodeFSP.realpath(
        await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-scale-")),
      );
  await NodeFSP.mkdir(work, { recursive: true });
  const log = (message: string) => console.error(`[scale ${new Date().toISOString()}] ${message}`);
  try {
    const libraryBase = NodePath.join(work, "library");
    const moveBase = NodePath.join(work, "move-pristine");
    const metaPath = NodePath.join(work, "meta.json");
    let meta: Meta;
    try {
      meta = JSON.parse(await NodeFSP.readFile(metaPath, "utf8")) as Meta;
      log(`Reusing the test library in ${work}.`);
    } catch {
      log(`Writing the ${records}-record test library in ${work}.`);
      const built = await buildScaleLibrary(libraryBase, { records });
      const needsMove = MOVE_MEASURES.some(wanted);
      const move = needsMove ? await buildScaleMoveProject(moveBase, { records }) : null;
      meta = {
        stateDir: built.stateDir,
        projects: built.projects,
        reviewId: built.reviewId,
        sourceIds: built.sourceIds,
        pinned: built.pinned,
        collectionIds: built.collectionIds,
        moveProject: move?.root ?? null,
      };
      await NodeFSP.writeFile(metaPath, JSON.stringify(meta));
      await NodeFSP.writeFile(
        NodePath.join(out, "generated.json"),
        `${JSON.stringify({ machine: machine(), library: built.generated, move: move?.generated ?? null }, null, 2)}\n`,
      );
    }
    const byMeasure = new Map<string, Array<Record<string, unknown>>>();
    const record = async (measure: string, round: number, resultPath: string, extra = {}) => {
      const result = {
        ...(JSON.parse(await NodeFSP.readFile(resultPath, "utf8")) as Record<string, unknown>),
        round,
        ...extra,
      };
      await NodeFSP.writeFile(
        NodePath.join(out, `${measure}-r${round}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      byMeasure.set(measure, [...(byMeasure.get(measure) ?? []), result]);
    };
    for (let round = 1; round <= rounds; round += 1) {
      for (const measure of LIBRARY_MEASURES.filter(wanted)) {
        log(`Round ${round}: ${measure}.`);
        const resultPath = NodePath.join(work, `${measure}.json`);
        await spawnMeasure({ measure, metaPath, resultPath, heapMiB });
        await record(measure, round, resultPath);
      }
      for (const measure of MOVE_MEASURES.filter(wanted)) {
        if (!meta.moveProject)
          throw new Error("The move project was not written; rerun without --work.");
        log(`Round ${round}: ${measure}.`);
        const runBase = NodePath.join(work, `${measure}-r${round}`);
        await NodeFSP.rm(runBase, { recursive: true, force: true });
        await NodeFSP.mkdir(runBase, { recursive: true });
        const moveRoot = NodePath.join(runBase, "project");
        const copied = await time(() =>
          NodeFSP.cp(meta.moveProject!, moveRoot, { recursive: true }),
        );
        const resultPath = NodePath.join(work, `${measure}.json`);
        if (measure === "move") {
          await spawnMeasure({ measure, metaPath, resultPath, moveRoot, heapMiB });
          await record(measure, round, resultPath, { copyMs: copied.ms });
        } else {
          const killed = await time(() =>
            spawnMeasure({
              measure,
              metaPath,
              resultPath: NodePath.join(work, "move-killed.json"),
              moveRoot,
              interrupt: { phase: values["interrupt-phase"], fraction: 0.5 },
              heapMiB,
            }),
          );
          const library = scientLibraryLocation(
            scientLibraryRootFor(NodePath.join(runBase, "state")),
          );
          const after = await readScientLibraryMoveState({ library, projectRoot: moveRoot });
          await spawnMeasure({ measure, metaPath, resultPath, moveRoot, heapMiB });
          await record(measure, round, resultPath, {
            interrupted: {
              at: killed.value.interruptedAt,
              exitCode: killed.value.code,
              msUntilKilled: killed.ms,
              journalAfterKill: after.journal?.state ?? null,
              movedAfterKill: after.moved,
            },
          });
        }
        if (!values.keep) await NodeFSP.rm(runBase, { recursive: true, force: true });
      }
    }
    const summary = Object.fromEntries(
      [...byMeasure].map(([measure, runs]) => [measure, summarize(runs)]),
    );
    await NodeFSP.writeFile(
      NodePath.join(out, "summary.json"),
      `${JSON.stringify({ machine: machine(), rounds, ...(heapMiB ? { heapMiB } : {}), summary }, null, 2)}\n`,
    );
    log(`Done: ${out}.`);
  } finally {
    if (!values.keep && !values.work) await NodeFSP.rm(work, { recursive: true, force: true });
  }
}

const { values: childArgs } = NodeUtil.parseArgs({
  strict: false,
  options: {
    child: { type: "string" },
    meta: { type: "string" },
    result: { type: "string" },
    "move-root": { type: "string" },
  },
});
if (typeof childArgs.child === "string") {
  await child(
    childArgs.child as Measure,
    String(childArgs.meta),
    String(childArgs.result),
    typeof childArgs["move-root"] === "string" ? childArgs["move-root"] : null,
  );
} else {
  await driver();
}

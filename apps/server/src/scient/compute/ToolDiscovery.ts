// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off -- owns the scan worker and its deadline.
import * as NodeFS from "node:fs";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";
import * as NodeWorkerThreads from "node:worker_threads";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  discoveryContext,
  quarantineFolder,
  RuntimeDiscoveryHostReference,
  type DiscoveryContext,
} from "./RuntimeDiscovery.ts";
import { groupTools, toolScanSteps, type FoundLanguageTool } from "./ToolScan.ts";

/** A folder that does not answer in this long is set aside, so one dead drive costs one second. */
const STALL_MS = 1000;
const STUCK_FOLDER_RETRY_MS = 5 * 60_000;
const WORKER_START_MS = 5000;
/** Blocked calls cannot be cancelled, so each stuck worker stays until its call returns. */
const MAX_STUCK_WORKERS = 3;
const FIRST_ANSWER_MS = 2000;
const SNAPSHOT_MAX_AGE_MS = 3 * 60_000;

export interface ToolSnapshot {
  readonly tools: ReadonlyMap<string, ReadonlyArray<FoundLanguageTool>>;
  /** False while a scan is running, or when a place could not be read. */
  readonly complete: boolean;
}

export type ToolScanMessage =
  | { readonly kind: "start"; readonly source: string }
  | {
      readonly kind: "found";
      readonly source: string;
      readonly tools: ReadonlyArray<FoundLanguageTool>;
    }
  | { readonly kind: "done" };

export interface ToolScanWorkerData {
  readonly platform: DiscoveryContext["platform"];
  readonly environment: DiscoveryContext["environment"];
  readonly homeDirectory: string;
  readonly skip: ReadonlyArray<string>;
}

export interface ToolScanRun {
  /** Settles only when the worker is really gone, which a blocked call can delay indefinitely. */
  readonly stop: () => Promise<unknown>;
}

/** Workers told to stop that have not stopped yet, across every scan. */
interface BlockedWorkers {
  count: number;
}

/** Bundled modules and the executable share the emitted worker's directory. */
function toolDiscoveryWorkerUrl(moduleUrl: string | URL): URL {
  const url = new URL(moduleUrl);
  return NodeSea.isSea() || url.pathname.endsWith(".mjs")
    ? new URL("./tool-discovery-worker.mjs", url)
    : new URL("../../tool-discovery-worker.ts", url);
}

function startWorker(
  context: DiscoveryContext,
  skip: ReadonlyArray<string>,
  onMessage: (message: ToolScanMessage) => void,
  onFailure: () => void,
): ToolScanRun {
  const worker = new NodeWorkerThreads.Worker(toolDiscoveryWorkerUrl(import.meta.url), {
    workerData: {
      platform: context.platform,
      environment: context.environment,
      homeDirectory: context.homeDirectory,
      skip,
    } satisfies ToolScanWorkerData,
  });
  worker.unref();
  worker.on("message", onMessage);
  worker.on("error", onFailure);
  return { stop: () => worker.terminate() };
}

/** For tests and source runs, where no worker was built. */
function startInline(
  context: DiscoveryContext,
  skip: ReadonlyArray<string>,
  onMessage: (message: ToolScanMessage) => void,
): ToolScanRun {
  for (const step of toolScanSteps(context)) {
    if (skip.includes(step.source)) continue;
    onMessage({ kind: "found", source: step.source, tools: step.run() });
  }
  onMessage({ kind: "done" });
  return { stop: () => Promise.resolve() };
}

type StartRun = (
  skip: ReadonlyArray<string>,
  onMessage: (message: ToolScanMessage) => void,
  onFailure: () => void,
) => ToolScanRun;

/** Runs one scan. The parent holds the deadline, because a blocked call cannot time itself out. */
export function runToolScan(
  start: StartRun,
  stalled: ReadonlyArray<string>,
  onStall: (source: string) => void,
  onProgress: (tools: ReadonlyArray<FoundLanguageTool>) => void,
  blocked: BlockedWorkers = { count: 0 },
): Promise<ToolSnapshot> {
  return new Promise((resolve) => {
    const tools: FoundLanguageTool[] = [];
    const finished = new Set(stalled);
    let complete = stalled.length === 0;
    const settle = () => resolve({ tools: groupTools(tools), complete });
    const launch = () => {
      if (blocked.count >= MAX_STUCK_WORKERS) {
        complete = false;
        settle();
        return;
      }
      let live = true;
      let reading: string | null = null;
      let run: ToolScanRun | undefined;
      const onStuck = () => {
        live = false;
        complete = false;
        blocked.count += 1;
        void run?.stop().finally(() => {
          blocked.count -= 1;
        });
        if (reading === null) {
          settle();
          return;
        }
        finished.add(reading);
        onStall(reading);
        launch();
      };
      let watchdog = setTimeout(onStuck, WORKER_START_MS);
      run = start(
        [...finished],
        (message) => {
          if (!live) return;
          clearTimeout(watchdog);
          if (message.kind === "done") {
            live = false;
            settle();
            return;
          }
          if (message.kind === "start") reading = message.source;
          else {
            reading = null;
            finished.add(message.source);
            tools.push(...message.tools);
            onProgress(tools);
          }
          watchdog = setTimeout(onStuck, STALL_MS);
        },
        () => {
          if (!live) return;
          live = false;
          clearTimeout(watchdog);
          complete = false;
          settle();
        },
      );
    };
    launch();
  });
}

const stalledSources = new Map<string, number>();

function currentlyStalled(now: number): ReadonlyArray<string> {
  for (const [source, until] of stalledSources) if (until <= now) stalledSources.delete(source);
  return [...stalledSources.keys()];
}

interface ToolDiscoveryService {
  readonly snapshot: (refresh: boolean) => Effect.Effect<ToolSnapshot>;
}

/** Absent where nothing asks about the whole computer, as in most tests. */
export const ToolDiscovery = Context.Reference<ToolDiscoveryService | null>(
  "t3/scient/compute/ToolDiscovery",
  { defaultValue: () => null },
);

const make = Effect.sync((): ToolDiscoveryService => {
  let latest: ToolSnapshot | null = null;
  let latestAt = 0;
  let running: Promise<ToolSnapshot> | null = null;
  let partial: ReadonlyArray<FoundLanguageTool> = [];
  const blocked: BlockedWorkers = { count: 0 };

  const scan = (context: DiscoveryContext, inline: boolean) => {
    const workerFile = NodeURL.fileURLToPath(toolDiscoveryWorkerUrl(import.meta.url));
    const start: StartRun =
      inline || !NodeFS.existsSync(workerFile)
        ? (skip, onMessage) => startInline(context, skip, onMessage)
        : (skip, onMessage, onFailure) => startWorker(context, skip, onMessage, onFailure);
    const pending = runToolScan(
      start,
      currentlyStalled(Date.now()),
      (source) => {
        const until = Date.now() + STUCK_FOLDER_RETRY_MS;
        stalledSources.set(source, until);
        quarantineFolder(source, until);
      },
      (tools) => {
        partial = tools;
      },
      blocked,
    ).then((snapshot) => {
      latest = snapshot;
      latestAt = Date.now();
      running = null;
      return snapshot;
    });
    running = pending;
    return pending;
  };

  return {
    snapshot: Effect.fn("ToolDiscovery.snapshot")(function* (refresh: boolean) {
      if (!refresh && latest !== null && Date.now() - latestAt < SNAPSHOT_MAX_AGE_MS) return latest;
      const context = yield* discoveryContext;
      const injected = yield* RuntimeDiscoveryHostReference;
      const pending = running ?? scan(context, injected !== null);
      return yield* Effect.promise(
        () =>
          new Promise<ToolSnapshot>((resolve) => {
            const timer = setTimeout(
              () => resolve({ tools: groupTools(partial), complete: false }),
              FIRST_ANSWER_MS,
            );
            void pending.then((snapshot) => {
              clearTimeout(timer);
              resolve(snapshot);
            });
          }),
      );
    }),
  };
});

export const layer = Layer.effect(ToolDiscovery, make);

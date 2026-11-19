// @effect-diagnostics nodeBuiltinImport:off -- reads the process table with `ps`.
/**
 * Memory over time that outlives a crash: each minute, available memory and the largest processes
 * by executable name (Scient's descendants and the machine's), plus upkeep runs. Names and numbers
 * only, never command lines, paths, prompts or credentials. Two 1 MiB files, about two days.
 */
import * as NodeChildProcess from "node:child_process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { RotatingFileSink, RotatingFileSinkError } from "@t3tools/shared/logging";
import { descendantsOf } from "@t3tools/shared/scientOwnedProcessTree";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as HostResources from "../../resourceTelemetry/HostResources.ts";

const SAMPLE_INTERVAL = "1 minute";
const RECORD_MAX_BYTES = 1024 * 1024;
const LARGEST_NAMES = 5;
const MB = 1024 * 1024;

type Field = string | number;

export class ResourceRecord extends Context.Service<
  ResourceRecord,
  {
    /** Adds one line; `fields` hold names and numbers only. */
    readonly note: (event: string, fields: Readonly<Record<string, Field>>) => Effect.Effect<void>;
  }
>()("t3/scient/observability/ResourceRecord") {}

export interface ProcessUse {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
  /** The executable's base name, without its directory or arguments. */
  readonly name: string;
}

/** Parses `ps -A -o pid=,ppid=,rss=,comm=` output (resident size in KiB). */
export function parseProcessUse(text: string): ReadonlyArray<ProcessUse> {
  const processes: Array<ProcessUse> = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (match === null) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      name: match[4]!.slice(match[4]!.lastIndexOf("/") + 1),
    });
  }
  return processes;
}

export interface NameUse {
  readonly name: string;
  readonly count: number;
  readonly mb: number;
}

/** The names holding the most resident memory, with how many processes share each. */
function largestByName(
  processes: ReadonlyArray<ProcessUse>,
  limit = LARGEST_NAMES,
): ReadonlyArray<NameUse> {
  const byName = new Map<string, { count: number; bytes: number }>();
  for (const { name, rssBytes } of processes) {
    const entry = byName.get(name) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += rssBytes;
    byName.set(name, entry);
  }
  return [...byName]
    .toSorted(([, left], [, right]) => right.bytes - left.bytes)
    .slice(0, limit)
    .map(([name, { count, bytes }]) => ({ name, count, mb: Math.round(bytes / MB) }));
}

/** Scient's share (the server's descendants) and the machine's largest names. */
export function summarizeProcesses(processes: ReadonlyArray<ProcessUse>, serverPid: number) {
  const scient = descendantsOf(processes, serverPid);
  return {
    scient: {
      count: scient.length,
      mb: Math.round(scient.reduce((sum, entry) => sum + entry.rssBytes, 0) / MB),
      largest: largestByName(scient),
    },
    machine: { count: processes.length, largest: largestByName(processes) },
  };
}

/** Undefined when `ps` fails: the line then records memory alone. */
const readProcessUse = Effect.callback<ReadonlyArray<ProcessUse> | undefined>((resume) => {
  NodeChildProcess.execFile(
    "ps",
    ["-A", "-o", "pid=,ppid=,rss=,comm="],
    {
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    },
    (error, stdout) => resume(Effect.succeed(error ? undefined : parseProcessUse(stdout))),
  );
});

const encodeLine = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const layerWith = (filePath: string) =>
  Layer.effect(
    ResourceRecord,
    Effect.gen(function* () {
      const host = yield* HostResources.HostResources;
      // Windows has no `ps`; its lines hold memory alone.
      const readsProcesses = (yield* HostProcess.Platform) !== "win32";
      const sink = yield* Effect.try({
        try: () => new RotatingFileSink({ filePath, maxBytes: RECORD_MAX_BYTES, maxFiles: 1 }),
        catch: (cause) => new RotatingFileSinkError({ operation: "initialize", filePath, cause }),
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("resource record unavailable", { filePath }).pipe(Effect.as(undefined)),
        ),
      );

      // The sink never throws (throwOnError is off), so a full disk costs a line, not the server.
      const write = (fields: Readonly<Record<string, unknown>>) =>
        sink === undefined
          ? Effect.void
          : DateTime.now.pipe(
              Effect.flatMap((now) => encodeLine({ time: DateTime.formatIso(now), ...fields })),
              Effect.flatMap((line) => Effect.sync(() => sink.write(`${line}\n`))),
              Effect.ignore,
            );

      const sample = Effect.gen(function* () {
        const memory = yield* host.read;
        const processes = readsProcesses ? yield* readProcessUse : undefined;
        yield* write({
          availableMb: Math.round(memory.availableMemoryBytes / MB),
          totalMb: Math.round(memory.totalMemoryBytes / MB),
          serverRssMb: Math.round(process.memoryUsage.rss() / MB),
          ...(processes === undefined ? {} : summarizeProcesses(processes, process.pid)),
        });
      });

      yield* write({ event: "server-start" });
      yield* Effect.sleep(SAMPLE_INTERVAL).pipe(
        Effect.andThen(sample),
        Effect.forever,
        Effect.forkScoped,
      );

      return ResourceRecord.of({
        note: Effect.fn("ResourceRecord.note")(function* (event, fields) {
          yield* write({ event, ...fields });
        }),
      });
    }),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { serverTracePath } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return layerWith(path.join(path.dirname(serverTracePath), "resource-record.ndjson"));
  }),
).pipe(Layer.provide(HostResources.layer));

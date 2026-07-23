/**
 * DevServerManager - Server-owned dev-server process orchestration.
 *
 * Dev servers are first-class background processes keyed by project id, fully
 * decoupled from chat threads. Each runs in a managed PTY (via TerminalManager)
 * under a synthetic `dev-server:<projectId>` thread so its lifetime survives
 * WebSocket reconnects and never clutters the thread list. The manager keeps an
 * in-memory registry, broadcasts changes over a PubSub for the
 * `project.devServerEvent` push channel, and reaps entries when their PTY exits.
 *
 * @module DevServerManager
 */
import {
  ProjectId,
  type ProjectDevServer,
  type ProjectDevServerEvent,
  type ProjectListDevServersResult,
  type ProjectRunDevServerInput,
  type ProjectRunDevServerResult,
  type ProjectStopDevServerInput,
  type ProjectStopDevServerResult,
  type ServerLocalServerProcess,
} from "@synara/contracts";
import * as Crypto from "node:crypto";
import { localServerProcessMatchesRun } from "@synara/shared/localServers";
import { Effect, Layer, PubSub, Ref, ServiceMap, Stream } from "effect";

import { TerminalManager, type TerminalError } from "./terminal/Services/Manager";
import { listLocalServers } from "./localServerMonitor";

// Dev servers reuse the terminal infrastructure under a reserved synthetic
// thread namespace so their PTYs never collide with real chat-thread terminals.
const DEV_SERVER_THREAD_PREFIX = "dev-server:";
const DEV_SERVER_TERMINAL_PREFIX = "run:";
const DEV_SERVER_TERMINAL_COLS = 120;
const DEV_SERVER_TERMINAL_ROWS = 30;
const DEV_SERVER_READINESS_TIMEOUT_MS = 30_000;
const DEV_SERVER_READINESS_POLL_MS = 400;

const devServerThreadId = (projectId: ProjectId): string =>
  `${DEV_SERVER_THREAD_PREFIX}${projectId}`;

const parseDevServerProjectId = (threadId: string): ProjectId | null => {
  if (!threadId.startsWith(DEV_SERVER_THREAD_PREFIX)) {
    return null;
  }
  const raw = threadId.slice(DEV_SERVER_THREAD_PREFIX.length);
  return raw.length > 0 ? ProjectId.makeUnsafe(raw) : null;
};

const devServerTerminalId = (runId: string): string => `${DEV_SERVER_TERMINAL_PREFIX}${runId}`;

const parseDevServerRunId = (terminalId: string): string | null =>
  terminalId.startsWith(DEV_SERVER_TERMINAL_PREFIX)
    ? terminalId.slice(DEV_SERVER_TERMINAL_PREFIX.length) || null
    : null;

export function findProjectDevServerForLocalServer(input: {
  localServer: ServerLocalServerProcess;
  devServers: readonly ProjectDevServer[];
}): ProjectDevServer | null {
  for (const devServer of input.devServers) {
    if (localServerProcessMatchesRun(input.localServer, devServer)) {
      return devServer;
    }
  }
  return null;
}

export function failProjectDevServerGeneration(
  current: ProjectDevServer | undefined,
  runId: string,
  error: string,
): ProjectDevServer | null {
  return current?.runId === runId ? { ...current, status: "failed", error } : null;
}

function preferredLocalServerUrl(server: ServerLocalServerProcess): string | null {
  return (
    server.addresses.find((address) => address.host === "127.0.0.1")?.url ??
    server.addresses.find((address) => address.host === "localhost")?.url ??
    server.addresses[0]?.url ??
    null
  );
}

export async function waitForProjectDevServerReadiness(
  server: ProjectDevServer,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    discover?: () => Promise<readonly ServerLocalServerProcess[]>;
    probe?: (url: string) => Promise<boolean>;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<{ url: string; ports: readonly number[] } | null> {
  const timeoutMs = options.timeoutMs ?? DEV_SERVER_READINESS_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEV_SERVER_READINESS_POLL_MS;
  const discover =
    options.discover ??
    (async () => (await listLocalServers({ includePageTitles: false })).servers);
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const probe =
    options.probe ??
    (async (url: string) => {
      try {
        await globalThis.fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(800),
        });
        return true;
      } catch {
        return false;
      }
    });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const localServers = await discover().catch(() => []);
    const match = localServers.find((candidate) => localServerProcessMatchesRun(candidate, server));
    const url = match ? preferredLocalServerUrl(match) : null;
    if (match && url && (await probe(url))) {
      return { url, ports: match.ports };
    }
    await sleep(pollMs);
  }
  return null;
}

export interface DevServerManagerShape {
  /** Start (or restart) the dev server for a project and return its descriptor. */
  readonly run: (
    input: ProjectRunDevServerInput,
  ) => Effect.Effect<ProjectRunDevServerResult, TerminalError>;
  /** Stop the dev server for a project. Resolves with whether one was running. */
  readonly stop: (input: ProjectStopDevServerInput) => Effect.Effect<ProjectStopDevServerResult>;
  /** Snapshot of all currently tracked dev servers. */
  readonly list: Effect.Effect<ProjectListDevServersResult>;
  /** Live stream of dev-server lifecycle events (excludes the initial snapshot). */
  readonly stream: Stream.Stream<ProjectDevServerEvent>;
}

export class DevServerManager extends ServiceMap.Service<DevServerManager, DevServerManagerShape>()(
  "synara/devServerManager",
) {}

export const DevServerManagerLive = Layer.effect(
  DevServerManager,
  Effect.gen(function* () {
    const terminalManager = yield* TerminalManager;
    const pubsub = yield* Effect.acquireRelease(
      PubSub.unbounded<ProjectDevServerEvent>(),
      PubSub.shutdown,
    );
    const registry = yield* Ref.make<Record<ProjectId, ProjectDevServer>>({});

    const publish = (event: ProjectDevServerEvent) => PubSub.publish(pubsub, event);

    // Preserve failures in the registry so the UI can explain why a launch did
    // not become ready. Deliberate stops remove the entry before PTY teardown.
    const markExited = (projectId: ProjectId, runId: string, error: string) =>
      Ref.modify(registry, (current) => {
        const existing = current[projectId];
        const failed = failProjectDevServerGeneration(existing, runId, error);
        if (!failed) {
          return [null, current] as const;
        }
        return [failed, { ...current, [projectId]: failed }] as const;
      }).pipe(
        Effect.flatMap((failed) =>
          failed ? publish({ type: "upserted", server: failed }) : Effect.void,
        ),
      );

    const unsubscribe = yield* terminalManager.subscribe((event) => {
      if (event.type !== "exited" && event.type !== "error") {
        return;
      }
      const projectId = parseDevServerProjectId(event.threadId);
      const runId = parseDevServerRunId(event.terminalId);
      if (!projectId || !runId) {
        return;
      }
      Effect.runFork(
        markExited(
          projectId,
          runId,
          event.type === "error"
            ? "The development server process reported an error."
            : "The development server process exited before it was stopped.",
        ),
      );
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

    const run: DevServerManagerShape["run"] = (input) =>
      Effect.gen(function* () {
        const threadId = devServerThreadId(input.projectId);
        const runId = Crypto.randomUUID();
        const terminalId = devServerTerminalId(runId);

        // If a dev server is already tracked for this project, tear its PTY down
        // first so the command always lands in a fresh shell. A deliberate close
        // emits no exit event, so the reaper stays quiet during the swap.
        const existing = (yield* Ref.get(registry))[input.projectId];
        if (existing) {
          yield* terminalManager
            .close({
              threadId,
              terminalId: devServerTerminalId(existing.runId),
              deleteHistory: true,
            })
            .pipe(Effect.catch(() => Effect.void));
        }

        const snapshot = yield* terminalManager.open({
          threadId,
          terminalId,
          cwd: input.cwd,
          cols: DEV_SERVER_TERMINAL_COLS,
          rows: DEV_SERVER_TERMINAL_ROWS,
          // Dev servers are headless: drain + retain history, but never broadcast
          // their continuous output to clients that have no terminal UI for them.
          streamOutput: false,
          ...(input.env ? { env: input.env } : {}),
        });

        yield* terminalManager.write({
          threadId,
          terminalId,
          data: `${input.command}\r`,
        });

        const startingServer: ProjectDevServer = {
          projectId: input.projectId,
          runId,
          command: input.command,
          cwd: input.cwd,
          pid: snapshot.pid,
          startedAt: new Date().toISOString(),
          status: "starting",
        };
        yield* Ref.update(registry, (current) => ({
          ...current,
          [input.projectId]: startingServer,
        }));
        yield* publish({ type: "upserted", server: startingServer });

        const readiness = yield* Effect.promise(() =>
          waitForProjectDevServerReadiness(startingServer),
        );
        const current = (yield* Ref.get(registry))[input.projectId];
        if (current?.runId === runId && current.status === "failed") {
          return { server: current };
        }
        if (!current || current.runId !== runId) {
          return {
            server: {
              ...startingServer,
              status: "failed",
              error: "This development-server launch was superseded by a newer run.",
            },
          };
        }
        const server: ProjectDevServer = readiness
          ? {
              ...startingServer,
              status: "running",
              url: readiness.url,
              ports: readiness.ports,
            }
          : {
              ...startingServer,
              status: "failed",
              error: "No local HTTP listener became ready within 30 seconds.",
            };
        yield* Ref.update(registry, (entries) => ({ ...entries, [input.projectId]: server }));
        yield* publish({ type: "upserted", server });
        return { server };
      });

    const stop: DevServerManagerShape["stop"] = (input) =>
      Effect.gen(function* () {
        // Remove from the registry *before* closing so the PTY teardown cannot be
        // mistaken for a crash by the reaper.
        const removed = yield* Ref.modify(registry, (current) => {
          const existing = current[input.projectId];
          if (!existing) {
            return [null, current] as const;
          }
          const next = { ...current };
          delete next[input.projectId];
          return [existing, next] as const;
        });
        if (!removed) {
          return { stopped: false };
        }
        yield* publish({ type: "removed", projectId: input.projectId, reason: "stopped" });
        yield* terminalManager
          .close({
            threadId: devServerThreadId(input.projectId),
            terminalId: devServerTerminalId(removed.runId),
            deleteHistory: true,
          })
          .pipe(Effect.catch(() => Effect.void));
        return { stopped: true };
      });

    const list: DevServerManagerShape["list"] = Ref.get(registry).pipe(
      Effect.map((current) => ({ servers: Object.values(current) })),
    );

    return {
      run,
      stop,
      list,
      get stream() {
        return Stream.fromPubSub(pubsub);
      },
    } satisfies DevServerManagerShape;
  }),
);

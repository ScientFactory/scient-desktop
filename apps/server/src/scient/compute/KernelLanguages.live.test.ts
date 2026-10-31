// @effect-diagnostics nodeBuiltinImport:off -- gated integration test runs real R, Julia and DuckDB kernels.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ComputeLanguageId,
  ComputeRequestId,
  ComputeSessionId,
  INITIAL_COMPUTE_SESSION_GENERATION,
  REQUIRED_COMPUTE_CAPABILITIES,
  nextComputeSessionGeneration,
  type ComputeChannel,
  type ComputeLaunchPlan,
  type ComputeSessionGeneration,
  type ComputeTransport,
  type ComputeTransportEvent,
} from "@scientfactory/compute";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as OwnedLocalEndpoints from "../../localEndpoints/OwnedLocalEndpointRegistry.ts";
import { DuplexProcess, layer as duplexProcessLayer } from "../execution/LocalDuplexProcess.ts";
import {
  ExecutionProcess,
  layer as executionProcessLayer,
} from "../execution/LocalExecutionProcess.ts";
import { makeComputeBridgeTransport } from "./ComputeBridgeTransport.ts";
import type { ComputeRuntimeBinding } from "./ComputeSessionService.ts";
import { JULIA_KERNEL_LANGUAGE } from "./JuliaComputeRuntime.ts";
import { makeKernelRuntimeBinding, type KernelLanguage } from "./KernelComputeRuntime.ts";
import { pythonRuntimeBinding } from "./PythonComputeRuntime.ts";
import { JUPYTER_BRIDGE_TRANSPORT_KIND, buildLaunchPlan } from "./PythonRuntimeAdapter.ts";
import { R_KERNEL_LANGUAGE } from "./RComputeRuntime.ts";
import { SQL_LANGUAGE_ID, makeSqlRuntimeBinding, sqlKernelSpec } from "./SqlComputeRuntime.ts";

// Opt-in: the bridge host Python (for SQL it also needs duckdb) and a directory for Scient's private
// kernels, which are set up there from CRAN and the Julia registry when missing.
const TEST_PYTHON = NodeProcess.env.SCIENT_TEST_PYTHON;
const KERNEL_DIR = NodeProcess.env.SCIENT_TEST_KERNEL_DIR;
const SETUP_TIMEOUT_MS = 20 * 60_000;
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const bridgePath = NodePath.join(here, "bridge", "scient_compute_bridge.py");
const Live = Layer.mergeAll(
  duplexProcessLayer,
  executionProcessLayer,
  OwnedLocalEndpoints.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

const runs = (executable: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync(executable, args, { stdio: "ignore" }).status === 0;
const enabled = Boolean(TEST_PYTHON && KERNEL_DIR);
const hasR = enabled && runs("R", ["--version"]);
const hasJulia = enabled && runs("julia", ["--version"]);
const hasDuckDb = enabled && runs(TEST_PYTHON!, ["-I", "-c", "import duckdb, ipykernel"]);

function hostEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(NodeProcess.env).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );
}

const bridgeTransport = Effect.fn("KernelLanguages.transport")(function* (
  startupTimeoutMs?: number,
) {
  const processes = yield* DuplexProcess;
  const endpoints = yield* OwnedLocalEndpoints.OwnedLocalEndpointRegistry;
  return makeComputeBridgeTransport(processes, {
    ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
    prepareKernelEndpoints: () =>
      endpoints
        .reserveProtectedLoopbackTcpPorts({
          owner: "compute-test/kernel-languages",
          purpose: "jupyter-kernel-channels",
          count: 5,
        })
        .pipe(
          Effect.orDie,
          Effect.map((lease) => {
            const [shell, iopub, stdin, heartbeat, control] = lease.ports as [
              number,
              number,
              number,
              number,
              number,
            ];
            return {
              ports: { ip: "127.0.0.1" as const, shell, iopub, stdin, heartbeat, control },
              handoff: lease.handoff.pipe(Effect.orDie),
              release: lease.release,
            };
          }),
        ),
  });
});

interface Session {
  readonly channel: ComputeChannel;
  readonly events: Queue.Dequeue<ComputeTransportEvent>;
}

const takeMatching = Effect.fn("KernelLanguages.takeMatching")(function* (
  queue: Queue.Dequeue<ComputeTransportEvent>,
  predicate: (event: ComputeTransportEvent) => boolean,
) {
  for (;;) {
    const event = yield* Queue.take(queue);
    if (predicate(event)) return event;
  }
});

const openSession = Effect.fn("KernelLanguages.openSession")(function* (
  languageId: ComputeLanguageId,
  transport: ComputeTransport,
  launch: ComputeLaunchPlan,
) {
  const channel = yield* transport.open({
    sessionId: ComputeSessionId.make(`${languageId}-integration-session`),
    generation: INITIAL_COMPUTE_SESSION_GENERATION,
    languageId,
    transportKind: JUPYTER_BRIDGE_TRANSPORT_KIND,
    launch,
    requiredCapabilities: [...REQUIRED_COMPUTE_CAPABILITIES],
  });
  const events = yield* Queue.unbounded<ComputeTransportEvent>();
  yield* channel.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* takeMatching(events, (event) => event._tag === "ready");
  return { channel, events } satisfies Session;
});

let requests = 0;
const execute = Effect.fn("KernelLanguages.execute")(function* (
  session: Session,
  code: string,
  generation = INITIAL_COMPUTE_SESSION_GENERATION,
) {
  const requestId = ComputeRequestId.make(`request-${++requests}`);
  yield* session.channel.execute({ requestId, expectedGeneration: generation, code });
  const observed: ComputeTransportEvent[] = [];
  for (;;) {
    const event = yield* Queue.take(session.events);
    observed.push(event);
    if (event._tag === "completed" && event.requestId === requestId) return observed;
  }
});

function text(events: ReadonlyArray<ComputeTransportEvent>, mediaType = "text/plain"): string {
  return events
    .flatMap((event) => {
      if (event._tag !== "output") return [];
      if (event.output._tag === "stream")
        return mediaType === "text/plain" ? [event.output.text] : [];
      if (event.output._tag !== "display-data" && event.output._tag !== "execute-result") return [];
      return event.output.bundle.representations.flatMap((representation) =>
        representation.mediaType === mediaType && representation.data._tag === "text"
          ? [representation.data.text]
          : [],
      );
    })
    .join("");
}

const hasMedia = (events: ReadonlyArray<ComputeTransportEvent>, mediaType: string) =>
  events.some(
    (event) =>
      event._tag === "output" &&
      (event.output._tag === "display-data" || event.output._tag === "execute-result") &&
      event.output.bundle.representations.some((item) => item.mediaType === mediaType),
  );

const errorOf = (events: ReadonlyArray<ComputeTransportEvent>) => {
  const error = events.find((event) => event._tag === "runtime-error");
  return error?._tag === "runtime-error" ? error.report : null;
};

const completion = (events: ReadonlyArray<ComputeTransportEvent>) =>
  events.findLast((event) => event._tag === "completed");

/** Interrupts a long run and restarts, returning the next generation. */
const interruptAndRestart = Effect.fn("KernelLanguages.interruptAndRestart")(function* (
  session: Session,
  longRunning: string,
) {
  const requestId = ComputeRequestId.make(`request-${++requests}`);
  yield* session.channel.execute({
    requestId,
    expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
    code: longRunning,
  });
  yield* takeMatching(
    session.events,
    (event) => event._tag === "accepted" && event.requestId === requestId,
  );
  yield* session.channel.interrupt({
    requestId,
    expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
  });
  const interrupted = yield* takeMatching(
    session.events,
    (event) => event._tag === "completed" && event.requestId === requestId,
  );
  expect(interrupted).toMatchObject({ outcome: "cancelled" });
  const nextGeneration = nextComputeSessionGeneration(INITIAL_COMPUTE_SESSION_GENERATION);
  yield* session.channel.restart({
    expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
    nextGeneration,
  });
  yield* takeMatching(session.events, (event) => event._tag === "restarted");
  return nextGeneration;
});

/** Discovers the installation, sets up Scient's private kernel when needed, and opens a session. */
const kernelSession = Effect.fn("KernelLanguages.kernelSession")(function* (
  language: KernelLanguage,
  project: string,
) {
  const transport = yield* bridgeTransport(language.startupTimeoutMs);
  const binding: ComputeRuntimeBinding = yield* makeKernelRuntimeBinding(language, {
    host: {
      bridgePath,
      transport: () => transport,
      executable: () => Effect.succeed(TEST_PYTHON!),
      mayHost: () => Effect.succeed(true),
    },
    computeDir: KERNEL_DIR!,
    processes: yield* ExecutionProcess,
    configuredExecutable: () => Effect.succeed(null),
  });
  const [profile] = yield* binding.adapter.discover({
    projectRoot: null,
    configuredExecutable: null,
    refresh: true,
  });
  if (profile === undefined) return yield* Effect.die(`${language.displayName} was not found.`);
  const verify = () =>
    binding.adapter.verify({ profile, cwd: project, environment: hostEnvironment() });
  if ((yield* verify()).readiness !== "ready") {
    const managed = binding.managedRuntime!;
    yield* managed.manage("install");
    const settled = yield* managed.status().pipe(
      Effect.repeat({
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- setup is a forked download and build that, as in Settings, is observable only through status
        schedule: Schedule.spaced("1 second"),
        until: (status) => status.operation === null,
      }),
    );
    expect(settled.failure ?? null).toBeNull();
  }
  expect((yield* verify()).readiness).toBe("ready");
  const launch = yield* binding.adapter.prepareLaunch({
    profile,
    cwd: project,
    environment: hostEnvironment(),
  });
  return { binding, session: yield* openSession(language.languageId, binding.transport, launch) };
});

const makeProject = () =>
  NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-kernel-")));

const inspectVariables = (session: Session, expectedGeneration: ComputeSessionGeneration) =>
  session.channel.inspectVariables({
    requestId: ComputeRequestId.make(`variables-${++requests}`),
    expectedGeneration,
  });

describe.runIf(enabled)("kernel language integration", () => {
  it.live.runIf(hasR)(
    "runs R through IRkernel with plots, errors, interrupt and restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { session } = yield* kernelSession(R_KERNEL_LANGUAGE, makeProject());
          expect(text(yield* execute(session, "x <- 41 + 1\nprint(x)"))).toContain("[1] 42");
          const failed = yield* execute(session, 'stop("boom")');
          expect(errorOf(failed)?.value).toContain("boom");
          expect(completion(failed)).toMatchObject({ outcome: "failed" });
          expect(hasMedia(yield* execute(session, "plot(1:10)"), "image/png")).toBe(true);
          const next = yield* interruptAndRestart(session, "Sys.sleep(60)");
          expect(text(yield* execute(session, 'exists("x")', next))).toContain("FALSE");
          yield* session.channel.shutdown({ expectedGeneration: next });
        }),
      ).pipe(Effect.provide(Live)),
    SETUP_TIMEOUT_MS,
  );

  it.live.runIf(hasJulia)(
    "runs Julia through IJulia with rich output, variables, interrupt and restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const userDepot = NodePath.join(NodeOS.homedir(), ".julia");
          const userDepotExisted = NodeFS.existsSync(userDepot);
          const { session } = yield* kernelSession(JULIA_KERNEL_LANGUAGE, makeProject());
          expect(text(yield* execute(session, "x = 41 + 1"))).toContain("42");
          expect(errorOf(yield* execute(session, 'error("boom")'))?.value).toContain("boom");
          expect(text(yield* execute(session, 'HTML("<b>bold</b>")'), "text/html")).toContain(
            "<b>bold</b>",
          );
          const variables = yield* session.channel.inspectVariables({
            requestId: ComputeRequestId.make(`variables-${++requests}`),
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          });
          expect(variables.variables).toContainEqual(
            expect.objectContaining({ name: "x", typeName: "Int64", preview: "42" }),
          );
          const next = yield* interruptAndRestart(session, "while true; sleep(0.01); end");
          expect(text(yield* execute(session, "isdefined(Main, :x)", next))).toContain("false");
          yield* session.channel.shutdown({ expectedGeneration: next });
          if (!userDepotExisted) expect(NodeFS.existsSync(userDepot)).toBe(false);
        }),
      ).pipe(Effect.provide(Live)),
    SETUP_TIMEOUT_MS,
  );

  it.live.runIf(hasDuckDb)(
    "runs SQL through DuckDB against project files with tables, errors, interrupt and restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const project = makeProject();
          NodeFS.writeFileSync(NodePath.join(project, "data.csv"), "a,b\n1,x\n2,y\n");
          const launch = buildLaunchPlan(
            {
              profile: {
                languageId: SQL_LANGUAGE_ID,
                source: "configured",
                executable: TEST_PYTHON!,
                languageVersion: "unknown",
                architecture: null,
                displayName: "SQL (integration)",
              },
              cwd: project,
              environment: hostEnvironment(),
            },
            bridgePath,
          );
          const session = yield* openSession(SQL_LANGUAGE_ID, yield* bridgeTransport(), {
            ...launch,
            kernel: sqlKernelSpec(TEST_PYTHON!, bridgePath),
          });
          const table = yield* execute(
            session,
            "CREATE TABLE t AS SELECT * FROM 'data.csv';\nSELECT count(*) AS n FROM t;",
          );
          expect(text(table, "text/html")).toContain("<th>n</th>");
          expect(text(table)).toContain("2");
          const failed = yield* execute(session, "SELECT 1;\nSELECT * FROM missing_table;");
          expect(errorOf(failed)).toMatchObject({ name: "CatalogException" });
          expect(errorOf(failed)?.traceback[0]).toBe("line 2");
          const variables = yield* session.channel.inspectVariables({
            requestId: ComputeRequestId.make(`variables-${++requests}`),
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          });
          expect(variables.variables).toContainEqual(
            expect.objectContaining({ name: "t", typeName: "table" }),
          );
          const next = yield* interruptAndRestart(
            session,
            "SELECT sum(a.range * b.range) FROM range(1000000) a, range(1000000) b;",
          );
          expect(errorOf(yield* execute(session, "SELECT * FROM t;", next))).toMatchObject({
            name: "CatalogException",
          });
          yield* session.channel.shutdown({ expectedGeneration: next });
        }),
      ).pipe(Effect.provide(Live)),
  );
});

// Opt-in: a Python with no Jupyter packages, on a computer with nothing else that could host the
// bridge. Scient's private Python and kernel come from the network, as they do for a person.
const BARE_PYTHON = NodeProcess.env.SCIENT_TEST_BARE_PYTHON;

describe.runIf(Boolean(BARE_PYTHON))("running on what people have", () => {
  const stateDirectory = () => makeProject();
  const bareLive = () =>
    Live.pipe(
      Layer.provideMerge(ServerConfig.layerTest(makeProject(), stateDirectory())),
      Layer.provideMerge(NodeServices.layer),
    );

  it.live(
    "runs a plain project environment with figures, Variables and Tables, and writes nothing into it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const project = makeProject();
          const created = NodeChildProcess.spawnSync(BARE_PYTHON!, ["-m", "venv", ".venv"], {
            cwd: project,
          });
          expect(created.status).toBe(0);
          const python = NodePath.join(
            project,
            ".venv",
            ...(NodeProcess.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]),
          );
          const installed = NodeChildProcess.spawnSync(
            python,
            ["-m", "pip", "install", "--quiet", "numpy", "pandas", "matplotlib"],
            { cwd: project },
          );
          expect(installed.status).toBe(0);
          const binding = yield* pythonRuntimeBinding;
          const [profile] = yield* binding.adapter.discover({
            projectRoot: project,
            configuredExecutable: null,
            refresh: true,
          });
          expect(profile).toMatchObject({ source: "project" });
          const request = { profile: profile!, cwd: project, environment: hostEnvironment() };
          expect((yield* binding.adapter.verify(request)).readiness).toBe("ready");
          const launch = yield* binding.adapter.prepareLaunch(request);
          expect(launch.kernel?.pythonFeatures).toBe(true);
          const session = yield* openSession(
            ComputeLanguageId.make("python"),
            binding.transport,
            launch,
          );
          const run = (code: string, generation = INITIAL_COMPUTE_SESSION_GENERATION) =>
            execute(session, code, generation);
          const paths = text(
            yield* run(
              [
                "import numpy, pandas, sys",
                "frame = pandas.DataFrame({'a': [1, 2], 'b': ['x', 'y']})",
                "print(sys.executable)",
                "print(numpy.__file__)",
              ].join("\n"),
            ),
          );
          expect(paths).toContain(".venv");
          expect(paths.split("\n")[1]).toContain(".venv");
          const figure = "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\nplt.show()";
          expect(hasMedia(yield* run(figure), "image/png")).toBe(true);
          const variables = yield* inspectVariables(session, INITIAL_COMPUTE_SESSION_GENERATION);
          expect(variables.variables).toContainEqual(
            expect.objectContaining({ name: "frame", typeName: "DataFrame" }),
          );
          const table = yield* session.channel.inspectTable({
            requestId: ComputeRequestId.make(`table-${++requests}`),
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
            name: "frame",
            query: { offset: 0, limit: 10, sort: null, search: "" },
          });
          expect(table.rowCount).toBe(2);
          const next = yield* interruptAndRestart(session, "import time\ntime.sleep(60)");
          // Display setup, Variables and figures all come back after a restart.
          expect(hasMedia(yield* run(figure, next), "image/png")).toBe(true);
          yield* run("kept = 1", next);
          expect((yield* inspectVariables(session, next)).variables).toContainEqual(
            expect.objectContaining({ name: "kept" }),
          );
          yield* session.channel.shutdown({ expectedGeneration: next });
          const untouched = NodeChildProcess.spawnSync(python, [
            "-c",
            "import importlib.util, sys; sys.exit(importlib.util.find_spec('ipykernel') is not None)",
          ]);
          expect(untouched.status).toBe(0);
        }),
      ).pipe(Effect.provide(bareLive())),
    SETUP_TIMEOUT_MS,
  );

  it.live(
    "runs SQL with Scient's own DuckDB when no Python here has it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const project = makeProject();
          const binding = yield* pythonRuntimeBinding;
          const sql = makeSqlRuntimeBinding(binding.kernelHost);
          const [profile] = yield* sql.adapter.discover({
            projectRoot: project,
            configuredExecutable: null,
            refresh: true,
          });
          const request = { profile: profile!, cwd: project, environment: hostEnvironment() };
          expect((yield* sql.adapter.verify(request)).readiness).toBe("ready");
          const session = yield* openSession(
            SQL_LANGUAGE_ID,
            sql.transport,
            yield* sql.adapter.prepareLaunch(request),
          );
          const result = yield* execute(session, "SELECT 40 + 2 AS answer;");
          expect(text(result)).toContain("42");
          yield* session.channel.shutdown({
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          });
        }),
      ).pipe(Effect.provide(bareLive())),
    SETUP_TIMEOUT_MS,
  );

  it.live.runIf(runs("R", ["--version"]))(
    "runs R with nothing but R installed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const project = makeProject();
          const python = yield* pythonRuntimeBinding;
          const config = yield* ServerConfig.ServerConfig;
          const binding = yield* makeKernelRuntimeBinding(R_KERNEL_LANGUAGE, {
            host: python.kernelHost,
            computeDir: config.computeDir,
            processes: yield* ExecutionProcess,
            configuredExecutable: () => Effect.succeed(null),
          });
          const [profile] = yield* binding.adapter.discover({
            projectRoot: null,
            configuredExecutable: null,
            refresh: true,
          });
          const request = { profile: profile!, cwd: project, environment: hostEnvironment() };
          expect((yield* binding.adapter.verify(request)).readiness).toBe("ready");
          const session = yield* openSession(
            R_KERNEL_LANGUAGE.languageId,
            binding.transport,
            yield* binding.adapter.prepareLaunch(request),
          );
          expect(text(yield* execute(session, "print(40 + 2)"))).toContain("[1] 42");
          const next = yield* interruptAndRestart(session, "Sys.sleep(60)");
          yield* session.channel.shutdown({ expectedGeneration: next });
        }),
      ).pipe(Effect.provide(bareLive())),
    SETUP_TIMEOUT_MS,
  );
});

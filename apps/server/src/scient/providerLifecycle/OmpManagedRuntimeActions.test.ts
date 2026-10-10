// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveReviewedOmpArtifact } from "@scientfactory/provider-runtime";
import { OmpSettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  canonicalOmpExecutablePath,
  makeOmpExecutableGate,
  OmpExecutableGate,
  type OmpExecutableGateShape,
} from "../../provider/omp/OmpExecutableGate.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  makeOmpManagedRuntimeResolution,
  makeQualifiedManagedOmpRuntime,
  qualifyManagedOmpRuntime,
} from "./OmpManagedRuntimeActions.ts";
import { ompTarget } from "../../provider/omp/OmpTarget.ts";

const artifact = resolveReviewedOmpArtifact({ platform: "darwin", arch: "arm64" })!;

/** Staging stubs: no network, no real binary. */
const dependencies = {
  download: async ({ destination }: { readonly destination: string }) => {
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.writeFile(destination, "omp");
  },
  verify: async () => undefined,
  materialize: async (input: { readonly destination: string; readonly executablePath: string }) => {
    await NodeFSP.mkdir(input.destination, { recursive: true });
    const executable = NodePath.join(input.destination, input.executablePath);
    await NodeFSP.writeFile(executable, "#!/bin/sh\n", { mode: 0o755 });
    return executable;
  },
  smoke: async () => undefined,
};

/** Whether a plain (non-activation) process could lease the executable right now. */
const canLease = (gate: OmpExecutableGateShape, executable: string) =>
  canonicalOmpExecutablePath(executable).pipe(
    Effect.flatMap((identity) =>
      Effect.scoped(gate.acquireProcess(identity, { target: ompTarget, kind: "one-shot" })),
    ),
    Effect.provide(NodeServices.layer),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

describe("managed Oh My Pi activation", () => {
  it.live(
    "holds the executable from after the activation window through commit, without deadlocking its own qualification",
    () =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-managed-"));
        const gate = yield* makeOmpExecutableGate({ processWaitTimeout: "20 millis" });
        const events: Array<string> = [];
        try {
          const runtime = yield* makeQualifiedManagedOmpRuntime({
            baseDir,
            environment: {},
            dependencies,
            qualification: (input) =>
              Effect.gen(function* () {
                // A new process for the staged executable waits and fails...
                events.push(`qualify:plain=${yield* canLease(gate, input.executablePath)}`);
                // ...while the activation's own qualification process is admitted.
                const identity = yield* canonicalOmpExecutablePath(input.executablePath).pipe(
                  Effect.provide(NodeServices.layer),
                );
                const activation = input.activations.find((held) => held.identity === identity);
                yield* Effect.scoped(
                  gate.acquireProcess(identity, {
                    target: ompTarget,
                    kind: "one-shot",
                    activation,
                  }),
                ).pipe(Effect.orDie);
                events.push("qualify:own=true");
              }),
          }).pipe(
            Effect.provideService(OmpExecutableGate, gate),
            Effect.provide(NodeServices.layer),
          );
          const executable = runtime.launchPath(artifact);
          const install = () =>
            Effect.promise(() =>
              runtime.install({
                artifact,
                signal: new AbortController().signal,
                beforeActivate: async () => {
                  // The provider runtime manager's idle window runs before the hold.
                  events.push(
                    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- beforeActivate is the managed runtime's Promise hook; the probe must run inside it.
                    `window:plain=${await Effect.runPromise(canLease(gate, executable))}`,
                  );
                },
              }),
            );

          yield* install();
          // A repair re-activates the same version in place: same identity.
          yield* install();
          expect(events).toEqual([
            "window:plain=true",
            "qualify:plain=false",
            "qualify:own=true",
            "window:plain=true",
            "qualify:plain=false",
            "qualify:own=true",
          ]);
          // Released after commit.
          expect(yield* canLease(gate, executable)).toBe(true);
        } finally {
          NodeFS.rmSync(baseDir, { recursive: true, force: true });
        }
      }),
  );

  it.live(
    "keeps a repair and an upgrade when another Oh My Pi instance reconciles during qualification",
    () =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-managed-"));
        const gate = yield* makeOmpExecutableGate();
        let materialized = 0;
        const counted = {
          ...dependencies,
          materialize: async (input: {
            readonly destination: string;
            readonly executablePath: string;
          }) => {
            materialized += 1;
            await NodeFSP.mkdir(input.destination, { recursive: true });
            const executable = NodePath.join(input.destination, input.executablePath);
            await NodeFSP.writeFile(executable, `install ${materialized}`, { mode: 0o755 });
            return executable;
          },
        };
        const makeRuntime = (
          qualification: Parameters<typeof makeQualifiedManagedOmpRuntime>[0]["qualification"],
        ) =>
          makeQualifiedManagedOmpRuntime({
            baseDir,
            environment: {},
            dependencies: counted,
            ...(qualification ? { qualification } : {}),
          }).pipe(
            Effect.provideService(OmpExecutableGate, gate),
            Effect.provide(NodeServices.layer),
          );
        const upgrade = { ...artifact, version: "18.3.1", catalogRevision: "omp:18.3.1:test" };
        try {
          // A second driver instance's creation reconciles its own runtime
          // object for the same private root.
          const other = yield* makeRuntime(() => Effect.void);
          const reconciled: Array<string> = [];
          const runtime = yield* makeRuntime((input) =>
            Effect.promise(async () => {
              await other.reconcile(artifact);
              await other.reconcile(upgrade);
              reconciled.push(input.expectedVersion);
            }),
          );
          const install = (target: typeof artifact) =>
            Effect.promise(() =>
              runtime.install({ artifact: target, signal: new AbortController().signal }),
            );

          yield* install(artifact);
          const repaired = yield* install(artifact);
          expect(repaired).toMatchObject({ installed: true, activeVersion: artifact.version });
          expect(NodeFS.readFileSync(repaired.launchPath, "utf8")).toBe("install 2");

          const upgraded = yield* install(upgrade);
          expect(upgraded).toMatchObject({ installed: true, activeVersion: "18.3.1" });
          expect(upgraded.launchPath).toBe(runtime.launchPath(upgrade));
          expect(NodeFS.readFileSync(upgraded.launchPath, "utf8")).toBe("install 3");
          expect(reconciled).toEqual([artifact.version, artifact.version, "18.3.1"]);
        } finally {
          NodeFS.rmSync(baseDir, { recursive: true, force: true });
        }
      }),
  );

  it.live("fails the activation while a conversation still holds the managed executable", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-managed-"));
      const gate = yield* makeOmpExecutableGate();
      try {
        const runtime = yield* makeQualifiedManagedOmpRuntime({
          baseDir,
          environment: {},
          dependencies,
          qualification: () => Effect.void,
        }).pipe(Effect.provideService(OmpExecutableGate, gate), Effect.provide(NodeServices.layer));
        yield* Effect.promise(() =>
          runtime.install({ artifact, signal: new AbortController().signal }),
        );
        const identity = yield* canonicalOmpExecutablePath(runtime.launchPath(artifact)).pipe(
          Effect.provide(NodeServices.layer),
        );
        const conversation = yield* Scope.make();
        yield* gate
          .acquireProcess(identity, { target: ompTarget, kind: "session" })
          .pipe(Effect.provideService(Scope.Scope, conversation));
        const failure = yield* Effect.tryPromise(() =>
          runtime.install({ artifact, signal: new AbortController().signal }),
        ).pipe(Effect.flip);
        expect(String(failure.cause)).toContain("open conversation");
        // The previous runtime stays selected.
        const status = yield* Effect.promise(() => runtime.status(artifact));
        expect(status.installed && status.selected).toBe(true);
        yield* Scope.close(conversation, Exit.void);
        yield* Effect.promise(() =>
          runtime.install({ artifact, signal: new AbortController().signal }),
        );
      } finally {
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
      }
    }),
  );
});

const decodeOmpSettings = Schema.decodeEffect(OmpSettings);

/** Records every spawned command and answers `--version` like OMP. */
const recordingSpawner = (spawned: Array<ChildProcess.StandardCommand>) =>
  ChildProcessSpawner.make((command) => {
    spawned.push(command as ChildProcess.StandardCommand);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make("18.2.8\n")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });

/** The environment a spawned child would really see. */
const effectiveChildEnvironment = (command: ChildProcess.StandardCommand) => ({
  ...(command.options.extendEnv === false ? {} : process.env),
  ...command.options.env,
});

/** A custom OMP executable, a gate and a resolution with a recording spawner. */
const probeFixture = Effect.fn("probeFixture")(function* () {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-probe-"));
  const executable = NodePath.join(baseDir, "bin", "omp");
  NodeFS.mkdirSync(NodePath.dirname(executable), { recursive: true });
  NodeFS.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
  const gate = yield* makeOmpExecutableGate({ processWaitTimeout: "50 millis" });
  const spawned: Array<ChildProcess.StandardCommand> = [];
  const resolve = makeOmpManagedRuntimeResolution({
    settings: yield* decodeOmpSettings({ binaryPath: executable }),
    baseDir,
    // The driver passes the already filtered OMP process environment.
    environment: { PATH: process.env.PATH ?? "", HOME: baseDir },
    spawner: recordingSpawner(spawned),
    managedInstallationAllowed: false,
  }).pipe(Effect.provideService(OmpExecutableGate, gate));
  const identity = yield* canonicalOmpExecutablePath(executable).pipe(
    Effect.provide(NodeServices.layer),
  );
  const versionProbes = () => spawned.filter((command) => command.args.includes("--version"));
  return { baseDir, gate, identity, resolve, versionProbes };
});

describe("configured Oh My Pi health probe", () => {
  it.live("does not run the executable while a runtime change holds it", () =>
    Effect.gen(function* () {
      const { baseDir, gate, identity, resolve, versionProbes } = yield* probeFixture();
      try {
        const activation = yield* Scope.make();
        yield* gate
          .acquireActivation(identity, { target: ompTarget })
          .pipe(Effect.provideService(Scope.Scope, activation));
        const during = yield* resolve;
        expect(versionProbes()).toEqual([]);
        expect(during.summary.source).toBe("unknown");
        yield* Scope.close(activation, Exit.void);

        const after = yield* resolve;
        expect(versionProbes()).toHaveLength(1);
        expect(after.summary.source).toBe("custom");
      } finally {
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("runs with the filtered OMP environment, never the server's internals", () =>
    Effect.gen(function* () {
      const canaries = ["T3CODE_PROBE_CANARY", "SCIENT_PROBE_CANARY"] as const;
      for (const name of canaries) process.env[name] = "server-internal";
      const { baseDir, resolve, versionProbes } = yield* probeFixture();
      try {
        expect((yield* resolve).summary.source).toBe("custom");
        const [probe] = versionProbes();
        expect(probe?.options.extendEnv).toBe(false);
        const names = Object.keys(effectiveChildEnvironment(probe!));
        expect(names.filter((name) => /^(T3CODE|SCIENT)_/iu.test(name))).toEqual([]);
      } finally {
        for (const name of canaries) delete process.env[name];
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
      }
    }),
  );
});

/**
 * Stands in for Oh My Pi's RPC startup: like the real binary, it exits with
 * "No models available" unless its agent directory defines a model.
 */
const FAKE_OMP_WITHOUT_LOGINS = `
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) {
  process.stdout.write("omp/18.2.8\\n");
  process.exit(0);
}
const agent = process.env.PI_CODING_AGENT_DIR ?? "";
if (!fs.existsSync(path.join(agent, "models.yml"))) {
  process.stderr.write("No models available. Use /login or set an API key environment variable.\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    const data = request.type === "negotiate_protocol"
      ? { protocolVersion: 2, maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }
      : { isStreaming: false, isCompacting: false };
    process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;

describe("managed Oh My Pi activation check", () => {
  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "gives Oh My Pi a model in its isolated home, so a machine without sign-ins qualifies",
    () =>
      Effect.gen(function* () {
        const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-qualify-"));
        try {
          const executable = NodePath.join(root, "omp");
          NodeFS.writeFileSync(executable, `#!${process.execPath}\n${FAKE_OMP_WITHOUT_LOGINS}`, {
            mode: 0o755,
          });
          const cwd = NodePath.join(root, "work");
          NodeFS.mkdirSync(cwd);
          yield* qualifyManagedOmpRuntime({
            executablePath: executable,
            expectedVersion: "18.2.8",
            cwd,
            environment: { PATH: process.env.PATH ?? "", HOME: root },
            activations: [],
          }).pipe(
            Effect.provideServiceEffect(OmpExecutableGate, makeOmpExecutableGate()),
            Effect.provide(NodeServices.layer),
          );
          const agent = NodePath.join(cwd, "qualification-home", "agent");
          expect(NodeFS.readFileSync(NodePath.join(agent, "models.yml"), "utf8")).toContain(
            "auth: none",
          );
          expect(NodeFS.readFileSync(NodePath.join(agent, "config.yml"), "utf8")).toContain(
            "- ollama",
          );
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }),
  );
});

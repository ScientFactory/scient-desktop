// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import {
  canonicalOmpExecutablePath,
  makeOmpExecutableGate,
  OmpExecutableGate,
} from "./OmpExecutableGate.ts";
import {
  appendOmpStderr,
  emptyOmpStderrTail,
  makeOmpRpcProcess,
  makeOmpRedaction,
  ompRedactionEnvironment,
  ompStderrTail,
  redactOmpDiagnostic,
  redactOmpLogValue,
  ompRpcArgs,
  OMP_RPC_ARGS,
} from "./OmpRpcProcess.ts";
import { ompTarget } from "./OmpTarget.ts";

const toJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

describe("Oh My Pi launch arguments", () => {
  it("adds an explicit session directory without changing the core RPC contract", () => {
    expect(ompRpcArgs()).toEqual([...OMP_RPC_ARGS]);
    expect(OMP_RPC_ARGS).not.toContain("--append-system-prompt");
    expect(ompRpcArgs("/state/omp/session", ["--no-tools"])).toEqual([
      ...OMP_RPC_ARGS,
      "--session-dir",
      "/state/omp/session",
      "--no-tools",
    ]);
  });

  it("redacts common credential forms from diagnostics", () => {
    const value = redactOmpDiagnostic(
      "HOME=/Users/alice API_KEY=super-secret Bearer abc.def-ghi sk-test-1234567890",
      {
        HOME: "/Users/alice",
        API_KEY: "super-secret",
      },
    );
    expect(value).not.toContain("/Users/alice");
    expect(value).not.toContain("super-secret");
    expect(value).not.toContain("abc.def-ghi");
    expect(value).not.toContain("sk-test-1234567890");
  });

  it("redacts bootstrap-delivered secrets that never enter the environment", () => {
    // Keys, the models token and the MCP bearer reach OMP in a bootstrap
    // file, so redaction must know them without an environment variable.
    const env = ompRedactionEnvironment({ PATH: "/usr/bin" }, [
      "Bearer mcp-session-token-42",
      "plainmodelkey987654",
      null,
      undefined,
    ]);
    expect(env.PATH).toBe("/usr/bin");
    const value = redactOmpDiagnostic(
      "auth=mcp-session-token-42 header=Bearer mcp-session-token-42 key=plainmodelkey987654",
      env,
    );
    expect(value).not.toContain("mcp-session-token-42");
    expect(value).not.toContain("plainmodelkey987654");
    const frame = toJson(
      redactOmpLogValue({ type: "notice", message: "rejected plainmodelkey987654" }, env),
    );
    expect(frame).not.toContain("plainmodelkey987654");
  });

  it("replaces only exact secrets in content, and never short placeholder keys", () => {
    const redaction = makeOmpRedaction(
      { HOME: "/Users/alice", OPENAI_API_KEY: "env-provider-key-123", GIT_AUTHOR_NAME: "Alice" },
      ["Bearer mcp-session-token-42", "customlivekey-0123456789abcdef", "ollama"],
    );
    const content = {
      text: "Alice at /Users/alice used customlivekey-0123456789abcdef with ollama",
      nested: [{ header: "Bearer mcp-session-token-42", env: "env-provider-key-123" }],
    };
    expect(redaction.exact(content)).toEqual({
      text: "Alice at /Users/alice used [REDACTED] with ollama",
      nested: [{ header: "[REDACTED]", env: "[REDACTED]" }],
    });
    const clean = { text: "nothing secret", list: ["a"] };
    expect(redaction.exact(clean)).toBe(clean);
    // Diagnostic text is redacted more broadly.
    expect(redaction.text("ollama rejected mcp-session-token-42 in /Users/alice")).toBe(
      "[REDACTED] rejected [REDACTED] in ~",
    );
  });

  it("redacts credentials, image data and typed answers from logged frames", () => {
    const env = { SCIENT_OMP_MODELS_TOKEN: "models-token-0123456789", HOME: "/Users/alice" };
    const image = "A".repeat(4096);
    const redacted = toJson(
      redactOmpLogValue(
        [
          {
            type: "prompt",
            id: "7",
            message: "see /Users/alice/plot.png with models-token-0123456789",
            images: [{ type: "image", data: image, mimeType: "image/png" }],
          },
          { type: "extension_ui_response", id: "ui-1", value: "sk-typed-into-a-login-prompt" },
          {
            type: "response",
            command: "get_available_models",
            success: true,
            data: {
              models: [
                {
                  provider: "custom",
                  apiKey: "plain-key",
                  headers: { Authorization: "Bearer header-token", "X-Api-Key": "x-key" },
                },
              ],
              note: "failed with Bearer abc.def-ghi",
            },
          },
        ],
        env,
      ),
    );
    for (const secret of [
      image,
      "models-token-0123456789",
      "/Users/alice",
      "sk-typed-into-a-login-prompt",
      "plain-key",
      "header-token",
      "x-key",
      "abc.def-ghi",
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('"omittedBase64Characters":4096');
    expect(redacted).toContain('"mimeType":"image/png"');
    expect(redacted).toContain('"command":"get_available_models"');
    expect(redacted).toContain('"type":"extension_ui_response"');
  });

  it.effect("reports redacted protocol frames in both directions", () =>
    Effect.gen(function* () {
      const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-frame-log-${process.pid}`);
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.mkdirSync(root, { recursive: true });
      const binary = NodePath.join(root, "omp");
      NodeFS.writeFileSync(binary, "frames");
      const secret = "provider-secret-0123456789";
      const encoder = new TextEncoder();
      const ready = {
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1_048_576,
        maxReassembledFrameBytes: 67_108_864,
        diagnostic: `started with ${secret}`,
      };
      const spawner = ChildProcessSpawner.make((command) => {
        const child = command as unknown as { readonly args: ReadonlyArray<string> };
        const isVersionProbe = child.args.includes("--version");
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(!isVersionProbe),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: isVersionProbe
              ? Stream.make(encoder.encode("omp/18.3.1\n"))
              : // The RPC child stays up after its ready frame.
                Stream.concat(Stream.make(encoder.encode(`${toJson(ready)}\n`)), Stream.never),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });
      const traced: Array<{ readonly direction: string; readonly frame: unknown }> = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const process = yield* makeOmpRpcProcess({
            target: ompTarget,
            command: binary,
            env: { PATH: "/usr/bin", PROVIDER_API_KEY: secret },
            onFrame: (trace) => Effect.sync(() => traced.push(trace)),
          });
          yield* process.ready;
          yield* Effect.sleep("50 millis");
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(OmpExecutableGate, yield* makeOmpExecutableGate()),
        ),
      );
      expect(traced.map((trace) => trace.direction)).toEqual(["inbound", "outbound"]);
      expect(traced[1]?.frame).toMatchObject({ type: "negotiate_protocol", protocolVersion: 2 });
      expect(toJson(traced)).not.toContain(secret);
      expect(toJson(traced)).toContain("[REDACTED]");
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer), TestClock.withLive),
  );

  it.effect("redacts every stderr chunk before the tail is truncated", () =>
    Effect.gen(function* () {
      const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-stderr-${process.pid}`);
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.mkdirSync(root, { recursive: true });
      const binary = NodePath.join(root, "omp");
      NodeFS.writeFileSync(binary, "stderr");
      const secret = "pk-live-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV";
      const encoder = new TextEncoder();
      // The secret straddles a chunk boundary, and enough output follows it
      // that a raw 4 KiB tail would start inside the secret.
      const stderr = [
        `provider rejected key ${secret.slice(0, 30)}`,
        `${secret.slice(30)}\n${"y".repeat(4096 - 10)}\n`,
      ];
      const spawner = ChildProcessSpawner.make((command) => {
        const child = command as unknown as { readonly args: ReadonlyArray<string> };
        const isVersionProbe = child.args.includes("--version");
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(isVersionProbe ? 0 : 1)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(isVersionProbe ? encoder.encode("omp/18.3.0\n") : new Uint8Array()),
            stderr: isVersionProbe
              ? Stream.empty
              : Stream.fromIterable(stderr.map((chunk) => encoder.encode(chunk))),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const process = yield* makeOmpRpcProcess({
            target: ompTarget,
            command: binary,
            env: { PATH: "/usr/bin", PROVIDER_API_KEY: secret },
          });
          yield* Effect.sleep("50 millis");
          return yield* process.shutdown;
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(OmpExecutableGate, yield* makeOmpExecutableGate()),
        ),
      );
      expect(exit.stderrTail.length).toBeLessThanOrEqual(4096);
      expect(exit.stderrTail).toContain("yyyy");
      for (let start = 0; start + 8 <= secret.length; start += 1) {
        expect(exit.stderrTail).not.toContain(secret.slice(start, start + 8));
      }
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer), TestClock.withLive),
  );

  it("redacts a secret split across stderr chunks and never emits a partial one", () => {
    const env = { OPENAI_API_KEY: "sk-proj-abcdefghijklmnopqrstuvwxyz0123" };
    let state = emptyOmpStderrTail;
    for (const chunk of [
      "error: Bearer tok",
      "en-value-123 key=sk-proj-abcdefghij",
      "klmnopqrstuvwxyz0123\n",
    ]) {
      state = appendOmpStderr(state, chunk, env);
      // Nothing pending is ever part of the redacted tail.
      expect(state.redacted).not.toContain("sk-proj-abc");
    }
    const tail = ompStderrTail(state, env);
    expect(tail).not.toContain("abcdefghij");
    expect(tail).not.toContain("token-value-123");
    expect(tail).toContain("[REDACTED]");
    // A whitespace-free run too long to hold is dropped, not cut into a fragment.
    let long = appendOmpStderr(emptyOmpStderrTail, "x".repeat(9000), env);
    long = appendOmpStderr(long, `${"x".repeat(10)} done\n`, env);
    expect(ompStderrTail(long, env)).not.toMatch(/x{20}/u);
    expect(ompStderrTail(long, env)).toContain("done");
  });

  it.effect("refreshes the version cache when the executable changes in place", () =>
    Effect.gen(function* () {
      const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-version-cache-${process.pid}`);
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.mkdirSync(root, { recursive: true });
      const binary = NodePath.join(root, "omp");
      NodeFS.writeFileSync(binary, "first");
      const gate = yield* makeOmpExecutableGate();
      let versionProbes = 0;
      const encoder = new TextEncoder();
      const spawner = ChildProcessSpawner.make((command) => {
        const child = command as unknown as { readonly args: ReadonlyArray<string> };
        const isVersionProbe = child.args.includes("--version");
        if (isVersionProbe) versionProbes += 1;
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            // The RPC child has nothing to say and exits once Scient closes it.
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(!isVersionProbe),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(isVersionProbe ? encoder.encode("omp/18.3.0\n") : new Uint8Array()),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });
      const start = Effect.scoped(
        makeOmpRpcProcess({
          target: ompTarget,
          command: binary,
          env: { PATH: "/usr/bin" },
          extraArgs: ["--no-tools"],
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(OmpExecutableGate, gate),
        ),
      );

      yield* start;
      yield* start;
      expect(versionProbes).toBe(1);

      NodeFS.writeFileSync(binary, "replacement-with-a-different-size");
      NodeFS.utimesSync(binary, 1_000_000, 1_000_000);
      yield* start;
      expect(versionProbes).toBe(2);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses an unsupported future major", () =>
    Effect.gen(function* () {
      const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-future-major-${process.pid}`);
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.mkdirSync(root, { recursive: true });
      const binary = NodePath.join(root, "omp");
      NodeFS.writeFileSync(binary, "future");
      const encoder = new TextEncoder();
      const spawner = ChildProcessSpawner.make((command) => {
        const child = command as unknown as { readonly args: ReadonlyArray<string> };
        const isVersionProbe = child.args.includes("--version");
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: isVersionProbe
              ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
              : Effect.never,
            isRunning: Effect.succeed(!isVersionProbe),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(
              isVersionProbe ? encoder.encode("omp/19.0.0-beta.1\n") : new Uint8Array(),
            ),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });
      const error = yield* Effect.scoped(
        makeOmpRpcProcess({ target: ompTarget, command: binary, env: { PATH: "/usr/bin" } }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(OmpExecutableGate, yield* makeOmpExecutableGate()),
          Effect.flip,
        ),
      );
      expect(error.message).toMatch(/18\.x releases/u);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  /** Answers `--version` with 18.3.0 and keeps every RPC child alive. */
  const fakeOmp = (spawned: Array<string>) =>
    ChildProcessSpawner.make((command) => {
      const child = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      const isVersionProbe = child.args.includes("--version");
      spawned.push([child.command, ...child.args].join(" "));
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: isVersionProbe ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Effect.never,
          isRunning: Effect.succeed(!isVersionProbe),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(
            isVersionProbe ? new TextEncoder().encode("omp/18.3.0\n") : new Uint8Array(),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });

  it.live(
    "leases the real executable for a PATH lookup, a symlink, and a managed path before spawning",
    () =>
      Effect.gen(function* () {
        const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-gate-"));
        try {
          const realDirectory = NodePath.join(root, "cellar", "omp", "18.3.0", "bin");
          const linkDirectory = NodePath.join(root, "bin");
          NodeFS.mkdirSync(realDirectory, { recursive: true });
          NodeFS.mkdirSync(linkDirectory, { recursive: true });
          const real = NodePath.join(realDirectory, "omp");
          NodeFS.writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
          NodeFS.symlinkSync(real, NodePath.join(linkDirectory, "omp"));
          const managed = NodePath.join(
            root,
            "provider-runtimes",
            "omp",
            "versions",
            "18.3.0",
            "darwin-arm64",
            "omp",
          );
          NodeFS.mkdirSync(NodePath.dirname(managed), { recursive: true });
          NodeFS.writeFileSync(managed, "#!/bin/sh\n", { mode: 0o755 });

          for (const [command, env, executable] of [
            ["omp", { PATH: linkDirectory }, real],
            [NodePath.join(linkDirectory, "omp"), { PATH: "/usr/bin" }, real],
            [managed, { PATH: "/usr/bin" }, managed],
          ] as const) {
            const gate = yield* makeOmpExecutableGate({ processWaitTimeout: "50 millis" });
            const spawned: Array<string> = [];
            const start = makeOmpRpcProcess({ target: ompTarget, command, env }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeOmp(spawned)),
              Effect.provideService(OmpExecutableGate, gate),
              Effect.scoped,
            );
            const identity = yield* canonicalOmpExecutablePath(executable);
            const error = yield* Effect.scoped(
              gate
                .acquireActivation(identity, { target: ompTarget })
                .pipe(Effect.andThen(Effect.flip(start))),
            );
            expect(error.message, command).toContain("Oh My Pi is being updated");
            // The lease comes first: nothing was probed or spawned.
            expect(spawned).toEqual([]);
            yield* start;
            // What was leased is what runs: the resolved path, never a second PATH lookup.
            expect(spawned.length).toBeGreaterThan(0);
            expect(spawned.every((line) => NodePath.isAbsolute(line.split(" ")[0] ?? ""))).toBe(
              true,
            );
          }
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("holds a conversation's lease until its process scope closes", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-lease-"));
      try {
        const binary = NodePath.join(root, "omp");
        NodeFS.writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
        const identity = yield* canonicalOmpExecutablePath(binary);
        const gate = yield* makeOmpExecutableGate();
        const scope = yield* Scope.make();
        yield* makeOmpRpcProcess({
          target: ompTarget,
          command: binary,
          env: { PATH: "/usr/bin" },
          sessionDir: NodePath.join(root, "session"),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeOmp([])),
          Effect.provideService(OmpExecutableGate, gate),
          Effect.provideService(Scope.Scope, scope),
        );
        const refused = yield* Effect.scoped(
          gate.acquireActivation(identity, { target: ompTarget }),
        ).pipe(Effect.flip);
        expect(refused.reason).toBe("conversations-open");
        yield* Scope.close(scope, Exit.void);
        yield* Effect.scoped(gate.acquireActivation(identity, { target: ompTarget }));
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("requires the server's executable gate at the type level", () => {
    // Providing no gate is a compile error rather than a runtime refusal.
    type Requirements = Effect.Services<ReturnType<typeof makeOmpRpcProcess>>;
    const requiresGate: [OmpExecutableGate] extends [Requirements] ? true : false = true;
    expect(requiresGate).toBe(true);
  });
});

/**
 * A fake `omp` whose RPC child exits when the test completes `exited`, or when
 * `exitOnStdinEnd` is set and Scient closes its stdin.
 */
const makeLifecycleSpawner = (input: {
  readonly exited: Deferred.Deferred<number>;
  readonly exitOnStdinEnd: boolean;
  readonly exitOnKill?: boolean;
  readonly killBarrier?: Deferred.Deferred<void>;
  readonly kills: Array<string>;
}) => {
  const encoder = new TextEncoder();
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const child = command as unknown as {
        readonly args: ReadonlyArray<string>;
        readonly options: { readonly stdin?: { readonly stream?: Stream.Stream<Uint8Array> } };
      };
      const isVersionProbe = child.args.includes("--version");
      if (!isVersionProbe && input.exitOnStdinEnd && child.options.stdin?.stream) {
        yield* Stream.runDrain(child.options.stdin.stream).pipe(
          Effect.andThen(Deferred.succeed(input.exited, 0)),
          Effect.forkScoped,
        );
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: isVersionProbe
          ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
          : Deferred.await(input.exited).pipe(Effect.map(ChildProcessSpawner.ExitCode)),
        isRunning: isVersionProbe
          ? Effect.succeed(false)
          : Deferred.isDone(input.exited).pipe(Effect.map((done) => !done)),
        kill: (options) =>
          Effect.sync(() => {
            input.kills.push(String(options?.killSignal ?? "SIGTERM"));
          }).pipe(
            Effect.andThen(
              input.killBarrier !== undefined
                ? Deferred.await(input.killBarrier)
                : input.exitOnKill === false
                  ? Effect.void
                  : Deferred.succeed(input.exited, 143),
            ),
            Effect.asVoid,
          ),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: isVersionProbe ? Stream.make(encoder.encode("omp/18.3.0\n")) : Stream.never,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
};

const makeLifecycleBinary = (label: string) => {
  const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-shutdown-${process.pid}-${label}`);
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.mkdirSync(root, { recursive: true });
  const binary = NodePath.join(root, "omp");
  NodeFS.writeFileSync(binary, label);
  return { root, binary };
};

describe("Oh My Pi process shutdown", () => {
  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "confirms real signal exit without inventing a numeric exit code",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-signal-"));
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
          );
          const binary = NodePath.join(root, "omp");
          NodeFS.writeFileSync(
            binary,
            `#!/bin/sh
if [ "$1" = "--version" ]; then echo "18.4.8"; exit 0; fi
printf '%s\\n' '${toJson({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 })}'
IFS= read -r command
kill -TERM "$$"
`,
            { mode: 0o700 },
          );
          const child = yield* makeOmpRpcProcess({
            target: ompTarget,
            command: binary,
            env: { HOME: root, PATH: "/usr/bin" },
          }).pipe(Effect.provideService(OmpExecutableGate, yield* makeOmpExecutableGate()));
          yield* child.ready;
          expect((yield* Effect.result(child.getState()))._tag).toBe("Failure");
          expect(yield* child.shutdown).toMatchObject({ code: null, exited: true });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.each(
    [false, true].map((killNeverReturns) => ({
      caseTitle: killNeverReturns
        ? "bounds a never-returning native kill without claiming child exit"
        : "retains uncertain shutdown until the exact child exit is observed",
      killNeverReturns,
    })),
  )("$caseTitle", ({ killNeverReturns }) =>
    Effect.gen(function* () {
      const { root, binary } = makeLifecycleBinary(`unknown-exit-${killNeverReturns}`);
      const exited = yield* Deferred.make<number>();
      const killBarrier = yield* Deferred.make<void>();
      const shutdownDone = yield* Deferred.make<void>();
      const kills: Array<string> = [];
      const scope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(exited, 0).pipe(
          Effect.andThen(Deferred.succeed(killBarrier, undefined)),
          Effect.andThen(Scope.close(scope, Exit.void)),
          Effect.andThen(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
        ),
      );
      const child = yield* makeOmpRpcProcess({
        target: ompTarget,
        command: binary,
        env: { PATH: "/usr/bin" },
      }).pipe(
        Effect.provideService(OmpExecutableGate, yield* makeOmpExecutableGate()),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeLifecycleSpawner({
            exited,
            exitOnStdinEnd: false,
            exitOnKill: false,
            ...(killNeverReturns ? { killBarrier } : {}),
            kills,
          }),
        ),
        Effect.provideService(Scope.Scope, scope),
      );
      // The native API never returns during the deadline. Only fixture teardown
      // releases its barrier, so a missing deadline fails without leaking a fiber.
      const shutdown = yield* child.shutdown.pipe(
        Effect.tap(() => Deferred.succeed(shutdownDone, undefined)),
        Effect.forkIn(scope),
      );
      yield* TestClock.adjust(killNeverReturns ? "8 seconds" : "5 seconds");
      expect(yield* Deferred.isDone(shutdownDone)).toBe(true);
      expect(yield* Fiber.join(shutdown)).toMatchObject({
        code: null,
        exited: false,
        forced: true,
      });
      expect(kills).toEqual(["SIGTERM"]);
      expect(yield* child.shutdown).toMatchObject({ code: null, exited: false });
      yield* Deferred.succeed(exited, 0);
      expect(yield* child.shutdown).toMatchObject({ code: null, exited: true });
      expect(kills).toEqual(["SIGTERM"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("completes a second shutdown after the first leader was interrupted", () =>
    Effect.gen(function* () {
      const { root, binary } = makeLifecycleBinary("interrupted-leader");
      const exited = yield* Deferred.make<number>();
      const kills: Array<string> = [];
      const scope = yield* Scope.make("sequential");
      const process = yield* makeOmpRpcProcess({
        target: ompTarget,
        command: binary,
        env: { PATH: "/usr/bin" },
      }).pipe(
        Effect.provideService(OmpExecutableGate, yield* makeOmpExecutableGate()),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeLifecycleSpawner({ exited, exitOnStdinEnd: false, kills }),
        ),
        Effect.provideService(Scope.Scope, scope),
      );
      const leader = yield* process.shutdown.pipe(Effect.forkScoped);
      for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
      // The caller that started shutdown goes away while the child is exiting.
      const interrupted = yield* Fiber.interrupt(leader).pipe(Effect.forkScoped);
      for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
      yield* Deferred.succeed(exited, 0);
      yield* Fiber.join(interrupted);
      const second = yield* process.shutdown.pipe(Effect.timeout("1 second"), TestClock.withLive);
      expect(second).toMatchObject({ code: 0, forced: false });
      yield* Scope.close(scope, Exit.void);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("shuts the child down when its scope closes", () =>
    Effect.gen(function* () {
      const { root, binary } = makeLifecycleBinary("scope-close");
      const exited = yield* Deferred.make<number>();
      const kills: Array<string> = [];
      yield* Effect.scoped(
        makeOmpRpcProcess({ target: ompTarget, command: binary, env: { PATH: "/usr/bin" } }).pipe(
          Effect.provideService(OmpExecutableGate, yield* makeOmpExecutableGate()),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeLifecycleSpawner({ exited, exitOnStdinEnd: true, kills }),
          ),
        ),
      );
      // Closing stdin let the child exit on its own before the scope ended.
      expect(yield* Deferred.isDone(exited)).toBe(true);
      expect(yield* Deferred.await(exited)).toBe(0);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "R1-unverified-1 ends the event stream when the child exits but stdout stays open",
    () =>
      Effect.gen(function* () {
        const { root, binary } = makeLifecycleBinary("exit-open-stdout");
        const exited = yield* Deferred.make<number>();
        const kills: Array<string> = [];
        const scope = yield* Scope.make("sequential");
        // A descendant still holds the child's stdout, so it never reaches EOF.
        const process = yield* makeOmpRpcProcess({
          target: ompTarget,
          command: binary,
          env: { PATH: "/usr/bin" },
        }).pipe(
          Effect.provideService(OmpExecutableGate, yield* makeOmpExecutableGate()),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeLifecycleSpawner({ exited, exitOnStdinEnd: false, kills }),
          ),
          Effect.provideService(Scope.Scope, scope),
        );
        const drained = yield* Stream.runDrain(process.events).pipe(Effect.forkScoped);
        for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
        yield* Deferred.succeed(exited, 1);
        for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
        yield* TestClock.adjust("5 seconds");
        const ended = yield* Fiber.await(drained).pipe(
          Effect.timeout("1 second"),
          Effect.exit,
          TestClock.withLive,
        );
        expect(ended._tag).toBe("Success");
        expect(kills).toEqual([]);
        yield* Scope.close(scope, Exit.void);
        NodeFS.rmSync(root, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not run the shutdown in the fiber that closes the client", () =>
    Effect.gen(function* () {
      const { root, binary } = makeLifecycleBinary("client-close");
      const exited = yield* Deferred.make<number>();
      const kills: Array<string> = [];
      const scope = yield* Scope.make("sequential");
      const process = yield* makeOmpRpcProcess({
        target: ompTarget,
        command: binary,
        env: { PATH: "/usr/bin" },
      }).pipe(
        Effect.provideService(OmpExecutableGate, yield* makeOmpExecutableGate()),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeLifecycleSpawner({ exited, exitOnStdinEnd: false, kills }),
        ),
        Effect.provideService(Scope.Scope, scope),
      );
      // A protocol failure closes the client from whichever fiber noticed it.
      // That fiber must not wait out the child's shutdown grace period.
      const closed = yield* process
        .close()
        .pipe(Effect.timeout("500 millis"), Effect.exit, TestClock.withLive);
      expect(closed._tag).toBe("Success");
      yield* Deferred.succeed(exited, 0);
      yield* Scope.close(scope, Exit.void);
      expect(yield* process.shutdown).toMatchObject({ code: 0 });
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

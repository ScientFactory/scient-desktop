// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  makeOmpRpcProcess,
  redactOmpDiagnostic,
  ompRpcArgs,
  OMP_RPC_ARGS,
} from "./OmpRpcProcess.ts";

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

  it.effect("refreshes the version cache when the executable changes in place", () =>
    Effect.gen(function* () {
      const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-version-cache-${process.pid}`);
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.mkdirSync(root, { recursive: true });
      const binary = NodePath.join(root, "omp");
      NodeFS.writeFileSync(binary, "first");
      let versionProbes = 0;
      const encoder = new TextEncoder();
      const spawner = ChildProcessSpawner.make((command) => {
        const child = command as unknown as { readonly args: ReadonlyArray<string> };
        const isVersionProbe = child.args.includes("--version");
        if (isVersionProbe) versionProbes += 1;
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
          command: binary,
          env: { PATH: "/usr/bin" },
          extraArgs: ["--no-tools"],
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
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
});

import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../../processRunner.ts";
import { LatexToolchain, make, parseLatexToolchainVersion } from "./LatexToolchain.ts";

// Verbatim engine banners; the parser must survive their prose, not a fixture.
const LATEXMK_BANNER = "\nLatexmk, John Collins, 27 Jan. 2023. Version 4.79\n";
const TECTONIC_BANNER = "Tectonic 0.15.0\n";

const output = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const spawnFailure = (command: string) =>
  Effect.fail(
    new ProcessRunner.ProcessSpawnError({
      command,
      argumentCount: 1,
      cause: new Error("spawn ENOENT"),
    }),
  );

interface RunnerHarness {
  readonly layer: Layer.Layer<LatexToolchain>;
  readonly calls: Ref.Ref<ReadonlyArray<string>>;
}

const harness = (
  respond: (
    command: string,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Ref.update(calls, (previous) => [...previous, input.command]).pipe(
          Effect.andThen(respond(input.command)),
        ),
    });
    return {
      layer: Layer.effect(LatexToolchain, make).pipe(
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
      ),
      calls,
    } satisfies RunnerHarness;
  });

describe("parseLatexToolchainVersion", () => {
  it("reads the version out of each engine's own banner", () => {
    expect(parseLatexToolchainVersion("latexmk", LATEXMK_BANNER)).toBe("4.79");
    expect(parseLatexToolchainVersion("tectonic", TECTONIC_BANNER)).toBe("0.15.0");
  });

  it("falls back to a loose version and tolerates an unreadable banner", () => {
    expect(parseLatexToolchainVersion("tectonic", "tectonic-cli 0.14.1 (custom build)")).toBe(
      "0.14.1",
    );
    expect(parseLatexToolchainVersion("latexmk", "no version here")).toBeNull();
  });
});

describe("LatexToolchain", () => {
  it.effect("prefers latexmk and reports its version", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* harness((command) =>
        command === "latexmk" ? Effect.succeed(output(LATEXMK_BANNER)) : spawnFailure(command),
      );
      const status = yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        return yield* toolchain.probe(false);
      }).pipe(Effect.provide(layer));

      expect(status.kind).toBe("latexmk");
      expect(status.executable).toBe("latexmk");
      expect(status.version).toBe("4.79");
      expect(yield* Ref.get(calls)).toEqual(["latexmk"]);
    }),
  );

  it.effect("treats a spawn failure as an absent candidate and falls through to tectonic", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* harness((command) =>
        command === "tectonic" ? Effect.succeed(output(TECTONIC_BANNER)) : spawnFailure(command),
      );
      const status = yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        return yield* toolchain.probe(false);
      }).pipe(Effect.provide(layer));

      expect(status.kind).toBe("tectonic");
      expect(status.version).toBe("0.15.0");
      expect(yield* Ref.get(calls)).toEqual(["latexmk", "tectonic"]);
    }),
  );

  it.effect("reports no toolchain when neither engine can be spawned", () =>
    Effect.gen(function* () {
      const { layer } = yield* harness((command) => spawnFailure(command));
      const status = yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        return yield* toolchain.probe(false);
      }).pipe(Effect.provide(layer));

      expect(status).toMatchObject({ kind: null, executable: null, version: null });
    }),
  );

  it.effect("serves a cached answer inside the TTL and re-probes once it lapses", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* harness(() => Effect.succeed(output(LATEXMK_BANNER)));
      yield* Effect.gen(function* () {
        const toolchain = yield* LatexToolchain;
        const first = yield* toolchain.probe(false);
        yield* TestClock.adjust(Duration.minutes(1));
        const cached = yield* toolchain.probe(false);
        expect(cached.probedAtEpochMs).toBe(first.probedAtEpochMs);
        expect(yield* Ref.get(calls)).toHaveLength(1);

        yield* TestClock.adjust(Duration.minutes(6));
        const refreshed = yield* toolchain.probe(false);
        expect(refreshed.probedAtEpochMs).toBeGreaterThan(first.probedAtEpochMs);
        expect(yield* Ref.get(calls)).toHaveLength(2);

        yield* toolchain.probe(true);
        expect(yield* Ref.get(calls)).toHaveLength(3);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

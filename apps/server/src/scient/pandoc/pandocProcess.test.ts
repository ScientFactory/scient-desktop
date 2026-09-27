// @effect-diagnostics nodeBuiltinImport:off -- Probes the fake Pandoc's pid and scratch directories on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import {
  makePandocScratch,
  pandocEnvironment,
  parsePandocWarnings,
  runPandoc,
  type PandocLimits,
} from "./pandocProcess.ts";
import { fakePandoc, processExists, readPid } from "./pandocTestSupport.ts";

const LIMITS: PandocLimits = {
  timeout: "20 seconds",
  maxHeapMb: 1024,
  maxStdoutBytes: 1024 * 1024,
};

const EnvReport = Schema.fromJsonString(
  Schema.Struct({
    env: Schema.Record(Schema.String, Schema.String),
    args: Schema.Array(Schema.String),
    cwd: Schema.String,
  }),
);

const decodeEnvReport = Schema.decodeUnknownEffect(EnvReport);

const harness = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-pandoc-run-" });
  const scratchRoot = NodePath.join(directory, "scratch");
  const pidFile = NodePath.join(directory, "pid");
  return { directory, scratchRoot, pidFile, fake: fakePandoc(pidFile) };
});

const runOnce = (input: {
  readonly scratchRoot: string;
  readonly pandoc: ReturnType<ReturnType<typeof fakePandoc>>;
  readonly stdin?: string;
  readonly limits?: PandocLimits;
  readonly stdoutPath?: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scratch = yield* makePandocScratch(input.scratchRoot).pipe(Effect.orDie);
      const hostEnvironment = yield* HostProcessEnvironment;
      return yield* runPandoc({
        pandoc: input.pandoc,
        args: ["--sandbox", "-f", "json", "-t", "docx"],
        stdin: new TextEncoder().encode(input.stdin ?? ""),
        scratch,
        limits: input.limits ?? LIMITS,
        platform: yield* HostProcessPlatform,
        hostEnvironment: { ...hostEnvironment, SCIENT_PARENT_SECRET: "FAKE-SECRET-ENV" },
        ...(input.stdoutPath === undefined ? {} : { stdoutPath: input.stdoutPath }),
      });
    }),
  );

const scratchEntries = (scratchRoot: string) =>
  NodeFS.existsSync(scratchRoot) ? NodeFS.readdirSync(scratchRoot) : [];

describe("pandocEnvironment", () => {
  it("builds the environment from scratch, with dead proxies and no PATH", () => {
    const scratch = {
      root: "/s",
      home: "/s/home",
      data: "/s/data",
      work: "/s/work",
      tmp: "/s/tmp",
    };
    const env = pandocEnvironment({
      scratch,
      platform: "darwin",
      hostEnvironment: { PATH: "/usr/bin", HOME: "/Users/someone", SECRET: "x" },
    });
    expect(env.PATH).toBe("");
    expect(env.HOME).toBe("/s/home");
    expect(env.XDG_DATA_HOME).toBe("/s/data");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:9");
    expect(env).not.toHaveProperty("SECRET");
    expect(env).not.toHaveProperty("SYSTEMROOT");
  });

  it("passes only SYSTEMROOT through on Windows", () => {
    const scratch = {
      root: "C:\\s",
      home: "C:\\s\\home",
      data: "C:\\s\\data",
      work: "C:\\s\\work",
      tmp: "C:\\s\\tmp",
    };
    const env = pandocEnvironment({
      scratch,
      platform: "win32",
      hostEnvironment: { SystemRoot: "D:\\Windows", USERPROFILE: "C:\\Users\\someone" },
    });
    expect(env.SYSTEMROOT).toBe("D:\\Windows");
    expect(env.USERPROFILE).toBe("C:\\s\\home");
    expect(env.APPDATA).toBe("C:\\s\\data");
  });
});

describe("parsePandocWarnings", () => {
  it("joins continuation lines and ignores other output", () => {
    expect(
      parsePandocWarnings(
        "[WARNING] Could not fetch resource x\n  because of y\nplain line\n[INFO] Loaded z\n",
      ),
    ).toEqual(["Could not fetch resource x because of y", "Loaded z"]);
  });
});

describe("runPandoc", () => {
  it.live("feeds stdin, collects stdout, and removes the scratch directory", () =>
    Effect.gen(function* () {
      const { scratchRoot, fake } = yield* harness;
      const output = yield* runOnce({ scratchRoot, pandoc: fake("echo"), stdin: "hello pandoc" });
      expect(new TextDecoder().decode(output.stdout)).toBe("hello pandoc");
      expect(output.stdoutBytes).toBe(12);
      expect(scratchEntries(scratchRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("runs in the scratch directory with nothing inherited and the heap limit set", () =>
    Effect.gen(function* () {
      const { scratchRoot, fake } = yield* harness;
      const output = yield* runOnce({ scratchRoot, pandoc: fake("env") });
      const report = yield* decodeEnvReport(new TextDecoder().decode(output.stdout));
      expect(report.env.SCIENT_PARENT_SECRET).toBeUndefined();
      expect(report.env.PATH).toBe("");
      expect(report.cwd.startsWith(NodeFS.realpathSync(scratchRoot))).toBe(true);
      expect(report.cwd.endsWith("work")).toBe(true);
      expect(report.env.HOME?.startsWith(scratchRoot)).toBe(true);
      expect(report.args).toEqual([
        "--sandbox",
        "-f",
        "json",
        "-t",
        "docx",
        "+RTS",
        "-M1024m",
        "-RTS",
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("maps Pandoc's exit codes and keeps its warnings", () =>
    Effect.gen(function* () {
      const { scratchRoot, fake } = yield* harness;
      const reasons = yield* Effect.forEach([64, 61, 251, 1], (code) =>
        runOnce({ scratchRoot, pandoc: fake(`exit:${code}`) }).pipe(
          Effect.flip,
          Effect.map((error) => [error.reason, error.exitCode] as const),
        ),
      );
      expect(reasons).toEqual([
        ["parse-error", 64],
        ["fetch-refused", 61],
        ["heap-limit", 251],
        ["failed", 1],
      ]);
      expect(scratchEntries(scratchRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("kills Pandoc when it overruns its output limit", () =>
    Effect.gen(function* () {
      const { scratchRoot, fake, pidFile } = yield* harness;
      const error = yield* runOnce({
        scratchRoot,
        pandoc: fake("flood"),
        limits: { ...LIMITS, maxStdoutBytes: 256 * 1024 },
      }).pipe(Effect.flip);
      expect(error.reason).toBe("output-limit");
      const pid = readPid(pidFile);
      expect(pid).not.toBeNull();
      expect(processExists(pid!)).toBe(false);
      expect(scratchEntries(scratchRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("kills Pandoc when it runs past its timeout", () =>
    Effect.gen(function* () {
      const { scratchRoot, fake, pidFile } = yield* harness;
      const error = yield* runOnce({
        scratchRoot,
        pandoc: fake("sleep"),
        limits: { ...LIMITS, timeout: "700 millis" },
      }).pipe(Effect.flip);
      expect(error.reason).toBe("timeout");
      const pid = readPid(pidFile);
      expect(pid).not.toBeNull();
      expect(processExists(pid!)).toBe(false);
      expect(scratchEntries(scratchRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("kills Pandoc and removes its scratch directory when cancelled", () =>
    Effect.gen(function* () {
      const { scratchRoot, fake, pidFile } = yield* harness;
      const fiber = yield* Effect.forkChild(runOnce({ scratchRoot, pandoc: fake("sleep") }));
      for (let attempt = 0; attempt < 200 && readPid(pidFile) === null; attempt += 1) {
        yield* Effect.sleep("10 millis");
      }
      const pid = readPid(pidFile);
      expect(pid).not.toBeNull();
      expect(processExists(pid!)).toBe(true);
      const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)));
      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(processExists(pid!)).toBe(false);
      expect(scratchEntries(scratchRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("streams stdout into a file when asked, under the same limit", () =>
    Effect.gen(function* () {
      const { directory, scratchRoot, fake } = yield* harness;
      const target = NodePath.join(directory, "out.bin");
      const output = yield* runOnce({
        scratchRoot,
        pandoc: fake("echo"),
        stdin: "streamed",
        stdoutPath: target,
      });
      expect(output.stdout.byteLength).toBe(0);
      expect(output.stdoutBytes).toBe(8);
      expect(NodeFS.readFileSync(target, "utf8")).toBe("streamed");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("reports a failed output file write without leaving Pandoc running", () =>
    Effect.gen(function* () {
      const { directory, scratchRoot, fake, pidFile } = yield* harness;
      const error = yield* runOnce({
        scratchRoot,
        pandoc: fake("echo"),
        stdin: "test output",
        stdoutPath: directory,
        limits: { ...LIMITS, timeout: "3 seconds" },
      }).pipe(Effect.flip);
      expect(error.reason).toBe("failed");
      expect(error.detail).toContain("Writing Pandoc's output failed");
      const pid = readPid(pidFile);
      // The output error can arrive before the child has executed its first line.
      if (pid !== null) expect(processExists(pid)).toBe(false);
      expect(scratchEntries(scratchRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

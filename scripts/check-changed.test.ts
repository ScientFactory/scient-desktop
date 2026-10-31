// @effect-diagnostics nodeBuiltinImport:off -- exercises the real CLI in isolated Git directories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import { defaultConcurrency, gitLines, runSteps, type Step } from "./check-changed.ts";

const GiB = 1024 ** 3;

function setup() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-changed-check-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const write = (file: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, file), text);
  };
  git("init", "--quiet");
  const emptyTree = NodeChildProcess.execFileSync(
    "git",
    ["hash-object", "-w", "-t", "tree", "--stdin"],
    { cwd: root, input: "", encoding: "utf8" },
  ).trim();
  write(
    "scripts/check-changed.ts",
    NodeFS.readFileSync(new URL("./check-changed.ts", import.meta.url), "utf8"),
  );
  write(
    ".github/scripts/ci-changes.cjs",
    NodeFS.readFileSync(new URL("../.github/scripts/ci-changes.cjs", import.meta.url), "utf8"),
  );
  write("pnpm-workspace.yaml", "packages:\n");
  write("package.json", '{"type":"module","scripts":{"knip:check":"knip --include files"}}\n');
  NodeFS.mkdirSync(NodePath.join(root, "node_modules"), { recursive: true });
  // The script's own dependencies (Effect, typescript-legacy) resolve beside it.
  NodeFS.symlinkSync(
    NodeURL.fileURLToPath(new URL("./node_modules/", import.meta.url)),
    NodePath.join(root, "scripts/node_modules"),
    "junction",
  );
  write(
    ".git/info/exclude",
    "/scripts/\n/node_modules/\n/pnpm-workspace.yaml\n/package.json\n/preload.mjs\n/calls.jsonl\n/.github/scripts/ci-changes.cjs\n",
  );
  // Only the base lookup and expensive vp gates are replaced. Path output comes
  // from real Git; Node-runner tests execute in a real child process.
  write(
    "preload.mjs",
    `
import ChildProcess from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const spawn = ChildProcess.spawn;
// Stand-ins are real child processes, so the Effect spawner sees ordinary exits.
const exitWith = (stdout, options) =>
  spawn(process.execPath, ["-e", \`process.stdout.write(\${JSON.stringify(stdout)})\`], options);
ChildProcess.spawn = (command, args, options) => {
  if (command === "git" && args.includes("merge-base")) {
    return exitWith(${JSON.stringify(emptyTree + "\n")}, options);
  }
  if (command !== "vp") return spawn(command, args, options);
  fs.appendFileSync(new URL("./calls.jsonl", import.meta.url), JSON.stringify(args) + "\\n");
  return exitWith("", options);
};
syncBuiltinESMExports();
`,
  );
  return {
    write,
    git,
    run: () =>
      NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--import",
          NodePath.join(root, "preload.mjs"),
          NodePath.join(root, "scripts/check-changed.ts"),
        ],
        { cwd: root, encoding: "utf8" },
      ),
    calls: () => {
      const file = NodePath.join(root, "calls.jsonl");
      return NodeFS.existsSync(file)
        ? NodeFS.readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[])
        : [];
    },
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

describe("check:changed", () => {
  it("bounds the default concurrency by the scarcer of cores and available memory", () => {
    assert.strictEqual(defaultConcurrency(32, 128 * GiB), 16);
    assert.strictEqual(defaultConcurrency(32, 20 * GiB), 3);
    assert.strictEqual(defaultConcurrency(4, 15 * GiB), 2);
    assert.strictEqual(defaultConcurrency(4, 2 * GiB), 1);
    assert.strictEqual(defaultConcurrency(1, 64 * GiB), 1);
  });

  it.effect(
    "keeps weighted steps within the budget, in order, and serial steps one at a time",
    () =>
      Effect.gen(function* () {
        const startedAt: Record<string, number> = {};
        let active = 0;
        let maxActive = 0;
        let serialActive = 0;
        let maxSerial = 0;
        const step = (
          name: string,
          options: { weight?: number; serial?: boolean } = {},
        ): Step<never> => {
          const slots = Math.min(options.weight ?? 1, 3);
          return {
            name,
            ...options,
            run: Effect.gen(function* () {
              startedAt[name] = (yield* Clock.currentTimeMillis) / 1000;
              active += slots;
              maxActive = Math.max(maxActive, active);
              if (options.serial) maxSerial = Math.max(maxSerial, ++serialActive);
              yield* Effect.sleep("1 second");
              active -= slots;
              if (options.serial) serialActive--;
              return { ok: true, output: "" };
            }),
          };
        };
        const fiber = yield* runSteps(
          [
            step("light 1"),
            // Above the budget, so it holds every slot rather than never starting.
            step("heavy", { weight: 5 }),
            step("pair", { weight: 2 }),
            step("light 2"),
            step("test 1", { serial: true }),
            step("test 2", { serial: true }),
          ],
          { concurrency: 3, timeoutSeconds: 60 },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        const results = yield* Fiber.join(fiber);

        assert.deepStrictEqual(
          results.map((result) => result.outcome),
          ["pass", "pass", "pass", "pass", "pass", "pass"],
        );
        assert.strictEqual(maxActive, 3);
        // Lighter steps queued behind the heavy one never start ahead of it.
        assert.deepStrictEqual(startedAt, {
          "light 1": 0,
          heavy: 1,
          pair: 2,
          "light 2": 2,
          "test 1": 3,
          "test 2": 4,
        });
        assert.strictEqual(maxSerial, 1);
      }),
  );

  it.effect("interrupts a step at its timeout and reports TIMEOUT, apart from FAIL", () =>
    Effect.gen(function* () {
      let interrupted = false;
      const fiber = yield* runSteps(
        [
          {
            name: "hangs",
            run: Effect.never.pipe(
              Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
            ),
          },
          { name: "fails", run: Effect.succeed({ ok: false, output: "error" }) },
          { name: "passes", run: Effect.succeed({ ok: true, output: "" }) },
        ],
        { concurrency: 3, timeoutSeconds: 10 },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("9 seconds");
      assert.isFalse(interrupted);
      yield* TestClock.adjust("1 second");
      const results = yield* Fiber.join(fiber);

      assert.isTrue(interrupted);
      assert.deepStrictEqual(
        results.map(({ name, outcome, time }) => [name, outcome, time]),
        [
          ["hangs", "TIMEOUT", "killed after 10s"],
          ["fails", "FAIL", "0.0s"],
          ["passes", "pass", "0.0s"],
        ],
      );
    }),
  );

  it.effect("fails instead of returning an empty file list when git exits nonzero", () => {
    const spawner = (exitCode: number) =>
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(exitCode === 0 ? "a.ts\nb.ts\n" : "")),
            stderr: Stream.encodeText(
              Stream.make(exitCode === 0 ? "" : "fatal: index file corrupt"),
            ),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
    return Effect.gen(function* () {
      const listed = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(0)),
      );
      assert.deepStrictEqual(listed, ["a.ts", "b.ts"]);
      const error = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(128)),
        Effect.flip,
      );
      assert.strictEqual(
        error,
        "check:changed: git ls-files exited with 128: fatal: index file corrupt",
      );
    });
  });
});

it.each([
  ["docs/café.md", "docs/naïve.md"],
  ["docs/first\npart.md", "docs/second\npart.md"],
])("preserves tracked and untracked Git filenames: %s, %s", (tracked, untracked) => {
  using fixture = setup();
  fixture.write(tracked, "tracked\n");
  fixture.git("add", "--", tracked);
  fixture.write(untracked, "untracked\n");
  const result = fixture.run();
  assert.strictEqual(result.status, 0, result.stderr);
  const format = fixture.calls().find((args) => args[0] === "fmt");
  assert.deepStrictEqual(format?.slice(3), [tracked, untracked]);
});

it.each([
  ["cjs", true],
  ["cjs", false],
  ["mjs", true],
  ["mjs", false],
] as const)("propagates the actual Node %s test outcome: passes=%s", (extension, passes) => {
  using fixture = setup();
  const file = `.github/scripts/fixture.test.${extension}`;
  fixture.write(
    file,
    `${extension === "cjs" ? 'const { test } = require("node:test");' : 'import { test } from "node:test";'}
test("node fixture", () => { ${passes ? "" : 'throw new Error("synthetic failure");'} });\n`,
  );
  const result = fixture.run();
  assert.strictEqual(result.status, passes ? 0 : 1, result.stdout + result.stderr);
  assert.include(result.stdout, "node fixture");
  assert.isFalse(fixture.calls().some((args) => args[0] === "test" && args.includes(file)));
});

it.each(["@effect/vitest", "vite-plus/test", "vitest"])(
  "keeps MJS suites importing %s on Vitest",
  (runner) => {
    using fixture = setup();
    const file = "fixtures/packaging.integration.test.mjs";
    fixture.write(file, `import { it } from "${runner}";\nit("Vitest fixture", () => {});\n`);
    const result = fixture.run();
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.isTrue(fixture.calls().some((args) => args[0] === "test" && args.includes(file)));
    assert.notInclude(result.stdout, "> " + process.execPath + " Node test");
  },
);

it("does not mistake Node-runner source fixtures for a Vitest suite's own runner", () => {
  using fixture = setup();
  const file = "fixtures/cli.test.ts";
  fixture.write(
    file,
    `import { it } from "@effect/vitest";
// import { test } from "node:test";
const fixture = 'require("node:test")';
const source = \`import { test } from "node:test"; test("fixture", () => {});\`;
it("fixture", () => {});
`,
  );
  const result = fixture.run();
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.isTrue(fixture.calls().some((args) => args[0] === "test" && args.includes(file)));
});

it("invalidates a passing cache when a real Node suite starts failing and never caches that failure", () => {
  using fixture = setup();
  const file = ".github/scripts/cache.test.mjs";
  fixture.write(file, 'import { test } from "node:test";\ntest("cache transition", () => {});\n');
  fixture.git("add", "--", file);
  const first = fixture.run();
  assert.strictEqual(first.status, 0, first.stdout + first.stderr);
  assert.include(first.stdout, "cache transition");
  const cached = fixture.run();
  assert.strictEqual(cached.status, 0, cached.stdout + cached.stderr);
  assert.include(cached.stdout, "Nothing changed since the last passing run.");

  fixture.write(
    file,
    'import { test } from "node:test";\ntest("cache transition", () => { throw new Error("changed suite fails"); });\n',
  );
  for (const result of [fixture.run(), fixture.run()]) {
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    assert.include(result.stdout, "changed suite fails");
    assert.notInclude(result.stdout, "Nothing changed since the last passing run.");
  }
});

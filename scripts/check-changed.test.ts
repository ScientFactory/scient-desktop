// @effect-diagnostics nodeBuiltinImport:off -- exercises the real CLI in isolated Git directories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";

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
  NodeFS.symlinkSync(
    NodeURL.fileURLToPath(new URL("../", import.meta.resolve("typescript-legacy"))),
    NodePath.join(root, "node_modules/typescript-legacy"),
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
import { EventEmitter } from "node:events";
const spawnSync = ChildProcess.spawnSync;
const spawn = ChildProcess.spawn;
ChildProcess.spawnSync = (command, args, options) => {
  if (command === "git" && args[0] === "merge-base") {
    return { status: 0, stdout: ${JSON.stringify(emptyTree + "\n")} };
  }
  if (command === "vp") {
    fs.appendFileSync(new URL("./calls.jsonl", import.meta.url), JSON.stringify(args) + "\\n");
    return { status: 0 };
  }
  return spawnSync(command, args, options);
};
ChildProcess.spawn = (command, args, options) => {
  if (command !== "vp") return spawn(command, args, options);
  fs.appendFileSync(new URL("./calls.jsonl", import.meta.url), JSON.stringify(args) + "\\n");
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => child.emit("close", 0));
  return child;
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

import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, test, vi } from "vite-plus/test";
import { main } from "./scient-alignment-gates.mjs";

const cli = NodeURL.fileURLToPath(new URL("./scient-alignment-gates.mjs", import.meta.url));
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

// A fake pnpm: lint fails, the smoke step uses its home unless told not to, and
// any leaked host variable fails the step that sees it.
const fakePnpm = `
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("11.10.0"); process.exit(0); }
if (process.env.ELECTRON_RUN_AS_NODE || process.env.SCIENT_ANALYTICS_ENABLED) process.exit(9);
if (args.includes("lint")) process.exit(1);
if (args.includes("test:desktop-smoke") && !process.env.FAKE_SMOKE_IGNORES_HOME) {
  NodeFS.mkdirSync(NodePath.join(process.env.SCIENT_NEXT_HOME, "dev"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(process.env.SCIENT_NEXT_HOME, "dev", "state"), "");
}
`;

function fixture() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-gates-"));
  directories.push(cwd);
  const git = (...args) => NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "core.hooksPath", NodePath.join(cwd, "no-hooks"));
  NodeFS.writeFileSync(NodePath.join(cwd, "file.txt"), "content\n");
  git("add", ".");
  git("-c", "user.name=Gates", "-c", "user.email=gates@example.invalid", "commit", "-qm", "base");
  const bin = NodePath.join(cwd, "..", `${NodePath.basename(cwd)}-bin`);
  directories.push(bin);
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(NodePath.join(bin, "fake-pnpm.mjs"), fakePnpm);
  NodeFS.writeFileSync(
    NodePath.join(bin, "pnpm"),
    `#!/bin/sh\nexec "${process.execPath}" "${NodePath.join(bin, "fake-pnpm.mjs")}" "$@"\n`,
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(
    NodePath.join(bin, "pnpm.cmd"),
    `@"${process.execPath}" "%~dp0fake-pnpm.mjs" %*\r\n`,
  );
  return { cwd, bin };
}

function run({ cwd, bin }, args, env = {}) {
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const result = NodeChildProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      [pathKey]: `${bin}${NodePath.delimiter}${process.env[pathKey]}`,
      ELECTRON_RUN_AS_NODE: "1",
      SCIENT_ANALYTICS_ENABLED: "true",
      ...env,
    },
  });
  const resultsPath = /Results: (.+results\.json)/u.exec(result.stdout)?.[1];
  const record = resultsPath ? JSON.parse(NodeFS.readFileSync(resultsPath, "utf8")) : null;
  if (resultsPath) directories.push(NodePath.dirname(resultsPath));
  return { ...result, record, statuses: record?.gates.map((gate) => [gate.id, gate.status]) };
}

test("one failing gate does not stop the rest, and host variables never reach a gate", () => {
  const result = run(fixture(), ["--tests"]);
  NodeAssert.equal(result.status, 1, result.stderr);
  NodeAssert.deepEqual(result.statuses, [
    ["fmt", "passed"],
    ["lint", "failed"],
    ["typecheck", "passed"],
    ["test", "passed"],
    ["build", "passed"],
    ["smoke", "passed"],
    ["brand", "passed"],
    ["diff-index", "passed"],
    ["diff-worktree", "passed"],
  ]);
  NodeAssert.equal(result.record.pnpm, "11.10.0");
  NodeAssert.equal(result.record.dirty, false);
  NodeAssert.match(result.stdout, /\| lint \| failed, \d+ s \|/u);
  NodeAssert.match(result.stdout, /Failed: lint/u);
});

test("a smoke run that ignores its synthetic home fails", () => {
  const result = run(fixture(), ["--only", "smoke"], { FAKE_SMOKE_IGNORES_HOME: "1" });
  NodeAssert.equal(result.status, 1, result.stderr);
  NodeAssert.deepEqual(result.statuses, [["smoke", "failed"]]);
  NodeAssert.equal(result.record.gates[0].reason, "the desktop did not use the synthetic home");
  NodeAssert.deepEqual(result.record.partial, ["smoke"]);
});

test("on Windows the local test aggregate is an explicit gap unless requested", () => {
  const { cwd, bin } = fixture();
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const original = process.env[pathKey];
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  process.env[pathKey] = `${bin}${NodePath.delimiter}${original}`;
  try {
    NodeAssert.equal(main(["--only", "test,brand"], { cwd, platform: "win32" }), 0);
    const output = log.mock.calls.flat().join("\n");
    NodeAssert.match(output, /\| test \| not run: the local aggregate is not a supported/u);
    NodeAssert.match(output, /\| brand \| passed/u);
    NodeAssert.match(output, /Not run: test/u);
    const before = log.mock.calls.length;
    NodeAssert.equal(main(["--only", "test", "--tests"], { cwd, platform: "win32" }), 0);
    NodeAssert.match(log.mock.calls.slice(before).flat().join("\n"), /\| test \| passed/u);
  } finally {
    for (const [line] of log.mock.calls) {
      const results = /Results: (.+results\.json)/u.exec(String(line))?.[1];
      if (results) directories.push(NodePath.dirname(results));
    }
    process.env[pathKey] = original;
    log.mockRestore();
  }
});

test("unknown gates and arguments are refused", () => {
  for (const args of [["--only", "typo"], ["--only"], ["--fast"]]) {
    NodeAssert.equal(run(fixture(), args).status, 2);
  }
});

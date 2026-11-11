// @effect-diagnostics nodeBuiltinImport:off -- the fixture is a real CLI process with a real detached child.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { spawnClaudeProcessGroup } from "./ClaudeAdapterV2.ts";

const isWindows = Context.get(Context.empty(), HostProcess.Platform) === "win32";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Claude Code starts its Bash tool shells and helpers detached, in process groups of their own,
// so killing the CLI's group when it exits leaves them running for good.
it.live.skipIf(isWindows)("stops the CLI's detached descendants when the CLI exits", () =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-tree-"));
    const pidFile = NodePath.join(dir, "grandchild");
    const cli = NodePath.join(dir, "claude");
    const program = [
      "const child = require('node:child_process').spawn(process.execPath,",
      "  ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      "require('node:fs').writeFileSync(process.argv[1], String(child.pid));",
      "setTimeout(() => process.exit(0), 2500);",
    ].join("\n");
    NodeFS.writeFileSync(
      cli,
      `#!/bin/sh\nexec "${process.execPath}" -e "$PROGRAM" "${pidFile}"\n`,
      { mode: 0o755 },
    );
    let grandchild = 0;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (grandchild > 0 && isAlive(grandchild)) process.kill(grandchild, "SIGKILL");
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }),
    );
    const child = spawnClaudeProcessGroup({
      command: cli,
      args: [],
      cwd: dir,
      env: { ...process.env, PROGRAM: program },
      // @effect-diagnostics-next-line abortControllerInEffect:off - The fixture exits by itself.
      signal: new AbortController().signal,
    }) as NodeChildProcess.ChildProcess;
    yield* Effect.callback<void>((resume) => {
      child.once("exit", () => resume(Effect.void));
    });
    grandchild = Number(NodeFS.readFileSync(pidFile, "utf8"));
    assert.isAbove(grandchild, 1);
    // The reap after exit asks it to stop, then kills it after a second.
    yield* Effect.promise(() =>
      expect.poll(() => isAlive(grandchild), { timeout: 5_000 }).toBe(false),
    );
  }).pipe(Effect.scoped),
);

// When the server dies, the watcher in the CLI's group stops the CLI's group, and now also the
// descendants that left it, while the CLI still links them.
it.live.skipIf(isWindows)("stops the CLI's detached descendants when the server goes away", () =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-crash-"));
    const pidFile = NodePath.join(dir, "grandchild");
    const cli = NodePath.join(dir, "claude");
    const program = [
      "const child = require('node:child_process').spawn(process.execPath,",
      "  ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      "require('node:fs').writeFileSync(process.argv[1], String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    NodeFS.writeFileSync(
      cli,
      `#!/bin/sh\nexec "${process.execPath}" -e "$PROGRAM" "${pidFile}"\n`,
      {
        mode: 0o755,
      },
    );
    let grandchild = 0;
    const child = spawnClaudeProcessGroup({
      command: cli,
      args: [],
      cwd: dir,
      env: { ...process.env, PROGRAM: program },
      // @effect-diagnostics-next-line abortControllerInEffect:off - The fixture closes its pipes itself.
      signal: new AbortController().signal,
    }) as NodeChildProcess.ChildProcess;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const pid of [grandchild, child.pid ?? 0]) {
          if (pid > 0 && isAlive(pid)) process.kill(pid, "SIGKILL");
        }
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }),
    );
    yield* Effect.promise(() =>
      expect.poll(() => NodeFS.existsSync(pidFile), { timeout: 5_000 }).toBe(true),
    );
    grandchild = Number(NodeFS.readFileSync(pidFile, "utf8"));
    assert.isAbove(grandchild, 1);
    // A dying server's descriptors close; the kernel would do this for it.
    for (const pipe of child.stdio) pipe?.destroy();
    yield* Effect.promise(() =>
      expect.poll(() => isAlive(grandchild), { timeout: 5_000 }).toBe(false),
    );
    assert.isFalse(isAlive(child.pid ?? 0), "the CLI stopped too");
  }).pipe(Effect.scoped),
);

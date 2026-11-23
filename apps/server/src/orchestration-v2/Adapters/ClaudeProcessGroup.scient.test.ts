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
    // The CLI and its detached descendant can exit in either order.
    yield* Effect.promise(() =>
      expect
        .poll(() => ({ cliAlive: isAlive(child.pid ?? 0), descendantAlive: isAlive(grandchild) }), {
          timeout: 5_000,
        })
        .toEqual({ cliAlive: false, descendantAlive: false }),
    );
  }).pipe(Effect.scoped),
);

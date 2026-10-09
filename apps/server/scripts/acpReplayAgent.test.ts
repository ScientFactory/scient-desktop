// @effect-diagnostics nodeBuiltinImport:off -- Exercise the replay agent as a child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, expect, it } from "vite-plus/test";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("exits promptly with a recorded mismatch instead of leaving the ACP child open", async () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-replay-agent-"));
  directories.push(directory);
  const statusPath = NodePath.join(directory, "status.json");
  const transcript = {
    scenario: "mismatch-exit",
    entries: [
      {
        type: "expect_outbound",
        label: "prompt",
        frame: {
          kind: "request",
          method: "session/prompt",
          params: { sessionId: "expected" },
        },
      },
    ],
  };
  const scriptPath = NodePath.join(import.meta.dirname, "acp-replay-agent.ts");
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["--experimental-strip-types", scriptPath],
    {
      env: {
        T3_ACP_REPLAY_TRANSCRIPT: Buffer.from(JSON.stringify(transcript)).toString("base64"),
        T3_ACP_REPLAY_STATUS_PATH: statusPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const exitResult = await Effect.runPromise(
    Effect.promise(
      () =>
        new Promise<{ readonly code: number | null; readonly signal: string | null }>(
          (resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code, signal) => resolve({ code, signal }));
            child.stdin.end(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "session/prompt",
                params: { sessionId: "actual" },
              })}\n`,
            );
          },
        ),
    ).pipe(Effect.timeoutOption("2 seconds")),
  );
  if (Option.isNone(exitResult)) {
    child.kill("SIGKILL");
    throw new Error("ACP replay agent did not exit after a mismatch.");
  }
  const exit = exitResult.value;

  expect(exit).toEqual({ code: 1, signal: null });
  expect(JSON.parse(NodeFS.readFileSync(statusPath, "utf8"))).toMatchObject({
    scenario: "mismatch-exit",
    cursor: 0,
    total: 1,
    failure: { detail: "Unexpected outbound ACP frame" },
  });
});

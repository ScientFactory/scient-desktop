// @effect-diagnostics nodeBuiltinImport:off -- Runs a synthetic ACP peer through Node directly.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const blockedPrompt = (action: "terminate" | "cancel") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "acp-prompt-lifecycle-" });
    const agent = NodePath.join(directory, "agent.mjs");
    const control = NodePath.join(directory, "exit");
    NodeFS.writeFileSync(
      agent,
      String.raw`
import * as fs from "node:fs";
import * as readline from "node:readline";
setInterval(() => { if (fs.existsSync(process.env.EXIT_FILE)) process.exit(7); }, 5);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "initialize"
    ? { protocolVersion: 1, agentCapabilities: {} }
    : message.method === "session/new" ? { sessionId: "s" } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
});
`,
    );
    const writeBlocked = yield* Deferred.make<void>();
    const releaseWrite = yield* Deferred.make<void>();
    const terminated = yield* Deferred.make<void>();
    const runtime = yield* AcpSessionRuntime.make({
      spawn: { command: process.execPath, args: [agent], env: { EXIT_FILE: control } },
      cwd: directory,
      clientInfo: { name: "lifecycle-test", version: "0.0.0" },
      authMethodId: undefined,
      requestLogger: (event) =>
        event.method === "session/prompt" && event.status === "started"
          ? Deferred.succeed(writeBlocked, undefined).pipe(
              Effect.andThen(Deferred.await(releaseWrite)),
            )
          : Effect.void,
      onTermination: () => Deferred.succeed(terminated, undefined).pipe(Effect.asVoid),
    });
    yield* runtime.start();
    const prompt = yield* runtime
      .prompt({ prompt: [{ type: "text", text: "Hello" }] })
      .pipe(Effect.exit, Effect.forkScoped);
    yield* Deferred.await(writeBlocked);
    if (action === "terminate") {
      NodeFS.writeFileSync(control, "exit");
      yield* Deferred.await(terminated);
      // No release: scope teardown must interrupt the logger before the RPC exists.
      const result = yield* Fiber.join(prompt);
      expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({
        _tag: "AcpProcessExitedError",
        code: 7,
      });
    } else {
      yield* runtime.cancel;
      const result = yield* Fiber.join(prompt);
      expect(Exit.isSuccess(result) && result.value).toEqual({ stopReason: "cancelled" });
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("ACP prompt teardown", () => {
  it.live("preserves process failure when teardown interrupts a prompt before its write", () =>
    blockedPrompt("terminate"),
  );
  it.live("still returns cancellation when the caller cancels a live peer", () =>
    blockedPrompt("cancel"),
  );
});

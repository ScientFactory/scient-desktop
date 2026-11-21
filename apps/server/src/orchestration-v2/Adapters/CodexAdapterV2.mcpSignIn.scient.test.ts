import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import type * as CodexReplay from "effect-codex-app-server/replay";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  codexReplayPreamble,
  makeCodexReplayHarness,
  makeCodexReplayTranscript,
} from "./CodexAdapterV2.replay.testkit.ts";

const nativeThreadId = "mcp-sign-in-browser-thread";
const authorizationUrl =
  "https://linear.example/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A50123%2Fcallback&state=s1";

const signInEntries = (completed: boolean): Array<CodexReplay.CodexAppServerReplayEntry> => [
  ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "unused", prompt: "work" }).slice(0, 5),
  {
    type: "expect_outbound",
    label: "mcpServerStatus/list",
    frame: {
      id: 3,
      method: "mcpServerStatus/list",
      params: { serverName: "linear", threadId: nativeThreadId, detail: "toolsAndAuthOnly" },
    },
  },
  {
    type: "emit_inbound",
    label: "mcpServerStatus/list",
    frame: { id: 3, result: { data: [] } },
  },
  {
    type: "expect_outbound",
    label: "mcpServer/oauth/login",
    frame: {
      id: 4,
      method: "mcpServer/oauth/login",
      params: { name: "linear", threadId: nativeThreadId },
    },
  },
  {
    type: "emit_inbound",
    label: "mcpServer/oauth/login",
    frame: { id: 4, result: { authorizationUrl } },
  },
  ...(completed
    ? [
        {
          type: "emit_inbound" as const,
          label: "mcpServer/oauthLogin/completed",
          frame: {
            method: "mcpServer/oauthLogin/completed",
            params: { name: "linear", threadId: nativeThreadId, success: true },
          },
        },
      ]
    : []),
];

const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
);

describe("CodexAdapterV2 MCP sign-in without a pasted address", () => {
  it.effect("finishes once Codex reports its own callback page was reached", () =>
    Effect.gen(function* () {
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: "codex-mcp-sign-in-browser",
          entries: signInEntries(true),
        }),
      );
      const mcpSignIn = harness.runtime.mcpSignIn!;
      const input = { providerThread: harness.providerThread, server: "linear" };
      assert.deepEqual(yield* mcpSignIn.start(input), { authorizationUrl });
      yield* mcpSignIn.complete({ ...input, callbackUrl: undefined });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("gives up after a bounded wait so the address can still be pasted", () =>
    Effect.gen(function* () {
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: "codex-mcp-sign-in-browser-silent",
          entries: signInEntries(false),
        }),
      );
      const mcpSignIn = harness.runtime.mcpSignIn!;
      const input = { providerThread: harness.providerThread, server: "linear" };
      yield* mcpSignIn.start(input);
      const waiting = yield* mcpSignIn
        .complete({ ...input, callbackUrl: undefined })
        .pipe(Effect.exit, Effect.forkChild);
      yield* TestClock.adjust("4 minutes");
      assert.isUndefined(waiting.pollUnsafe());
      yield* TestClock.adjust("1 minute");
      const exit = yield* Fiber.join(waiting);
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "Paste the address");
    }).pipe(Effect.provide(layer)),
  );
});

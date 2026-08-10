import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import type { ProviderConnectionActions } from "../ProviderDriver.ts";
import {
  assistedClaudeConnectionMethods,
  invalidateClaudeCapabilitiesAfterAccountChange,
} from "./ClaudeDriver.ts";

describe("ClaudeDriver assisted account boundary", () => {
  it("offers subscription login first with Console as the fallback", () => {
    expect(assistedClaudeConnectionMethods({})).toEqual(["claude_subscription", "claude_console"]);
    expect(assistedClaudeConnectionMethods({ CLAUDE_CODE_USE_BEDROCK: "false" })).toEqual([
      "claude_subscription",
      "claude_console",
    ]);
  });

  it("does not offer account actions that cannot configure an external backend", () => {
    expect(assistedClaudeConnectionMethods({ ANTHROPIC_API_KEY: "configured" })).toEqual([]);
    expect(assistedClaudeConnectionMethods({ ANTHROPIC_BASE_URL: "https://example.com" })).toEqual(
      [],
    );
    expect(assistedClaudeConnectionMethods({ CLAUDE_CODE_USE_BEDROCK: "1" })).toEqual([]);
    expect(assistedClaudeConnectionMethods({ CLAUDE_CODE_USE_VERTEX: "true" })).toEqual([]);
    expect(assistedClaudeConnectionMethods({ CLAUDE_CODE_USE_FOUNDRY: "yes" })).toEqual([]);
  });

  it.effect("invalidates cached account capabilities after successful sign-in and sign-out", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const actions: ProviderConnectionActions = {
        methods: ["claude_console"],
        start: () =>
          Effect.succeed({
            authorizationUrl: "https://platform.claude.com/oauth/authorize",
            authorizationUrlKind: "manual_fallback",
            waitForCompletion: Effect.sync(() => events.push("signed-in")).pipe(Effect.asVoid),
            cancel: Effect.void,
          }),
        disconnect: Effect.sync(() => events.push("signed-out")).pipe(Effect.asVoid),
      };
      const wrapped = invalidateClaudeCapabilitiesAfterAccountChange(
        actions,
        Effect.sync(() => events.push("invalidated")),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const attempt = yield* wrapped.start("claude_console");
          yield* attempt.waitForCompletion;
          yield* wrapped.disconnect;
        }),
      );

      expect(events).toEqual(["signed-in", "invalidated", "signed-out", "invalidated"]);
    }),
  );

  it.effect("keeps the cached account result when sign-in fails", () =>
    Effect.gen(function* () {
      let invalidations = 0;
      const actions: ProviderConnectionActions = {
        methods: ["claude_console"],
        start: () =>
          Effect.succeed({
            authorizationUrl: "https://platform.claude.com/oauth/authorize",
            authorizationUrlKind: "manual_fallback",
            waitForCompletion: Effect.fail({ message: "not completed" }),
            cancel: Effect.void,
          }),
        disconnect: Effect.void,
      };
      const wrapped = invalidateClaudeCapabilitiesAfterAccountChange(
        actions,
        Effect.sync(() => {
          invalidations += 1;
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const attempt = yield* wrapped.start("claude_console");
          yield* attempt.waitForCompletion.pipe(Effect.flip);
        }),
      );
      expect(invalidations).toBe(0);
    }),
  );
});

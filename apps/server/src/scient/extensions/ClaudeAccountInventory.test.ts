import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  accountConnectorOptions,
  makeClaudeAccountInventoryRefresh,
  pollClaudeAccountServers,
} from "./ClaudeAccountInventory.ts";
import type { ClaudeCapabilitiesProbe } from "../../provider/ClaudeProvider.ts";

describe("Claude account inventory", () => {
  it.effect("waits for a nonempty stable account sample, excluding other scopes", () =>
    Effect.gen(function* () {
      let samples = 0;
      const polling = yield* pollClaudeAccountServers(() =>
        Effect.sync(() => {
          samples++;
          return samples < 2
            ? []
            : [
                { name: "account", scope: "claudeai", status: "needs-auth" },
                { name: "local", scope: "user", status: "connected" },
              ];
        }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(polling)).toEqual([
        {
          name: "account",
          scope: "claudeai",
          status: "needs-auth",
          connectUrl: "https://claude.ai/settings/connectors",
        },
      ]);
      expect(samples).toBe(3);
    }),
  );
  it.effect("bounds a query that never reports connectors", () =>
    Effect.gen(function* () {
      const polling = yield* pollClaudeAccountServers(() => Effect.succeed([])).pipe(
        Effect.result,
        Effect.forkChild,
      );
      yield* TestClock.adjust("15 seconds");
      expect((yield* Fiber.join(polling))._tag).toBe("Failure");
    }),
  );
  it.effect("requires first-party subscription auth and throttles only ordinary refreshes", () =>
    Effect.gen(function* () {
      let account = { apiProvider: "bedrock", subscriptionType: "pro" } as ClaudeCapabilitiesProbe;
      let probes = 0;
      const refresh = yield* makeClaudeAccountInventoryRefresh(
        Effect.sync(() => account),
        Effect.sync(() => {
          probes++;
          return [];
        }),
        () => Effect.void,
      );
      yield* refresh();
      expect(probes).toBe(0);
      account = { ...account, apiProvider: "firstParty" };
      yield* refresh();
      yield* refresh();
      expect(probes).toBe(1);
      yield* refresh({ force: true });
      expect(probes).toBe(2);
      yield* TestClock.adjust("10 minutes");
      yield* refresh();
      expect(probes).toBe(3);
    }),
  );
  it("leaves claude.ai discovery enabled without loading user hooks or MCP config", () => {
    const options = accountConnectorOptions(
      "/instance/claude",
      { HOME: "/instance" },
      "/probe",
      new AbortController(),
    );
    expect(options).toMatchObject({
      persistSession: false,
      settingSources: [],
      mcpServers: {},
      settings: { disableAllHooks: true },
      env: { ENABLE_CLAUDEAI_MCP_SERVERS: "true" },
    });
    expect(options.strictMcpConfig).toBeUndefined();
  });
});

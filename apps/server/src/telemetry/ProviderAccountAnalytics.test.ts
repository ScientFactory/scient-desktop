import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createProviderAccountAnalyticsMapper } from "./ProviderAccountAnalytics.ts";

const provider = (overrides: Partial<ServerProvider>): ServerProvider =>
  ({
    driver: "codex",
    auth: { status: "unauthenticated" },
    ...overrides,
  }) as ServerProvider;

describe("createProviderAccountAnalyticsMapper", () => {
  it("reports each signed-in account once with its email and plan", () => {
    const mapper = createProviderAccountAnalyticsMapper();
    const snapshot = [
      provider({
        driver: "claudeAgent" as ServerProvider["driver"],
        auth: { status: "authenticated", email: "Ada@Uni.edu", label: "Claude Max", type: "max" },
      }),
      provider({
        driver: "codex" as ServerProvider["driver"],
        auth: { status: "unauthenticated" },
      }),
    ];
    expect(mapper.observe(snapshot)).toEqual([
      {
        name: "install.account_observed",
        properties: {
          provider: "claudeAgent",
          email: "ada@uni.edu",
          plan: "Claude Max",
          accountType: "max",
        },
      },
    ]);
    expect(mapper.observe(snapshot)).toEqual([]);
  });

  it("reports each model subscription an agent is connected to", () => {
    const mapper = createProviderAccountAnalyticsMapper();
    const events = mapper.observe([
      provider({
        driver: "scientAgent" as ServerProvider["driver"],
        auth: { status: "unknown" },
        connection: {
          accounts: [
            {
              id: "anthropic",
              name: "Claude Pro/Max",
              kind: "account",
              connected: true,
              canDisconnect: true,
              email: "ada@uni.edu",
            },
            {
              id: "openai-codex",
              name: "ChatGPT Plus/Pro",
              kind: "account",
              connected: false,
              canDisconnect: false,
            },
            {
              id: "openai-device",
              name: "ChatGPT (device)",
              kind: "account",
              connected: true,
              canDisconnect: true,
              sameAccountAs: "openai-codex",
            },
          ],
        } as unknown as NonNullable<ServerProvider["connection"]>,
      }),
    ]);
    expect(events).toEqual([
      {
        name: "install.account_observed",
        properties: {
          provider: "scientAgent",
          email: "ada@uni.edu",
          accountType: "anthropic",
        },
      },
    ]);
  });
});

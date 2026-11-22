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

  it("reports a custom endpoint split into host, port, scheme and where it was set", () => {
    const mapper = createProviderAccountAnalyticsMapper();
    const claude = (endpoint: string) =>
      provider({
        driver: "claudeAgent" as ServerProvider["driver"],
        auth: {
          status: "authenticated",
          type: "customEndpoint",
          label: "Custom API endpoint",
          endpoint,
          endpointSource: "claude-settings",
        },
      });
    expect(mapper.observe([claude("http://127.0.0.1:3456")])).toEqual([
      {
        name: "install.account_observed",
        properties: {
          provider: "claudeAgent",
          accountType: "customEndpoint",
          endpointHost: "127.0.0.1",
          endpointPort: 3456,
          endpointScheme: "http",
          endpointSource: "claude-settings",
        },
      },
    ]);
    // A moved endpoint is a new observation; the same one is not.
    expect(mapper.observe([claude("http://127.0.0.1:3456")])).toEqual([]);
    expect(mapper.observe([claude("https://proxy.example")])).toEqual([
      {
        name: "install.account_observed",
        properties: {
          provider: "claudeAgent",
          accountType: "customEndpoint",
          endpointHost: "proxy.example",
          endpointScheme: "https",
          endpointSource: "claude-settings",
        },
      },
    ]);
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

it.each(["codex", "claudeAgent"] as const)(
  "does not report %s API-key authentication as a subscription tier",
  (driver) => {
    const mapper = createProviderAccountAnalyticsMapper();
    const events = mapper.observe([
      provider({
        driver: driver as ServerProvider["driver"],
        auth: { status: "authenticated", type: "apiKey", label: "API Key" },
      }),
    ]);
    expect(events[0]?.properties).toMatchObject({ accountType: "apiKey" });
    expect(events[0]?.properties).not.toHaveProperty("plan");
  },
);

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { liveVoiceCallInstance, liveVoiceUnavailableReason } from "./liveVoiceAvailability.ts";

const scientAgent = (version: string, signedIn = true): ServerProvider => ({
  instanceId: ProviderInstanceId.make("scient"),
  driver: ProviderDriverKind.make("scient"),
  enabled: true,
  installed: true,
  version,
  status: "ready",
  auth: { status: "unknown", required: false },
  checkedAt: "2026-11-14T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: [],
    canDisconnect: false,
    operation: null,
    accounts: [
      {
        id: "openai-codex",
        name: "ChatGPT",
        kind: "account",
        connected: signedIn,
        canDisconnect: false,
      },
    ],
  },
});

describe("live voice availability", () => {
  it("lets a new conversation talk when the agent runs calls on its own", () => {
    const provider = scientAgent("0.1.10");
    expect(liveVoiceCallInstance(provider)).toBe("scient");
    expect(liveVoiceUnavailableReason({ provider, threadStarted: false })).toBeNull();
  });

  it("asks for a first message on an agent whose calls join the conversation's session", () => {
    const provider = scientAgent("0.1.9");
    expect(liveVoiceCallInstance(provider)).toBeNull();
    expect(liveVoiceUnavailableReason({ provider, threadStarted: false })).toBe(
      "Send a first message, then talk",
    );
    expect(liveVoiceUnavailableReason({ provider, threadStarted: true })).toBeNull();
  });

  it("asks for a ChatGPT sign-in first", () => {
    expect(
      liveVoiceUnavailableReason({ provider: scientAgent("0.1.10", false), threadStarted: true }),
    ).toBe("Sign in to ChatGPT in Scient Agent to talk");
  });
});

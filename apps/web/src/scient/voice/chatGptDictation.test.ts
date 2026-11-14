import {
  ChatGptDictationError,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionAccount,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { chatGptDictationInstance, makeChatGptDictationTranscriber } from "./chatGptDictation.ts";

const environmentId = EnvironmentId.make("primary");

const scientAgent = (
  id: string,
  accounts: ReadonlyArray<Partial<ProviderConnectionAccount> & { id: string }>,
  enabled = true,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("scient"),
  enabled,
  installed: true,
  version: "0.1.9",
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
    accounts: accounts.map((account) => ({
      name: account.id,
      kind: "account",
      connected: false,
      canDisconnect: false,
      ...account,
    })),
  },
});

describe("chatGptDictationInstance", () => {
  it("picks the enabled Scient Agent signed in to ChatGPT", () => {
    expect(
      chatGptDictationInstance([
        scientAgent("off", [{ id: "openai-codex", connected: true }], false),
        scientAgent("claude-only", [{ id: "anthropic", connected: true }]),
        scientAgent("chatgpt", [{ id: "openai-codex", connected: true }]),
      ]),
    ).toBe("chatgpt");
  });

  it("counts a sign-in to the same ChatGPT account under another entry", () => {
    expect(
      chatGptDictationInstance([
        scientAgent("scient", [
          { id: "openai-codex-alt", connected: true, sameAccountAs: "openai-codex" },
        ]),
      ]),
    ).toBe("scient");
  });

  it("finds none without a ChatGPT sign-in", () => {
    expect(chatGptDictationInstance([scientAgent("scient", [{ id: "openai-codex" }])])).toBeNull();
    expect(chatGptDictationInstance(undefined)).toBeNull();
  });
});

describe("makeChatGptDictationTranscriber", () => {
  const request = {
    audioBase64: "UklGRg==",
    mimeType: "audio/wav" as const,
    sampleRateHz: 16_000,
    durationMs: 1200,
    language: "he" as const,
  };

  it("sends the recording to the named instance and returns its text", async () => {
    const run = vi.fn(async () => AsyncResult.success({ text: "שלום" }));
    const transcriber = makeChatGptDictationTranscriber(
      run,
      environmentId,
      ProviderInstanceId.make("scient"),
    );
    await expect(transcriber.transcribe(request)).resolves.toEqual({ text: "שלום" });
    expect(run).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId: "scient", audioBase64: "UklGRg==", language: "he" },
    });
  });

  it("shows the server's reason when ChatGPT refuses", async () => {
    const transcriber = makeChatGptDictationTranscriber(
      async () =>
        AsyncResult.failure(Cause.fail(new ChatGptDictationError({ reason: "signed-out" }))),
      environmentId,
      ProviderInstanceId.make("scient"),
    );
    await expect(transcriber.transcribe(request)).rejects.toThrow(
      "Sign in to ChatGPT in Scient Agent to dictate with ChatGPT.",
    );
  });
});

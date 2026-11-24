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

import {
  resolveChatGptConnection,
  chatGptDictationUnavailableMessage,
  makeChatGptDictationTranscriber,
} from "./chatGptDictation.ts";

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

const codex = (id: string, authType: string | undefined, enabled = true): ServerProvider => ({
  ...scientAgent(id, [], enabled),
  driver: ProviderDriverKind.make("codex"),
  version: "0.169.0",
  auth:
    authType === undefined
      ? { status: "unauthenticated", required: true }
      : { status: "authenticated", type: authType },
});

const automaticInstance = (providers: readonly ServerProvider[]) => {
  const { ready, selected } = resolveChatGptConnection(providers);
  return ready ? (selected?.instanceId ?? null) : null;
};

describe("automatic ChatGPT dictation", () => {
  it("picks the enabled Scient Agent signed in to ChatGPT", () => {
    expect(
      automaticInstance([
        scientAgent("off", [{ id: "openai-codex", connected: true }], false),
        scientAgent("claude-only", [{ id: "anthropic", connected: true }]),
        scientAgent("chatgpt", [{ id: "openai-codex", connected: true }]),
      ]),
    ).toBe("chatgpt");
  });

  it("counts a sign-in to the same ChatGPT account under another entry", () => {
    expect(
      automaticInstance([
        scientAgent("scient", [
          { id: "openai-codex-alt", connected: true, sameAccountAs: "openai-codex" },
        ]),
      ]),
    ).toBe("scient");
  });

  it("finds none without a ChatGPT sign-in", () => {
    expect(
      automaticInstance([
        scientAgent("scient", [{ id: "openai-codex" }]),
        codex("codex-key", "apiKey"),
        codex("codex-signed-out", undefined),
        codex("codex-off", "chatgpt", false),
      ]),
    ).toBeNull();
    expect(automaticInstance([])).toBeNull();
  });

  it("dictates through Codex's ChatGPT sign-in when no Scient Agent is signed in", () => {
    expect(
      automaticInstance([
        scientAgent("scient", [{ id: "openai-codex" }]),
        codex("codex", "chatgpt"),
      ]),
    ).toBe("codex");
  });

  it("never offers an agent too old to dictate, and asks for its update instead", () => {
    const outdated = {
      ...scientAgent("scient", [{ id: "openai-codex", connected: true }]),
      version: "0.1.8",
    };
    expect(automaticInstance([outdated])).toBeNull();
    const fallback = codex("codex", "chatgpt");
    expect(resolveChatGptConnection([outdated, fallback], null, outdated.instanceId).selected).toBe(
      fallback,
    );
    expect(chatGptDictationUnavailableMessage([outdated])).toBe(
      "Update Scient Agent to dictate with ChatGPT.",
    );
    expect(chatGptDictationUnavailableMessage([])).toBe(
      "Sign in to ChatGPT in Scient Agent or Codex to dictate with ChatGPT.",
    );
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
      input: {
        selection: { kind: "chatgpt", instanceId: "scient" },
        audioBase64: "UklGRg==",
        language: "he",
      },
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
      "Sign in to ChatGPT in Scient Agent or Codex to dictate with ChatGPT.",
    );
  });
});

it("uses the active chat's eligible connection, with Codex as the automatic default", () => {
  const agent = scientAgent("scient", [{ id: "openai-codex", connected: true }]);
  const first = codex("codex", "chatgpt");
  const second = codex("second-codex", "chatgpt");
  const providers = [agent, second, first];
  expect(resolveChatGptConnection(providers).selected).toBe(first);
  expect(resolveChatGptConnection(providers, null, agent.instanceId).selected).toBe(agent);
  expect(resolveChatGptConnection(providers, null, second.instanceId).selected).toBe(second);
  expect(
    resolveChatGptConnection(providers, null, ProviderInstanceId.make("claude")).selected,
  ).toBe(first);
  const reauth = codex("second-codex", undefined);
  expect(resolveChatGptConnection([agent, first, reauth], null, reauth.instanceId).selected).toBe(
    first,
  );
  expect(resolveChatGptConnection([agent, reauth], null, reauth.instanceId).selected).toBe(agent);
});

it("keeps a connection the user selected explicitly, even if it needs a new sign-in", () => {
  const first = codex("first", "chatgpt");
  const reauth = codex("second", undefined);
  expect(
    resolveChatGptConnection([first, reauth], reauth.instanceId, first.instanceId),
  ).toMatchObject({
    ready: false,
    selected: reauth,
  });
});

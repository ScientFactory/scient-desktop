import { ThreadId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Agent, Model, OpencodeClient, Part, Provider } from "@opencode-ai/sdk/v2";
import { Effect, Exit, Fiber, Layer, Stream } from "effect";
import { describe, it, expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import {
  type OpenCodeCliModelDescriptor,
  OpenCodeRuntimeError,
  type OpenCodeInventory,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { KiloAdapter, type KiloAdapterShape } from "../Services/KiloAdapter.ts";
import {
  flattenOpenCodeCliModels,
  flattenOpenCodeModels,
  makeOpenCodeAdapterLive,
  makeKiloAdapterLive,
  normalizeOpenCodeTokenUsage,
  resolvePreferredOpenCodeModelProviders,
} from "./OpenCodeAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

type TestModelInput = Omit<Partial<Model>, "capabilities"> &
  Pick<Model, "id" | "name"> & {
    readonly capabilities?: Partial<Model["capabilities"]>;
  };

function makeProvider(input: {
  id: string;
  name: string;
  source?: Provider["source"];
  env?: ReadonlyArray<string>;
  models?: Record<string, TestModelInput>;
}): Provider {
  return {
    id: input.id,
    name: input.name,
    source: input.source ?? "api",
    env: input.env ? [...input.env] : [],
    options: {},
    models: Object.fromEntries(
      Object.entries(input.models ?? {}).map(([modelId, model]) => [
        modelId,
        makeModel({
          providerID: input.id,
          ...model,
        }),
      ]),
    ),
  };
}

function makeModel(input: Omit<TestModelInput, "providerID"> & Pick<Model, "providerID">): Model {
  const capabilities: Model["capabilities"] = {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: true,
      video: false,
      pdf: true,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
    ...input.capabilities,
  };

  return {
    id: input.id,
    providerID: input.providerID,
    api: input.api ?? { id: "openai", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
    name: input.name,
    capabilities,
    cost: input.cost ?? {
      input: 1,
      output: 1,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: input.limit ?? {
      context: 128_000,
      output: 8_192,
    },
    status: input.status ?? "active",
    options: input.options ?? {},
    headers: input.headers ?? {},
    release_date: input.release_date ?? "2026-01-01",
    ...(input.family ? { family: input.family } : {}),
    ...(input.variants ? { variants: input.variants } : {}),
  };
}

function createMockOpenCodeRuntime(options?: {
  readonly inventory?: OpenCodeInventory;
  readonly inventoryError?: OpenCodeRuntimeError;
  readonly connectError?: OpenCodeRuntimeError;
  readonly cliModelsError?: OpenCodeRuntimeError;
  readonly cliModels?: ReadonlyArray<OpenCodeCliModelDescriptor>;
  readonly events?: AsyncIterable<unknown>;
  readonly prompt?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly promptAsync?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly commandList?: () => Promise<{
    data?: ReadonlyArray<{ name: string; description?: string }>;
  }>;
  readonly commandLists?: ReadonlyArray<ReadonlyArray<{ name: string; description?: string }>>;
  readonly messages?: (
    input?: Record<string, unknown>,
    requestOptions?: { readonly signal?: AbortSignal },
  ) => Promise<{
    data: Array<{ info: Record<string, unknown>; parts: Part[] }>;
  }>;
  readonly status?: (
    input?: Record<string, unknown>,
    requestOptions?: { readonly signal?: AbortSignal },
  ) => Promise<{ data: Record<string, { type: string }> }>;
  readonly abort?: (
    input: { sessionID: string },
    requestOptions?: { readonly signal?: AbortSignal },
  ) => Promise<unknown>;
  readonly session?: Record<string, unknown>;
  readonly sessionIds?: ReadonlyArray<string>;
}) {
  const abortCalls: Array<{ sessionID: string }> = [];
  const abortRequestSignals: Array<AbortSignal | undefined> = [];
  const cliModelCalls: Array<Parameters<OpenCodeRuntimeShape["listOpenCodeCliModels"]>[0]> = [];
  const connectCalls: Array<Parameters<OpenCodeRuntimeShape["connectToOpenCodeServer"]>[0]> = [];
  const createCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<Record<string, unknown>> = [];
  const forkCalls: Array<{ sessionID: string }> = [];
  const permissionReplyCalls: Array<Record<string, unknown>> = [];
  const promptCalls: Array<Record<string, unknown>> = [];
  let sessionCreateCallCount = 0;
  const emptySubscription = {
    async *[Symbol.asyncIterator]() {
      // No provider-side events needed for these adapter lifecycle tests.
    },
  };
  const client = {
    event: {
      subscribe: async () => ({ stream: options?.events ?? emptySubscription }),
    },
    session: {
      create: async (input: Record<string, unknown>) => {
        createCalls.push(input);
        const id = options?.sessionIds?.[sessionCreateCallCount] ?? "opencode-session-1";
        sessionCreateCallCount += 1;
        return { data: { id } };
      },
      update: async (input: Record<string, unknown>) => {
        updateCalls.push(input);
        return { data: null };
      },
      promptAsync: async (promptInput: Record<string, unknown>) => {
        promptCalls.push(promptInput);
        if (options?.promptAsync) {
          return options.promptAsync(promptInput);
        }
        return { data: null };
      },
      prompt: async (promptInput: Record<string, unknown>) => {
        promptCalls.push(promptInput);
        if (options?.prompt) {
          return options.prompt(promptInput);
        }
        return { data: null };
      },
      abort: async (
        input: { sessionID: string },
        requestOptions?: { readonly signal?: AbortSignal },
      ) => {
        abortCalls.push(input);
        abortRequestSignals.push(requestOptions?.signal);
        if (options?.abort) {
          return options.abort(input, requestOptions);
        }
        return { data: null };
      },
      messages: async (
        input?: Record<string, unknown>,
        requestOptions?: { readonly signal?: AbortSignal },
      ) => options?.messages?.(input, requestOptions) ?? { data: [] },
      status: async (
        input?: Record<string, unknown>,
        requestOptions?: { readonly signal?: AbortSignal },
      ) => options?.status?.(input, requestOptions) ?? { data: {} },
      get: async () => ({ data: { directory: process.cwd(), ...(options?.session ?? {}) } }),
      revert: async () => ({ data: null }),
      summarize: async () => ({ data: null }),
      fork: async (input: { sessionID: string }) => {
        forkCalls.push(input);
        return { data: { id: "forked-session-1" } };
      },
    },
    permission: {
      reply: async (input: Record<string, unknown>) => {
        permissionReplyCalls.push(input);
        return { data: null };
      },
    },
    question: {
      reply: async () => ({ data: null }),
    },
    command: {
      list: options?.commandList ?? (async () => ({ data: [] })),
    },
  };
  let createClientCallCount = 0;

  const unexpectedOperation = (operation: string) =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation,
        detail: `Unexpected runtime operation: ${operation}`,
      }),
    );

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = () => {
    const commandList = options?.commandLists?.[createClientCallCount];
    createClientCallCount += 1;
    if (!commandList) {
      return client as unknown as OpencodeClient;
    }
    return {
      ...client,
      command: {
        list: async () => ({ data: commandList }),
      },
    } as unknown as OpencodeClient;
  };

  const runtime: OpenCodeRuntimeShape = {
    startOpenCodeServerProcess: () => unexpectedOperation("startOpenCodeServerProcess"),
    connectToOpenCodeServer: (input) =>
      Effect.gen(function* () {
        connectCalls.push(input);
        if (options?.connectError) {
          return yield* options.connectError;
        }
        return {
          url: input.serverUrl ?? "http://127.0.0.1:4099",
          exitCode: null,
          external: Boolean(input.serverUrl),
        };
      }),
    runOpenCodeCommand: () => unexpectedOperation("runOpenCodeCommand"),
    createOpenCodeSdkClient,
    loadOpenCodeInventory: () =>
      options?.inventoryError
        ? Effect.fail(options.inventoryError)
        : Effect.succeed(
            options?.inventory ?? {
              providerList: { connected: [], all: [], default: {} },
              agents: [],
              consoleState: null,
            },
          ),
    listOpenCodeCliModels: (input) =>
      Effect.gen(function* () {
        cliModelCalls.push(input);
        if (options?.cliModelsError) {
          return yield* options.cliModelsError;
        }
        return options?.cliModels ?? [];
      }),
    loadOpenCodeCredentialProviderIDs: () => Effect.succeed([]),
  };

  return {
    abortCalls,
    abortRequestSignals,
    cliModelCalls,
    connectCalls,
    createCalls,
    updateCalls,
    forkCalls,
    permissionReplyCalls,
    promptCalls,
    runtime,
  };
}

function pushActivePromptEcho(
  eventQueue: { readonly push: (event: unknown) => void },
  runtime: ReturnType<typeof createMockOpenCodeRuntime>,
  promptIndex = runtime.promptCalls.length - 1,
): string {
  const promptMessageId = runtime.promptCalls[promptIndex]?.messageID;
  if (typeof promptMessageId !== "string") {
    throw new Error(`Expected prompt call ${promptIndex} to contain a messageID.`);
  }
  eventQueue.push({
    type: "message.updated",
    properties: {
      sessionID: "opencode-session-1",
      info: { id: promptMessageId, role: "user" },
    },
  });
  return promptMessageId;
}

function createSubscribedEventQueue() {
  const pendingEvents: Array<unknown> = [];
  let waitingResolver: ((result: IteratorResult<unknown>) => void) | undefined;
  let closed = false;

  return {
    push(event: unknown) {
      if (closed) {
        return;
      }
      if (waitingResolver) {
        const resolve = waitingResolver;
        waitingResolver = undefined;
        resolve({ value: event, done: false });
        return;
      }
      pendingEvents.push(event);
    },
    close() {
      closed = true;
      if (waitingResolver) {
        const resolve = waitingResolver;
        waitingResolver = undefined;
        resolve({ value: undefined, done: true });
      }
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            if (pendingEvents.length > 0) {
              return {
                value: pendingEvents.shift(),
                done: false,
              };
            }
            if (closed) {
              return { value: undefined, done: true };
            }
            return await new Promise<IteratorResult<unknown>>((resolve) => {
              waitingResolver = resolve;
            });
          },
        };
      },
    },
  };
}

function createBroadcastSubscribedEventQueue() {
  const subscribers: Array<ReturnType<typeof createSubscribedEventQueue>> = [];
  return {
    subscribe() {
      const subscriber = createSubscribedEventQueue();
      subscribers.push(subscriber);
      return subscriber.stream;
    },
    push(event: unknown) {
      for (const subscriber of subscribers) {
        subscriber.push(event);
      }
    },
    close() {
      for (const subscriber of subscribers) {
        subscriber.close();
      }
    },
  };
}

function bindSubscribedEventQueue(
  runtime: ReturnType<typeof createMockOpenCodeRuntime>,
  eventQueue: ReturnType<typeof createSubscribedEventQueue>,
): void {
  const client = runtime.runtime.createOpenCodeSdkClient({
    baseUrl: "http://127.0.0.1:4099",
    directory: process.cwd(),
  }) as unknown as {
    event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> };
  };
  client.event.subscribe = async () => ({ stream: eventQueue.stream });
}

function makeInventoryWithContextLimit(input: {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly contextLimit?: number;
}): OpenCodeInventory {
  const providerId = input.providerId ?? "openai";
  const modelId = input.modelId ?? "gpt-5.4";
  return {
    providerList: {
      connected: [providerId],
      all: [
        makeProvider({
          id: providerId,
          name: "OpenAI",
          source: "api",
          models: {
            [modelId]: {
              id: modelId,
              name: "GPT-5.4",
              limit: {
                context: input.contextLimit ?? 200_000,
                output: 8_192,
              },
            },
          },
        }),
      ],
      default: {},
    },
    agents: [],
    consoleState: null,
  };
}

function assistantMessageUpdated(input?: {
  readonly id?: string;
  readonly tokens?: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cache: {
      readonly read: number;
      readonly write: number;
    };
  };
  readonly cost?: number;
}) {
  return {
    type: "message.updated",
    properties: {
      sessionID: "opencode-session-1",
      info: {
        id: input?.id ?? "assistant-message-usage",
        role: "assistant",
        tokens: input?.tokens ?? {
          input: 120,
          output: 80,
          reasoning: 30,
          cache: {
            read: 10,
            write: 5,
          },
        },
        cost: input?.cost ?? 0.1234,
      },
    },
  };
}

function idleStatusEvent() {
  return {
    type: "session.status",
    properties: {
      sessionID: "opencode-session-1",
      status: {
        type: "idle",
      },
    },
  };
}

describe("normalizeOpenCodeTokenUsage", () => {
  it("converts OpenCode assistant tokens into a context usage snapshot", () => {
    expect(
      normalizeOpenCodeTokenUsage(
        {
          input: 100,
          output: 50,
          reasoning: 25,
          cache: {
            read: 10,
            write: 5,
          },
        },
        200_000,
      ),
    ).toEqual({
      usedTokens: 190,
      totalProcessedTokens: 190,
      maxTokens: 200_000,
      inputTokens: 100,
      cachedInputTokens: 15,
      outputTokens: 50,
      reasoningOutputTokens: 25,
      lastUsedTokens: 190,
      lastInputTokens: 100,
      lastCachedInputTokens: 15,
      lastOutputTokens: 50,
      lastReasoningOutputTokens: 25,
    });
  });

  it("returns undefined for missing, malformed, negative, infinite, or all-zero usage", () => {
    const validBase = {
      input: 1,
      output: 1,
      reasoning: 1,
      cache: {
        read: 1,
        write: 1,
      },
    };

    expect(normalizeOpenCodeTokenUsage(undefined)).toBeUndefined();
    expect(normalizeOpenCodeTokenUsage({ ...validBase, input: -1 })).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({ ...validBase, output: Number.POSITIVE_INFINITY }),
    ).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({ ...validBase, cache: { read: Number.NaN, write: 1 } }),
    ).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      }),
    ).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({
        input: 1,
        output: 1,
        reasoning: 1,
      }),
    ).toBeUndefined();
  });

  it("clamps used tokens to the model context limit while preserving total processed tokens", () => {
    expect(
      normalizeOpenCodeTokenUsage(
        {
          input: 150,
          output: 75,
          reasoning: 50,
          cache: {
            read: 25,
            write: 25,
          },
        },
        200,
      ),
    ).toMatchObject({
      usedTokens: 200,
      totalProcessedTokens: 325,
      maxTokens: 200,
      lastUsedTokens: 200,
    });
  });
});

describe("resolvePreferredOpenCodeModelProviders", () => {
  it("keeps explicit credential providers and OpenCode-managed providers together", () => {
    const providers = resolvePreferredOpenCodeModelProviders({
      inventory: {
        providerList: {
          connected: ["cloudflare-ai-gateway", "openai", "opencode"],
          all: [
            makeProvider({
              id: "cloudflare-ai-gateway",
              name: "Cloudflare AI Gateway",
              source: "env",
            }),
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
            }),
            makeProvider({
              id: "opencode",
              name: "OpenCode",
              source: "api",
            }),
          ],
        },
        consoleState: {
          consoleManagedProviders: [],
        },
      },
      credentialProviderIDs: ["openai"],
    });

    expect(providers.map((provider) => provider.id)).toEqual(["openai", "opencode"]);
  });

  it("adds console-managed connected providers to the preferred set", () => {
    const providers = resolvePreferredOpenCodeModelProviders({
      inventory: {
        providerList: {
          connected: ["cloudflare-ai-gateway", "openai", "opencode", "openrouter"],
          all: [
            makeProvider({
              id: "cloudflare-ai-gateway",
              name: "Cloudflare AI Gateway",
              source: "env",
            }),
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
            }),
            makeProvider({
              id: "opencode",
              name: "OpenCode",
              source: "api",
            }),
            makeProvider({
              id: "openrouter",
              name: "OpenRouter",
              source: "api",
            }),
          ],
        },
        consoleState: {
          consoleManagedProviders: ["openrouter"],
        },
      },
      credentialProviderIDs: ["openai"],
    });

    expect(providers.map((provider) => provider.id)).toEqual(["openai", "opencode", "openrouter"]);
  });

  it("prefers OpenCode-managed providers before generic non-environment providers", () => {
    const providers = resolvePreferredOpenCodeModelProviders({
      inventory: {
        providerList: {
          connected: ["cloudflare-ai-gateway", "openai", "opencode"],
          all: [
            makeProvider({
              id: "cloudflare-ai-gateway",
              name: "Cloudflare AI Gateway",
              source: "env",
            }),
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
            }),
            makeProvider({
              id: "opencode",
              name: "OpenCode",
              source: "api",
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(providers.map((provider) => provider.id)).toEqual(["opencode"]);
  });

  it("falls back to non-environment connected providers when no stronger OpenCode signals exist", () => {
    const providers = resolvePreferredOpenCodeModelProviders({
      inventory: {
        providerList: {
          connected: ["cloudflare-ai-gateway", "openai", "openrouter"],
          all: [
            makeProvider({
              id: "cloudflare-ai-gateway",
              name: "Cloudflare AI Gateway",
              source: "env",
            }),
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
            }),
            makeProvider({
              id: "openrouter",
              name: "OpenRouter",
              source: "api",
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(providers.map((provider) => provider.id)).toEqual(["openai", "openrouter"]);
  });

  it("falls back to every connected provider when only environment providers are connected", () => {
    const providers = resolvePreferredOpenCodeModelProviders({
      inventory: {
        providerList: {
          connected: ["cloudflare-ai-gateway", "cloudflare-workers-ai"],
          all: [
            makeProvider({
              id: "cloudflare-ai-gateway",
              name: "Cloudflare AI Gateway",
              source: "env",
            }),
            makeProvider({
              id: "cloudflare-workers-ai",
              name: "Cloudflare Workers AI",
              source: "env",
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(providers.map((provider) => provider.id)).toEqual([
      "cloudflare-ai-gateway",
      "cloudflare-workers-ai",
    ]);
  });
});

describe("flattenOpenCodeModels", () => {
  it("converts OpenCode CLI model output into grouped model descriptors", () => {
    const models = flattenOpenCodeCliModels({
      models: [
        {
          slug: "openai/gpt-5.4",
          providerID: "openai",
          modelID: "gpt-5.4",
          name: "GPT-5.4",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "opencode/minimax-m2.5-free",
          providerID: "opencode",
          modelID: "minimax-m2.5-free",
          name: "MiniMax M2.5 Free",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "opencode-go/kimi-k2.6",
          providerID: "opencode-go",
          modelID: "kimi-k2.6",
          name: "Kimi K2.6",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "kimi-for-coding/k2p6",
          providerID: "kimi-for-coding",
          modelID: "k2p6",
          name: "K2P6",
          variants: [],
          supportedReasoningEfforts: [
            {
              value: "high",
            },
          ],
          defaultReasoningEffort: "high",
        },
        {
          slug: "github-copilot/claude-sonnet-4.6",
          providerID: "github-copilot",
          modelID: "claude-sonnet-4.6",
          name: "Claude Sonnet 4.6",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "anthropic/claude-sonnet-4-5",
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "google-vertex/gemini-3-pro",
          providerID: "google-vertex",
          modelID: "gemini-3-pro",
          name: "Gemini 3 Pro",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "openrouter/qwen/qwen3-coder",
          providerID: "openrouter",
          modelID: "qwen/qwen3-coder",
          name: "Qwen3 Coder",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "ollama/qwen3-coder:30b",
          providerID: "ollama",
          modelID: "qwen3-coder:30b",
          name: "Qwen3 Coder 30B",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "amazon-bedrock/anthropic-claude-sonnet-4.5",
          providerID: "amazon-bedrock",
          modelID: "anthropic-claude-sonnet-4.5",
          name: "Claude Sonnet 4.5",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "vercel-ai-gateway/xai/grok-code-fast",
          providerID: "vercel-ai-gateway",
          modelID: "xai/grok-code-fast",
          name: "Grok Code Fast",
          variants: [],
          supportedReasoningEfforts: [],
        },
      ],
    });

    expect(models).toEqual([
      {
        slug: "amazon-bedrock/anthropic-claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        upstreamProviderId: "amazon-bedrock",
        upstreamProviderName: "Amazon Bedrock",
      },
      {
        slug: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
      },
      {
        slug: "github-copilot/claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        upstreamProviderId: "github-copilot",
        upstreamProviderName: "GitHub Copilot",
      },
      {
        slug: "google-vertex/gemini-3-pro",
        name: "Gemini 3 Pro",
        upstreamProviderId: "google-vertex",
        upstreamProviderName: "Google Vertex AI",
      },
      {
        slug: "kimi-for-coding/k2p6",
        name: "K2P6",
        upstreamProviderId: "kimi-for-coding",
        upstreamProviderName: "Kimi For Coding",
        supportedReasoningEfforts: [
          {
            value: "high",
          },
        ],
        defaultReasoningEffort: "high",
      },
      {
        slug: "ollama/qwen3-coder:30b",
        name: "Qwen3 Coder 30B",
        upstreamProviderId: "ollama",
        upstreamProviderName: "Ollama",
      },
      {
        slug: "openai/gpt-5.4",
        name: "GPT-5.4",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
      },
      {
        slug: "opencode/minimax-m2.5-free",
        name: "MiniMax M2.5 Free",
        upstreamProviderId: "opencode",
        upstreamProviderName: "OpenCode",
      },
      {
        slug: "opencode-go/kimi-k2.6",
        name: "Kimi K2.6",
        upstreamProviderId: "opencode-go",
        upstreamProviderName: "OpenCode Go",
      },
      {
        slug: "openrouter/qwen/qwen3-coder",
        name: "Qwen3 Coder",
        upstreamProviderId: "openrouter",
        upstreamProviderName: "OpenRouter",
      },
      {
        slug: "vercel-ai-gateway/xai/grok-code-fast",
        name: "Grok Code Fast",
        upstreamProviderId: "vercel-ai-gateway",
        upstreamProviderName: "Vercel AI Gateway",
      },
    ]);
  });

  it("includes upstream provider metadata for grouped OpenCode model menus", () => {
    const models = flattenOpenCodeModels({
      inventory: {
        providerList: {
          connected: ["opencode", "openai"],
          all: [
            makeProvider({
              id: "opencode",
              name: "OpenCode",
              source: "api",
              models: {
                "nemotron-3-super-free": {
                  id: "nemotron-3-super-free",
                  name: "Nemotron 3 Super Free",
                },
              },
            }),
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
              models: {
                "gpt-5": {
                  id: "gpt-5",
                  name: "GPT-5",
                },
              },
            }),
          ],
        },
        consoleState: {
          consoleManagedProviders: ["openai"],
        },
      },
    });

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "GPT-5",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
        contextWindowOptions: [{ value: "128k", label: "128K", isDefault: true }],
        defaultContextWindow: "128k",
      },
      {
        slug: "opencode/nemotron-3-super-free",
        name: "Nemotron 3 Super Free",
        upstreamProviderId: "opencode",
        upstreamProviderName: "OpenCode",
        contextWindowOptions: [{ value: "128k", label: "128K", isDefault: true }],
        defaultContextWindow: "128k",
      },
    ]);
  });

  it("surfaces reasoning variants as supported thinking levels for OpenCode models", () => {
    const models = flattenOpenCodeModels({
      inventory: {
        providerList: {
          connected: ["openai"],
          all: [
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  capabilities: {
                    reasoning: true,
                  },
                  variants: {
                    none: {
                      reasoningEffort: "none",
                    },
                    low: {
                      reasoningEffort: "low",
                    },
                    minimal: {
                      reasoning: {
                        effort: "minimal",
                      },
                    },
                    medium: {
                      reasoningEffort: "medium",
                    },
                    high: {
                      reasoningEffort: "high",
                    },
                    xhigh: {
                      reasoningEffort: "xhigh",
                    },
                    custom: {
                      label: "Do not treat as thinking",
                    },
                  },
                },
              },
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        name: "GPT-5.4",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
        contextWindowOptions: [{ value: "128k", label: "128K", isDefault: true }],
        defaultContextWindow: "128k",
        supportedReasoningEfforts: [
          {
            value: "none",
          },
          {
            value: "low",
          },
          {
            value: "minimal",
          },
          {
            value: "medium",
          },
          {
            value: "high",
          },
          {
            value: "xhigh",
          },
        ],
        defaultReasoningEffort: "medium",
      },
    ]);
  });

  it("trims upstream provider and model names before exposing runtime models", () => {
    const models = flattenOpenCodeModels({
      inventory: {
        providerList: {
          connected: ["openai"],
          all: [
            makeProvider({
              id: "openai",
              name: " OpenAI ",
              source: "api",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: " GPT-5.4 ",
                },
              },
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        name: "GPT-5.4",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
        contextWindowOptions: [{ value: "128k", label: "128K", isDefault: true }],
        defaultContextWindow: "128k",
      },
    ]);
  });

  it("prefers OpenCode-managed connected providers when no stronger auth metadata exists", () => {
    const models = flattenOpenCodeModels({
      inventory: {
        providerList: {
          connected: ["opencode", "github-copilot"],
          all: [
            makeProvider({
              id: "opencode",
              name: "OpenCode",
              source: "api",
              models: {
                "glm-4.6": {
                  id: "glm-4.6",
                  name: "GLM 4.6",
                },
              },
            }),
            makeProvider({
              id: "github-copilot",
              name: "GitHub Copilot",
              source: "api",
              models: {
                "claude-opus-4.6": {
                  id: "claude-opus-4.6",
                  name: "Claude Opus 4.6",
                },
              },
            }),
            makeProvider({
              id: "openrouter",
              name: "OpenRouter",
              source: "api",
              models: {
                "qwen/qwen3-coder": {
                  id: "qwen/qwen3-coder",
                  name: "Qwen3 Coder",
                },
              },
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(models.map((model) => model.slug)).toEqual(["opencode/glm-4.6"]);
  });
});

describe("OpenCodeAdapter runtime lifecycle", () => {
  it("lists OpenCode models from the CLI before falling back to server inventory", async () => {
    const runtime = createMockOpenCodeRuntime({
      cliModels: [
        {
          slug: "opencode/minimax-m2.5-free",
          providerID: "opencode",
          modelID: "minimax-m2.5-free",
          name: "MiniMax M2.5 Free",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "opencode-go/kimi-k2.6",
          providerID: "opencode-go",
          modelID: "kimi-k2.6",
          name: "Kimi K2.6",
          variants: [],
          supportedReasoningEfforts: [],
        },
      ],
      inventory: {
        providerList: {
          connected: ["openai"],
          default: {},
          all: [
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
              models: {
                "gpt-5": {
                  id: "gpt-5",
                  name: "GPT-5",
                },
              },
            }),
          ],
        },
        agents: [],
        consoleState: null,
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listModels = adapter.listModels;
        if (!listModels) {
          throw new Error("Expected OpenCode adapter to support runtime model listing.");
        }
        return yield* listModels({
          provider: "opencode",
          binaryPath: "opencode",
          cwd: "/repo/model-discovery-config",
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result).toMatchObject({
      source: "opencode-cli",
      cached: false,
    });
    expect(result?.models.map((model) => model.slug)).toEqual([
      "openai/gpt-5",
      "opencode/minimax-m2.5-free",
      "opencode-go/kimi-k2.6",
    ]);
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/model-discovery-config" });
    expect(runtime.cliModelCalls).toHaveLength(1);
    expect(runtime.cliModelCalls[0]).toMatchObject({ cwd: "/repo/model-discovery-config" });
  });

  it("lists OpenCode CLI models when server inventory discovery fails", async () => {
    const runtime = createMockOpenCodeRuntime({
      connectError: new OpenCodeRuntimeError({
        operation: "connectToOpenCodeServer",
        detail: "OpenCode server failed to start.",
      }),
      cliModels: [
        {
          slug: "opencode/nemotron-3-ultra-free",
          providerID: "opencode",
          modelID: "nemotron-3-ultra-free",
          name: "Nemotron 3 Ultra Free",
          variants: [],
          supportedReasoningEfforts: [],
        },
      ],
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listModels = adapter.listModels;
        if (!listModels) {
          throw new Error("Expected OpenCode adapter to support runtime model listing.");
        }
        return yield* listModels({
          provider: "opencode",
          binaryPath: "opencode",
          cwd: "/repo/server-startup-fails",
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result).toMatchObject({
      source: "opencode-cli",
      cached: false,
    });
    expect(result?.models.map((model) => model.slug)).toEqual(["opencode/nemotron-3-ultra-free"]);
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/server-startup-fails" });
    expect(runtime.cliModelCalls).toHaveLength(1);
    expect(runtime.cliModelCalls[0]).toMatchObject({ cwd: "/repo/server-startup-fails" });
  });

  it("lists OpenCode agents from the active discovery cwd", async () => {
    const runtime = createMockOpenCodeRuntime({
      inventory: {
        providerList: {
          connected: [],
          default: {},
          all: [],
        },
        agents: [
          {
            name: "project-review",
            displayName: "Project Review",
            description: "Review code with the project-local agent",
            mode: "primary",
            hidden: false,
          } as unknown as Agent,
        ],
        consoleState: null,
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listAgents = adapter.listAgents;
        if (!listAgents) {
          throw new Error("Expected OpenCode adapter to support runtime agent listing.");
        }
        return yield* listAgents({
          provider: "opencode",
          binaryPath: "opencode",
          cwd: "/repo/agent-discovery-config",
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result).toMatchObject({
      source: "opencode",
      cached: false,
      agents: [
        {
          name: "project-review",
          displayName: "Project Review",
          description: "Review code with the project-local agent",
        },
      ],
    });
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/agent-discovery-config" });
  });

  it("does not reuse an unrelated active OpenCode session for command discovery", async () => {
    const runtime = createMockOpenCodeRuntime({
      commandLists: [[{ name: "wrong-thread" }], [{ name: "review", description: "Review code" }]],
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listCommands = adapter.listCommands;
        if (!listCommands) {
          throw new Error("Expected OpenCode adapter to support command listing.");
        }

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-active"),
          runtimeMode: "full-access",
        });

        return yield* listCommands({
          provider: "opencode",
          cwd: process.cwd(),
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result).toEqual({
      commands: [{ name: "review", description: "Review code" }],
      source: "opencode",
      cached: false,
    });
  });

  it("passes the session cwd to managed OpenCode server connections", async () => {
    const runtime = createMockOpenCodeRuntime();
    const cwd = process.cwd();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-managed-cwd"),
          runtimeMode: "full-access",
          cwd,
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd });
  });

  it("uses the persisted resume cursor cwd when resuming OpenCode sessions", async () => {
    const runtime = createMockOpenCodeRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        return yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-resume-cwd"),
          runtimeMode: "full-access",
          resumeCursor: { openCodeSessionId: "existing-session-1", cwd: "/repo/resume" },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.createCalls).toEqual([]);
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/resume" });
    expect(result.cwd).toBe("/repo/resume");
    expect(result.resumeCursor).toMatchObject({
      openCodeSessionId: "existing-session-1",
      cwd: "/repo/resume",
    });
  });

  it("re-applies the runtime-mode permission ruleset when resuming OpenCode sessions", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-resume-permissions"),
          runtimeMode: "full-access",
          resumeCursor: { openCodeSessionId: "existing-session-1", cwd: "/repo/resume" },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.createCalls).toEqual([]);
    expect(runtime.updateCalls).toEqual([
      {
        sessionID: "existing-session-1",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      },
    ]);
  });

  it("declines inactive OpenCode native fork when source and target cwd differ", async () => {
    const runtime = createMockOpenCodeRuntime();

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          const forkThread = adapter.forkThread;
          if (!forkThread) {
            throw new Error("Expected OpenCode adapter to support native thread forking.");
          }
          return yield* forkThread({
            sourceThreadId: asThreadId("thread-source"),
            threadId: asThreadId("thread-target"),
            sourceResumeCursor: { openCodeSessionId: "source-session-1" },
            sourceCwd: "/repo/source",
            cwd: "/repo/target",
            runtimeMode: "full-access",
          });
        }).pipe(
          Effect.provide(
            makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      ),
    ).rejects.toThrow("native fork cannot cross cwd boundaries");

    expect(runtime.forkCalls).toEqual([]);
    expect(runtime.connectCalls).toEqual([]);
  });

  it("defaults inactive OpenCode native forks to the source cwd", async () => {
    const runtime = createMockOpenCodeRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const forkThread = adapter.forkThread;
        if (!forkThread) {
          throw new Error("Expected OpenCode adapter to support native thread forking.");
        }
        return yield* forkThread({
          sourceThreadId: asThreadId("thread-source"),
          threadId: asThreadId("thread-target"),
          sourceResumeCursor: { openCodeSessionId: "source-session-1" },
          sourceCwd: "/repo/source",
          runtimeMode: "full-access",
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.forkCalls).toEqual([{ sessionID: "source-session-1" }]);
    expect(runtime.connectCalls).toHaveLength(2);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/source" });
    expect(runtime.connectCalls[1]).toMatchObject({ cwd: "/repo/source" });
    expect(result.resumeCursor).toMatchObject({
      openCodeSessionId: "forked-session-1",
      cwd: "/repo/source",
    });
  });

  it("reuses the matching active OpenCode thread for command discovery", async () => {
    const threadId = asThreadId("thread-command-discovery");
    const runtime = createMockOpenCodeRuntime({
      commandLists: [[{ name: "active-thread-command" }], [{ name: "scoped-client-command" }]],
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listCommands = adapter.listCommands;
        if (!listCommands) {
          throw new Error("Expected OpenCode adapter to support command listing.");
        }

        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
        });

        return yield* listCommands({
          provider: "opencode",
          threadId,
          cwd: process.cwd(),
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.commands.map((command) => command.name)).toEqual(["active-thread-command"]);
  });

  it("returns no OpenCode commands when command discovery is unsupported", async () => {
    const runtime = createMockOpenCodeRuntime({
      commandList: async () => {
        throw new Error("status=404 body={}");
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listCommands = adapter.listCommands;
        if (!listCommands) {
          throw new Error("Expected OpenCode adapter to support command listing.");
        }

        return yield* listCommands({
          provider: "opencode",
          cwd: process.cwd(),
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result).toEqual({
      commands: [],
      source: "unsupported",
      cached: false,
    });
  });

  it("pins the initial model on new OpenCode sessions", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-model-pin"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "opencode",
            model: "opencode/big-pickle",
            options: {
              agent: "build",
              variant: "fast",
            },
          },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.createCalls[0]).toMatchObject({
      model: {
        providerID: "opencode",
        id: "big-pickle",
        variant: "fast",
      },
      agent: "build",
      title: "Scient thread-model-pin",
    });
  });

  it("clears adapter session state when interrupting an active OpenCode turn", async () => {
    const runtime = createMockOpenCodeRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-1"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
            options: {
              variant: "high",
            },
          },
        });

        const [runningSession] = yield* adapter.listSessions();

        yield* adapter.interruptTurn(asThreadId("thread-1"));

        const [readySession] = yield* adapter.listSessions();
        const events = Array.from(yield* Fiber.join(eventsFiber));

        return { events, readySession, runningSession };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.promptCalls).toHaveLength(1);
    expect(runtime.promptCalls[0]).toMatchObject({
      model: {
        providerID: "openai",
        modelID: "gpt-5.4",
      },
      variant: "high",
    });
    expect(runtime.abortCalls.length).toBeGreaterThanOrEqual(1);
    expect(runtime.abortCalls[0]).toEqual({ sessionID: "opencode-session-1" });
    expect(result.runningSession?.status).toBe("running");
    expect(result.runningSession?.activeTurnId).toBeDefined();
    expect(result.readySession).toMatchObject({
      provider: "opencode",
      status: "ready",
      model: "openai/gpt-5.4",
    });
    expect(result.readySession?.activeTurnId).toBeUndefined();
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "turn.aborted",
    ]);
    expect(result.events[3]).toMatchObject({
      type: "turn.aborted",
      payload: {
        reason: "Interrupted by user.",
      },
    });
  });

  it("replays assistant text when OpenCode sends delta before part snapshot and assistant role", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-ordered-events"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: asThreadId("thread-ordered-events"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.part.delta",
          properties: {
            sessionID: "opencode-session-1",
            partID: "part-1",
            delta: "Hello",
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-1",
              messageID: "assistant-message-1",
              type: "text",
              text: "",
              time: {
                start: 1,
              },
            },
          },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "assistant-message-1",
              role: "assistant",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-1",
              messageID: "assistant-message-1",
              type: "text",
              text: "Hello",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        });
        eventQueue.push({
          type: "session.status",
          properties: {
            sessionID: "opencode-session-1",
            status: {
              type: "idle",
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();

        return { events, turn };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.turn.turnId).toBeDefined();
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(result.events[3]).toMatchObject({
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "Hello",
      },
    });
    expect(result.events[4]).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        detail: "Hello",
      },
    });
  });

  it("filters Kilo synthetic and ignored text parts from assistant transcript", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-synthetic-kilo-parts"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-synthetic-kilo-parts"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "assistant-message-filtered",
              role: "assistant",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-synthetic",
              messageID: "assistant-message-filtered",
              type: "text",
              text: "Initializing snapshot...",
              synthetic: true,
              time: {
                start: 1,
              },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-ignored",
              messageID: "assistant-message-filtered",
              type: "text",
              text: "Internal warning",
              ignored: true,
              time: {
                start: 2,
              },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-visible",
              messageID: "assistant-message-filtered",
              type: "text",
              text: "Actual answer",
              time: {
                start: 3,
                end: 4,
              },
            },
          },
        });
        eventQueue.push({
          type: "session.status",
          properties: {
            sessionID: "opencode-session-1",
            status: {
              type: "idle",
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "Actual answer",
      },
    });
    expect(JSON.stringify(result)).not.toContain("Initializing snapshot");
    expect(JSON.stringify(result)).not.toContain("Internal warning");
  });

  it("sends plan-mode prompt instructions and captures tagged markdown as a proposed plan", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-plan-events"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-plan-events"),
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "assistant-message-plan",
              role: "assistant",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-plan",
              messageID: "assistant-message-plan",
              type: "text",
              text: "<proposed_plan>\n# OpenCode plan\n\n- capture it\n</proposed_plan>",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.promptCalls[0]?.parts).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Scient plan mode is active."),
      },
    ]);
    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "turn.proposed.completed",
      "item.completed",
    ]);
    expect(result[4]).toMatchObject({
      type: "turn.proposed.completed",
      payload: {
        planMarkdown: "# OpenCode plan\n\n- capture it",
      },
    });
  });

  it("pins default-mode turns to the OpenCode build agent", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-default-build-agent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-default-build-agent"),
          input: "implement this",
          interactionMode: "default",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.promptCalls[0]).toMatchObject({
      agent: "build",
    });
  });

  it("projects generic file attachments into text instead of native OpenCode file parts", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-docx-attachment"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-docx-attachment"),
          input: "summarize this",
          interactionMode: "default",
          attachments: [
            {
              type: "file",
              id: "thread-docx-attachment-00000000-0000-4000-8000-000000000001",
              name: "minutes.docx",
              mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              sizeBytes: 4_096,
            },
          ],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    const parts = runtime.promptCalls[0]?.parts as Array<Record<string, unknown>> | undefined;
    expect(parts).toHaveLength(1);
    expect(parts?.[0]).toMatchObject({ type: "text" });
    expect(parts?.[0]?.text).toEqual(expect.stringContaining("<attached_files>"));
    expect(parts?.[0]?.text).toEqual(expect.stringContaining('"minutes.docx"'));
    expect(parts?.[0]?.text).toEqual(
      expect.stringContaining(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    );
    expect(parts?.[0]?.text).toEqual(expect.stringContaining(".docx"));
  });

  it("pins plan-mode turns to the OpenCode plan agent", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-plan-agent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-plan-agent"),
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.promptCalls[0]).toMatchObject({
      agent: "plan",
    });
  });

  it("preserves explicitly selected OpenCode agents", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-explicit-agent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-explicit-agent"),
          input: "use custom agent",
          interactionMode: "default",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
            options: {
              agent: "reviewer",
            },
          },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.promptCalls[0]).toMatchObject({
      agent: "reviewer",
    });
  });

  it("does not capture tagged markdown as a proposed plan outside plan mode", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-default-tagged-plan"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-default-tagged-plan"),
          input: "show an example tagged block",
          interactionMode: "default",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "assistant-message-default-plan",
              role: "assistant",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-default-plan",
              messageID: "assistant-message-default-plan",
              type: "text",
              text: "<proposed_plan>\n# Not a Synara plan\n</proposed_plan>",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
    ]);
    expect(result[4]).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        detail: "<proposed_plan>\n# Not a Synara plan\n</proposed_plan>",
      },
    });
  });

  it("emits context usage from OpenCode assistant message updates", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      inventory: makeInventoryWithContextLimit({ contextLimit: 200_000 }),
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-usage-events"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: asThreadId("thread-usage-events"),
          input: "count tokens",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push(assistantMessageUpdated());

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return { events, turn };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    const usageEvent = result.events.find((event) => event.type === "thread.token-usage.updated");
    expect(usageEvent).toMatchObject({
      type: "thread.token-usage.updated",
      turnId: result.turn.turnId,
      payload: {
        usage: {
          usedTokens: 245,
          totalProcessedTokens: 245,
          inputTokens: 120,
          cachedInputTokens: 15,
          outputTokens: 80,
          reasoningOutputTokens: 30,
          maxTokens: 200_000,
          lastUsedTokens: 245,
          lastInputTokens: 120,
          lastCachedInputTokens: 15,
          lastOutputTokens: 80,
          lastReasoningOutputTokens: 30,
        },
      },
      raw: {
        source: "opencode.sdk.event",
      },
    });
  });

  it("does not emit duplicate usage for identical assistant message updates", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      inventory: makeInventoryWithContextLimit({ contextLimit: 200_000 }),
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-usage-dedup"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-usage-dedup"),
          input: "count tokens",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push(assistantMessageUpdated());
        eventQueue.push(assistantMessageUpdated());

        const runtimeEvents = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return runtimeEvents;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(events.filter((event) => event.type === "thread.token-usage.updated")).toHaveLength(1);
  });

  it("emits usage without max tokens when the selected model limit is unknown", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-usage-unknown-limit"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-usage-unknown-limit"),
          input: "count tokens",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push(assistantMessageUpdated());

        const runtimeEvents = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return runtimeEvents;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    const usageEvent = events.find((event) => event.type === "thread.token-usage.updated");
    expect(usageEvent).toMatchObject({
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens: 245,
          totalProcessedTokens: 245,
        },
      },
    });
    expect(
      usageEvent?.type === "thread.token-usage.updated" && usageEvent.payload.usage,
    ).not.toHaveProperty("maxTokens");
  });

  it("ignores malformed and zero-token assistant usage updates", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-usage-zero"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-usage-zero"),
          input: "count tokens",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push(
          assistantMessageUpdated({
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          }),
        );
        eventQueue.push(
          assistantMessageUpdated({
            id: "assistant-message-malformed",
            tokens: {
              input: Number.NaN,
              output: 1,
              reasoning: 1,
              cache: {
                read: 1,
                write: 1,
              },
            },
          }),
        );
        const runtimeEvents = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return runtimeEvents;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
    ]);
  });

  it("maps OpenCode todo updates into shared turn tasks", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-todo-updated"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-todo-updated"),
          input: "work through todos",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "todo.updated",
          properties: {
            sessionID: "opencode-session-1",
            todos: [
              { content: "Inspect OpenCode events", status: "completed", priority: "high" },
              { content: "Wire todo updates", status: "in_progress", priority: "medium" },
              { content: "Report back", status: "pending", priority: "low" },
            ],
          },
        });

        const runtimeEvents = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return runtimeEvents;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    const taskEvent = events.find((event) => event.type === "turn.tasks.updated");
    expect(taskEvent?.type).toBe("turn.tasks.updated");
    if (taskEvent?.type === "turn.tasks.updated") {
      expect(taskEvent.payload.tasks).toEqual([
        { task: "Inspect OpenCode events", status: "completed" },
        { task: "Wire todo updates", status: "inProgress" },
        { task: "Report back", status: "pending" },
      ]);
    }
  });

  it("streams and completes turns from newer OpenCode session.next events", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-next-events"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-next-events"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });
        pushActivePromptEcho(eventQueue, runtime);

        eventQueue.push({
          id: "evt-next-text-delta",
          type: "session.next.text.delta",
          properties: {
            timestamp: 1,
            sessionID: "opencode-session-1",
            delta: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-text-ended",
          type: "session.next.text.ended",
          properties: {
            timestamp: 2,
            sessionID: "opencode-session-1",
            text: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-step-ended",
          type: "session.next.step.ended",
          properties: {
            timestamp: 3,
            sessionID: "opencode-session-1",
            finish: "stop",
            cost: 0.025,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "Hello",
      },
    });
    expect(result[4]).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        detail: "Hello",
      },
    });
  });

  it("bounds provider event-id deduplication while suppressing recent replays", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    bindSubscribedEventQueue(runtime, eventQueue);

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 7)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-bounded-event-dedupe");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        for (const [id, content] of [
          ["dedupe-1", "one"],
          ["dedupe-2", "two"],
          ["dedupe-3", "three"],
          ["dedupe-3", "three replay"],
          ["dedupe-1", "one after eviction"],
        ] as const) {
          eventQueue.push({
            id,
            type: "todo.updated",
            properties: {
              sessionID: "opencode-session-1",
              todos: [{ content, status: "pending", priority: "low" }],
            },
          });
        }
        const collected = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return collected;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime, eventDedupeLimit: 2 }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    const taskEvents = events.filter((event) => event.type === "turn.tasks.updated");
    expect(taskEvents).toHaveLength(4);
    expect(JSON.stringify(taskEvents)).not.toContain("three replay");
    expect(JSON.stringify(taskEvents)).toContain("one after eviction");
  });

  it("auto-approves OpenCode permission asks in full access without surfacing approvals", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-full-access-permission"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-full-access-permission"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });
        pushActivePromptEcho(eventQueue, runtime);

        eventQueue.push({
          id: "evt-permission-asked",
          type: "permission.asked",
          properties: {
            id: "permission-1",
            sessionID: "opencode-session-1",
            permission: "external_directory",
            patterns: ["/outside/project/**"],
            metadata: {},
            always: [],
          },
        });
        eventQueue.push({
          id: "evt-permission-replied",
          type: "permission.replied",
          properties: {
            sessionID: "opencode-session-1",
            requestID: "permission-1",
            reply: "always",
          },
        });
        eventQueue.push({
          id: "evt-next-text-delta",
          type: "session.next.text.delta",
          properties: {
            timestamp: 1,
            sessionID: "opencode-session-1",
            delta: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-text-ended",
          type: "session.next.text.ended",
          properties: {
            timestamp: 2,
            sessionID: "opencode-session-1",
            text: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-step-ended",
          type: "session.next.step.ended",
          properties: {
            timestamp: 3,
            sessionID: "opencode-session-1",
            finish: "stop",
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(runtime.permissionReplyCalls).toEqual([{ requestID: "permission-1", reply: "always" }]);
  });

  it("suppresses a permission.replied echo that arrives after turn teardown", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 7)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-late-permission-echo"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-late-permission-echo"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });
        pushActivePromptEcho(eventQueue, runtime);

        // Auto-approved ask at the tail of the turn; the reply echo has not arrived yet
        // when the turn completes and active-turn state is torn down.
        eventQueue.push({
          id: "evt-permission-asked",
          type: "permission.asked",
          properties: {
            id: "permission-late-1",
            sessionID: "opencode-session-1",
            permission: "external_directory",
            patterns: ["/outside/project/**"],
            metadata: {},
            always: [],
          },
        });
        eventQueue.push({
          id: "evt-next-text-delta",
          type: "session.next.text.delta",
          properties: {
            timestamp: 1,
            sessionID: "opencode-session-1",
            delta: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-text-ended",
          type: "session.next.text.ended",
          properties: {
            timestamp: 2,
            sessionID: "opencode-session-1",
            text: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-step-ended",
          type: "session.next.step.ended",
          properties: {
            timestamp: 3,
            sessionID: "opencode-session-1",
            finish: "stop",
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          },
        });
        // Late echo after teardown: must be swallowed as the auto-approved reply, not
        // surfaced as a request.resolved for a request the UI never saw opened.
        eventQueue.push({
          id: "evt-late-permission-replied",
          type: "permission.replied",
          properties: {
            sessionID: "opencode-session-1",
            requestID: "permission-late-1",
            reply: "always",
          },
        });
        // A queued question flushes the stream: the queue is FIFO, so its
        // user-input.requested must be the next event, proving the late echo emitted nothing.
        eventQueue.push({
          id: "evt-question-asked",
          type: "question.asked",
          properties: {
            id: "question-1",
            sessionID: "opencode-session-1",
            questions: [
              {
                question: "Proceed?",
                header: "Confirm",
                options: [{ label: "Yes", description: "" }],
                multiple: false,
                custom: false,
              },
            ],
            tool: undefined,
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
      "user-input.requested",
    ]);
    expect(runtime.permissionReplyCalls).toEqual([
      { requestID: "permission-late-1", reply: "always" },
    ]);
  });

  it("surfaces OpenCode permission asks as approvals in approval-required mode", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-approval-required-permission"),
          runtimeMode: "approval-required",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-approval-required-permission"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          id: "evt-permission-asked",
          type: "permission.asked",
          properties: {
            id: "permission-1",
            sessionID: "opencode-session-1",
            permission: "bash",
            patterns: ["rm -rf *"],
            metadata: {},
            always: [],
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "request.opened",
    ]);
    expect(result[3]).toMatchObject({
      type: "request.opened",
      payload: {
        requestType: "command_execution_approval",
        detail: "rm -rf *",
      },
    });
    expect(runtime.permissionReplyCalls).toEqual([]);
  });

  it("keeps newer OpenCode tool-call steps attached to the active turn", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-next-tool-call"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-next-tool-call"),
          input: "inspect files",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });
        pushActivePromptEcho(eventQueue, runtime);

        eventQueue.push({
          id: "evt-next-step-tool-calls",
          type: "session.next.step.ended",
          properties: {
            timestamp: 3,
            sessionID: "opencode-session-1",
            finish: "tool-calls",
            cost: 0.01,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          },
        });
        eventQueue.push({
          id: "evt-next-tool-called",
          type: "session.next.tool.called",
          properties: {
            timestamp: 4,
            sessionID: "opencode-session-1",
            callID: "tool-call-1",
            tool: "read",
            input: {
              filePath: "README.md",
            },
            provider: {
              executed: true,
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "item.started",
    ]);
    expect(result[3]).toMatchObject({
      type: "item.started",
      turnId: result[2]?.turnId,
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
      },
    });
  });

  it("forwards OpenCode child-session tool activity created by task parts", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-child-session-tools"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-child-session-tools"),
          input: "inspect files",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });
        pushActivePromptEcho(eventQueue, runtime);

        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "parent-task-part",
              messageID: "assistant-message-1",
              type: "tool",
              tool: "task",
              callID: "task-call-1",
              state: {
                status: "running",
                title: "Find changelog implementation",
                input: {
                  description: "Find changelog implementation",
                  prompt: "Explore changelog files.",
                },
                metadata: {
                  sessionId: "child-session-1",
                  parentSessionId: "opencode-session-1",
                },
                time: {
                  start: 1,
                },
              },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "child-session-1",
            part: {
              id: "child-grep-part",
              messageID: "child-assistant-message-1",
              type: "tool",
              tool: "grep",
              callID: "grep-call-1",
              state: {
                status: "completed",
                input: {
                  pattern: "changelog",
                },
                output: "Found 18 matches",
                time: {
                  start: 2,
                  end: 3,
                },
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "item.updated",
      "item.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "item.updated",
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        title: "Find changelog implementation",
      },
    });
    expect(result[4]).toMatchObject({
      type: "item.completed",
      turnId: result[2]?.turnId,
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        detail: "Found 18 matches",
      },
    });
  });

  it("projects newer OpenCode shell step events as command executions", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-next-shell"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-next-shell"),
          input: "inspect files",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });
        pushActivePromptEcho(eventQueue, runtime);

        eventQueue.push({
          id: "evt-next-shell-started",
          type: "session.next.shell.started",
          properties: {
            timestamp: 4,
            sessionID: "opencode-session-1",
            callID: "shell-call-1",
            command: "cat package.json | grep next",
          },
        });
        eventQueue.push({
          id: "evt-next-shell-ended",
          type: "session.next.shell.ended",
          properties: {
            timestamp: 5,
            sessionID: "opencode-session-1",
            callID: "shell-call-1",
            output: '"next": "15.5.0"',
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "item.started",
      "item.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "item.started",
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        detail: "cat package.json | grep next",
        data: {
          command: "cat package.json | grep next",
        },
      },
    });
    expect(result[4]).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
        detail: '"next": "15.5.0"',
        data: {
          output: '"next": "15.5.0"',
        },
      },
    });
  });

  it("does not block sendTurn when the OpenCode prompt request stalls during startup", async () => {
    const runtime = createMockOpenCodeRuntime({
      promptAsync: async () => await new Promise(() => {}),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-stalled-prompt-async"),
          runtimeMode: "full-access",
        });

        const turnReturned = yield* adapter
          .sendTurn({
            threadId: asThreadId("thread-stalled-prompt-async"),
            input: "hello",
            attachments: [],
            modelSelection: {
              provider: "opencode",
              model: "opencode/claude-opus-4-7",
            },
          })
          .pipe(
            Effect.timeoutOption(50),
            Effect.map((turnOption) => turnOption._tag === "Some"),
          );

        const events = Array.from(yield* Fiber.join(eventsFiber));
        return { events, turnReturned };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            promptSubmissionInlineWaitMs: 1,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.turnReturned).toBe(true);
    expect(runtime.promptCalls).toHaveLength(1);
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
    ]);
  });

  it("keeps immediate OpenCode prompt failures on the sendTurn failure path", async () => {
    const runtime = createMockOpenCodeRuntime({
      promptAsync: async () => {
        throw new Error("prompt rejected");
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-rejected-prompt-async"),
          runtimeMode: "full-access",
        });

        const sendExit = yield* Effect.exit(
          adapter.sendTurn({
            threadId: asThreadId("thread-rejected-prompt-async"),
            input: "hello",
            attachments: [],
            modelSelection: {
              provider: "opencode",
              model: "opencode/claude-opus-4-7",
            },
          }),
        );

        const events = Array.from(yield* Fiber.join(eventsFiber));
        return { events, sendFailed: sendExit._tag === "Failure" };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            promptSubmissionInlineWaitMs: 50,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.sendFailed).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "turn.aborted",
    ]);
    expect(result.events[3]).toMatchObject({
      type: "turn.aborted",
      payload: {
        reason: "prompt rejected",
      },
    });
  });

  it("treats OpenCode session.idle as turn completion", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-session-idle"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-session-idle"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-session-idle",
              role: "assistant",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-session-idle",
              messageID: "msg-session-idle",
              type: "text",
              text: "done",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        });
        eventQueue.push({
          id: "evt-session-idle",
          type: "session.idle",
          properties: {
            sessionID: "opencode-session-1",
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
  });

  it("completes after an early idle when final assistant events arrive without a second idle", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({ messages: async () => ({ data: [] }) });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const session = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-early-idle-no-repeat");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });

        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-early-idle-no-repeat",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-early-idle-no-repeat",
              messageID: "msg-early-idle-no-repeat",
              type: "text",
              text: "done",
              time: { start: 1, end: 2 },
            },
          },
        });

        yield* Effect.sleep(75);
        const [currentSession] = yield* adapter.listSessions();
        eventQueue.close();
        return currentSession;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(session?.status).toBe("ready");
    expect(session?.activeTurnId).toBeUndefined();
  });

  it("waits for a late text part when final metadata arrives before idle", async () => {
    const eventQueue = createSubscribedEventQueue();
    let messageFetchCount = 0;
    const runtime = createMockOpenCodeRuntime({
      messages: async () => {
        messageFetchCount += 1;
        return {
          data:
            messageFetchCount === 1
              ? []
              : [
                  {
                    info: {
                      id: "msg-final-before-parts",
                      role: "assistant",
                      finish: "stop",
                      time: { completed: 2 },
                    },
                    parts: [],
                  },
                ],
        };
      },
    });
    bindSubscribedEventQueue(runtime, eventQueue);

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-final-before-parts");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-final-before-parts",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });

        yield* Effect.sleep(30);
        const [sessionBeforeLatePart] = yield* adapter.listSessions();
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-final-before-parts",
              messageID: "msg-final-before-parts",
              type: "text",
              text: "done",
              time: { start: 1, end: 2 },
            },
          },
        });

        const collected = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return { collected, sessionBeforeLatePart };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(events.sessionBeforeLatePart?.status).toBe("running");
    expect(events.collected.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(messageFetchCount).toBeGreaterThanOrEqual(2);
  });

  it("waits for every final-message text part before completing a plan turn", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({ messages: async () => ({ data: [] }) });
    bindSubscribedEventQueue(runtime, eventQueue);

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 9)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-late-multipart-plan");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-late-multipart-plan",
              role: "assistant",
              finish: "stop",
              time: { completed: 3 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-late-multipart-preamble",
              messageID: "msg-late-multipart-plan",
              type: "text",
              text: "I prepared the implementation plan.",
              time: { start: 1, end: 2 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-late-multipart-plan",
              messageID: "msg-late-multipart-plan",
              type: "text",
              text: "<proposed_plan>\n# Complete plan\n\n- implement it\n</proposed_plan>",
              time: { start: 2 },
            },
          },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });

        yield* Effect.sleep(10);
        const [sessionBeforePlanSettled] = yield* adapter.listSessions();
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-late-multipart-plan",
              messageID: "msg-late-multipart-plan",
              type: "text",
              text: "<proposed_plan>\n# Complete plan\n\n- implement it\n</proposed_plan>",
              time: { start: 2, end: 3 },
            },
          },
        });

        const collected = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return { collected, sessionBeforePlanSettled };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(events.sessionBeforePlanSettled?.status).toBe("running");
    expect(events.collected.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "content.delta",
      "turn.proposed.completed",
      "item.completed",
      "turn.completed",
    ]);
    expect(events.collected[6]).toMatchObject({
      type: "turn.proposed.completed",
      payload: { planMarkdown: "# Complete plan\n\n- implement it" },
    });
  });

  it("does not recover a snapshot until every visible assistant text part is complete", async () => {
    const eventQueue = createSubscribedEventQueue();
    let messageSnapshot: Array<{ info: Record<string, unknown>; parts: Part[] }> = [];
    const runtime = createMockOpenCodeRuntime({
      messages: async () => ({ data: messageSnapshot }),
    });
    bindSubscribedEventQueue(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 9)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-mixed-final-snapshot");
        const finalInfo = {
          id: "msg-mixed-final-snapshot",
          role: "assistant",
          finish: "stop",
          time: { completed: 3 },
        };
        const preamblePart = {
          id: "part-mixed-final-preamble",
          messageID: "msg-mixed-final-snapshot",
          type: "text",
          text: "I prepared the implementation plan.",
          time: { start: 1, end: 2 },
        } as Part;
        const planText = "<proposed_plan>\n# Snapshot plan\n\n- implement it\n</proposed_plan>";

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        messageSnapshot = [
          {
            info: finalInfo,
            parts: [
              preamblePart,
              {
                id: "part-mixed-final-plan",
                messageID: "msg-mixed-final-snapshot",
                type: "text",
                text: planText,
                time: { start: 2 },
              } as Part,
            ],
          },
        ];
        eventQueue.push({
          type: "message.updated",
          properties: { sessionID: "opencode-session-1", info: finalInfo },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });

        yield* Effect.sleep(30);
        const [sessionWhilePlanPartOpen] = yield* adapter.listSessions();
        messageSnapshot = [
          {
            info: finalInfo,
            parts: [
              preamblePart,
              {
                id: "part-mixed-final-plan",
                messageID: "msg-mixed-final-snapshot",
                type: "text",
                text: planText,
                time: { start: 2, end: 3 },
              } as Part,
            ],
          },
        ];

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return { events, sessionWhilePlanPartOpen };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.sessionWhilePlanPartOpen?.status).toBe("running");
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "content.delta",
      "turn.proposed.completed",
      "item.completed",
      "turn.completed",
    ]);
  });

  it("does not let stale snapshot recovery complete a newer turn", async () => {
    const eventQueue = createSubscribedEventQueue();
    let messageFetchCount = 0;
    let startRecovery: (() => void) | undefined;
    let resolveRecovery:
      | ((value: { data: Array<{ info: Record<string, unknown>; parts: Part[] }> }) => void)
      | undefined;
    const recoveryStarted = new Promise<void>((resolve) => {
      startRecovery = resolve;
    });
    const runtime = createMockOpenCodeRuntime({
      messages: async () => {
        messageFetchCount += 1;
        if (messageFetchCount !== 2) {
          return { data: [] };
        }
        startRecovery?.();
        return await new Promise((resolve) => {
          resolveRecovery = resolve;
        });
      },
    });
    bindSubscribedEventQueue(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-stale-recovery");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const firstTurn = yield* adapter.sendTurn({
          threadId,
          input: "first",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-stale-recovery",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });

        yield* Effect.promise(() => recoveryStarted);
        yield* adapter.interruptTurn(threadId, firstTurn.turnId);
        const secondTurn = yield* adapter.sendTurn({
          threadId,
          input: "second",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        yield* Effect.sync(() => {
          resolveRecovery?.({
            data: [
              {
                info: {
                  id: "msg-stale-recovery",
                  role: "assistant",
                  finish: "stop",
                  time: { completed: 2 },
                },
                parts: [
                  {
                    id: "part-stale-recovery",
                    messageID: "msg-stale-recovery",
                    type: "text",
                    text: "obsolete",
                    time: { start: 1, end: 2 },
                  } as Part,
                ],
              },
            ],
          });
        });
        yield* Effect.sleep(10);

        const [session] = yield* adapter.listSessions();
        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return { events, secondTurn, session };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 5,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "turn.aborted",
      "turn.started",
    ]);
    expect(result.session).toMatchObject({
      status: "running",
      activeTurnId: result.secondTurn.turnId,
    });
  });

  it("fails closed after bounded idle recovery when no assistant response arrives", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({ messages: async () => ({ data: [] }) });
    bindSubscribedEventQueue(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-idle-without-assistant");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        const [session] = yield* adapter.listSessions();
        eventQueue.close();
        return { events, session };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 10,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "turn.completed",
      "runtime.error",
    ]);
    expect(result.events[3]).toMatchObject({
      type: "turn.completed",
      payload: {
        state: "failed",
        errorMessage: "OpenCode became idle before producing an assistant response.",
      },
    });
    expect(result.session).toMatchObject({
      status: "error",
      lastError: "OpenCode became idle before producing an assistant response.",
    });
    expect(result.session?.activeTurnId).toBeUndefined();
  });

  it("fails closed when final metadata never receives a completed visible text part", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({ messages: async () => ({ data: [] }) });
    bindSubscribedEventQueue(runtime, eventQueue);

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-final-metadata-without-parts");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-final-metadata-without-parts",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });

        const collected = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return collected;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 5,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(events[3]).toMatchObject({
      type: "turn.completed",
      payload: {
        state: "failed",
        errorMessage: "OpenCode became idle before its final assistant response finished arriving.",
      },
    });
    expect(events[4]).toMatchObject({
      type: "runtime.error",
      payload: {
        message: "OpenCode became idle before its final assistant response finished arriving.",
        class: "provider_error",
      },
    });
  });

  it("emits one completion when duplicate idle signals race", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({ messages: async () => ({ data: [] }) });
    bindSubscribedEventQueue(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-duplicate-idle");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-duplicate-idle",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-duplicate-idle",
              messageID: "msg-duplicate-idle",
              type: "text",
              text: "done",
              time: { start: 1, end: 2 },
            },
          },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        eventQueue.push({
          type: "session.status",
          properties: { sessionID: "opencode-session-1", status: { type: "idle" } },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });

        const collected = Array.from(yield* Fiber.join(eventsFiber));
        const extraEvent = yield* Stream.runHead(adapter.streamEvents).pipe(
          Effect.timeoutOption(20),
        );
        eventQueue.close();
        return { collected, extraEvent };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 10,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.collected.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(result.extraEvent._tag).toBe("None");
  });

  it("bounds a hung completion snapshot request and completes from settled local parts", async () => {
    const eventQueue = createSubscribedEventQueue();
    let messageFetchCount = 0;
    const runtime = createMockOpenCodeRuntime({
      messages: async () => {
        messageFetchCount += 1;
        if (messageFetchCount === 1) {
          return { data: [] };
        }
        return await new Promise<{
          data: Array<{ info: Record<string, unknown>; parts: Part[] }>;
        }>(() => undefined);
      },
    });
    bindSubscribedEventQueue(runtime, eventQueue);

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-hung-completion-snapshot");

        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-hung-completion-snapshot",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-hung-completion-snapshot",
              messageID: "msg-hung-completion-snapshot",
              type: "text",
              text: "done",
              time: { start: 1, end: 2 },
            },
          },
        });

        const collected = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return collected;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 5,
            completionSnapshotTimeoutMs: 10,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(messageFetchCount).toBeGreaterThanOrEqual(2);
  });

  it("restarts the quiet window when text arrives during a completion snapshot", async () => {
    const eventQueue = createSubscribedEventQueue();
    let messageFetchCount = 0;
    let startRecovery: (() => void) | undefined;
    let resolveRecovery: ((value: { data: [] }) => void) | undefined;
    const recoveryStarted = new Promise<void>((resolve) => {
      startRecovery = resolve;
    });
    const runtime = createMockOpenCodeRuntime({
      messages: async () => {
        messageFetchCount += 1;
        if (messageFetchCount === 1) {
          return { data: [] };
        }
        if (messageFetchCount === 2) {
          startRecovery?.();
          return await new Promise<{ data: [] }>((resolve) => {
            resolveRecovery = resolve;
          });
        }
        return { data: [] };
      },
    });
    bindSubscribedEventQueue(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-activity-during-snapshot");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-activity-during-snapshot",
              role: "assistant",
              finish: "stop",
              time: { completed: 3 },
            },
          },
        });
        yield* Effect.promise(() => recoveryStarted);
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-activity-during-snapshot",
              messageID: "msg-activity-during-snapshot",
              type: "text",
              text: "still arriving",
              time: { start: 1 },
            },
          },
        });
        yield* Effect.sync(() => resolveRecovery?.({ data: [] }));
        yield* Effect.sleep(5);
        const [duringQuiet] = yield* adapter.listSessions();
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-activity-during-snapshot",
              messageID: "msg-activity-during-snapshot",
              type: "text",
              text: "finished",
              time: { start: 1, end: 3 },
            },
          },
        });
        yield* Effect.sleep(60);
        const [settled] = yield* adapter.listSessions();
        eventQueue.close();
        return { duringQuiet, settled };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
            completionSnapshotTimeoutMs: 50,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.duringQuiet?.status).toBe("running");
    expect(result.settled?.status).toBe("ready");
  });

  it("defers idle after partial text until the same assistant message settles", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({ messages: async () => ({ data: [] }) });
    bindSubscribedEventQueue(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-partial-before-idle");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: { id: "msg-partial-before-idle", role: "assistant" },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-partial-before-idle",
              messageID: "msg-partial-before-idle",
              type: "text",
              text: "part",
              time: { start: 1 },
            },
          },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        yield* Effect.sleep(5);
        const [whilePartial] = yield* adapter.listSessions();
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-partial-before-idle",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-partial-before-idle",
              messageID: "msg-partial-before-idle",
              type: "text",
              text: "partial complete",
              time: { start: 1, end: 2 },
            },
          },
        });
        yield* Effect.sleep(60);
        const [settled] = yield* adapter.listSessions();
        eventQueue.close();
        return { whilePartial, settled };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.whilePartial?.status).toBe("running");
    expect(result.settled?.status).toBe("ready");
  });

  it("completes reordered metadata-light assistant output after an early idle", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({ messages: async () => ({ data: [] }) });
    bindSubscribedEventQueue(runtime, eventQueue);

    const session = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-metadata-light-early-idle");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: { id: "msg-metadata-light-early-idle", role: "assistant" },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-metadata-light-early-idle",
              messageID: "msg-metadata-light-early-idle",
              type: "text",
              text: "done",
              time: { start: 1, end: 2 },
            },
          },
        });
        yield* Effect.sleep(60);
        const [current] = yield* adapter.listSessions();
        eventQueue.close();
        return current;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(session?.status).toBe("ready");
    expect(session?.activeTurnId).toBeUndefined();
  });

  it("fails closed instead of rebinding a previous assistant message and idle", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({ messages: async () => ({ data: [] }) });
    bindSubscribedEventQueue(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-stale-live-events");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const firstTurn = yield* adapter.sendTurn({
          threadId,
          input: "first",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-stale-live-events",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });
        yield* Effect.sleep(1);
        yield* adapter.interruptTurn(threadId, firstTurn.turnId);
        const secondTurn = yield* adapter.sendTurn({
          threadId,
          input: "second",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-stale-live-events",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-stale-live-events",
              messageID: "msg-stale-live-events",
              type: "text",
              text: "obsolete",
              time: { start: 1, end: 2 },
            },
          },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        yield* Effect.sleep(50);
        const [session] = yield* adapter.listSessions();
        eventQueue.close();
        return { secondTurn, session };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 10,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.session?.status).toBe("error");
    expect(result.session?.activeTurnId).toBeUndefined();
    expect(result.session?.lastError).toContain("before producing an assistant response");
  });

  for (const provider of ["opencode", "kilo"] as const) {
    it(`bounds an unavailable pre-turn message baseline for ${provider}`, async () => {
      const runtime = createMockOpenCodeRuntime({
        messages: async () =>
          await new Promise<{
            data: Array<{ info: Record<string, unknown>; parts: Part[] }>;
          }>(() => undefined),
      });

      const runTurn =
        provider === "kilo"
          ? Effect.gen(function* () {
              const adapter = yield* KiloAdapter;
              const threadId = asThreadId(`thread-hung-baseline-${provider}`);
              yield* adapter.startSession({ provider, threadId, runtimeMode: "full-access" });
              const startedAt = Date.now();
              yield* adapter.sendTurn({
                threadId,
                input: "hello",
                attachments: [],
                modelSelection: { provider, model: "openai/gpt-5.4" },
              });
              const elapsedMs = Date.now() - startedAt;
              const [session] = yield* adapter.listSessions();
              return { elapsedMs, session };
            }).pipe(
              Effect.provide(
                makeKiloAdapterLive({
                  runtime: runtime.runtime,
                  completionSnapshotTimeoutMs: 10,
                  promptAcceptedActivityTimeoutMs: 1_000,
                  promptAcceptedRecoveryDelaysMs: [],
                }).pipe(
                  Layer.provideMerge(
                    ServerConfig.layerTest(process.cwd(), {
                      prefix: `${provider}-adapter-test-`,
                    }),
                  ),
                  Layer.provideMerge(NodeServices.layer),
                ),
              ),
            )
          : Effect.gen(function* () {
              const adapter = yield* OpenCodeAdapter;
              const threadId = asThreadId(`thread-hung-baseline-${provider}`);
              yield* adapter.startSession({ provider, threadId, runtimeMode: "full-access" });
              const startedAt = Date.now();
              yield* adapter.sendTurn({
                threadId,
                input: "hello",
                attachments: [],
                modelSelection: { provider, model: "openai/gpt-5.4" },
              });
              const elapsedMs = Date.now() - startedAt;
              const [session] = yield* adapter.listSessions();
              return { elapsedMs, session };
            }).pipe(
              Effect.provide(
                makeOpenCodeAdapterLive({
                  runtime: runtime.runtime,
                  completionSnapshotTimeoutMs: 10,
                }).pipe(
                  Layer.provideMerge(
                    ServerConfig.layerTest(process.cwd(), {
                      prefix: `${provider}-adapter-test-`,
                    }),
                  ),
                  Layer.provideMerge(NodeServices.layer),
                ),
              ),
            );
      const result = await Effect.runPromise(runTurn);

      expect(result.elapsedMs).toBeLessThan(250);
      expect(runtime.promptCalls).toHaveLength(1);
      expect(runtime.promptCalls[0]?.messageID).toMatch(/^msg_/u);
      expect(result.session?.status).toBe("running");
    });
  }

  it("bounds status-watchdog message snapshots and stops with the active turn", async () => {
    let messageFetchCount = 0;
    let messageRequestsAborted = 0;
    let inFlightMessageRequests = 0;
    let maxInFlightMessageRequests = 0;
    let statusFetchCount = 0;
    const runtime = createMockOpenCodeRuntime({
      messages: async (_input, requestOptions) => {
        messageFetchCount += 1;
        if (messageFetchCount === 1) {
          return { data: [] };
        }
        inFlightMessageRequests += 1;
        maxInFlightMessageRequests = Math.max(maxInFlightMessageRequests, inFlightMessageRequests);
        return await new Promise<{
          data: Array<{ info: Record<string, unknown>; parts: Part[] }>;
        }>((_resolve, reject) => {
          requestOptions?.signal?.addEventListener("abort", () => {
            messageRequestsAborted += 1;
            inFlightMessageRequests -= 1;
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      },
      status: async () => {
        statusFetchCount += 1;
        return { data: { "opencode-session-1": { type: "idle" } } };
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-bounded-status-watchdog");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        yield* Effect.sleep(550);
        const [beforeInterrupt] = yield* adapter.listSessions();
        yield* adapter.interruptTurn(threadId, turn.turnId);
        const statusAtInterrupt = statusFetchCount;
        yield* Effect.sleep(550);
        const [afterInterrupt] = yield* adapter.listSessions();
        const statusAfterInterruptGrace = statusFetchCount;
        yield* Effect.sleep(550);
        return { beforeInterrupt, afterInterrupt, statusAtInterrupt, statusAfterInterruptGrace };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            completionSnapshotTimeoutMs: 10,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(messageFetchCount).toBeGreaterThanOrEqual(2);
    expect(messageRequestsAborted).toBeGreaterThanOrEqual(1);
    expect(maxInFlightMessageRequests).toBe(1);
    expect(inFlightMessageRequests).toBe(0);
    expect(result.beforeInterrupt?.status).toBe("running");
    expect(result.afterInterrupt?.status).toBe("ready");
    expect(result.statusAfterInterruptGrace - result.statusAtInterrupt).toBeLessThanOrEqual(1);
    expect(statusFetchCount).toBe(result.statusAfterInterruptGrace);
  });

  it("ignores sessionless idle and error events when two active sessions share a server", async () => {
    const events = createBroadcastSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      sessionIds: ["opencode-session-1", "opencode-session-2"],
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> };
    };
    client.event.subscribe = async () => ({ stream: events.subscribe() });

    const sessions = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const firstThreadId = asThreadId("thread-sessionless-first");
        const secondThreadId = asThreadId("thread-sessionless-second");
        yield* adapter.startSession({
          provider: "opencode",
          threadId: firstThreadId,
          runtimeMode: "full-access",
        });
        yield* adapter.startSession({
          provider: "opencode",
          threadId: secondThreadId,
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId: firstThreadId,
          input: "first",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        yield* adapter.sendTurn({
          threadId: secondThreadId,
          input: "second",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        events.push({ type: "session.idle", properties: {} });
        events.push({
          type: "session.error",
          properties: { error: { data: { message: "wrong session" } } },
        });
        yield* Effect.sleep(25);
        const activeSessions = yield* adapter.listSessions();
        events.close();
        return activeSessions;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 5,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.status === "running")).toBe(true);
    expect(sessions.every((session) => session.activeTurnId !== undefined)).toBe(true);
  });

  it("applies dropped-idle recovery to Kilo without waiting on ignored synthetic text", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({ messages: async () => ({ data: [] }) });
    bindSubscribedEventQueue(runtime, eventQueue);

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* KiloAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-kilo-early-idle");

        yield* adapter.startSession({ provider: "kilo", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "kilo", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-kilo-early-idle",
              role: "assistant",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-kilo-synthetic",
              messageID: "msg-kilo-early-idle",
              type: "text",
              text: "Creating snapshot",
              synthetic: true,
              ignored: true,
              time: { start: 1 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-kilo-visible",
              messageID: "msg-kilo-early-idle",
              type: "text",
              text: "done",
              time: { start: 1, end: 2 },
            },
          },
        });

        const collected = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return collected;
      }).pipe(
        Effect.provide(
          makeKiloAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
            promptAcceptedActivityTimeoutMs: 1_000,
            promptAcceptedRecoveryDelaysMs: [],
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "kilo-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(events[5]).toMatchObject({
      provider: "kilo",
      raw: {
        source: "kilo.sdk.event",
        payload: { source: "scient.kilo.deferred-idle-local-parts" },
      },
    });
  });

  it("does not complete Kilo from a partial prompt response", async () => {
    const runtime = createMockOpenCodeRuntime({
      prompt: async () => ({
        data: {
          info: {
            id: "msg-kilo-partial-prompt",
            role: "assistant",
            finish: "stop",
            time: { completed: 2 },
          },
          parts: [
            {
              id: "part-kilo-partial-prompt",
              messageID: "msg-kilo-partial-prompt",
              type: "text",
              text: "still arriving",
              time: { start: 1 },
            } as Part,
          ],
        },
      }),
    });

    const session = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* KiloAdapter;
        const threadId = asThreadId("thread-kilo-partial-prompt");

        yield* adapter.startSession({ provider: "kilo", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "kilo", model: "openai/gpt-5.4" },
        });
        const [currentSession] = yield* adapter.listSessions();
        return currentSession;
      }).pipe(
        Effect.provide(
          makeKiloAdapterLive({
            runtime: runtime.runtime,
            promptAcceptedActivityTimeoutMs: 1_000,
            promptAcceptedRecoveryDelaysMs: [],
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "kilo-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(session?.status).toBe("running");
    expect(session?.activeTurnId).toBeDefined();
  });

  it("tracks a partial assistant part that arrives before its message metadata", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    bindSubscribedEventQueue(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-part-before-metadata");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-before-metadata",
              messageID: "msg-before-metadata",
              type: "text",
              text: "partial",
              time: { start: 1 },
            },
          },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: { id: "msg-before-metadata", role: "assistant" },
          },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        yield* Effect.sleep(5);
        const [whilePartial] = yield* adapter.listSessions();
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-before-metadata",
              messageID: "msg-before-metadata",
              type: "text",
              text: "partial complete",
              time: { start: 1, end: 2 },
            },
          },
        });
        yield* Effect.sleep(60);
        const [settled] = yield* adapter.listSessions();
        eventQueue.close();
        return { whilePartial, settled };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 20,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.whilePartial?.status).toBe("running");
    expect(result.settled?.status).toBe("ready");
  });

  it("does not treat completed tool-call text as a final assistant response", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    bindSubscribedEventQueue(runtime, eventQueue);

    const session = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-tool-call-text-not-final");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-tool-call-text",
              role: "assistant",
              finish: "tool-calls",
              time: { completed: 2 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-tool-call-text",
              messageID: "msg-tool-call-text",
              type: "text",
              text: "I will inspect that.",
              time: { start: 1, end: 2 },
            },
          },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        yield* Effect.sleep(60);
        const [current] = yield* adapter.listSessions();
        eventQueue.close();
        return current;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 5,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(session?.status).toBe("error");
    expect(session?.lastError).toContain("after tool calls");
  });

  it("rejects delayed parts from cached prior assistant metadata when the successor baseline times out", async () => {
    const eventQueue = createSubscribedEventQueue();
    let messageFetchCount = 0;
    const runtime = createMockOpenCodeRuntime({
      messages: async (_input, requestOptions) => {
        messageFetchCount += 1;
        if (messageFetchCount === 2) {
          return await new Promise<{
            data: Array<{ info: Record<string, unknown>; parts: Part[] }>;
          }>((_resolve, reject) => {
            requestOptions?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        return { data: [] };
      },
    });
    bindSubscribedEventQueue(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const observedEvents: Array<unknown> = [];
        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            observedEvents.push(event);
          }),
        ).pipe(Effect.forkChild);
        const threadId = asThreadId("thread-cached-prior-role-untrusted-baseline");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const firstTurn = yield* adapter.sendTurn({
          threadId,
          input: "first",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-cached-prior-assistant",
              role: "assistant",
              parentID: runtime.promptCalls[0]?.messageID,
              finish: "tool-calls",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-cached-prior-assistant",
              messageID: "msg-cached-prior-assistant",
              type: "text",
              text: "prior turn text",
              time: { start: 1 },
            },
          },
        });
        yield* Effect.sleep(5);
        yield* adapter.interruptTurn(threadId, firstTurn.turnId);
        yield* adapter.sendTurn({
          threadId,
          input: "second",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        pushActivePromptEcho(eventQueue, runtime);
        eventQueue.push({
          type: "message.part.delta",
          properties: {
            sessionID: "opencode-session-1",
            messageID: "msg-cached-prior-assistant",
            partID: "part-cached-prior-assistant",
            field: "text",
            delta: " delayed stale suffix",
          },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-current-after-untrusted-baseline",
              role: "assistant",
              parentID: runtime.promptCalls.at(-1)?.messageID,
              finish: "stop",
              time: { completed: 3 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-current-after-untrusted-baseline",
              messageID: "msg-current-after-untrusted-baseline",
              type: "text",
              text: "current turn text",
              time: { start: 2, end: 3 },
            },
          },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        yield* Effect.sleep(30);
        const [session] = yield* adapter.listSessions();
        yield* Fiber.interrupt(eventsFiber);
        eventQueue.close();
        return { observedEvents, session };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            completionSnapshotTimeoutMs: 5,
            prematureIdleCompletionGraceMs: 5,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.session?.status).toBe("ready");
    expect(JSON.stringify(result.observedEvents)).not.toContain("delayed stale suffix");
    expect(JSON.stringify(result.observedEvents)).toContain("current turn text");
  });

  it("requires prompt-parent ownership when the baseline times out, then recovers valid output", async () => {
    let messageFetchCount = 0;
    let baselineRequestAborted = false;
    let exposeCurrentResponse = false;
    const runtime = createMockOpenCodeRuntime({
      messages: async (_input, requestOptions) => {
        messageFetchCount += 1;
        if (messageFetchCount === 1) {
          return await new Promise<{
            data: Array<{ info: Record<string, unknown>; parts: Part[] }>;
          }>((_resolve, reject) => {
            requestOptions?.signal?.addEventListener("abort", () => {
              baselineRequestAborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        const promptMessageId = runtime.promptCalls[0]?.messageID;
        return {
          data: [
            {
              info: {
                id: exposeCurrentResponse ? "msg-current-parent" : "msg-replayed-no-parent",
                role: "assistant",
                finish: "stop",
                time: { completed: 2 },
                ...(exposeCurrentResponse ? { parentID: promptMessageId } : {}),
              },
              parts: [
                {
                  id: exposeCurrentResponse ? "part-current-parent" : "part-replayed-no-parent",
                  messageID: exposeCurrentResponse
                    ? "msg-current-parent"
                    : "msg-replayed-no-parent",
                  type: "text",
                  text: exposeCurrentResponse ? "current" : "obsolete",
                  time: { start: 1, end: 2 },
                } as Part,
              ],
            },
          ],
        };
      },
      status: async () => ({ data: { "opencode-session-1": { type: "idle" } } }),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-untrusted-baseline-parent");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        yield* Effect.sleep(575);
        const [afterReplay] = yield* adapter.listSessions();
        exposeCurrentResponse = true;
        yield* Effect.sleep(575);
        const [afterCurrent] = yield* adapter.listSessions();
        const thread = yield* adapter.readThread(threadId);
        return { afterReplay, afterCurrent, thread };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            completionSnapshotTimeoutMs: 10,
            prematureIdleCompletionGraceMs: 5,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(baselineRequestAborted).toBe(true);
    expect(result.afterReplay?.status).toBe("running");
    expect(JSON.stringify(result.thread)).not.toContain("obsolete");
    expect(result.afterCurrent?.status).toBe("ready");
  });

  it("completes valid output even when a stale baseline event arrives afterward", async () => {
    const eventQueue = createSubscribedEventQueue();
    let messageFetchCount = 0;
    const runtime = createMockOpenCodeRuntime({
      messages: async () => ({
        data:
          messageFetchCount++ === 0
            ? [{ info: { id: "msg-old-after-valid", role: "assistant" }, parts: [] }]
            : [],
      }),
    });
    bindSubscribedEventQueue(runtime, eventQueue);

    const session = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-stale-after-valid");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        for (const input of [
          { id: "msg-valid-before-stale", text: "current" },
          { id: "msg-old-after-valid", text: "obsolete" },
        ]) {
          eventQueue.push({
            type: "message.updated",
            properties: {
              sessionID: "opencode-session-1",
              info: {
                id: input.id,
                role: "assistant",
                finish: "stop",
                time: { completed: 2 },
              },
            },
          });
          eventQueue.push({
            type: "message.part.updated",
            properties: {
              sessionID: "opencode-session-1",
              part: {
                id: `part-${input.id}`,
                messageID: input.id,
                type: "text",
                text: input.text,
                time: { start: 1, end: 2 },
              },
            },
          });
        }
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        yield* Effect.sleep(60);
        const [current] = yield* adapter.listSessions();
        eventQueue.close();
        return current;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 5,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(session?.status).toBe("ready");
  });

  it("accepts a fresh assistant id with a provider-normalized parent when baseline is trusted", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    bindSubscribedEventQueue(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-parent-mismatch");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-parent-mismatch",
              role: "assistant",
              parentID: "msg-previous-prompt",
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-parent-mismatch",
              messageID: "msg-parent-mismatch",
              type: "text",
              text: "provider-normalized parent output",
              time: { start: 1, end: 2 },
            },
          },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        yield* Effect.sleep(60);
        const [session] = yield* adapter.listSessions();
        eventQueue.close();
        return session;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            prematureIdleCompletionGraceMs: 5,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result?.status).toBe("ready");
  });

  for (const provider of ["opencode", "kilo"] as const) {
    it(`fails ${provider} in bounded time after only stale output and idle`, async () => {
      const eventQueue = createSubscribedEventQueue();
      let messageFetchCount = 0;
      const runtime = createMockOpenCodeRuntime({
        messages: async () => ({
          data:
            messageFetchCount++ === 0
              ? [{ info: { id: "msg-only-stale", role: "assistant" }, parts: [] }]
              : [],
        }),
      });
      bindSubscribedEventQueue(runtime, eventQueue);

      const exercise = (adapter: OpenCodeAdapterShape | KiloAdapterShape) =>
        Effect.gen(function* () {
          const threadId = asThreadId(`thread-only-stale-${provider}`);
          yield* adapter.startSession({ provider, threadId, runtimeMode: "full-access" });
          yield* adapter.sendTurn({
            threadId,
            input: "hello",
            attachments: [],
            modelSelection: { provider, model: "openai/gpt-5.4" },
          });
          eventQueue.push({
            type: "message.updated",
            properties: {
              sessionID: "opencode-session-1",
              info: {
                id: "msg-only-stale",
                role: "assistant",
                finish: "stop",
                time: { completed: 2 },
              },
            },
          });
          eventQueue.push({
            type: "message.part.updated",
            properties: {
              sessionID: "opencode-session-1",
              part: {
                id: "part-only-stale",
                messageID: "msg-only-stale",
                type: "text",
                text: "obsolete",
                time: { start: 1, end: 2 },
              },
            },
          });
          eventQueue.push({
            type: "session.idle",
            properties: { sessionID: "opencode-session-1" },
          });
          yield* Effect.sleep(60);
          const [session] = yield* adapter.listSessions();
          eventQueue.close();
          return session;
        });

      const session =
        provider === "kilo"
          ? await Effect.runPromise(
              Effect.gen(function* () {
                return yield* exercise(yield* KiloAdapter);
              }).pipe(
                Effect.provide(
                  makeKiloAdapterLive({
                    runtime: runtime.runtime,
                    prematureIdleCompletionGraceMs: 5,
                    promptAcceptedActivityTimeoutMs: 1_000,
                    promptAcceptedRecoveryDelaysMs: [],
                  }).pipe(
                    Layer.provideMerge(
                      ServerConfig.layerTest(process.cwd(), {
                        prefix: `${provider}-adapter-test-`,
                      }),
                    ),
                    Layer.provideMerge(NodeServices.layer),
                  ),
                ),
              ),
            )
          : await Effect.runPromise(
              Effect.gen(function* () {
                return yield* exercise(yield* OpenCodeAdapter);
              }).pipe(
                Effect.provide(
                  makeOpenCodeAdapterLive({
                    runtime: runtime.runtime,
                    prematureIdleCompletionGraceMs: 5,
                  }).pipe(
                    Layer.provideMerge(
                      ServerConfig.layerTest(process.cwd(), {
                        prefix: `${provider}-adapter-test-`,
                      }),
                    ),
                    Layer.provideMerge(NodeServices.layer),
                  ),
                ),
              ),
            );

      expect(session?.status).toBe("error");
      expect(session?.lastError).toContain("before producing an assistant response");
    });
  }

  it("keeps concurrent interrupts single-flight until provider cancellation settles", async () => {
    let resolveAbort: (() => void) | undefined;
    let notifyAbortStarted: (() => void) | undefined;
    const abortStarted = new Promise<void>((resolve) => {
      notifyAbortStarted = resolve;
    });
    let abortInvocationCount = 0;
    const runtime = createMockOpenCodeRuntime({
      abort: async () => {
        abortInvocationCount += 1;
        if (abortInvocationCount > 1) {
          return { data: null };
        }
        notifyAbortStarted?.();
        await new Promise<void>((resolve) => {
          resolveAbort = resolve;
        });
        return { data: null };
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-concurrent-interrupt");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        const firstInterrupt = yield* adapter
          .interruptTurn(threadId, turn.turnId)
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => abortStarted);
        const secondInterrupt = yield* Effect.exit(adapter.interruptTurn(threadId, turn.turnId));
        const blockedSend = yield* Effect.exit(
          adapter.sendTurn({
            threadId,
            input: "too early",
            attachments: [],
            modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
          }),
        );
        const abortCallsWhilePending = runtime.abortCalls.length;
        resolveAbort?.();
        yield* Fiber.join(firstInterrupt);
        const nextTurn = yield* adapter.sendTurn({
          threadId,
          input: "after cancellation",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        return { abortCallsWhilePending, blockedSend, nextTurn, secondInterrupt };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.abortCallsWhilePending).toBe(1);
    expect(Exit.isFailure(result.secondInterrupt)).toBe(true);
    expect(Exit.isFailure(result.blockedSend)).toBe(true);
    expect(result.nextTurn.turnId).toBeDefined();
  });

  it("bounds a hung provider abort, aborts the request signal, and quarantines the session", async () => {
    let observedSignal: AbortSignal | undefined;
    let abortInvocationCount = 0;
    const runtime = createMockOpenCodeRuntime({
      abort: async (_input, requestOptions) => {
        abortInvocationCount += 1;
        if (abortInvocationCount > 1) {
          return { data: null };
        }
        observedSignal = requestOptions?.signal;
        await new Promise<void>((resolve) => {
          requestOptions?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { data: null };
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-hung-abort");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        const interruptExit = yield* Effect.exit(adapter.interruptTurn(threadId, turn.turnId));
        const blockedSend = yield* Effect.exit(
          adapter.sendTurn({
            threadId,
            input: "must remain quarantined",
            attachments: [],
            modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
          }),
        );
        const [session] = yield* adapter.listSessions();
        return { blockedSend, interruptExit, session };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            completionSnapshotTimeoutMs: 10,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(Exit.isFailure(result.interruptExit)).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
    expect(Exit.isFailure(result.blockedSend)).toBe(true);
    expect(result.session?.status).toBe("error");
    expect(result.session?.lastError).toContain("did not settle within 10ms");
  });

  it("cannot strand cancellation state when the interrupt caller is itself interrupted", async () => {
    let observedSignal: AbortSignal | undefined;
    let abortInvocationCount = 0;
    const runtime = createMockOpenCodeRuntime({
      abort: async (_input, requestOptions) => {
        abortInvocationCount += 1;
        if (abortInvocationCount > 1) {
          return { data: null };
        }
        observedSignal = requestOptions?.signal;
        await new Promise<void>((resolve) => {
          requestOptions?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { data: null };
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-interrupted-interrupt-caller");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        const interruptFiber = yield* adapter
          .interruptTurn(threadId, turn.turnId)
          .pipe(Effect.forkChild);
        yield* Effect.sleep(2);
        yield* Fiber.interrupt(interruptFiber);
        const blockedSend = yield* Effect.exit(
          adapter.sendTurn({
            threadId,
            input: "must remain quarantined",
            attachments: [],
            modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
          }),
        );
        const [session] = yield* adapter.listSessions();
        return { blockedSend, session };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            completionSnapshotTimeoutMs: 10,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(observedSignal?.aborted).toBe(true);
    expect(Exit.isFailure(result.blockedSend)).toBe(true);
    expect(result.session?.status).toBe("error");
    expect(result.session?.lastError).toContain("did not settle within 10ms");
  });

  it("suppresses abort-related session errors after cancellation", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      abort: async () => {
        eventQueue.push({
          type: "session.error",
          properties: {
            sessionID: "opencode-session-1",
            error: { data: { message: "request aborted" } },
          },
        });
        await Promise.resolve();
        return { data: null };
      },
    });
    bindSubscribedEventQueue(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-abort-error-race");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        yield* adapter.interruptTurn(threadId, turn.turnId);
        yield* Effect.sleep(20);
        const [session] = yield* adapter.listSessions();
        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return { events, session };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "turn.aborted",
    ]);
    expect(result.session?.status).toBe("ready");
    expect(result.session?.lastError).toBeUndefined();
  });

  it("does not hide a genuine session failure during the cancellation drain", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      abort: async () => {
        eventQueue.push({
          type: "session.error",
          properties: {
            sessionID: "opencode-session-1",
            error: { data: { message: "provider disconnected" } },
          },
        });
        return { data: null };
      },
    });
    bindSubscribedEventQueue(runtime, eventQueue);

    const session = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-cancel-genuine-error");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        yield* adapter.interruptTurn(threadId, turn.turnId);
        const [current] = yield* adapter.listSessions();
        eventQueue.close();
        return current;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            cancellationDrainQuietMs: 10,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(session?.status).toBe("error");
    expect(session?.lastError).toBe("provider disconnected");
  });

  it("quarantines the session when provider abort fails", async () => {
    const runtime = createMockOpenCodeRuntime({
      abort: async () => {
        throw new Error("abort transport failed");
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-abort-failure-quarantine");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "first",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        const interruptExit = yield* Effect.exit(adapter.interruptTurn(threadId, turn.turnId));
        const secondTurnExit = yield* Effect.exit(
          adapter.sendTurn({
            threadId,
            input: "second",
            attachments: [],
            modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
          }),
        );
        const [session] = yield* adapter.listSessions();
        return { interruptExit, secondTurnExit, session };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(Exit.isFailure(result.interruptExit)).toBe(true);
    expect(Exit.isFailure(result.secondTurnExit)).toBe(true);
    expect(runtime.promptCalls).toHaveLength(1);
    expect(result.session?.status).toBe("error");
    expect(result.session?.lastError).toContain("abort transport failed");
  });

  it("does not let a delayed cancellation error fail the next turn", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      abort: async () => {
        setTimeout(() => {
          eventQueue.push({
            type: "session.error",
            properties: {
              sessionID: "opencode-session-1",
              error: { data: { message: "late abort error" } },
            },
          });
        }, 20);
        return { data: null };
      },
    });
    bindSubscribedEventQueue(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-delayed-abort-error");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const firstTurn = yield* adapter.sendTurn({
          threadId,
          input: "first",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        yield* adapter.interruptTurn(threadId, firstTurn.turnId);
        const secondTurn = yield* adapter.sendTurn({
          threadId,
          input: "second",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        pushActivePromptEcho(eventQueue, runtime);
        yield* Effect.sleep(30);
        const [afterLateAbortError] = yield* adapter.listSessions();
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-current-after-abort",
              role: "assistant",
              parentID: runtime.promptCalls.at(-1)?.messageID,
            },
          },
        });
        eventQueue.push({
          type: "session.error",
          properties: {
            sessionID: "opencode-session-1",
            error: { name: "MessageAbortedError", data: { message: "current request cancelled" } },
          },
        });
        yield* Effect.sleep(10);
        const [afterCurrentError] = yield* adapter.listSessions();
        eventQueue.close();
        return { afterCurrentError, afterLateAbortError, secondTurn };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            cancellationDrainQuietMs: 5,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.afterLateAbortError).toMatchObject({
      status: "running",
      activeTurnId: result.secondTurn.turnId,
    });
    expect(result.afterCurrentError?.status).toBe("error");
    expect(result.afterCurrentError?.lastError).toBe("current request cancelled");
  });

  it("fails a genuine successor cancellation error after the ownership watchdog expires", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    bindSubscribedEventQueue(runtime, eventQueue);

    const session = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-successor-cancel-error-watchdog");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const firstTurn = yield* adapter.sendTurn({
          threadId,
          input: "first",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        yield* adapter.interruptTurn(threadId, firstTurn.turnId);
        yield* adapter.sendTurn({
          threadId,
          input: "second",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        pushActivePromptEcho(eventQueue, runtime);
        eventQueue.push({
          type: "session.error",
          properties: {
            sessionID: "opencode-session-1",
            error: { name: "MessageAbortedError", data: { message: "current request cancelled" } },
          },
        });
        yield* Effect.sleep(20);
        const [current] = yield* adapter.listSessions();
        eventQueue.close();
        return current;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            cancellationDrainQuietMs: 5,
            promptAcceptedActivityTimeoutMs: 5,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(session?.status).toBe("error");
    expect(session?.lastError).toBe("current request cancelled");
  });

  it("does not emit a cancellation error after genuine successor output wins completion", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    bindSubscribedEventQueue(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const observedEvents: Array<{ readonly type: string }> = [];
        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            observedEvents.push(event);
          }),
        ).pipe(Effect.forkChild);
        const threadId = asThreadId("thread-successor-completes-before-cancel-watchdog");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const firstTurn = yield* adapter.sendTurn({
          threadId,
          input: "first",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        yield* adapter.interruptTurn(threadId, firstTurn.turnId);
        yield* adapter.sendTurn({
          threadId,
          input: "second",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        pushActivePromptEcho(eventQueue, runtime);
        eventQueue.push({
          type: "session.error",
          properties: {
            sessionID: "opencode-session-1",
            error: { name: "MessageAbortedError", data: { message: "ambiguous cancellation" } },
          },
        });
        yield* Effect.sleep(4);
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-successor-before-cancel-watchdog",
              role: "assistant",
              parentID: runtime.promptCalls.at(-1)?.messageID,
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-successor-before-cancel-watchdog",
              messageID: "msg-successor-before-cancel-watchdog",
              type: "text",
              text: "successor output",
              time: { start: 1, end: 2 },
            },
          },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        yield* Effect.sleep(30);
        const [session] = yield* adapter.listSessions();
        yield* Fiber.interrupt(eventsFiber);
        eventQueue.close();
        return { observedEvents, session };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            cancellationDrainQuietMs: 5,
            prematureIdleCompletionGraceMs: 5,
            promptAcceptedActivityTimeoutMs: 10,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.session?.status).toBe("ready");
    expect(result.observedEvents.filter((event) => event.type === "turn.completed")).toHaveLength(
      1,
    );
    expect(result.observedEvents.filter((event) => event.type === "runtime.error")).toHaveLength(0);
  });

  it("keeps an ambiguous cancellation error fenced while successor permission work is pending", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    bindSubscribedEventQueue(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-successor-cancel-error-pending-permission");
        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "approval-required",
        });
        const firstTurn = yield* adapter.sendTurn({
          threadId,
          input: "first",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        yield* adapter.interruptTurn(threadId, firstTurn.turnId);
        const secondTurn = yield* adapter.sendTurn({
          threadId,
          input: "second",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        pushActivePromptEcho(eventQueue, runtime);
        eventQueue.push({
          id: "evt-successor-permission-asked",
          type: "permission.asked",
          properties: {
            id: "successor-permission",
            sessionID: "opencode-session-1",
            permission: "bash",
            patterns: ["pwd"],
            metadata: {},
            always: [],
          },
        });
        eventQueue.push({
          type: "session.error",
          properties: {
            sessionID: "opencode-session-1",
            error: { name: "MessageAbortedError", data: { message: "ambiguous cancellation" } },
          },
        });
        yield* Effect.sleep(25);
        const [whilePending] = yield* adapter.listSessions();
        eventQueue.push({
          id: "evt-successor-permission-replied",
          type: "permission.replied",
          properties: {
            sessionID: "opencode-session-1",
            requestID: "successor-permission",
            reply: "once",
          },
        });
        yield* Effect.sleep(25);
        const [afterResolution] = yield* adapter.listSessions();
        eventQueue.close();
        return { afterResolution, secondTurn, whilePending };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            cancellationDrainQuietMs: 5,
            promptAcceptedActivityTimeoutMs: 5,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.whilePending).toMatchObject({
      status: "running",
      activeTurnId: result.secondTurn.turnId,
    });
    expect(result.afterResolution?.status).toBe("error");
    expect(result.afterResolution?.lastError).toBe("ambiguous cancellation");
  });

  it("does not let a delayed Kilo cancellation error fail a successor after its prompt echo", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      abort: async () => {
        setTimeout(() => {
          eventQueue.push({
            type: "session.error",
            properties: {
              sessionID: "opencode-session-1",
              error: { data: { message: "late abort error" } },
            },
          });
        }, 20);
        return { data: null };
      },
    });
    bindSubscribedEventQueue(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* KiloAdapter;
        const threadId = asThreadId("thread-kilo-delayed-abort-error");
        yield* adapter.startSession({ provider: "kilo", threadId, runtimeMode: "full-access" });
        const firstTurn = yield* adapter.sendTurn({
          threadId,
          input: "first",
          attachments: [],
          modelSelection: { provider: "kilo", model: "openai/gpt-5.4" },
        });
        yield* adapter.interruptTurn(threadId, firstTurn.turnId);
        const secondTurn = yield* adapter.sendTurn({
          threadId,
          input: "second",
          attachments: [],
          modelSelection: { provider: "kilo", model: "openai/gpt-5.4" },
        });
        pushActivePromptEcho(eventQueue, runtime);
        yield* Effect.sleep(30);
        const [session] = yield* adapter.listSessions();
        eventQueue.close();
        return { secondTurn, session };
      }).pipe(
        Effect.provide(
          makeKiloAdapterLive({
            runtime: runtime.runtime,
            cancellationDrainQuietMs: 5,
            promptAcceptedActivityTimeoutMs: 1_000,
            promptAcceptedRecoveryDelaysMs: [],
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "kilo-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.session).toMatchObject({
      status: "running",
      activeTurnId: result.secondTurn.turnId,
    });
  });

  for (const provider of ["opencode", "kilo"] as const) {
    it(`rejects stale ${provider} output after prompt echo until current-turn ownership is proven`, async () => {
      const eventQueue = createSubscribedEventQueue();
      const runtime = createMockOpenCodeRuntime();
      bindSubscribedEventQueue(runtime, eventQueue);

      const exercise = (adapter: OpenCodeAdapterShape | KiloAdapterShape) =>
        Effect.gen(function* () {
          const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
            Effect.forkChild,
          );
          const threadId = asThreadId(`thread-owned-tool-buffer-${provider}`);
          yield* adapter.startSession({ provider, threadId, runtimeMode: "full-access" });
          const firstTurn = yield* adapter.sendTurn({
            threadId,
            input: "first",
            attachments: [],
            modelSelection: { provider, model: "openai/gpt-5.4" },
          });
          yield* adapter.interruptTurn(threadId, firstTurn.turnId);
          yield* adapter.sendTurn({
            threadId,
            input: "second",
            attachments: [],
            modelSelection: { provider, model: "openai/gpt-5.4" },
          });
          const secondPromptMessageId = runtime.promptCalls.at(-1)?.messageID;
          pushActivePromptEcho(eventQueue, runtime);
          eventQueue.push({
            type: "message.part.updated",
            properties: {
              sessionID: "opencode-session-1",
              part: {
                id: "part-stale-tool-before-metadata",
                messageID: "msg-stale-tool-before-metadata",
                type: "tool",
                callID: "call-stale-tool",
                tool: "read",
                state: {
                  status: "completed",
                  input: {},
                  output: "obsolete tool output",
                  title: "obsolete tool",
                  metadata: { sessionId: "stale-child-session" },
                  time: { start: 1, end: 2 },
                },
              },
            },
          });
          eventQueue.push({
            type: "message.updated",
            properties: {
              sessionID: "opencode-session-1",
              info: {
                id: "msg-stale-tool-before-metadata",
                role: "assistant",
                parentID: runtime.promptCalls[0]?.messageID,
                finish: "tool-calls",
              },
            },
          });
          eventQueue.push({
            type: "message.part.updated",
            properties: {
              sessionID: "opencode-session-1",
              part: {
                id: "part-stale-metadata-light-tool-after-prompt",
                messageID: "msg-stale-metadata-light-tool-after-prompt",
                type: "tool",
                callID: "call-stale-metadata-light-tool",
                tool: "grep",
                state: {
                  status: "completed",
                  input: {},
                  output: "metadata-light obsolete output",
                  time: { start: 2, end: 3 },
                },
              },
            },
          });
          eventQueue.push({
            type: "message.part.updated",
            properties: {
              sessionID: "opencode-session-1",
              part: {
                id: "part-current-tool-before-metadata",
                messageID: "msg-current-tool-before-metadata",
                type: "tool",
                callID: "call-current-tool",
                tool: "read",
                state: {
                  status: "completed",
                  input: {},
                  output: "current tool output",
                  title: "current tool",
                  metadata: {},
                  time: { start: 3, end: 4 },
                },
              },
            },
          });
          eventQueue.push({
            type: "message.updated",
            properties: {
              sessionID: "opencode-session-1",
              info: {
                id: "msg-current-tool-before-metadata",
                role: "assistant",
                parentID: secondPromptMessageId,
                finish: "tool-calls",
              },
            },
          });
          eventQueue.push({
            type: "message.updated",
            properties: {
              sessionID: "opencode-session-1",
              info: {
                id: "msg-stale-after-current-ownership",
                role: "assistant",
                parentID: runtime.promptCalls[0]?.messageID,
                finish: "stop",
                time: { completed: 6 },
              },
            },
          });
          eventQueue.push({
            type: "message.part.updated",
            properties: {
              sessionID: "opencode-session-1",
              part: {
                id: "part-stale-after-current-ownership",
                messageID: "msg-stale-after-current-ownership",
                type: "text",
                text: "obsolete output after current ownership",
                time: { start: 5, end: 6 },
              },
            },
          });
          yield* Effect.sleep(10);
          const thread = yield* adapter.readThread(threadId);
          const events = Array.from(yield* Fiber.join(eventsFiber));
          eventQueue.close();
          return { events, thread };
        });

      const result =
        provider === "kilo"
          ? await Effect.runPromise(
              Effect.gen(function* () {
                return yield* exercise(yield* KiloAdapter);
              }).pipe(
                Effect.provide(
                  makeKiloAdapterLive({
                    runtime: runtime.runtime,
                    cancellationDrainQuietMs: 5,
                    promptAcceptedActivityTimeoutMs: 1_000,
                    promptAcceptedRecoveryDelaysMs: [],
                  }).pipe(
                    Layer.provideMerge(
                      ServerConfig.layerTest(process.cwd(), { prefix: "kilo-adapter-test-" }),
                    ),
                    Layer.provideMerge(NodeServices.layer),
                  ),
                ),
              ),
            )
          : await Effect.runPromise(
              Effect.gen(function* () {
                return yield* exercise(yield* OpenCodeAdapter);
              }).pipe(
                Effect.provide(
                  makeOpenCodeAdapterLive({
                    runtime: runtime.runtime,
                    cancellationDrainQuietMs: 5,
                  }).pipe(
                    Layer.provideMerge(
                      ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
                    ),
                    Layer.provideMerge(NodeServices.layer),
                  ),
                ),
              ),
            );

      expect(JSON.stringify(result)).not.toContain("stale-tool");
      expect(JSON.stringify(result)).not.toContain("obsolete tool output");
      expect(JSON.stringify(result)).not.toContain("metadata-light obsolete output");
      expect(JSON.stringify(result)).not.toContain("obsolete output after current ownership");
      expect(result.events.filter((event) => event.itemId === "call-current-tool")).toHaveLength(1);
    });
  }

  it("restores metadata-light child-session tools after explicit post-cancel assistant ownership", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    bindSubscribedEventQueue(runtime, eventQueue);

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 7)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-post-cancel-child-tools");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const firstTurn = yield* adapter.sendTurn({
          threadId,
          input: "first",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        yield* adapter.interruptTurn(threadId, firstTurn.turnId);
        yield* adapter.sendTurn({
          threadId,
          input: "second",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        pushActivePromptEcho(eventQueue, runtime);
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "post-cancel-parent-assistant",
              role: "assistant",
              parentID: runtime.promptCalls.at(-1)?.messageID,
              finish: "tool-calls",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "post-cancel-parent-task",
              messageID: "post-cancel-parent-assistant",
              type: "tool",
              tool: "task",
              callID: "post-cancel-task-call",
              state: {
                status: "running",
                title: "Inspect child",
                input: {},
                metadata: { sessionId: "post-cancel-child-session" },
                time: { start: 1 },
              },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "post-cancel-child-session",
            part: {
              id: "post-cancel-child-tool",
              messageID: "post-cancel-child-assistant",
              type: "tool",
              tool: "grep",
              callID: "post-cancel-child-call",
              state: {
                status: "completed",
                input: {},
                output: "child result",
                time: { start: 2, end: 3 },
              },
            },
          },
        });
        const collected = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return collected;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            cancellationDrainQuietMs: 5,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(events.filter((event) => event.itemId === "post-cancel-task-call")).toHaveLength(1);
    expect(events.filter((event) => event.itemId === "post-cancel-child-call")).toHaveLength(1);
  });

  it("keeps strict post-cancel ownership until a later retry establishes a boundary", async () => {
    const eventQueue = createSubscribedEventQueue();
    let promptInvocationCount = 0;
    const runtime = createMockOpenCodeRuntime({
      promptAsync: async () => {
        promptInvocationCount += 1;
        if (promptInvocationCount === 2) {
          throw new Error("successor submission failed");
        }
        return { data: null };
      },
    });
    bindSubscribedEventQueue(runtime, eventQueue);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-strict-boundary-retry");
        yield* adapter.startSession({ provider: "opencode", threadId, runtimeMode: "full-access" });
        const firstTurn = yield* adapter.sendTurn({
          threadId,
          input: "first",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        yield* adapter.interruptTurn(threadId, firstTurn.turnId);
        const failedSuccessor = yield* Effect.exit(
          adapter.sendTurn({
            threadId,
            input: "fails before boundary",
            attachments: [],
            modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
          }),
        );
        const retry = yield* adapter.sendTurn({
          threadId,
          input: "retry",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-stale-before-retry-boundary",
              role: "assistant",
              parentID: runtime.promptCalls[0]?.messageID,
              finish: "stop",
              time: { completed: 2 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-stale-before-retry-boundary",
              messageID: "msg-stale-before-retry-boundary",
              type: "text",
              text: "stale retry output",
              time: { start: 1, end: 2 },
            },
          },
        });
        yield* Effect.sleep(10);
        const [beforeBoundary] = yield* adapter.listSessions();
        pushActivePromptEcho(eventQueue, runtime);
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-current-after-retry-boundary",
              role: "assistant",
              parentID: runtime.promptCalls.at(-1)?.messageID,
              finish: "stop",
              time: { completed: 4 },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-current-after-retry-boundary",
              messageID: "msg-current-after-retry-boundary",
              type: "text",
              text: "current retry output",
              time: { start: 3, end: 4 },
            },
          },
        });
        eventQueue.push({
          type: "session.idle",
          properties: { sessionID: "opencode-session-1" },
        });
        yield* Effect.sleep(60);
        const [settled] = yield* adapter.listSessions();
        eventQueue.close();
        return { beforeBoundary, failedSuccessor, retry, settled };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            cancellationDrainQuietMs: 5,
            prematureIdleCompletionGraceMs: 5,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(Exit.isFailure(result.failedSuccessor)).toBe(true);
    expect(result.beforeBoundary).toMatchObject({
      status: "running",
      activeTurnId: result.retry.turnId,
    });
    expect(result.settled?.status).toBe("ready");
  });

  for (const provider of ["opencode", "kilo"] as const) {
    it(`does not attribute a duplicated prior session.next terminal event to a new ${provider} turn`, async () => {
      const eventQueue = createSubscribedEventQueue();
      const runtime = createMockOpenCodeRuntime();
      bindSubscribedEventQueue(runtime, eventQueue);

      const exercise = (adapter: OpenCodeAdapterShape | KiloAdapterShape) =>
        Effect.gen(function* () {
          const threadId = asThreadId(`thread-next-generation-boundary-${provider}`);
          yield* adapter.startSession({ provider, threadId, runtimeMode: "full-access" });
          yield* adapter.sendTurn({
            threadId,
            input: "first",
            attachments: [],
            modelSelection: { provider, model: "openai/gpt-5.4" },
          });
          pushActivePromptEcho(eventQueue, runtime);
          eventQueue.push({
            type: "session.next.text.ended",
            properties: {
              timestamp: 1,
              sessionID: "opencode-session-1",
              text: "first response",
            },
          });
          const completedStep = {
            id: "evt-first-turn-step-ended",
            type: "session.next.step.ended",
            properties: {
              timestamp: 2,
              sessionID: "opencode-session-1",
              finish: "stop",
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            },
          };
          eventQueue.push(completedStep);
          yield* Effect.sleep(20);
          const secondTurn = yield* adapter.sendTurn({
            threadId,
            input: "second",
            attachments: [],
            modelSelection: { provider, model: "openai/gpt-5.4" },
          });
          eventQueue.push(completedStep);
          yield* Effect.sleep(10);
          const [beforeBoundary] = yield* adapter.listSessions();
          pushActivePromptEcho(eventQueue, runtime);
          eventQueue.push(completedStep);
          yield* Effect.sleep(10);
          const [afterBoundaryBeforeCurrent] = yield* adapter.listSessions();
          eventQueue.push({
            type: "session.next.text.ended",
            properties: {
              timestamp: 3,
              sessionID: "opencode-session-1",
              text: "second response",
            },
          });
          eventQueue.push({
            ...completedStep,
            id: "evt-second-turn-step-ended",
            properties: { ...completedStep.properties, timestamp: 4 },
          });
          yield* Effect.sleep(20);
          const [afterBoundary] = yield* adapter.listSessions();
          eventQueue.close();
          return { afterBoundary, afterBoundaryBeforeCurrent, beforeBoundary, secondTurn };
        });

      const result =
        provider === "kilo"
          ? await Effect.runPromise(
              Effect.gen(function* () {
                return yield* exercise(yield* KiloAdapter);
              }).pipe(
                Effect.provide(
                  makeKiloAdapterLive({
                    runtime: runtime.runtime,
                    promptAcceptedActivityTimeoutMs: 1_000,
                    promptAcceptedRecoveryDelaysMs: [],
                  }).pipe(
                    Layer.provideMerge(
                      ServerConfig.layerTest(process.cwd(), { prefix: "kilo-adapter-test-" }),
                    ),
                    Layer.provideMerge(NodeServices.layer),
                  ),
                ),
              ),
            )
          : await Effect.runPromise(
              Effect.gen(function* () {
                return yield* exercise(yield* OpenCodeAdapter);
              }).pipe(
                Effect.provide(
                  makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
                    Layer.provideMerge(
                      ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
                    ),
                    Layer.provideMerge(NodeServices.layer),
                  ),
                ),
              ),
            );

      expect(result.beforeBoundary).toMatchObject({
        status: "running",
        activeTurnId: result.secondTurn.turnId,
      });
      expect(result.afterBoundaryBeforeCurrent).toMatchObject({
        status: "running",
        activeTurnId: result.secondTurn.turnId,
      });
      expect(result.afterBoundary?.status).toBe("ready");
    });
  }

  for (const provider of ["opencode", "kilo"] as const) {
    it(`fences delayed session.next events after cancelling a ${provider} turn`, async () => {
      const eventQueue = createSubscribedEventQueue();
      const runtime = createMockOpenCodeRuntime();
      bindSubscribedEventQueue(runtime, eventQueue);

      const exercise = (adapter: OpenCodeAdapterShape | KiloAdapterShape) =>
        Effect.gen(function* () {
          const threadId = asThreadId(`thread-next-fence-${provider}`);
          yield* adapter.startSession({ provider, threadId, runtimeMode: "full-access" });
          const firstTurn = yield* adapter.sendTurn({
            threadId,
            input: "first",
            attachments: [],
            modelSelection: { provider, model: "openai/gpt-5.4" },
          });
          yield* adapter.interruptTurn(threadId, firstTurn.turnId);
          const secondTurn = yield* adapter.sendTurn({
            threadId,
            input: "second",
            attachments: [],
            modelSelection: { provider, model: "openai/gpt-5.4" },
          });
          eventQueue.push({
            type: "message.part.updated",
            properties: {
              sessionID: "opencode-session-1",
              part: {
                id: "part-late-cancelled-tool",
                messageID: "msg-late-cancelled-assistant",
                type: "tool",
                callID: "call-late-cancelled",
                tool: "read",
                state: {
                  status: "completed",
                  input: {},
                  output: "obsolete tool output",
                  title: "obsolete tool",
                  metadata: {},
                  time: { start: 1, end: 2 },
                },
              },
            },
          });
          eventQueue.push({
            type: "message.updated",
            properties: {
              sessionID: "opencode-session-1",
              info: {
                id: "msg-late-cancelled-assistant",
                role: "assistant",
                parentID: runtime.promptCalls[0]?.messageID,
                finish: "tool-calls",
              },
            },
          });
          eventQueue.push({
            type: "session.next.text.delta",
            properties: {
              timestamp: 1,
              sessionID: "opencode-session-1",
              delta: "obsolete next text",
            },
          });
          eventQueue.push({
            type: "session.next.step.ended",
            properties: {
              timestamp: 2,
              sessionID: "opencode-session-1",
              finish: "stop",
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            },
          });
          yield* Effect.sleep(10);
          const [afterStaleNext] = yield* adapter.listSessions();
          const threadAfterStaleNext = yield* adapter.readThread(threadId);
          pushActivePromptEcho(eventQueue, runtime);
          eventQueue.push({
            id: `evt-stale-next-after-prompt-${provider}`,
            type: "session.next.text.ended",
            properties: {
              timestamp: 3,
              sessionID: "opencode-session-1",
              text: "obsolete next text after prompt echo",
            },
          });
          eventQueue.push({
            type: "message.updated",
            properties: {
              sessionID: "opencode-session-1",
              info: {
                id: `msg-current-after-cancel-${provider}`,
                role: "assistant",
                parentID: runtime.promptCalls.at(-1)?.messageID,
              },
            },
          });
          eventQueue.push({
            type: "session.next.text.delta",
            properties: {
              timestamp: 3,
              sessionID: "opencode-session-1",
              delta: "second response",
            },
          });
          eventQueue.push({
            type: "session.next.text.ended",
            properties: {
              timestamp: 4,
              sessionID: "opencode-session-1",
              text: "second response",
            },
          });
          eventQueue.push({
            type: "session.next.step.ended",
            properties: {
              timestamp: 5,
              sessionID: "opencode-session-1",
              finish: "stop",
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            },
          });
          yield* Effect.sleep(20);
          const [secondSettled] = yield* adapter.listSessions();
          const thirdTurn = yield* adapter.sendTurn({
            threadId,
            input: "third",
            attachments: [],
            modelSelection: { provider, model: "openai/gpt-5.4" },
          });
          pushActivePromptEcho(eventQueue, runtime);
          eventQueue.push({
            type: "session.next.text.ended",
            properties: {
              timestamp: 6,
              sessionID: "opencode-session-1",
              text: "third response",
            },
          });
          eventQueue.push({
            type: "session.next.step.ended",
            properties: {
              timestamp: 7,
              sessionID: "opencode-session-1",
              finish: "stop",
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            },
          });
          yield* Effect.sleep(20);
          const [thirdSettled] = yield* adapter.listSessions();
          const threadAfterAll = yield* adapter.readThread(threadId);
          eventQueue.close();
          return {
            afterStaleNext,
            secondSettled,
            secondTurn,
            thirdSettled,
            thirdTurn,
            threadAfterAll,
            threadAfterStaleNext,
          };
        });

      const result =
        provider === "kilo"
          ? await Effect.runPromise(
              Effect.gen(function* () {
                return yield* exercise(yield* KiloAdapter);
              }).pipe(
                Effect.provide(
                  makeKiloAdapterLive({
                    runtime: runtime.runtime,
                    prematureIdleCompletionGraceMs: 5,
                    promptAcceptedActivityTimeoutMs: 1_000,
                    promptAcceptedRecoveryDelaysMs: [],
                  }).pipe(
                    Layer.provideMerge(
                      ServerConfig.layerTest(process.cwd(), { prefix: "kilo-adapter-test-" }),
                    ),
                    Layer.provideMerge(NodeServices.layer),
                  ),
                ),
              ),
            )
          : await Effect.runPromise(
              Effect.gen(function* () {
                return yield* exercise(yield* OpenCodeAdapter);
              }).pipe(
                Effect.provide(
                  makeOpenCodeAdapterLive({
                    runtime: runtime.runtime,
                    prematureIdleCompletionGraceMs: 5,
                  }).pipe(
                    Layer.provideMerge(
                      ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
                    ),
                    Layer.provideMerge(NodeServices.layer),
                  ),
                ),
              ),
            );

      expect(result.afterStaleNext).toMatchObject({
        status: "running",
        activeTurnId: result.secondTurn.turnId,
      });
      expect(JSON.stringify(result.threadAfterStaleNext)).not.toContain("obsolete next text");
      expect(JSON.stringify(result.threadAfterAll)).not.toContain(
        "obsolete next text after prompt",
      );
      expect(result.secondSettled?.status).toBe("ready");
      expect(result.thirdSettled?.status).toBe("ready");
      expect(result.thirdTurn.turnId).toBeDefined();
    });
  }

  for (const provider of ["opencode", "kilo"] as const) {
    it(`fails boundedly when ${provider} becomes idle without post-cancel ownership`, async () => {
      const eventQueue = createSubscribedEventQueue();
      const runtime = createMockOpenCodeRuntime({
        messages: async () => ({ data: [] }),
        status: async () => ({ data: { "opencode-session-1": { type: "idle" } } }),
      });
      bindSubscribedEventQueue(runtime, eventQueue);

      const exercise = (adapter: OpenCodeAdapterShape | KiloAdapterShape) =>
        Effect.gen(function* () {
          const observedEvents: Array<{
            readonly provider: string;
            readonly raw?: unknown;
            readonly type: string;
          }> = [];
          yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              observedEvents.push(event);
            }),
          ).pipe(Effect.forkChild);
          const threadId = asThreadId(`thread-idle-without-post-cancel-ownership-${provider}`);
          yield* adapter.startSession({ provider, threadId, runtimeMode: "full-access" });
          const firstTurn = yield* adapter.sendTurn({
            threadId,
            input: "first",
            attachments: [],
            modelSelection: { provider, model: "openai/gpt-5.4" },
          });
          yield* adapter.interruptTurn(threadId, firstTurn.turnId);
          yield* adapter.sendTurn({
            threadId,
            input: "second",
            attachments: [],
            modelSelection: { provider, model: "openai/gpt-5.4" },
          });
          pushActivePromptEcho(eventQueue, runtime);
          eventQueue.push({
            id: `evt-blocked-next-output-${provider}`,
            type: "session.next.text.ended",
            properties: {
              timestamp: 1,
              sessionID: "opencode-session-1",
              text: "ambiguous successor output",
            },
          });
          yield* Effect.sleep(650);
          const [session] = yield* adapter.listSessions();
          const thread = yield* adapter.readThread(threadId);
          eventQueue.close();
          return { observedEvents, session, thread };
        });

      const result =
        provider === "kilo"
          ? await Effect.runPromise(
              Effect.gen(function* () {
                return yield* exercise(yield* KiloAdapter);
              }).pipe(
                Effect.provide(
                  makeKiloAdapterLive({
                    runtime: runtime.runtime,
                    prematureIdleCompletionGraceMs: 5,
                    promptAcceptedActivityTimeoutMs: 1_000,
                    promptAcceptedRecoveryDelaysMs: [],
                  }).pipe(
                    Layer.provideMerge(
                      ServerConfig.layerTest(process.cwd(), { prefix: "kilo-adapter-test-" }),
                    ),
                    Layer.provideMerge(NodeServices.layer),
                  ),
                ),
              ),
            )
          : await Effect.runPromise(
              Effect.gen(function* () {
                return yield* exercise(yield* OpenCodeAdapter);
              }).pipe(
                Effect.provide(
                  makeOpenCodeAdapterLive({
                    runtime: runtime.runtime,
                    prematureIdleCompletionGraceMs: 5,
                  }).pipe(
                    Layer.provideMerge(
                      ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
                    ),
                    Layer.provideMerge(NodeServices.layer),
                  ),
                ),
              ),
            );

      expect(result.session?.status).toBe("error");
      expect(result.session?.lastError).toBeTruthy();
      expect(JSON.stringify(result.thread)).not.toContain("ambiguous successor output");
      expect(result.observedEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider,
            type: "turn.completed",
            raw: {
              source: `${provider}.sdk.event`,
              payload: {
                source: `scient.${provider}.deferred-idle-timeout`,
                event: {
                  source: `scient.${provider}.snapshot-watchdog-idle-without-ownership`,
                  status: { type: "idle" },
                },
              },
            },
          }),
        ]),
      );
    });
  }

  it("rejects sessionless terminal events across OpenCode and Kilo URL aliases", async () => {
    const events = createBroadcastSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      sessionIds: ["opencode-session-1", "kilo-session-1"],
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> };
    };
    client.event.subscribe = async () => ({ stream: events.subscribe() });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const openCode = yield* OpenCodeAdapter;
        const kilo = yield* KiloAdapter;
        const openCodeThreadId = asThreadId("thread-cross-provider-opencode");
        const kiloThreadId = asThreadId("thread-cross-provider-kilo");
        yield* openCode.startSession({
          provider: "opencode",
          threadId: openCodeThreadId,
          runtimeMode: "full-access",
          providerOptions: { opencode: { serverUrl: "http://[::1]:4099/" } },
        });
        yield* kilo.startSession({
          provider: "kilo",
          threadId: kiloThreadId,
          runtimeMode: "full-access",
          providerOptions: { kilo: { serverUrl: "http://127.0.0.1:4099" } },
        });
        const turn = yield* openCode.sendTurn({
          threadId: openCodeThreadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        events.push({ type: "session.idle", properties: {} });
        events.push({
          type: "session.error",
          properties: { error: { data: { message: "ambiguous" } } },
        });
        yield* Effect.sleep(25);
        const [openCodeSession] = yield* openCode.listSessions();
        const [kiloSession] = yield* kilo.listSessions();
        events.close();
        return { kiloSession, openCodeSession, turn };
      }).pipe(
        Effect.provide(
          Layer.merge(
            makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
            makeKiloAdapterLive({
              runtime: runtime.runtime,
              promptAcceptedActivityTimeoutMs: 1_000,
              promptAcceptedRecoveryDelaysMs: [],
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), { prefix: "kilo-adapter-test-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      ),
    );

    expect(result.openCodeSession).toMatchObject({
      status: "running",
      activeTurnId: result.turn.turnId,
    });
    expect(result.kiloSession?.status).toBe("ready");
  });

  it("keeps a stopping context registered until provider abort finishes", async () => {
    const events = createBroadcastSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      sessionIds: ["opencode-session-1", "opencode-session-2"],
      abort: async (input) => {
        if (input.sessionID === "opencode-session-2") {
          events.push({ type: "session.idle", properties: {} });
          events.push({
            type: "session.error",
            properties: { error: { data: { message: "stopping context" } } },
          });
          await Promise.resolve();
        }
        return { data: null };
      },
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> };
    };
    client.event.subscribe = async () => ({ stream: events.subscribe() });

    const active = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const activeThreadId = asThreadId("thread-stop-race-active");
        const stoppingThreadId = asThreadId("thread-stop-race-stopping");
        yield* adapter.startSession({
          provider: "opencode",
          threadId: activeThreadId,
          runtimeMode: "full-access",
        });
        yield* adapter.startSession({
          provider: "opencode",
          threadId: stoppingThreadId,
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId: activeThreadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        yield* adapter.stopSession(stoppingThreadId);
        yield* Effect.sleep(20);
        const sessions = yield* adapter.listSessions();
        events.close();
        return { session: sessions.find((session) => session.threadId === activeThreadId), turn };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(active.session).toMatchObject({
      status: "running",
      activeTurnId: active.turn.turnId,
    });
  });

  it("keeps an unexpectedly exiting context registered until provider abort finishes", async () => {
    const activeEvents = createSubscribedEventQueue();
    let rejectFailedSubscription: ((cause: Error) => void) | undefined;
    const failedSubscription = new Promise<never>((_resolve, reject) => {
      rejectFailedSubscription = reject;
    });
    const failedStream = {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<never>> => {
            await failedSubscription;
            return { value: undefined, done: true };
          },
        };
      },
    };
    const runtime = createMockOpenCodeRuntime({
      sessionIds: ["opencode-session-1", "opencode-session-2"],
      abort: async (input) => {
        if (input.sessionID === "opencode-session-2") {
          activeEvents.push({ type: "session.idle", properties: {} });
          activeEvents.push({
            type: "session.error",
            properties: { error: { data: { message: "exiting context" } } },
          });
        }
        return { data: null };
      },
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> };
    };
    let subscriptionCount = 0;
    client.event.subscribe = async () => {
      subscriptionCount += 1;
      return { stream: subscriptionCount === 1 ? activeEvents.stream : failedStream };
    };

    const active = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const activeThreadId = asThreadId("thread-unexpected-exit-active");
        const failingThreadId = asThreadId("thread-unexpected-exit-failing");
        yield* adapter.startSession({
          provider: "opencode",
          threadId: activeThreadId,
          runtimeMode: "full-access",
        });
        yield* adapter.startSession({
          provider: "opencode",
          threadId: failingThreadId,
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId: activeThreadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });
        rejectFailedSubscription?.(new Error("subscription failed"));
        yield* Effect.sleep(30);
        const sessions = yield* adapter.listSessions();
        activeEvents.close();
        return { session: sessions.find((session) => session.threadId === activeThreadId), turn };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(active.session).toMatchObject({
      status: "running",
      activeTurnId: active.turn.turnId,
    });
  });

  it("keeps Kilo identity in prompt-response recovery provenance", async () => {
    const runtime = createMockOpenCodeRuntime({
      prompt: async (input) => ({
        data: {
          info: {
            id: "msg-kilo-prompt-response",
            role: "assistant",
            parentID: input.messageID,
            finish: "stop",
            time: { completed: 2 },
          },
          parts: [
            {
              id: "part-kilo-prompt-response",
              messageID: "msg-kilo-prompt-response",
              type: "text",
              text: "done",
              time: { start: 1, end: 2 },
            } as Part,
          ],
        },
      }),
    });

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* KiloAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-kilo-prompt-response");
        yield* adapter.startSession({ provider: "kilo", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "kilo", model: "openai/gpt-5.4" },
        });
        return Array.from(yield* Fiber.join(eventsFiber));
      }).pipe(
        Effect.provide(
          makeKiloAdapterLive({
            runtime: runtime.runtime,
            promptAcceptedActivityTimeoutMs: 1_000,
            promptAcceptedRecoveryDelaysMs: [],
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "kilo-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(events[5]).toMatchObject({
      provider: "kilo",
      raw: {
        source: "kilo.sdk.event",
        payload: { source: "scient.kilo.prompt.response" },
      },
    });
    expect(JSON.stringify(events)).not.toContain("scient.opencode");
  });

  it("keeps Kilo identity in prompt watchdog errors", async () => {
    const runtime = createMockOpenCodeRuntime();

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* KiloAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-kilo-prompt-watchdog");
        yield* adapter.startSession({ provider: "kilo", threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "hello",
          attachments: [],
          modelSelection: { provider: "kilo", model: "openai/gpt-5.4" },
        });
        return Array.from(yield* Fiber.join(eventsFiber));
      }).pipe(
        Effect.provide(
          makeKiloAdapterLive({
            runtime: runtime.runtime,
            promptAcceptedActivityTimeoutMs: 10,
            promptAcceptedRecoveryDelaysMs: [],
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "kilo-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(events[3]).toMatchObject({
      provider: "kilo",
      type: "turn.completed",
      raw: {
        source: "kilo.sdk.event",
        payload: { source: "scient.kilo.prompt.watchdog" },
      },
      payload: { state: "failed", errorMessage: expect.stringContaining("Kilo") },
    });
    expect(events[4]).toMatchObject({
      provider: "kilo",
      type: "runtime.error",
      payload: { message: expect.stringContaining("restart Kilo") },
    });
    expect(JSON.stringify(events)).not.toContain("scient.opencode");
  });

  for (const eventType of ["session.error", "session.next.step.failed"] as const) {
    it(`keeps Kilo identity in ${eventType} fallback errors`, async () => {
      const eventQueue = createSubscribedEventQueue();
      const runtime = createMockOpenCodeRuntime();
      bindSubscribedEventQueue(runtime, eventQueue);

      const session = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* KiloAdapter;
          const threadId = asThreadId(`thread-kilo-fallback-${eventType}`);
          yield* adapter.startSession({ provider: "kilo", threadId, runtimeMode: "full-access" });
          yield* adapter.sendTurn({
            threadId,
            input: "hello",
            attachments: [],
            modelSelection: { provider: "kilo", model: "openai/gpt-5.4" },
          });
          if (eventType.startsWith("session.next.")) {
            pushActivePromptEcho(eventQueue, runtime);
          }
          eventQueue.push(
            eventType === "session.error"
              ? {
                  type: eventType,
                  properties: { sessionID: "opencode-session-1", error: {} },
                }
              : {
                  type: eventType,
                  properties: {
                    timestamp: 1,
                    sessionID: "opencode-session-1",
                    error: { message: "" },
                  },
                },
          );
          yield* Effect.sleep(10);
          const [current] = yield* adapter.listSessions();
          eventQueue.close();
          return current;
        }).pipe(
          Effect.provide(
            makeKiloAdapterLive({
              runtime: runtime.runtime,
              promptAcceptedActivityTimeoutMs: 1_000,
              promptAcceptedRecoveryDelaysMs: [],
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), { prefix: "kilo-adapter-test-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );

      expect(session?.status).toBe("error");
      expect(session?.lastError).toBe("Kilo session failed.");
    });
  }
});

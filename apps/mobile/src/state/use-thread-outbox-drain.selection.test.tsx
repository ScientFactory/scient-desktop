// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ServerConfig,
  sessionGrantsScope,
  type AuthEnvironmentScope,
  type SessionGrantInput,
  type ModelSelection,
} from "@t3tools/contracts";
import {
  presentThreadShell,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { makeRawThreadShell } from "../test-fixtures";
import type { QueuedThreadMessage } from "./thread-outbox-model";

const calls = vi.hoisted(() => ({
  startTurn: vi.fn(),
  updateMetadata: vi.fn(),
  setRuntimeMode: vi.fn(),
  setInteractionMode: vi.fn(),
  threads: [] as EnvironmentThreadShell[],
  configs: new Map<EnvironmentId, ServerConfig>(),
  writeConfig: vi.fn<(value: ServerConfig) => void>(),
  writeThreadShells: vi.fn<(values: readonly EnvironmentThreadShell[]) => void>(),
  storage: new Map<MessageId, QueuedThreadMessage>(),
  sessions: new Map<EnvironmentId, SessionGrantInput>(),
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("./session", () => {
  const readEnvironmentScope = (environmentId: EnvironmentId, scope: AuthEnvironmentScope) => {
    const session = calls.sessions.get(environmentId);
    return session !== undefined && sessionGrantsScope(session, scope);
  };
  return {
    readEnvironmentScope,
    useEnvironmentsWithScope: (
      environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
      scope: AuthEnvironmentScope,
    ) =>
      new Set(
        environments
          .filter(({ environmentId }) => readEnvironmentScope(environmentId, scope))
          .map(({ environmentId }) => environmentId),
      ),
  };
});
vi.mock("../lib/attachmentUpload", () => ({
  prepareTurnAttachments: async () => ({
    status: "ready",
    attachments: [],
    draftAttachments: [],
    pendingAttachmentIds: [],
  }),
}));
vi.mock("../lib/uuid", () => ({ randomHex: () => "abcd" }));
vi.mock("./entities", () => ({
  useProjects: () => [],
  useServerConfigs: () => calls.configs,
  useThreadShells: () => calls.threads,
}));
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  const { appAtomRegistry } = await import("./atom-registry");
  const configs = Atom.family(() => Atom.make<ServerConfig | null>(null).pipe(Atom.keepAlive));
  calls.writeConfig.mockImplementation((value) =>
    appAtomRegistry.set(configs(value.environment.environmentId), value),
  );
  return {
    serverEnvironment: {
      configValueAtom: configs,
    },
  };
});
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const { appAtomRegistry } = await import("./atom-registry");
  const shells = Atom.make<readonly EnvironmentThreadShell[]>([]).pipe(Atom.keepAlive);
  calls.writeThreadShells.mockImplementation((values) => appAtomRegistry.set(shells, values));
  return {
    environmentThreadShells: {
      threadShellsAtom: shells,
    },
    threadEnvironment: {
      startTurn: "start",
      updateMetadata: "metadata",
      setRuntimeMode: "runtime",
      setInteractionMode: "interaction",
    },
  };
});
vi.mock("./use-atom-command", () => ({
  useAtomCommand: (command: string) => {
    switch (command) {
      case "start":
        return calls.startTurn;
      case "metadata":
        return calls.updateMetadata;
      case "runtime":
        return calls.setRuntimeMode;
      case "interaction":
        return calls.setInteractionMode;
      default:
        throw new Error(`Unexpected command ${command}`);
    }
  },
}));
vi.mock("./use-remote-environment-registry", () => ({
  setPendingConnectionError: vi.fn(),
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [
      { environmentId: "environment-selection", connectionState: "connected" },
    ],
  }),
}));
vi.mock("./thread-outbox", async () => {
  const { createThreadOutboxManager } = await import("./thread-outbox-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  const manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => ({ messages: [...calls.storage.values()], errors: [] }),
      write: async (message) => {
        calls.storage.set(message.messageId, message);
      },
      remove: async (message) => {
        calls.storage.delete(message.messageId);
      },
    },
  });
  return {
    threadOutboxManager: manager,
    confirmThreadOutboxMessageQueued: manager.confirmQueued,
    threadOutboxRevision: manager.revisionOf,
    updateThreadOutboxMessage: manager.update,
  };
});
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  const { appAtomRegistry } = await import("./atom-registry");
  const { threadOutboxManager } = await import("./thread-outbox");
  return {
    editingQueuedMessageIdsAtom: Atom.make({}).pipe(Atom.keepAlive),
    dispatchingQueuedMessageIdAtom: Atom.make<MessageId | null>(null).pipe(Atom.keepAlive),
    useThreadOutboxMessages: () =>
      appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
    useThreadOutboxShellStatuses: () => new Map([["environment-selection", "live"]]),
  };
});
vi.mock("./use-composer-drafts", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    composerDraftsAtom: Atom.make({}),
    removeDeliveredCloudQueuedMessage: async () => undefined,
    scheduleUnusedComposerAttachmentCleanup: vi.fn(),
  };
});

import { appAtomRegistry } from "./atom-registry";
import { threadOutboxManager } from "./thread-outbox";
import { dispatchingQueuedMessageIdAtom } from "./use-thread-outbox";
import { acknowledgedThreadMessagesAtom } from "./acknowledged-thread-messages";
import { useThreadOutboxDrain } from "./use-thread-outbox-drain";

const environmentId = EnvironmentId.make("environment-selection");
const instanceId = ProviderInstanceId.make("codex");
const baseSelection: ModelSelection = { instanceId, model: "model-a" };
const decodeConfig = Schema.decodeUnknownSync(ServerConfig);
const config = decodeConfig({
  environment: {
    environmentId,
    label: "Synthetic test",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "test",
    capabilities: {},
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  cwd: "/synthetic",
  keybindingsConfigPath: "/synthetic/keys",
  keybindings: [],
  issues: [],
  providers: ["codex", "codex-second"].map((id) => ({
    instanceId: id,
    driver: "codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-05T00:00:00.000Z",
    models: ["model-a", "model-b"].map((slug) => ({
      slug,
      name: slug,
      isDefault: slug === "model-a",
      capabilities: {
        optionDescriptors: [
          {
            id: "thinking",
            label: "Thinking",
            type: "select",
            options: [
              { id: "high", label: "High" },
              { id: "low", label: "Low" },
            ],
          },
          { id: "search", label: "Search", type: "boolean" },
        ],
      },
    })),
    slashCommands: [],
    skills: [],
  })),
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/synthetic/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: {},
});
function Drain() {
  useThreadOutboxDrain();
  return null;
}
let root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls.storage.clear();
  calls.sessions.clear();
  calls.sessions.set(environmentId, {
    authenticated: true,
    scopes: [AuthOrchestrationOperateScope],
    permissions: [AuthOrchestrationOperateScope],
  });
  await threadOutboxManager.clearEnvironment(environmentId);
  for (const command of [
    calls.startTurn,
    calls.updateMetadata,
    calls.setRuntimeMode,
    calls.setInteractionMode,
  ]) {
    command.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  }
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, null);
  appAtomRegistry.set(acknowledgedThreadMessagesAtom, []);
  calls.writeConfig(config);
  calls.configs.set(environmentId, config);
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
async function deliver(current: ModelSelection, captured: ModelSelection, permitted = true) {
  const thread = presentThreadShell(
    environmentId,
    makeRawThreadShell({ modelSelection: current, itemCount: 1 }),
  );
  calls.threads = [thread];
  calls.writeThreadShells(calls.threads);
  const message: QueuedThreadMessage = {
    environmentId,
    threadId: thread.id,
    messageId: MessageId.make("message-selection"),
    commandId: CommandId.make("command-selection"),
    text: "Keep these exact user bytes: שלום\nsecond line",
    attachments: [],
    modelSelection: captured,
    dispatchMode: "queue",
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt: "2026-10-05T00:00:00.000Z",
  };
  await threadOutboxManager.enqueue(message);
  await act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <Drain />
      </RegistryContext.Provider>,
    ),
  );
  if (!permitted) {
    expect(calls.storage.get(message.messageId)).toEqual(message);
    expect(calls.startTurn).not.toHaveBeenCalled();
    expect(calls.updateMetadata).not.toHaveBeenCalled();
    expect(calls.setRuntimeMode).not.toHaveBeenCalled();
    expect(calls.setInteractionMode).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(acknowledgedThreadMessagesAtom)).toEqual([]);
    return;
  }
  await act(async () => {
    await vi.waitFor(() => expect(calls.storage.size).toBe(0));
  });
  expect(calls.startTurn).toHaveBeenCalledTimes(1);
  expect(calls.startTurn.mock.calls[0]?.[0]).toMatchObject({
    environmentId,
    input: {
      commandId: message.commandId,
      threadId: thread.id,
      modelSelection: captured,
      message: { messageId: message.messageId, text: message.text, attachments: [] },
      dispatchMode: "queue",
    },
  });
  expect(appAtomRegistry.get(acknowledgedThreadMessagesAtom)).toEqual([message]);
  expect(calls.setRuntimeMode).not.toHaveBeenCalled();
  expect(calls.setInteractionMode).not.toHaveBeenCalled();
}
it("keeps a connected target's captured selection queued when its exact operation grant is absent", async () => {
  calls.sessions.set(environmentId, {
    authenticated: true,
    scopes: [AuthOrchestrationOperateScope],
    permissions: [],
  });
  await deliver(baseSelection, { ...baseSelection, model: "model-b" }, false);
});
it.each([
  [baseSelection, { ...baseSelection, options: [] }],
  [{ ...baseSelection, options: [] }, baseSelection],
  [
    {
      ...baseSelection,
      options: [
        { id: "thinking", value: "high" },
        { id: "search", value: true },
      ],
    },
    {
      ...baseSelection,
      options: [
        { id: "search", value: true },
        { id: "thinking", value: "high" },
      ],
    },
  ],
])(
  "delivers equivalent captured options without a metadata command: %j → %j",
  async (current, captured) => {
    await deliver(current, captured);
    expect(calls.updateMetadata).not.toHaveBeenCalled();
  },
);
it.each([
  {
    current: baseSelection,
    captured: { ...baseSelection, options: [{ id: "thinking", value: "high" }] },
  },
  {
    current: baseSelection,
    captured: { ...baseSelection, instanceId: ProviderInstanceId.make("codex-second") },
  },
  { current: baseSelection, captured: { ...baseSelection, model: "model-b" } },
  {
    current: { ...baseSelection, options: [{ id: "thinking", value: "high" }] },
    captured: { ...baseSelection, options: [{ id: "thinking", value: "low" }] },
  },
  {
    current: { ...baseSelection, options: [{ id: "search", value: true }] },
    captured: { ...baseSelection, options: [{ id: "search", value: false }] },
  },
])(
  "syncs a genuine model selection change successfully before delivery: %j",
  async ({ current, captured }) => {
    await deliver(current, captured);
    expect(calls.updateMetadata).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        commandId: "command-selection:model-selection",
        threadId: calls.threads[0]?.id,
        modelSelection: captured,
      },
    });
    const settingsOrder = calls.updateMetadata.mock.invocationCallOrder[0];
    const turnOrder = calls.startTurn.mock.invocationCallOrder[0];
    if (settingsOrder === undefined || turnOrder === undefined)
      throw new Error("Missing settings or turn receipt");
    expect(settingsOrder).toBeLessThan(turnOrder);
  },
);

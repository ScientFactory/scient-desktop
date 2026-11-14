import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const mocks = vi.hoisted(() => ({
  setModelSelection: null as ((value: unknown) => Promise<AtomCommandResult<void, unknown>>) | null,
}));

vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => (value: unknown) => mocks.setModelSelection?.(value)) as never,
}));

vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      threadShellAtom: ((ref: { threadId: string }) => shellAtom(ref.threadId)) as never,
    },
  };
});

import { render, stubGlobal } from "../../../test/render";
import {
  DraftId,
  deriveEffectiveComposerModelState,
  flushComposerDraftPersistence,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { createMemoryStorage } from "../../lib/storage";
import { makeThreadFixture } from "../../test-fixtures";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { useComposerSelection } from "./useComposerSelection";

// Kept alive so a shell set before the hook mounts is still there when it saves a pick.
const shellAtom = Atom.family((_threadId: string) => Atom.make<unknown>(null).pipe(Atom.keepAlive));

function setup() {
  const setModelSelection = vi.fn<(value: unknown) => Promise<AtomCommandResult<void, unknown>>>();
  mocks.setModelSelection = setModelSelection;
  return { setModelSelection };
}

const environmentId = EnvironmentId.make("environment-local");
const cursor = ProviderInstanceId.make("cursor");
const stored = createModelSelection(cursor, "claude-opus-5-5", [{ id: "effort", value: "medium" }]);

const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: cursor,
    driver: ProviderDriverKind.make("cursor"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: "auto-smart", name: "Auto", isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  },
];

// The hook reads only the thread's identity and stored selection.
function cursorThread(id: string) {
  return { environmentId, id: ThreadId.make(id), modelSelection: stored } as EnvironmentThreadShell;
}

function Picker(props: {
  thread: EnvironmentThreadShell;
  runtime: Parameters<typeof useComposerSelection>[0]["activeRuntime"];
  model?: string;
}) {
  const { onProviderModelSelectStable } = useComposerSelection({
    environmentId,
    composerDraftTarget: scopeThreadRef(environmentId, props.thread.id),
    draftThread: null,
    activeThread: props.thread,
    activeRuntime: props.runtime,
    activeProjectSettings: { settings: { newWorktreesStartFromOrigin: false } },
    settings: DEFAULT_UNIFIED_SETTINGS,
    providerStatuses: providers,
    lockedProvider: null,
    supportsProviderSwitchingViaHandoff: true,
    multipleModelSelections: null,
    runtimeMode: "full-access",
    isLocalDraftThread: false,
    canOverrideServerThreadEnvMode: false,
    setPendingServerThreadEnvModeEntry: () => {},
    setPendingServerThreadStartFromOriginByThreadId: () => {},
    scheduleComposerFocus: () => {},
  });
  return (
    <button
      type="button"
      onClick={() => onProviderModelSelectStable(cursor, props.model ?? stored.model)}
    >
      Pick the model
    </button>
  );
}

it("keeps a Cursor thread's stored model and options when the user re-picks its unavailable row", async () => {
  setup();
  const thread = cursorThread("thread-cursor");
  await using _screen = await render(<Picker thread={thread} runtime={null} />);
  await page.getByRole("button", { name: "Pick the model" }).click();

  await vi.waitFor(() => {
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(environmentId, thread.id));
    expect(draft?.modelSelectionByProvider[cursor] ?? thread.modelSelection).toEqual(stored);
  });
});

it("switches back to the thread's stored model while the session runs on another instance", async () => {
  setup();
  const thread = cursorThread("thread-cursor-handoff");
  const runtime = { providerInstanceId: ProviderInstanceId.make("codex") } as Parameters<
    typeof useComposerSelection
  >[0]["activeRuntime"];
  await using _screen = await render(<Picker thread={thread} runtime={runtime} />);
  await page.getByRole("button", { name: "Pick the model" }).click();

  await vi.waitFor(() => {
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(environmentId, thread.id));
    expect(draft?.activeProvider).toBe(cursor);
    expect(
      deriveEffectiveComposerModelState({
        draft,
        threadStarted: true,
        providers,
        selectedProvider: ProviderDriverKind.make("cursor"),
        selectedInstanceId: cursor,
        threadModelSelection: thread.modelSelection,
        projectModelSelection: null,
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toEqual({ selectedModel: stored.model, modelOptions: { [cursor]: stored.options } });
  });
});

it("saves a re-picked model again when its first save failed", async () => {
  const { setModelSelection } = setup();
  setModelSelection
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))))
    .mockResolvedValue(AsyncResult.success(undefined));
  const thread = cursorThread("thread-cursor-retry");
  appAtomRegistry.set(shellAtom(thread.id), thread);
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <Picker thread={thread} runtime={null} model="auto-smart" />
    </AppAtomRegistryProvider>,
  );
  const pick = page.getByRole("button", { name: "Pick the model" });
  await pick.click();
  await vi.waitFor(() => expect(setModelSelection).toHaveBeenCalledTimes(1));
  await pick.click();

  const autoSave = expect.objectContaining({
    input: {
      threadId: thread.id,
      modelSelection: expect.objectContaining({ instanceId: cursor, model: "auto-smart" }),
    },
  });
  await vi.waitFor(() => expect(setModelSelection.mock.calls).toEqual([[autoSave], [autoSave]]));
});

it("saves a pick of a seeded model the started thread does not show", async () => {
  const { setModelSelection } = setup();
  setModelSelection.mockResolvedValue(AsyncResult.success(undefined));
  const thread = cursorThread("thread-cursor-seeded");
  appAtomRegistry.set(shellAtom(thread.id), thread);
  useComposerDraftStore
    .getState()
    .setModelSelection(
      scopeThreadRef(environmentId, thread.id),
      createModelSelection(cursor, "auto-smart"),
    );
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <Picker thread={thread} runtime={null} model="auto-smart" />
    </AppAtomRegistryProvider>,
  );
  await page.getByRole("button", { name: "Pick the model" }).click();

  await vi.waitFor(() =>
    expect(setModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          threadId: thread.id,
          modelSelection: expect.objectContaining({ instanceId: cursor, model: "auto-smart" }),
        },
      }),
    ),
  );
});

// SCIENT-FORK:START — model picks land on the draft target the composer edits.
it("applies remembered, explicit and cleared model options to the draft target, not the server thread", async () => {
  using _storage = stubGlobal("localStorage", createMemoryStorage());
  using cleanup = new DisposableStack();
  const before = useComposerDraftStore.getState();
  cleanup.defer(() => {
    useComposerDraftStore.setState(before, true);
    flushComposerDraftPersistence();
  });
  const environmentId = EnvironmentId.make("selection-owner");
  const instanceId = ProviderInstanceId.make("codex");
  const model = "gpt-5.4";
  const draftId = DraftId.make("selection-draft");
  // Picking a model the thread does not show yet: re-picking the shown one keeps its options.
  const activeThread = makeThreadFixture({
    environmentId,
    modelSelection: { instanceId, model: "gpt-5.2" },
  });
  const serverTarget = scopeThreadRef(environmentId, activeThread.id);
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(environmentId, activeThread.projectId), draftId, {
    threadId: ThreadId.make("local-draft-thread"),
  });
  store.setPrompt(draftId, "Keep the authored draft");
  store.setPrompt(serverTarget, "Keep the server composer");
  const serverBefore = useComposerDraftStore.getState().getComposerDraft(serverTarget);
  const remembered = [{ id: "reasoning", value: "high" }];
  useComposerDraftStore.setState({
    stickyOptionsByModelByProvider: { [instanceId]: { [model]: remembered } },
  });
  const provider: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-20T00:00:00Z",
    models: [{ slug: model, name: model, isCustom: false, capabilities: {}, isDefault: true }],
    slashCommands: [],
    skills: [],
  };
  const focus = vi.fn();
  const draftThread = store.getDraftSession(draftId);
  function Owner() {
    const { onProviderModelSelectStable } = useComposerSelection({
      environmentId,
      composerDraftTarget: draftId,
      draftThread,
      activeThread,
      activeRuntime: null,
      activeProjectSettings: { settings: { newWorktreesStartFromOrigin: false } },
      settings: DEFAULT_UNIFIED_SETTINGS,
      providerStatuses: [provider],
      lockedProvider: null,
      supportsProviderSwitchingViaHandoff: false,
      multipleModelSelections: null,
      runtimeMode: "full-access",
      isLocalDraftThread: true,
      canOverrideServerThreadEnvMode: false,
      setPendingServerThreadEnvModeEntry: () => {},
      setPendingServerThreadStartFromOriginByThreadId: () => {},
      scheduleComposerFocus: focus,
    });
    return (
      <>
        <button onClick={() => onProviderModelSelectStable(instanceId, model)}>
          Remember options
        </button>
        <button
          onClick={() =>
            onProviderModelSelectStable(instanceId, model, [{ id: "reasoning", value: "low" }])
          }
        >
          Explicit options
        </button>
        <button onClick={() => onProviderModelSelectStable(instanceId, model, [])}>
          Clear options
        </button>
        <button
          onClick={() => onProviderModelSelectStable(instanceId, model, { focusComposer: false })}
        >
          Select without focus
        </button>
      </>
    );
  }
  await using screen = await render(<Owner />);
  const draft = () => useComposerDraftStore.getState().getComposerDraft(draftId);
  await screen.getByRole("button", { name: "Remember options", exact: true }).click();
  expect(draft()?.modelSelectionByProvider[instanceId]).toEqual({
    instanceId,
    model,
    options: remembered,
  });
  await screen.getByRole("button", { name: "Explicit options", exact: true }).click();
  expect(draft()?.modelSelectionByProvider[instanceId]).toEqual({
    instanceId,
    model,
    options: [{ id: "reasoning", value: "low" }],
  });
  await screen.getByRole("button", { name: "Clear options", exact: true }).click();
  expect(draft()?.modelSelectionByProvider[instanceId]).toEqual({ instanceId, model });
  expect(focus).toHaveBeenCalledTimes(3);
  await screen.getByRole("button", { name: "Select without focus", exact: true }).click();
  expect(focus).toHaveBeenCalledTimes(3);
  expect(draft()?.prompt).toBe("Keep the authored draft");
  expect(draft()?.modelSelectionExplicit).toBe(true);
  expect(useComposerDraftStore.getState().getComposerDraft(serverTarget)).toBe(serverBefore);
});
// SCIENT-FORK:END

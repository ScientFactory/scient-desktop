import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { render, stubGlobal } from "../../../test/render";
import {
  DraftId,
  flushComposerDraftPersistence,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { createMemoryStorage } from "../../lib/storage";
import { makeThreadFixture } from "../../test-fixtures";
import { useComposerSelection } from "./useComposerSelection";

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
  const activeThread = makeThreadFixture({ environmentId, modelSelection: { instanceId, model } });
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
      interactionMode: "default",
      interactionModeEnabled: true,
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

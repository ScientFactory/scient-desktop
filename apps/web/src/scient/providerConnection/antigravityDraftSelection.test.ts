import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import {
  scopeThreadRef,
  scopeProjectRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  deriveEffectiveComposerModelState,
  useComposerDraftStore,
  DraftId,
  markPromotedDraftThreadByRef,
  finalizePromotedDraftThreadByRef,
} from "../../composerDraftStore";
import { getComposerProviderState } from "../../components/chat/composerProviderState";
import { resolveAntigravityDraftSelection } from "./antigravityDraftSelection";

const id = ProviderInstanceId.make("antigravity_work");
const threadRef = scopeThreadRef(EnvironmentId.make("test"), ThreadId.make("new-thread"));
const key = scopedThreadKey(threadRef);
const old = createModelSelection(id, "gemini-3.8-flash", [{ id: "reasoning", value: "medium" }]);
const provider: ServerProvider = {
  instanceId: id,
  driver: ProviderDriverKind.make("antigravity"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-07T00:00:00.000Z",
  models: ["low", "medium", "high"].map((level) => ({
    slug: `gemini-3.8-flash-${level}`,
    name: `Gemini 3.8 Flash (${level[0]!.toUpperCase() + level.slice(1)})`,
    isCustom: false,
    capabilities: {},
    isDefault: level === "high",
  })),
  slashCommands: [],
  skills: [],
};
function reset() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}
beforeEach(reset);
afterEach(async () => {
  await useComposerDraftStore.persist.clearStorage();
  reset();
  vi.useRealTimers();
});
function reconcile(value = provider, started = false) {
  useComposerDraftStore
    .getState()
    .reconcileAntigravityDraftSelection({ threadRef, provider: value, hasStartedSession: started });
}
function saved() {
  return useComposerDraftStore.getState().draftsByThreadKey[key]?.modelSelectionByProvider[id];
}

it.each(["low", "medium", "high"])(
  "preserves explicit %s reasoning and other options",
  (effort) => {
    const selection = createModelSelection(id, old.model, [
      { id: "effort", value: effort },
      { id: "other", value: true },
    ]);
    expect(resolveAntigravityDraftSelection(selection, provider)).toEqual(
      createModelSelection(id, `${old.model}-${effort}`, [{ id: "other", value: true }]),
    );
  },
);
it("preserves the historical medium default, not the new catalog's high default", () => {
  expect(
    resolveAntigravityDraftSelection(createModelSelection(id, old.model), provider)?.model,
  ).toBe(`${old.model}-medium`);
});
it("does not guess unavailable efforts, unknown families, conflicting options or already-native selections", () => {
  for (const selection of [
    createModelSelection(id, "gemini-missing"),
    createModelSelection(id, old.model, [{ id: "reasoning", value: "max" }]),
    createModelSelection(id, old.model, [
      { id: "reasoning", value: "low" },
      { id: "effort", value: "high" },
    ]),
    createModelSelection(id, `${old.model}-low`),
  ])
    expect(resolveAntigravityDraftSelection(selection, provider)).toBeNull();
  expect(
    resolveAntigravityDraftSelection(old, {
      ...provider,
      models: provider.models.filter((m) => !m.slug.endsWith("-medium")),
    }),
  ).toBeNull();
});
it("leaves legacy catalogs, native options, unavailable accounts and other instances/providers alone", () => {
  for (const value of [
    {
      ...provider,
      models: [{ slug: old.model, name: "Gemini 3.8 Flash", isCustom: false, capabilities: {} }],
    },
    { ...provider, models: [] },
    { ...provider, enabled: false },
    { ...provider, installed: false },
    { ...provider, status: "error" as const },
    { ...provider, instanceId: ProviderInstanceId.make("antigravity_other") },
    { ...provider, driver: ProviderDriverKind.make("codex") },
    { ...provider, models: provider.models.map((model) => ({ ...model, isCustom: true })) },
    {
      ...provider,
      models: provider.models.map((model) => ({ ...model, name: "Unverified model label" })),
    },
    {
      ...provider,
      models: provider.models.map((model) => ({
        ...model,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinking",
              label: "Thinking",
              type: "select" as const,
              currentValue: "medium",
              options: [{ id: "medium", label: "Medium" }],
            },
          ],
        },
      })),
    },
  ])
    expect(resolveAntigravityDraftSelection(old, value)).toBeNull();
  expect(resolveAntigravityDraftSelection(old, provider, [`${old.model}-medium`])).toBeNull();
});
it("repairs a remembered draft after catalog refresh and retains the native ID through first send and restart", async () => {
  vi.useFakeTimers();
  const store = useComposerDraftStore.getState();
  store.setStickyModelSelection(old);
  store.applyStickyState(threadRef);
  store.setPrompt(threadRef, "Keep this draft");
  reconcile({ ...provider, models: [] });
  expect(saved()).toEqual(old);
  reconcile();
  const native = createModelSelection(id, `${old.model}-medium`);
  expect(saved()).toEqual(native);
  expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[id]).toEqual(native);
  expect(useComposerDraftStore.getState().draftsByThreadKey[key]?.prompt).toBe("Keep this draft");
  expect(
    useComposerDraftStore.getState().draftsByThreadKey[key]?.modelSelectionExplicit,
  ).toBeUndefined();
  const stable = useComposerDraftStore.getState();
  reconcile();
  expect(useComposerDraftStore.getState()).toBe(stable);
  store.clearComposerContent(threadRef);
  const state = deriveEffectiveComposerModelState({
    draft: useComposerDraftStore.getState().draftsByThreadKey[key],
    providers: [provider],
    selectedProvider: provider.driver,
    selectedInstanceId: id,
    threadModelSelection: native,
    projectModelSelection: null,
    settings: DEFAULT_UNIFIED_SETTINGS,
  });
  expect(state.selectedModel).toBe(native.model);
  expect(
    getComposerProviderState({
      provider: provider.driver,
      model: state.selectedModel,
      models: provider.models,
      modelOptions: state.modelOptions?.[id],
      planModeEnabled: false,
    }).modelOptionsForDispatch,
  ).toBeUndefined();
  await vi.advanceTimersByTimeAsync(300);
  reset();
  await useComposerDraftStore.persist.rehydrate();
  expect(saved()).toEqual(native);
});
it("does not touch started sessions or newer remembered selections", () => {
  const store = useComposerDraftStore.getState();
  store.setModelSelection(threadRef, old, { explicit: true });
  const newer = createModelSelection(id, `${old.model}-high`);
  store.setStickyModelSelection(newer);
  reconcile(provider, true);
  expect(saved()).toEqual(old);
  reconcile();
  expect(saved()?.model).toBe(`${old.model}-medium`);
  expect(useComposerDraftStore.getState().draftsByThreadKey[key]?.modelSelectionExplicit).toBe(
    true,
  );
  expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[id]).toEqual(newer);
  store.setModelSelection(threadRef, newer);
  reconcile();
  expect(saved()).toEqual(newer);
});
it("normalizes inherited project defaults without editing the project or another active provider", () => {
  const input = { threadRef, provider, hasStartedSession: false, fallbackSelection: old };
  useComposerDraftStore.getState().reconcileAntigravityDraftSelection(input);
  expect(saved()?.model).toBe(`${old.model}-medium`);
  expect(old.model).toBe("gemini-3.8-flash");
  const codex = createModelSelection(ProviderInstanceId.make("codex"), "gpt-test");
  useComposerDraftStore.getState().setModelSelection(threadRef, codex);
  const state = useComposerDraftStore.getState();
  state.reconcileAntigravityDraftSelection(input);
  expect(useComposerDraftStore.getState()).toBe(state);
});

it("carries the canonical selection from a logical draft into the materialized server thread", () => {
  const draftId = DraftId.make("new-antigravity-draft");
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(
    scopeProjectRef(threadRef.environmentId, ProjectId.make("project")),
    draftId,
    { threadId: threadRef.threadId },
  );
  store.setModelSelection(draftId, old);
  store.reconcileAntigravityDraftSelection({
    threadRef: draftId,
    provider,
    hasStartedSession: false,
  });
  markPromotedDraftThreadByRef(threadRef);
  store.clearComposerContent(draftId);
  finalizePromotedDraftThreadByRef(threadRef);
  expect(saved()).toEqual(createModelSelection(id, `${old.model}-medium`));
  expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
  reconcile(provider, true);
  expect(saved()?.model).toBe(`${old.model}-medium`);
});

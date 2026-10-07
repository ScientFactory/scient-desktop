import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

import { ProviderOnboardingPicker } from "../providerConnection/ProviderOnboardingPicker";
import { ProviderModelPicker } from "../../components/chat/ProviderModelPicker";
import {
  hasCommittedConversationMessages,
  useComposerModelPickerFork,
} from "../../components/chat/composerModelPickerFork";
import { ScientForkWorkspaceModeDialog } from "../../components/chat/scient-fork/ScientForkWorkspaceModeDialog";
import { DraftId, useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";
import { deriveProviderInstanceEntries } from "../../providerInstances";

const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");
const draftTarget = DraftId.make("model-picker-new-chat-browser");
const queuedRunId = RunId.make("queue-only-run");
const entries = deriveProviderInstanceEntries(
  [codexId, claudeId].map((instanceId): ServerProvider => ({
    instanceId,
    driver: ProviderDriverKind.make(instanceId),
    displayName: instanceId === codexId ? "Codex" : "Claude Agent",
    enabled: true,
    installed: true,
    version: "fixture",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-04T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  })),
);
const options = new Map([
  [codexId, [{ slug: "gpt-model", name: "GPT model" }]],
  [claudeId, [{ slug: "claude-model", name: "Claude model" }]],
]);
const forkRequested = vi.fn();
const modelSelected = vi.fn();
let root: Root | undefined;
let host: HTMLDivElement | undefined;

function ComposerPickerParent(props: {
  readonly history: Parameters<typeof hasCommittedConversationMessages>[0];
  readonly busy?: boolean;
  readonly singleProvider?: boolean;
  readonly onboarding?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selection, setSelection] = useState({ instanceId: codexId, model: "gpt-model" });
  const draft = useComposerThreadDraft(draftTarget);
  const continueInNewChat = useComposerModelPickerFork({
    hasConversationMessages: hasCommittedConversationMessages(props.history),
    onForkConversation: (settings) => {
      forkRequested(settings);
      if (!settings?.preserveComposerDraft) {
        useComposerDraftStore.getState().setPrompt(draftTarget, "");
      }
      setDialogOpen(true);
    },
  });
  return (
    <>
      <textarea aria-label="Ordinary composer draft" value={draft.prompt} readOnly />
      {props.onboarding ? (
        <ProviderOnboardingPicker
          environmentId={EnvironmentId.make("local")}
          instanceEntries={[]}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          autoSelectReadyProvider={false}
          {...(continueInNewChat ? { onContinueInNewChat: continueInNewChat } : {})}
          continueInNewChatDisabled={props.busy ?? false}
          onInstanceModelChange={modelSelected}
        />
      ) : (
        <ProviderModelPicker
          activeInstanceId={selection.instanceId}
          model={selection.model}
          lockedProvider={null}
          instanceEntries={props.singleProvider ? entries.slice(0, 1) : entries}
          modelOptionsByInstance={options}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          {...(continueInNewChat ? { onContinueInNewChat: continueInNewChat } : {})}
          continueInNewChatDisabled={props.busy ?? false}
          onInstanceModelChange={(instanceId, model) => {
            modelSelected(instanceId, model);
            setSelection({ instanceId, model });
          }}
        />
      )}
      <ScientForkWorkspaceModeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        disabled={false}
        source="new-chat"
        proposedTitle="Existing conversation (2)"
        titleOverrideSupported
        worktreeAvailability={{ available: false, reason: "no-git-repository" }}
        onConfirm={() => {}}
      />
    </>
  );
}

const existingHistory = { messages: [{ runId: null }], runs: [], items: [] };
const footer = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Continue in a new chat"]');
const provider = (id: ProviderInstanceId) =>
  document.querySelector<HTMLButtonElement>(`[data-model-picker-provider="${id}"] button`);
const picker = () => document.querySelector("[data-model-picker-content]");
const forkDialog = () =>
  [...document.querySelectorAll('[role="dialog"]')].find((dialog) =>
    dialog.textContent?.includes("Fork this chat"),
  );

beforeEach(async () => {
  forkRequested.mockClear();
  modelSelected.mockClear();
  useComposerDraftStore.getState().clearDraftThread(draftTarget);
  useComposerDraftStore.getState().setPrompt(draftTarget, "Keep this ordinary draft");
  const file = new File(["original attachment bytes"], "draft.txt", { type: "text/plain" });
  useComposerDraftStore.getState().addFiles(
    draftTarget,
    [
      {
        id: "draft-file",
        type: "file",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
      },
    ],
    { appendReference: false },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await page.viewport(1280, 900);
});
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  useComposerDraftStore.getState().clearDraftThread(draftTarget);
});

describe("existing-conversation model picker continuation", () => {
  it("keeps providers enabled and selects a different provider in place with the footer present", async () => {
    root!.render(<ComposerPickerParent history={existingHistory} />);
    await expect.poll(() => footer()).toBeTruthy();
    expect(footer()!.textContent).toContain("Fork");
    expect(provider(codexId)!.disabled).toBe(false);
    expect(provider(claudeId)!.disabled).toBe(false);
    provider(claudeId)!.click();
    await expect.poll(() => document.body.textContent?.includes("Claude model")).toBe(true);
    expect(footer()).not.toBeNull();
    const model = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
      row.textContent?.includes("Claude model"),
    );
    model!.click();
    await expect.poll(() => modelSelected.mock.calls.length).toBe(1);
    expect(modelSelected).toHaveBeenCalledWith(claudeId, "claude-model");
    expect(forkRequested).not.toHaveBeenCalled();
    await expect.poll(() => picker()).toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt).toBe(
      "Keep this ordinary draft",
    );
  });

  it.each([false, true])(
    "offers the footer with one provider and opens Scient's dialog preserving the draft (%s)",
    async (singleProvider) => {
      root!.render(
        <ComposerPickerParent history={existingHistory} singleProvider={singleProvider} />,
      );
      await expect.poll(() => footer()).toBeTruthy();
      footer()!.click();
      await expect.poll(() => forkDialog()?.textContent).toContain("Fork this chat");
      expect(forkDialog()?.textContent).toContain("Continue in a new chat");
      expect(forkRequested).toHaveBeenCalledExactlyOnceWith({ preserveComposerDraft: true });
      await expect.poll(() => picker()).toBeNull();
      const draft = useComposerDraftStore.getState().getComposerDraft(draftTarget)!;
      expect(draft.prompt).toBe("Keep this ordinary draft");
      expect(draft.files).toHaveLength(1);
      expect(await draft.files[0]!.file!.text()).toBe("original attachment bytes");
    },
  );

  it.each([
    { messages: [], runs: [], items: [] },
    {
      messages: [{ runId: queuedRunId }],
      runs: [{ id: queuedRunId, status: "queued" as const }],
      items: [],
    },
  ])(
    "hides the footer for empty or held queued-only history even with a typed draft",
    async (history) => {
      root!.render(<ComposerPickerParent history={history} />);
      await expect.poll(() => provider(codexId)).toBeTruthy();
      expect(footer()).toBeNull();
      expect(document.body.textContent).not.toContain("Continue in a new chat");
      expect(forkRequested).not.toHaveBeenCalled();
      expect(useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt).toBe(
        "Keep this ordinary draft",
      );
    },
  );

  it("keeps the new-chat fork reachable in the unavailable-provider setup selector", async () => {
    root!.render(<ComposerPickerParent history={existingHistory} onboarding />);
    await expect
      .poll(() => document.querySelector("[data-provider-onboarding-picker]"))
      .toBeTruthy();
    expect(footer()).not.toBeNull();
    footer()!.click();
    await expect.poll(() => forkDialog()?.textContent).toContain("Fork this chat");
    expect(forkRequested).toHaveBeenCalledExactlyOnceWith({ preserveComposerDraft: true });
    await expect.poll(() => picker()).toBeNull();
    const draft = useComposerDraftStore.getState().getComposerDraft(draftTarget)!;
    expect(draft.prompt).toBe("Keep this ordinary draft");
    expect(await draft.files[0]!.file!.text()).toBe("original attachment bytes");
    expect(modelSelected).not.toHaveBeenCalled();
  });

  it("keeps a new empty provider setup selector free of the fork footer", async () => {
    root!.render(
      <ComposerPickerParent history={{ messages: [], runs: [], items: [] }} onboarding />,
    );
    await expect
      .poll(() => document.querySelector("[data-provider-onboarding-picker]"))
      .toBeTruthy();
    expect(footer()).toBeNull();
    expect(forkRequested).not.toHaveBeenCalled();
  });

  it("shows the disabled footer while busy without opening the fork dialog", async () => {
    root!.render(<ComposerPickerParent history={existingHistory} busy />);
    await expect.poll(() => footer()).toBeTruthy();
    expect(footer()!.disabled).toBe(true);
    footer()!.click();
    expect(forkRequested).not.toHaveBeenCalled();
    expect(forkDialog()).toBeUndefined();
  });
});

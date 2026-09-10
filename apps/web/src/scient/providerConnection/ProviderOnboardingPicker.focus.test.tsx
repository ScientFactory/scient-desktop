// @vitest-environment happy-dom
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, useState } from "react";
import { createModelSelection } from "@t3tools/shared/model";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  isInsideComposerFloatingLayer,
  isInsideRestingComposerControlScope,
} from "../../components/chat/composerEventScope";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderOnboardingPicker, readyProviderModelSelection } from "./ProviderOnboardingPicker";
import { shouldShowProviderLifecycleSetupInComposer } from "./providerConnectionPresentation";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
// Keep the real picker, portal and focus behavior; no provider installation in tests.
vi.mock("./AssistedProviderSetupHost", () => ({
  supportsAssistedProviderSetupSurface: () => true,
  AssistedProviderSetupHost: () => <button>Install provider</button>,
}));

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("antigravity"),
  driver: ProviderDriverKind.make("antigravity"),
  enabled: true,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unauthenticated", required: true },
  checkedAt: "2026-09-06T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("keeps search, provider selection and install controls inside the composer focus scope", async () => {
  await act(() =>
    root.render(
      <ProviderOnboardingPicker
        environmentId={EnvironmentId.make("local")}
        instanceEntries={deriveProviderInstanceEntries([provider])}
        onInstanceModelChange={vi.fn()}
        open
      />,
    ),
  );
  const popup = document.querySelector('[data-provider-onboarding-picker="true"]');
  expect(popup).not.toBeNull();
  expect(host.contains(popup)).toBe(false); // The setup actually lives in a portal.

  const search = popup!.querySelector("input")!;
  const railButton = popup!.querySelector<HTMLButtonElement>('[aria-label^="Antigravity,"]')!;
  for (const control of [search, railButton]) {
    expect(control).not.toBeNull();
    await act(() => control.focus());
    expect(document.activeElement).toBe(control);
    expect(isInsideComposerFloatingLayer(document.activeElement)).toBe(true);
    expect(isInsideRestingComposerControlScope(document.activeElement)).toBe(true);
  }
  await act(() => railButton.click());
  const install = [...popup!.querySelectorAll("button")].find(
    (button) => button.textContent === "Install provider",
  )!;
  expect(install).toBeDefined();
  await act(() => install.focus());
  expect(document.activeElement).toBe(install);
  expect(isInsideComposerFloatingLayer(document.activeElement)).toBe(true);
  expect(isInsideRestingComposerControlScope(document.activeElement)).toBe(true);

  expect(isInsideComposerFloatingLayer(host)).toBe(false);
  expect(isInsideRestingComposerControlScope(host)).toBe(false);
});

const ready: ServerProvider = {
  ...provider,
  installed: true,
  status: "ready",
  auth: { status: "authenticated", required: true },
  models: ["high", "medium", "low"].map((level) => ({
    slug: `gemini-3.8-flash-${level}`,
    name: `Gemini 3.8 Flash (${level[0]!.toUpperCase() + level.slice(1)})`,
    isCustom: false,
    capabilities: {},
    isDefault: level === "high",
  })),
};
it.each([false, true])(
  "finishes open setup across the readiness refresh (legacy selection: %s)",
  async (legacy) => {
    const onChange = vi.fn();
    const saved = legacy
      ? createModelSelection(provider.instanceId, "gemini-3.8-flash", [
          { id: "reasoning", value: "medium" },
        ])
      : undefined;
    function ComposerPickerOwner({ snapshot }: { snapshot: ServerProvider }) {
      const [open, setOpen] = useState(false);
      return shouldShowProviderLifecycleSetupInComposer(snapshot) || open ? (
        <ProviderOnboardingPicker
          environmentId={EnvironmentId.make("local")}
          instanceEntries={deriveProviderInstanceEntries([snapshot])}
          onInstanceModelChange={onChange}
          open={open}
          onOpenChange={setOpen}
          preferredSelections={saved ? { [snapshot.instanceId]: saved } : {}}
        />
      ) : (
        <div>Ready model picker</div>
      );
    }
    await act(() => root.render(<ComposerPickerOwner snapshot={provider} />));
    await act(() =>
      host.querySelector<HTMLButtonElement>("[data-provider-onboarding-trigger]")!.click(),
    );
    await act(() =>
      document.querySelector<HTMLButtonElement>('[aria-label^="Antigravity,"]')!.click(),
    );
    expect(onChange).not.toHaveBeenCalled();
    await act(() => root.render(<ComposerPickerOwner snapshot={ready} />));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      provider.instanceId,
      `gemini-3.8-flash-${legacy ? "medium" : "high"}`,
      [],
    );
    expect(host.textContent).toBe("Ready model picker");
  },
);
it("does not silently replace unknown or hidden saved models during setup completion", () => {
  const entry = deriveProviderInstanceEntries([ready])[0]!;
  expect(
    readyProviderModelSelection(entry, createModelSelection(provider.instanceId, "unknown-model")),
  ).toBeNull();
  expect(
    readyProviderModelSelection(
      entry,
      createModelSelection(provider.instanceId, "gemini-3.8-flash", [
        { id: "reasoning", value: "medium" },
      ]),
      ["gemini-3.8-flash-medium"],
    ),
  ).toBeNull();
});

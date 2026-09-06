// @vitest-environment happy-dom
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  isInsideComposerFloatingLayer,
  isInsideRestingComposerControlScope,
} from "../../components/chat/composerEventScope";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderOnboardingPicker } from "./ProviderOnboardingPicker";

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

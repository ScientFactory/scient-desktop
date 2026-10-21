import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useState } from "react";
import { createModelSelection } from "@t3tools/shared/model";

import { expect, it, vi } from "vite-plus/test";

import {
  isInsideComposerFloatingLayer,
  isInsideRestingComposerControlScope,
} from "../../components/chat/composerEventScope";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderOnboardingPicker, readyProviderModelSelection } from "./ProviderOnboardingPicker";
import { shouldShowProviderLifecycleSetupInComposer } from "./providerConnectionPresentation";

vi.mock("@tanstack/react-router", async (_actualRouter) => ({
  ...(await _actualRouter<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
// Keep the real picker, portal and focus behavior; no provider installation in tests.
vi.mock("./AssistedProviderSetupHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./AssistedProviderSetupHost")>()),
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

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.host.remove();
  vi.unstubAllGlobals();
}

it("keeps search, provider selection and install controls inside the composer focus scope", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(
    async () =>
      await _fixture.root0.rerender(
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
  expect(_fixture.host.contains(popup)).toBe(false); // The setup actually lives in a portal.

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

  expect(isInsideComposerFloatingLayer(_fixture.host)).toBe(false);
  expect(isInsideRestingComposerControlScope(_fixture.host)).toBe(false);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await act(
      async () => await _fixture.root0.rerender(<ComposerPickerOwner snapshot={provider} />),
    );
    await act(() =>
      _fixture.host.querySelector<HTMLButtonElement>("[data-provider-onboarding-trigger]")!.click(),
    );
    await act(() =>
      document.querySelector<HTMLButtonElement>('[aria-label^="Antigravity,"]')!.click(),
    );
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => await _fixture.root0.rerender(<ComposerPickerOwner snapshot={ready} />));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      provider.instanceId,
      `gemini-3.8-flash-${legacy ? "medium" : "high"}`,
      [],
    );
    expect(_fixture.host.textContent).toBe("Ready model picker");
  },
);
it("does not silently replace unknown or hidden saved models during setup completion", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

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

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;

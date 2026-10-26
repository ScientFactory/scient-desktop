import {
  render as _fixtureRender,
  type Screen,
  stubGlobal as _fixtureStubGlobal,
  act,
} from "../../../test/render";
import { userEvent } from "vite-plus/test/browser";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ComponentProps } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  canManageProviders: true,
  publishButton: (
    _element: HTMLButtonElement,
    _props: ComponentProps<"button">,
  ): (() => void) | undefined => undefined,
  auth: null as ProviderAuthState | null,
  installation: null as ProviderInstallState | null,
  commands: {
    startProviderAuth: vi.fn(),
    completeProviderAuth: vi.fn(),
    cancelProviderAuth: vi.fn(),
    logoutProviderAuth: vi.fn(),
    startProviderInstall: vi.fn(),
    cancelProviderInstall: vi.fn(),
    chatGptReconnectProfile: vi.fn(),
    chatGptImportProfile: vi.fn(),
  },
}));

vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => state.canManageProviders,
  readPreparedConnection: () => null,
  useEnvironmentScope: () => state.canManageProviders,
}));
vi.mock("../../state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make(null) };
});
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationAtom: () => null },
}));
vi.mock("../../composerDraftStore", async () => {
  const Schema = await import("effect/Schema");
  return {
    DraftId: Schema.String.pipe(Schema.brand("DraftId")),
    useComposerDraftStore: () => null,
  };
});
vi.mock("./AddCodexAccountDialog", () => ({ AddCodexAccountDialog: () => null }));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: string;
    description?: import("react").ReactNode;
    control?: import("react").ReactNode;
  }) => (
    <div>
      {title}
      {description}
      {control}
    </div>
  ),
}));
vi.mock("../../state/environments", () => ({
  useEnvironmentHttpBaseUrl: () => "https://remote.example",
  usePrimaryEnvironmentId: () => null,
  useEnvironment: () => null,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerAuthState: () => "auth",
    providerInstallState: () => "installation",
    startProviderAuth: "startProviderAuth",
    completeProviderAuth: "completeProviderAuth",
    cancelProviderAuth: "cancelProviderAuth",
    logoutProviderAuth: "logoutProviderAuth",
    startProviderInstall: "startProviderInstall",
    cancelProviderInstall: "cancelProviderInstall",
    chatGptReconnectProfile: "chatGptReconnectProfile",
    chatGptImportProfile: "chatGptImportProfile",
    chatGptHandoffState: () => "handoff",
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: string | null) => ({
    data: query === "auth" ? state.auth : query === "installation" ? state.installation : null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof state.commands) => state.commands[command],
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: vi.fn() } }),
}));
vi.mock("./ChatGptAccountPicker", () => ({ ChatGptAccountPicker: () => null }));
vi.mock("./ChatGptUsageButton", () => ({ ChatGptUsageButton: () => null }));
vi.mock("./ChatGptConnectionButton", () => ({
  ChatGptConnectionButton: (props: ComponentProps<"button">) => (
    <button
      {...props}
      ref={(element) => {
        if (element) return state.publishButton(element, props);
      }}
    />
  ),
}));
vi.mock("../ui/button", async (original) => {
  const actual = await original<typeof import("../ui/button")>();
  return {
    ...actual,
    Button: (props: ComponentProps<"button">) => (
      <actual.Button
        {...props}
        ref={(element) => {
          if (element) return state.publishButton(element, props);
        }}
      />
    ),
  };
});

import { CodexSetupSection } from "./CodexSetupSection";

const environmentId = EnvironmentId.make("paired-remote");
const instanceId = ProviderInstanceId.make("codex_work");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-10-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  setup: { canAuthenticate: true, canInstall: true },
};

function button(_fixture: _Fixture, label: string) {
  return [..._fixture.container.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  )!;
}
function retainedClick(_fixture: _Fixture, element: HTMLButtonElement) {
  const handler = _fixture.buttons.get(element)?.onClick;
  expect(handler).toBeTypeOf("function");
  return () => handler!({} as import("react").MouseEvent<HTMLButtonElement>);
}

async function renderSetup(
  _fixture: _Fixture,
  options: {
    readOnly: boolean;
    autoStart?: boolean;
    mode?: "managed" | "existing";
    onAutoStartConsumed?: () => void;
  },
) {
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
  await _fixture.root0.rerender(
    <CodexSetupSection
      environmentId={environmentId}
      instanceId={instanceId}
      provider={provider}
      mode={options.mode ?? "managed"}
      enabled
      readOnly={options.readOnly}
      presentation="onboarding"
      {...(options.autoStart === undefined ? {} : { autoStart: options.autoStart })}
      {...(options.onAutoStartConsumed === undefined
        ? {}
        : { onAutoStartConsumed: options.onAutoStartConsumed })}
      onModeChange={vi.fn()}
    />,
  );
}

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.container = document.createElement("div");
  document.body.append(_fixture.container);
  _fixture.stack.use(_fixtureStubGlobal("desktopBridge", undefined));
  const buttons = _fixture.buttons;
  state.publishButton = (element, props) => {
    buttons.set(element, props);
    return () => {
      buttons.delete(element);
    };
  };
  _fixture.stack.defer(() => {
    state.publishButton = () => undefined;
    buttons.clear();
  });
  state.canManageProviders = true;
  state.auth = null;
  state.installation = {
    driver: ProviderDriverKind.make("codex"),
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: null,
    version: null,
    installedVersion: null,
    canRemove: false,
    message: null,
  };
  for (const command of Object.values(state.commands)) command.mockReset();
}

async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0?.unmount());
  _fixture.root0 = undefined;
  _fixture.container.remove();
  vi.unstubAllGlobals();
}

// regression: 89974f96b6 fix(alignment): preserve Scient provider and lifecycle behavior
// (every case below).
describe("CodexSetupSection provider-management scope", () => {
  it("does not auto-start installation or consume the request while read-only", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onAutoStartConsumed = vi.fn();
    await act(
      async () =>
        await renderSetup(_fixture, { readOnly: true, autoStart: true, onAutoStartConsumed }),
    );

    expect(state.commands.startProviderInstall).not.toHaveBeenCalled();
    expect(state.commands.startProviderAuth).not.toHaveBeenCalled();
    expect(onAutoStartConsumed).not.toHaveBeenCalled();
  });

  it("rejects a retained setup click when the caller marks the component read-only", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(async () => await renderSetup(_fixture, { readOnly: true }));
    const setupButton = button(_fixture, "Continue with ChatGPT");

    expect(setupButton.disabled).toBe(true);
    await act(async () => retainedClick(_fixture, setupButton)());

    expect(state.commands.startProviderInstall).not.toHaveBeenCalled();
    expect(state.commands.startProviderAuth).not.toHaveBeenCalled();
  });

  it("rejects a retained setup click after providers:manage is revoked", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(async () => await renderSetup(_fixture, { readOnly: false }));
    const setupClick = retainedClick(_fixture, button(_fixture, "Continue with ChatGPT"));

    state.canManageProviders = false;
    await act(async () => setupClick());

    expect(state.commands.startProviderInstall).not.toHaveBeenCalled();
    expect(state.commands.startProviderAuth).not.toHaveBeenCalled();
  });

  it("rejects a retained authentication callback after providers:manage is revoked", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    state.auth = {
      instanceId,
      phase: "waiting",
      flowId: "flow-1",
      authorizationUrl: "https://accounts.example/authorize",
      expiresAt: "2026-10-10T00:05:00.000Z",
      message: null,
    };
    await act(async () => await renderSetup(_fixture, { readOnly: false }));

    const callbackInput = _fixture.container.querySelector<HTMLInputElement>(
      '[aria-label="ChatGPT sign-in redirect URL"]',
    )!;
    await userEvent.fill(callbackInput, "http://localhost/callback?code=test");
    const form = _fixture.container.querySelector("form")!;
    const submit = () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    state.canManageProviders = false;
    await act(async () => submit());

    expect(state.commands.completeProviderAuth).not.toHaveBeenCalled();
  });

  it("disables both mode choices when read-only and guards their callbacks", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onModeChange = vi.fn();
    await act(async () => {
      _fixture.root0 = _fixture.stack.use(
        await _fixtureRender(null, { container: _fixture.container, router: false }),
      );
      await _fixture.root0.rerender(
        <CodexSetupSection
          environmentId={environmentId}
          instanceId={instanceId}
          provider={provider}
          mode="existing"
          enabled
          readOnly
          presentation="onboarding"
          onModeChange={onModeChange}
        />,
      );
    });

    const useExisting = button(_fixture, "Use existing CLI");
    expect(useExisting.disabled).toBe(true);
    await act(async () => retainedClick(_fixture, useExisting)());
    expect(onModeChange).not.toHaveBeenCalled();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    buttons: new Map<HTMLButtonElement, ComponentProps<"button">>(),
    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
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

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
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  canManageProviders: true,
  buttons: new Map<HTMLButtonElement, ComponentProps<"button">>(),
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
  useEnvironmentScope: () => state.canManageProviders,
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
        if (element) state.buttons.set(element, props);
      }}
    />
  ),
}));
vi.mock("../ui/button", async (original) => ({
  ...(await original<typeof import("../ui/button")>()),
  Button: (props: ComponentProps<"button">) => (
    <button
      {...props}
      ref={(element) => {
        if (element) state.buttons.set(element, props);
      }}
    />
  ),
}));

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

let renderer: Root | undefined;
let container: HTMLDivElement;

function button(label: string) {
  return [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
}
function retainedClick(element: HTMLButtonElement) {
  const handler = state.buttons.get(element)?.onClick;
  expect(handler).toBeTypeOf("function");
  return () => handler!({} as import("react").MouseEvent<HTMLButtonElement>);
}

function renderSetup(options: {
  readOnly: boolean;
  autoStart?: boolean;
  mode?: "managed" | "existing";
  onAutoStartConsumed?: () => void;
}) {
  renderer = createRoot(container);
  renderer.render(
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  vi.stubGlobal("desktopBridge", undefined);
  state.buttons.clear();
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
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

describe("CodexSetupSection provider-management scope", () => {
  it("does not auto-start installation or consume the request while read-only", async () => {
    const onAutoStartConsumed = vi.fn();
    await act(async () => renderSetup({ readOnly: true, autoStart: true, onAutoStartConsumed }));

    expect(state.commands.startProviderInstall).not.toHaveBeenCalled();
    expect(state.commands.startProviderAuth).not.toHaveBeenCalled();
    expect(onAutoStartConsumed).not.toHaveBeenCalled();
  });

  it("rejects a retained setup click when the caller marks the component read-only", async () => {
    await act(async () => renderSetup({ readOnly: true }));
    const setupButton = button("Continue with ChatGPT");

    expect(setupButton.disabled).toBe(true);
    await act(async () => retainedClick(setupButton)());

    expect(state.commands.startProviderInstall).not.toHaveBeenCalled();
    expect(state.commands.startProviderAuth).not.toHaveBeenCalled();
  });

  it("rejects a retained setup click after providers:manage is revoked", async () => {
    await act(async () => renderSetup({ readOnly: false }));
    const setupClick = retainedClick(button("Continue with ChatGPT"));

    state.canManageProviders = false;
    await act(async () => setupClick());

    expect(state.commands.startProviderInstall).not.toHaveBeenCalled();
    expect(state.commands.startProviderAuth).not.toHaveBeenCalled();
  });

  it("rejects a retained authentication callback after providers:manage is revoked", async () => {
    state.auth = {
      instanceId,
      phase: "waiting",
      flowId: "flow-1",
      authorizationUrl: "https://accounts.example/authorize",
      expiresAt: "2026-10-10T00:05:00.000Z",
      message: null,
    };
    await act(async () => renderSetup({ readOnly: false }));

    const callbackInput = container.querySelector<HTMLInputElement>(
      '[aria-label="ChatGPT sign-in redirect URL"]',
    )!;
    await act(async () => userEvent.fill(callbackInput, "http://localhost/callback?code=test"));
    const form = container.querySelector("form")!;
    const submit = () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    state.canManageProviders = false;
    await act(async () => submit());

    expect(state.commands.completeProviderAuth).not.toHaveBeenCalled();
  });

  it("disables both mode choices when read-only and guards their callbacks", async () => {
    const onModeChange = vi.fn();
    await act(async () => {
      renderer = createRoot(container);
      renderer.render(
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

    const useExisting = button("Use existing CLI");
    expect(useExisting.disabled).toBe(true);
    await act(async () => retainedClick(useExisting)());
    expect(onModeChange).not.toHaveBeenCalled();
  });
});

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  canManageProviders: true,
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

vi.mock("../../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/session")>();
  return {
    ...actual,
    readEnvironmentScope: () => state.canManageProviders,
    useEnvironmentScope: () => state.canManageProviders,
  };
});
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
  ChatGptConnectionButton: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
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

let renderer: ReactTestRenderer | undefined;

function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}

function button(label: string) {
  return renderer!.root.findAllByType("button").find((node) => text(node) === label)!;
}

function renderSetup(options: {
  readOnly: boolean;
  autoStart?: boolean;
  mode?: "managed" | "existing";
  onAutoStartConsumed?: () => void;
}) {
  renderer = create(
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
  vi.stubGlobal("window", {
    location: { href: "https://remote.example/welcome", pathname: "/welcome", hash: "" },
    desktopBridge: undefined,
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
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
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

    expect(setupButton.props.disabled).toBe(true);
    await act(async () => setupButton.props.onClick());

    expect(state.commands.startProviderInstall).not.toHaveBeenCalled();
    expect(state.commands.startProviderAuth).not.toHaveBeenCalled();
  });

  it("rejects a retained setup click after providers:manage is revoked", async () => {
    await act(async () => renderSetup({ readOnly: false }));
    const setupClick = button("Continue with ChatGPT").props.onClick as () => void;

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

    const callbackInput = renderer!.root.findByProps({
      "aria-label": "ChatGPT sign-in redirect URL",
    });
    await act(async () =>
      callbackInput.props.onChange({ target: { value: "http://localhost/callback?code=test" } }),
    );
    const submit = renderer!.root.findByType("form").props.onSubmit as (event: {
      preventDefault: () => void;
    }) => void;

    state.canManageProviders = false;
    await act(async () => submit({ preventDefault: vi.fn() }));

    expect(state.commands.completeProviderAuth).not.toHaveBeenCalled();
  });

  it("disables both mode choices when read-only and guards their callbacks", async () => {
    const onModeChange = vi.fn();
    await act(async () => {
      renderer = create(
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
    expect(useExisting.props.disabled).toBe(true);
    await act(async () => useExisting.props.onClick());
    expect(onModeChange).not.toHaveBeenCalled();
  });
});

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const controller = vi.hoisted(() => ({
  disconnect: vi.fn(),
  startConnection: vi.fn(),
  startRuntime: vi.fn(),
}));
const controllerFactory = vi.hoisted(() => vi.fn(() => controller));
const enableState = vi.hoisted(() => ({
  access: "granted" as "granted" | "denied" | "pending",
  canEnable: true,
  enable: vi.fn<() => Promise<void>>(),
}));

function inlineSetup(name: string) {
  return (props: {
    readonly accountAction?: ReactNode;
    readonly managedRuntimePresentedExternally?: boolean;
    readonly onRepairSucceeded?: () => void;
  }) => (
    <div>
      {name} setup
      {props.managedRuntimePresentedExternally ? " · shared runtime" : null}
      {props.onRepairSucceeded ? " · repair callback" : null}
      {props.accountAction}
    </div>
  );
}

vi.mock("./useProviderLifecycleController", () => ({
  useProviderLifecycleController: controllerFactory,
}));
vi.mock("./useProviderEnableAction", () => ({
  useProviderEnableAction: () => enableState,
}));
vi.mock("./AntigravityInlineSetup", () => ({
  AntigravityInlineSetup: inlineSetup("Antigravity"),
}));
vi.mock("./ClaudeInlineSetup", () => ({ ClaudeInlineSetup: inlineSetup("Claude") }));
vi.mock("./CodexInlineSetup", () => ({ CodexInlineSetup: inlineSetup("Codex") }));
vi.mock("./CursorInlineSetup", () => ({ CursorInlineSetup: inlineSetup("Cursor") }));
vi.mock("./DroidInlineSetup", () => ({ DroidInlineSetup: inlineSetup("Droid") }));
vi.mock("./GrokInlineSetup", () => ({ GrokInlineSetup: inlineSetup("Grok") }));

import {
  AssistedProviderSetupHost,
  supportsAssistedProviderSetupSurface,
} from "./AssistedProviderSetupHost";

function provider(driver: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    displayName,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", required: true },
    checkedAt: "2026-08-24T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    connection: { methods: [], canDisconnect: true, operation: null },
  };
}

describe("AssistedProviderSetupHost", () => {
  beforeEach(() => {
    controllerFactory.mockClear();
    controller.disconnect.mockReset();
    controller.startConnection.mockReset();
    controller.startRuntime.mockReset();
    enableState.access = "granted";
    enableState.canEnable = true;
    enableState.enable.mockReset();
    enableState.enable.mockResolvedValue();
  });

  it.each([
    ["codex", "Codex"],
    ["claudeAgent", "Claude"],
    ["antigravity", "Antigravity"],
    ["cursor", "Cursor"],
    ["droid", "Droid"],
    ["grok", "Grok"],
  ] as const)("routes the %s composer surface through one controller", (driver, name) => {
    const value = provider(driver, name);
    const markup = renderToStaticMarkup(
      <AssistedProviderSetupHost
        displayName={name}
        environmentId={EnvironmentId.make("local")}
        provider={value}
        surface="composer"
      />,
    );

    expect(markup).toContain(`${name} setup`);
    expect(markup).not.toContain("shared runtime");
    expect(markup).not.toContain("Sign out");
    expect(controllerFactory).toHaveBeenCalledOnce();
  });

  it.each([
    ["codex", "Codex"],
    ["claudeAgent", "Claude"],
    ["antigravity", "Antigravity"],
    ["cursor", "Cursor"],
    ["droid", "Droid"],
    ["grok", "Grok"],
  ] as const)("keeps the %s management capabilities explicit", (driver, name) => {
    const markup = renderToStaticMarkup(
      <AssistedProviderSetupHost
        accountActionDisabled={false}
        displayName={name}
        environmentId={EnvironmentId.make("local")}
        managedRuntimePresentedExternally
        onAccountActionPendingChange={vi.fn()}
        onRepairSucceeded={vi.fn()}
        provider={provider(driver, name)}
        surface="management"
      />,
    );

    expect(markup).toContain(`${name} setup`);
    expect(markup).toContain("shared runtime");
    expect(markup).toContain("repair callback");
    expect(markup).toContain("Sign out");
    expect(controllerFactory).toHaveBeenCalledOnce();
  });

  it("shows the shared sign-out action only when the provider advertises it", () => {
    const unauthenticated = provider("codex", "Codex");
    const markup = renderToStaticMarkup(
      <AssistedProviderSetupHost
        accountActionDisabled={false}
        displayName="Codex"
        environmentId={EnvironmentId.make("local")}
        managedRuntimePresentedExternally
        onAccountActionPendingChange={vi.fn()}
        onRepairSucceeded={vi.fn()}
        provider={{
          ...unauthenticated,
          auth: { status: "unauthenticated", required: true },
        }}
        surface="management"
      />,
    );

    expect(markup).not.toContain("Sign out");
  });

  it.each([
    ["codex", "Codex"],
    ["claudeAgent", "Claude"],
    ["antigravity", "Antigravity"],
    ["cursor", "Cursor"],
    ["droid", "Droid"],
    ["grok", "Grok"],
  ] as const)("owns the disabled %s state instead of delegating it", (driver, name) => {
    controllerFactory.mockClear();
    const markup = renderToStaticMarkup(
      <AssistedProviderSetupHost
        displayName={name}
        environmentId={EnvironmentId.make("local")}
        provider={{ ...provider(driver, name), enabled: false }}
        surface="composer"
      />,
    );

    expect(markup).toContain(`${name} is disabled`);
    expect(markup).toContain(">Enable<");
    expect(markup).toContain("lucide-power");
    expect(markup).toContain("border-transparent");
    expect(markup).toContain("text-primary");
    expect(markup).not.toContain("text-primary-foreground");
    expect(markup).not.toContain(`${name} setup`);
    expect(controllerFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["codex", "Codex"],
    ["claudeAgent", "Claude"],
    ["antigravity", "Antigravity"],
    ["cursor", "Cursor"],
    ["droid", "Droid"],
    ["grok", "Grok"],
  ] as const)("shows only a spinner while the enabled %s probe settles", (driver, name) => {
    controllerFactory.mockClear();
    const markup = renderToStaticMarkup(
      <AssistedProviderSetupHost
        displayName={name}
        environmentId={EnvironmentId.make("local")}
        provider={{ ...provider(driver, name), installed: false, probePending: true }}
        surface="composer"
      />,
    );

    expect(markup).toContain(`aria-label="Checking ${name} status"`);
    expect(markup).toContain("lucide-loader");
    expect(markup).not.toContain(`${name} setup`);
    expect(markup).not.toContain("Checking provider");
    expect(controllerFactory).not.toHaveBeenCalled();
  });

  it("explains read-only access without offering a broken enable action", () => {
    enableState.access = "denied";
    enableState.canEnable = false;
    const markup = renderToStaticMarkup(
      <AssistedProviderSetupHost
        displayName="Droid"
        environmentId={EnvironmentId.make("remote")}
        provider={{ ...provider("droid", "Droid"), enabled: false }}
        surface="composer"
      />,
    );

    expect(markup).toContain("can view Droid, but cannot enable it");
    expect(markup).not.toContain(">Enable<");
  });

  it("keeps unsupported providers on the generic fallback", () => {
    expect(
      supportsAssistedProviderSetupSurface(ProviderDriverKind.make("antigravity"), "composer"),
    ).toBe(true);
    expect(
      supportsAssistedProviderSetupSurface(ProviderDriverKind.make("antigravity"), "management"),
    ).toBe(true);
    expect(
      supportsAssistedProviderSetupSurface(ProviderDriverKind.make("opencode"), "composer"),
    ).toBe(false);

    const antigravityMarkup = renderToStaticMarkup(
      <AssistedProviderSetupHost
        accountActionDisabled={false}
        displayName="Antigravity"
        environmentId={EnvironmentId.make("local")}
        managedRuntimePresentedExternally
        onAccountActionPendingChange={vi.fn()}
        onRepairSucceeded={vi.fn()}
        provider={provider("antigravity", "Antigravity")}
        surface="management"
      />,
    );
    const unsupportedMarkup = renderToStaticMarkup(
      <AssistedProviderSetupHost
        displayName="OpenCode"
        environmentId={EnvironmentId.make("local")}
        provider={provider("opencode", "OpenCode")}
        surface="composer"
      />,
    );

    expect(antigravityMarkup).toContain("Antigravity setup");
    expect(antigravityMarkup).toContain("shared runtime");
    expect(antigravityMarkup).toContain("Sign out");
    expect(unsupportedMarkup).toBe("");
    expect(controllerFactory).toHaveBeenCalledOnce();
  });
});

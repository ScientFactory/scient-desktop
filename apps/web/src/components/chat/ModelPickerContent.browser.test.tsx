import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionMethod,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
} from "../../hooks/useSettings";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";
import { ModelPickerContent } from "./ModelPickerContent";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  AssistedProviderSetupHost,
  supportsAssistedProviderSetupSurface,
} from "../../scient/providerConnection/AssistedProviderSetupHost";

// Only the command boundary is fake: the picker, host, and all provider views are real.
const commands = vi.hoisted(() => ({
  startConnection: vi.fn(),
  planRuntime: vi.fn(),
  cancelRuntime: vi.fn(),
  accountCommand: vi.fn(),
}));
vi.mock("../../scient/providerConnection/useProviderLifecycleController", () => ({
  useProviderLifecycleController: () => ({
    ...commands,
    startRuntime: vi.fn(),
    cancelConnection: vi.fn(),
    submitAuthorizationCode: vi.fn(),
    disconnect: vi.fn(),
    openAuthorizationPage: vi.fn(),
    updateExternalRuntime: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => commands.accountCommand }));

const DRIVERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "droid",
  "grok",
  "antigravity",
  "scient",
  "omp",
  "pi",
] as const;
const METHODS: Record<(typeof DRIVERS)[number], ProviderConnectionMethod[]> = {
  codex: ["codex_browser"],
  claudeAgent: ["claude_subscription"],
  cursor: ["cursor_browser"],
  droid: ["droid_device_pairing"],
  grok: ["grok_account"],
  antigravity: ["antigravity_google"],
  scient: [],
  omp: [],
  pi: [],
};
function snapshot(driver: (typeof DRIVERS)[number], installed = false): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(`${driver}_work`),
    driver: ProviderDriverKind.make(driver),
    displayName: driver,
    enabled: true,
    installed,
    version: installed ? "1.0.0" : null,
    status: "warning",
    auth: {
      status: installed ? "unauthenticated" : "unknown",
      required: METHODS[driver].length > 0,
    },
    checkedAt: "2026-10-08T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    setup: { canInstall: true, canAuthenticate: METHODS[driver].length > 0 },
    connection: {
      methods: METHODS[driver],
      canDisconnect: false,
      operation: null,
      runtime: {
        source: installed ? "scient_managed" : "missing",
        supportTier: "fully_assisted",
        target: "darwin-arm64",
        actions: installed ? ["repair", "remove"] : ["install"],
        managedVersion: installed ? "1.0.0" : null,
        previousManagedVersion: null,
        operation: null,
        message: "Synthetic runtime state",
      },
    },
  };
}
let host: HTMLDivElement;
let root: Root;
const selectModel = vi.fn();
function render(
  provider: ServerProvider,
  options = provider.models,
  locked = false,
  providers = [provider],
) {
  if (!host) {
    host = document.createElement("div");
    host.style.padding = "16px";
    document.body.append(host);
    root = createRoot(host);
  }
  root.render(
    <ModelPickerContent
      activeInstanceId={provider.instanceId}
      model="model-0"
      lockedProvider={locked ? provider.driver : null}
      instanceEntries={deriveProviderInstanceEntries(providers)}
      modelOptionsByInstance={new Map([[provider.instanceId, options]])}
      terminalOpen={false}
      onInstanceModelChange={selectModel}
      isProviderSetupAvailable={(entry) =>
        entry.enabled &&
        entry.isAvailable &&
        supportsAssistedProviderSetupSurface(entry.driverKind, "composer")
      }
      renderProviderSetup={(entry) => (
        <AssistedProviderSetupHost
          environmentId={EnvironmentId.make("synthetic")}
          provider={entry.snapshot}
          displayName={entry.displayName}
          surface="composer"
        />
      )}
    />,
  );
}
afterEach(() => {
  root?.unmount();
  host?.remove();
  host = undefined!;
  root = undefined!;
  __resetClientSettingsPersistenceForTests();
  vi.clearAllMocks();
});
function reachable(button: HTMLElement) {
  const box = button.getBoundingClientRect();
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  return box.width > 0 && box.height > 0 && (hit === button || button.contains(hit));
}
async function setupButton() {
  await expect
    .poll(() =>
      host.querySelector<HTMLElement>("[data-provider-onboarding-view] button:not(:disabled)"),
    )
    .toBeTruthy();
  const button = host.querySelector<HTMLElement>(
    "[data-provider-onboarding-view] button:not(:disabled)",
  )!;
  await expect.poll(() => reachable(button)).toBe(true);
  return button;
}

describe("actual picker provider setup", () => {
  it.each(DRIVERS)("keeps %s installation visible with no model rows", async (driver) => {
    await page.viewport(1280, 720);
    render(snapshot(driver));
    await setupButton();
    expect(host.querySelector("[data-model-picker-models]")).toBeNull();
    expect(commands.planRuntime).not.toHaveBeenCalled();
    expect(commands.startConnection).not.toHaveBeenCalled();
  });

  it.each(DRIVERS)("keeps %s model connection visible after installation", async (driver) => {
    render(snapshot(driver, true));
    await setupButton();
  });

  it("centers setup beside the full provider rail without relying on model rows", async () => {
    await page.viewport(1280, 720);
    const providers = DRIVERS.map((driver) => snapshot(driver));
    render(providers[0]!, [], false, providers);
    await setupButton();
    const body = host.querySelector<HTMLElement>("[data-model-picker-setup]")!;
    const frame = body.querySelector<HTMLElement>("[data-provider-onboarding-view]")!;
    await expect.poll(() => frame.getBoundingClientRect().height).toBeGreaterThan(200);
    expect(
      Math.abs(frame.getBoundingClientRect().height - body.getBoundingClientRect().height),
    ).toBeLessThan(2);
  });

  it("opens the active Scient setup rather than unrelated favorites", async () => {
    const provider = snapshot("scient");
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [{ provider: ProviderInstanceId.make("codex"), model: "cached-model" }],
    });
    render(provider);
    await setupButton();
  });

  it("starts Cursor browser sign-in once from the reachable button", async () => {
    const provider = snapshot("cursor", true);
    commands.startConnection.mockResolvedValue(provider);
    render(provider);
    const button = await setupButton();
    await page.getByRole("button", { name: button.textContent!.trim(), exact: true }).click();
    expect(commands.startConnection).toHaveBeenCalledExactlyOnceWith("cursor_browser");
  });

  it("remounts and remeasures models after setup, then reveals sign-in with cached models", async () => {
    const provider = snapshot("cursor", true);
    render(provider);
    await setupButton();
    const models = Array.from({ length: 30 }, (_, i) => ({
      slug: `model-${i}`,
      name: `Model ${i}`,
      isCustom: false,
      capabilities: null,
    }));
    const ready = {
      ...provider,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      models,
    };
    render(ready);
    await expect
      .poll(
        () => host.querySelector("[data-model-picker-models]")?.getBoundingClientRect().height ?? 0,
      )
      .toBeGreaterThan(100);
    expect(host.querySelector("[data-model-picker-setup]")).toBeNull();
    await page.getByText("Model 0", { exact: true }).click();
    expect(selectModel).toHaveBeenCalledExactlyOnceWith(provider.instanceId, "model-0");
    render({ ...ready, auth: { status: "unauthenticated" } });
    await setupButton();
    render({ ...ready, models: models.slice(0, 1) });
    await expect
      .poll(
        () => host.querySelector("[data-model-picker-models]")?.getBoundingClientRect().height ?? 0,
      )
      .toBeGreaterThan(30);
    await expect
      .poll(
        () =>
          host.querySelector("[data-model-picker-models]")?.getBoundingClientRect().height ?? 999,
      )
      .toBeLessThan(100);
  });

  it("offers Scient Agent accounts and keeps the same dialog during browser wait", async () => {
    const base = snapshot("scient", true);
    const provider: ServerProvider = {
      ...base,
      connection: {
        ...base.connection!,
        accounts: [
          {
            id: "openai-codex",
            name: "ChatGPT Plus/Pro",
            kind: "account",
            connected: false,
            canDisconnect: false,
          },
        ],
      },
    };
    commands.accountCommand.mockResolvedValue({
      _tag: "Success",
      value: { providers: [provider] },
    });
    render(provider);
    await setupButton();
    expect(commands.accountCommand).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Connect models", exact: true }).click();
    await expect
      .poll(() => document.querySelector("[role=dialog]")?.textContent)
      .toContain("ChatGPT Plus/Pro");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    expect(commands.accountCommand).toHaveBeenCalledExactlyOnceWith({
      environmentId: EnvironmentId.make("synthetic"),
      input: {
        instanceId: provider.instanceId,
        method: "scient_agent_account",
        account: "openai-codex",
      },
    });
    const waiting: ServerProvider = {
      ...provider,
      connection: {
        ...base.connection!,
        accountOperation: {
          operationId: "account-1",
          method: "scient_agent_account",
          account: "openai-codex",
          status: "waiting_for_browser",
          startedAt: provider.checkedAt,
          finishedAt: null,
          message: "Finish signing in securely in your browser.",
        },
      },
    };
    render(waiting);
    await expect
      .poll(() => document.querySelector("[role=dialog]")?.textContent)
      .toContain("Finish signing in securely");
    expect(document.querySelector("[role=dialog]")?.textContent).toContain("Cancel");
    expect(commands.accountCommand).toHaveBeenCalledTimes(1);
  });

  it("does not turn hidden ready models into installation or sign-in", async () => {
    const provider = snapshot("cursor", true);
    render(
      {
        ...provider,
        status: "ready",
        auth: { status: "authenticated" },
        models: [{ slug: "hidden", name: "Hidden", isCustom: false, capabilities: null }],
      },
      [],
    );
    await expect.poll(() => host.querySelector("[data-model-picker-models]")).toBeTruthy();
    expect(host.querySelector("[data-model-picker-setup]")).toBeNull();
  });

  it("keeps long setup scrollable within a short viewport", async () => {
    await page.viewport(380, 240);
    const provider = snapshot("cursor", true);
    const installing: ServerProvider = {
      ...provider,
      connection: {
        ...provider.connection!,
        runtime: {
          ...provider.connection!.runtime!,
          operation: {
            operationId: "install-1",
            action: "install",
            status: "downloading",
            startedAt: provider.checkedAt,
            finishedAt: null,
            message: "Downloading the verified runtime. ".repeat(30),
            downloadedBytes: 1,
            totalBytes: 100,
          },
        },
      },
    };
    render(installing);
    await expect
      .poll(() => host.querySelector<HTMLElement>("[data-model-picker-setup]"))
      .toBeTruthy();
    const body = host.querySelector<HTMLElement>("[data-model-picker-setup]")!;
    await expect.poll(() => body.scrollHeight > body.clientHeight).toBe(true);
    const button = body.querySelector<HTMLElement>("button")!;
    button.scrollIntoView({ block: "nearest" });
    await expect.poll(() => reachable(button)).toBe(true);
    expect(
      host.querySelector("[data-model-picker-content]")!.getBoundingClientRect().height,
    ).toBeLessThanOrEqual(240);
    await page.viewport(1280, 720);
  });
});

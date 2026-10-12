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
import { useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { ConnectModelsButton } from "../../scient/providerConnection/ConnectModelsButton";
import { CustomModelConnectionDialog } from "../settings/CustomModelConnectionDialog";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { ModelPickerContent } from "./ModelPickerContent";
import { ProviderModelPicker } from "./ProviderModelPicker";
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
  composed = false,
  environmentId = EnvironmentId.make("synthetic"),
  customSetup?: ReactNode,
) {
  if (!host) {
    host = document.createElement("div");
    host.style.padding = "16px";
    document.body.append(host);
    root = createRoot(host);
  }
  const Picker = composed ? ProviderModelPicker : ModelPickerContent;
  root.render(
    <Picker
      {...(composed ? { triggerAriaLabel: "Choose test model" } : {})}
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
      renderProviderSetup={(entry) =>
        customSetup ?? (
          <AssistedProviderSetupHost
            environmentId={environmentId}
            provider={entry.snapshot}
            displayName={entry.displayName}
            surface="composer"
          />
        )
      }
    />,
  );
}
afterEach(() => {
  root?.unmount();
  host?.remove();
  host = undefined!;
  root = undefined!;
  document.documentElement.classList.remove("dark");
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
      document.querySelector<HTMLElement>("[data-provider-onboarding-view] button:not(:disabled)"),
    )
    .toBeTruthy();
  const button = document.querySelector<HTMLElement>(
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

const saveCustomModel = vi.fn(async () => {});
function NestedCustomSetup() {
  const [managing, setManaging] = useState(false);
  return (
    <ConnectModelsButton
      environmentId={EnvironmentId.make("synthetic")}
      instanceId={ProviderInstanceId.make("pi_work")}
      accountContent={
        <>
          <Button onClick={() => setManaging(true)}>Manage synthetic connection</Button>
          {managing ? (
            <CustomModelConnectionDialog
              connection={{
                id: "synthetic-connection",
                name: "Synthetic connection",
                protocol: "openai-completions",
                baseUrl: `https://example.test/${"long-endpoint/".repeat(60)}`,
                credentialId: null,
                apiKeySuffix: null,
                models: [],
              }}
              revision={1}
              onSave={saveCustomModel}
              onDelete={() => {}}
              onClose={() => setManaging(false)}
            />
          ) : null}
        </>
      }
    />
  );
}
function longAccounts(): ServerProvider {
  const base = snapshot("scient", true);
  return {
    ...base,
    connection: {
      ...base.connection!,
      accounts: Array.from({ length: 40 }, (_, i) => ({
        id: `account-${i}`,
        name: `Synthetic account ${i}`,
        kind: i < 25 ? "account" : "key",
        connected: i === 0,
        canDisconnect: i === 0,
      })),
    },
  };
}
async function openComposed(provider: ServerProvider) {
  render(provider, provider.models, false, [provider], true);
  await page.getByRole("button", { name: "Choose test model", exact: true }).click();
  await setupButton();
  await page.getByRole("button", { name: "Connect models", exact: true }).click();
  await expect.poll(() => document.querySelector("[data-slot=dialog-popup]")).toBeTruthy();
  await expect
    .poll(() => document.querySelector("[data-slot=dialog-popup]")?.textContent)
    .toContain(provider.driver === "scient" ? "Model accounts" : "Custom models");
  return document.querySelector<HTMLElement>("[data-slot=dialog-popup]")!;
}
function scrollEvent(target: Element, type: "wheel" | "touchmove") {
  const event =
    type === "wheel"
      ? new WheelEvent(type, { bubbles: true, cancelable: true, deltaY: 120 })
      : new Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}
describe("composed picker Connect models overlay", () => {
  it("allows portaled account scrolling while refusing background wheel and touch", async () => {
    const dialog = await openComposed(longAccounts());
    const list = dialog.querySelector<HTMLElement>(
      "section[aria-label='Model accounts'] .overflow-y-auto",
    )!;
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    await userEvent.wheel(list, { delta: { y: 150 } });
    await expect.poll(() => list.scrollTop).toBeGreaterThan(0);
    for (const type of ["wheel", "touchmove"] as const) {
      expect(scrollEvent(host, type)).toBe(true);
      expect(scrollEvent(list, type)).toBe(false);
    }
  });
  it("keeps the dialog above the parent card and returns focus through nested Escape", async () => {
    const provider = longAccounts();
    commands.accountCommand.mockResolvedValue({
      _tag: "Success",
      value: { providers: [provider] },
    });
    const dialog = await openComposed(provider);
    const search = dialog.querySelector<HTMLInputElement>("input[type=search]")!;
    await expect.poll(() => reachable(search)).toBe(true);
    const close = dialog.querySelector<HTMLElement>("button[aria-label=Close]")!;
    await expect.poll(() => reachable(close)).toBe(true);
    const picker = document.querySelector<HTMLElement>("[data-model-picker-content]")!;
    expect(getComputedStyle(picker).visibility).toBe("hidden");
    await page
      .getByRole("searchbox", { name: "Search model accounts" })
      .fill("Synthetic account 39");
    expect(commands.accountCommand).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Add key", exact: true }).click();
    expect(commands.accountCommand).toHaveBeenCalledExactlyOnceWith({
      environmentId: EnvironmentId.make("synthetic"),
      input: {
        instanceId: ProviderInstanceId.make("scient_work"),
        method: "scient_agent_account",
        account: "account-39",
      },
    });
    await page.getByRole("searchbox", { name: "Search model accounts" }).fill("");
    await page.getByRole("searchbox", { name: "Search model accounts" }).click();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector("[data-slot=dialog-popup]")).toBeNull();
    await expect.poll(() => getComputedStyle(picker).visibility).toBe("visible");
    await expect.poll(() => document.activeElement?.textContent).toContain("Connect models");
    await userEvent.keyboard("{Escape}");
    await expect
      .poll(() => document.activeElement?.getAttribute("aria-label"))
      .toBe("Choose test model");
  });
  it.each(["pi", "omp", "droid"] as const)(
    "suspends %s setup through a ready catalog and closes its dialog",
    async (driver) => {
      await page.viewport(380, 480);
      document.documentElement.classList.add("dark");
      const provider = { ...snapshot(driver, true), auth: { status: "authenticated" as const } };
      const dialog = await openComposed(provider);
      const close = dialog.querySelector<HTMLElement>("button[aria-label=Close]")!;
      await expect.poll(() => reachable(close)).toBe(true);
      expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(380);
      const ready: ServerProvider = {
        ...provider,
        status: "ready",
        models: [
          { slug: "custom-model", name: "Custom model", isCustom: true, capabilities: null },
        ],
      };
      render(ready, ready.models, false, [ready], true);
      await expect.poll(() => document.querySelector("[data-slot=dialog-popup]")).toBe(dialog);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect.poll(() => document.querySelector("[data-slot=dialog-popup]")).toBeNull();
      await expect.poll(() => document.querySelector("[data-model-picker-models]")).toBeTruthy();
      expect(commands.startConnection).not.toHaveBeenCalled();
      expect(commands.accountCommand).not.toHaveBeenCalled();
      await page.viewport(1280, 720);
    },
  );
  it("resets the dialog when execution environment identity changes", async () => {
    await page.viewport(1280, 720);
    const provider = longAccounts();
    await openComposed(provider);
    await page.getByRole("searchbox", { name: "Search model accounts" }).fill("account 39");
    render(
      provider,
      provider.models,
      false,
      [provider],
      true,
      EnvironmentId.make("another-synthetic"),
    );
    await expect.poll(() => document.querySelector("[data-slot=dialog-popup]")).toBeNull();
    expect(commands.accountCommand).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Connect models", exact: true }).click();
    await expect
      .poll(
        () =>
          document.querySelector<HTMLInputElement>("[data-slot=dialog-popup] input[type=search]")
            ?.value,
      )
      .toBe("");
  });
  it("allows a nested production custom-model editor portal without admitting background scrolling", async () => {
    await page.viewport(380, 480);
    const provider = snapshot("pi", true);
    render(
      provider,
      [],
      false,
      [provider],
      true,
      EnvironmentId.make("synthetic"),
      <NestedCustomSetup />,
    );
    await page.getByRole("button", { name: "Choose test model", exact: true }).click();
    await page.getByRole("button", { name: "Connect models", exact: true }).click();
    await page.getByRole("button", { name: "Manage synthetic connection", exact: true }).click();
    await expect.poll(() => document.querySelectorAll("[data-slot=dialog-popup]").length).toBe(2);
    const nested = [...document.querySelectorAll<HTMLElement>("[data-slot=dialog-popup]")].at(-1)!;
    const viewport = nested.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    for (const type of ["wheel", "touchmove"] as const) {
      expect(scrollEvent(viewport, type)).toBe(false);
      expect(scrollEvent(host, type)).toBe(true);
    }
    await userEvent.wheel(viewport, { delta: { y: 150 } });
    await expect.poll(() => viewport.scrollTop).toBeGreaterThan(0);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelectorAll("[data-slot=dialog-popup]").length).toBe(1);
    expect(saveCustomModel).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelectorAll("[data-slot=dialog-popup]").length).toBe(0);
    await page.viewport(1280, 720);
  });
  it("retains an operation draft and search across ready snapshot updates", async () => {
    const base = longAccounts();
    const provider: ServerProvider = {
      ...base,
      connection: {
        ...base.connection!,
        accountOperation: {
          operationId: "synthetic-operation",
          method: "scient_agent_account",
          account: "account-39",
          status: "waiting_for_browser",
          startedAt: base.checkedAt,
          finishedAt: null,
          message: "Synthetic sign-in",
          acceptsAuthorizationCode: true,
        },
      },
    };
    const dialog = await openComposed(provider);
    await page
      .getByLabelText("Answer for Synthetic account 39", { exact: true })
      .fill("synthetic-draft");
    const ready: ServerProvider = {
      ...provider,
      status: "ready",
      auth: { status: "authenticated" },
      models: [{ slug: "ready-model", name: "Ready model", isCustom: false, capabilities: null }],
    };
    const probing = { ...ready, probePending: true };
    render(probing, probing.models, false, [probing], true);
    await expect
      .poll(
        () =>
          document.querySelector<HTMLInputElement>("[data-slot=dialog-popup] input[type=password]")
            ?.value,
      )
      .toBe("synthetic-draft");
    render(ready, ready.models, false, [ready], true);
    await expect.poll(() => document.querySelector("[data-slot=dialog-popup]")).toBe(dialog);
    expect(dialog.querySelector<HTMLInputElement>("input[type=password]")?.value).toBe(
      "synthetic-draft",
    );
    expect(commands.accountCommand).not.toHaveBeenCalled();
    const completed = { ...ready, connection: { ...ready.connection!, accountOperation: null } };
    render(completed, completed.models, false, [completed], true);
    await expect.poll(() => document.querySelector("[data-slot=dialog-popup]")).toBe(dialog);
    await page.getByRole("searchbox", { name: "Search model accounts" }).fill("account 39");
    render(completed, completed.models, false, [completed], true);
    expect(dialog.querySelector<HTMLInputElement>("input[type=search]")?.value).toBe("account 39");
  });
});

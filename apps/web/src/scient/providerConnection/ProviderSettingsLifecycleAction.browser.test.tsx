import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

const commands = vi.hoisted(() => ({ plan: vi.fn(), start: vi.fn() }));

vi.mock("./useProviderLifecycleController", () => ({
  useProviderLifecycleController: () => ({
    planRuntime: commands.plan,
    startRuntime: commands.start,
  }),
}));

// Only the dialog is synthetic. The actual onboarding row and shared header
// consume streamed snapshots while this dialog mounts and unmounts.
vi.mock("./ProviderConnectionDialog", () => ({
  ProviderConnectionDialog: (props: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
  }) =>
    props.open ? (
      <section role="dialog" aria-label="Provider details">
        <button onClick={() => props.onOpenChange(false)}>Close details</button>
      </section>
    ) : null,
}));

import {
  GettingStartedAgentStep,
  ScientGettingStartedShell,
} from "../onboarding/ScientGettingStartedView";
import { ProviderSettingsLifecycleAction } from "./ProviderSettingsLifecycleAction";

function snapshot(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: false,
    version: null,
    status: "warning",
    auth: { status: "unauthenticated", required: true },
    checkedAt: "2026-10-08T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    connection: {
      methods: ["codex_browser"],
      canDisconnect: false,
      operation: null,
      runtime: {
        source: "missing",
        supportTier: "fully_assisted",
        target: "darwin-arm64",
        actions: ["install"],
        managedVersion: null,
        previousManagedVersion: null,
        operation: null,
        message: "Install available.",
      },
    },
  };
}

function operation(patch: Partial<ProviderRuntimeOperation>): ServerProvider {
  const value = snapshot();
  return {
    ...value,
    connection: {
      ...value.connection!,
      runtime: {
        ...value.connection!.runtime!,
        operation: {
          operationId: "runtime-1",
          action: "install",
          status: "downloading",
          startedAt: "2026-10-08T00:00:00.000Z",
          finishedAt: null,
          message: "Working.",
          downloadedBytes: 42,
          totalBytes: 100,
          ...patch,
        },
      },
    },
  };
}

function ProviderHeader(props: { readonly provider: ServerProvider }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ProviderSettingsLifecycleAction
        displayName="Codex"
        environmentId={EnvironmentId.make("local")}
        onManage={() => setOpen(true)}
        provider={props.provider}
      />
      {open ? (
        <section role="dialog" aria-label="Provider details">
          <button onClick={() => setOpen(false)}>Close details</button>
        </section>
      ) : null}
    </>
  );
}

const SURFACES = ["onboarding", "provider header"] as const;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

function renderSurface(surface: (typeof SURFACES)[number], provider: ServerProvider) {
  if (!host) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  flushSync(() => {
    root!.render(
      surface === "onboarding" ? (
        <ScientGettingStartedShell
          canGoBack={false}
          currentStep="agent"
          journey={["agent", "preferences", "start"]}
          onBack={() => undefined}
          onSkip={() => undefined}
        >
          <GettingStartedAgentStep
            canContinue={false}
            choices={[
              {
                driverKind: provider.driver,
                icon: () => null,
                label: "Codex",
                detail: "OpenAI · ChatGPT subscription",
                status: "Not installed",
                ready: false,
                actionable: true,
                entry: {
                  instanceId: provider.instanceId,
                  driverKind: provider.driver,
                  displayName: "Codex",
                  enabled: true,
                  installed: provider.installed,
                  status: provider.status,
                  isDefault: true,
                  isAvailable: true,
                  snapshot: provider,
                  models: [],
                },
              },
            ]}
            environmentId={EnvironmentId.make("local")}
            onContinue={() => undefined}
            onSelect={() => undefined}
            selectedEntry={null}
          />
        </ScientGettingStartedShell>
      ) : (
        <ProviderHeader provider={provider} />
      ),
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  commands.plan.mockResolvedValue({
    action: "install",
    target: "darwin-arm64",
    version: "0.161.0",
    downloadBytes: 100,
    sourceLabel: "Official release",
    catalogRevision: "test:1",
    message: "Ready to install.",
  });
  commands.start.mockResolvedValue(operation({ status: "preparing" }));
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

describe.each(SURFACES)("%s runtime progress", (surface) => {
  it("survives start acknowledgement, closing details and remount without another transaction", async () => {
    await page.viewport(1280, 800);
    renderSurface(surface, snapshot());
    await page.getByRole("button", { name: "Install Codex", exact: true }).click();
    await expect.poll(() => commands.start.mock.calls.length).toBe(1);

    // Acknowledgement ends local pending; canonical snapshots own ongoing progress.
    await commands.start.mock.results[0]!.value;
    renderSurface(surface, operation({}));
    await expect.element(page.getByLabelText("Download progress 42%")).toBeVisible();
    await page.getByRole("button", { name: "Installing Codex", exact: true }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Close details" }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

    renderSurface(surface, operation({ downloadedBytes: 73 }));
    await expect.element(page.getByLabelText("Download progress 73%")).toBeVisible();
    const manage = host!.querySelector<HTMLButtonElement>('button[aria-label="Manage Codex"]')!;
    expect(manage.textContent).not.toContain("Manage");
    expect(manage.disabled).toBe(false);

    flushSync(() => root!.unmount());
    root = createRoot(host!);
    renderSurface(surface, operation({ downloadedBytes: 73 }));
    await expect.element(page.getByLabelText("Download progress 73%")).toBeVisible();
    await page.getByRole("button", { name: "Manage Codex", exact: true }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Close details" }).click();

    renderSurface(surface, operation({ status: "testing" }));
    await expect.element(page.getByRole("button", { name: "Verifying Codex" })).toBeVisible();
    expect(host!.textContent).not.toContain("73%");
    for (const status of ["succeeded", "cancelled", "failed"] as const) {
      renderSurface(surface, operation({ status, finishedAt: "2026-10-08T00:01:00.000Z" }));
      expect(host!.querySelector('[role="status"]')).toBeNull();
      expect(host!.textContent).not.toContain("Verifying");
    }
    expect(commands.plan).toHaveBeenCalledTimes(1);
    expect(commands.start).toHaveBeenCalledTimes(1);
  });
});

it.each([1280, 390])(
  "keeps the shortened onboarding description and list compact at %spx",
  async (width) => {
    await page.viewport(width, 800);
    renderSurface("onboarding", snapshot());
    const description = host!.querySelector("header p")!;
    const list = host!.querySelector<HTMLElement>('[aria-label="AI providers"]')!;
    expect(description.textContent).toBe(
      "Use a ChatGPT, Claude, or Google subscription you already have.",
    );
    expect(getComputedStyle(list).marginTop).toBe("12px");
    expect(host!.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
    await expect.element(page.getByRole("button", { name: "Skip", exact: true })).toBeVisible();
  },
);

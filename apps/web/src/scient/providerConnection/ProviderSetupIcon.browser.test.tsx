import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimePlan,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({ plan: vi.fn(), start: vi.fn() }));

vi.mock("./useProviderLifecycleController", () => {
  const never = () => new Promise<never>(() => undefined);
  const controller = {
    startConnection: never,
    cancelConnection: never,
    submitAuthorizationCode: never,
    disconnect: never,
    openAuthorizationPage: never,
    planRuntime: runtime.plan,
    startRuntime: runtime.start,
    cancelRuntime: never,
    updateExternalRuntime: never,
    refresh: never,
  };
  return { useProviderLifecycleController: () => controller };
});
vi.mock("./useProviderEnableAction", () => ({
  useProviderEnableAction: () => ({ access: "granted", canEnable: true, enable: vi.fn() }),
}));

import { AssistedProviderSetupHost } from "./AssistedProviderSetupHost";

type Methods = NonNullable<ServerProvider["connection"]>["methods"];

const PROVIDERS: ReadonlyArray<readonly [driver: string, name: string, methods: Methods]> = [
  ["codex", "Codex", ["codex_browser"]],
  ["claudeAgent", "Claude", ["claude_subscription"]],
  ["cursor", "Cursor", ["cursor_browser"]],
  ["antigravity", "Antigravity", ["antigravity_google"]],
  ["droid", "Droid", ["droid_device_pairing"]],
  ["grok", "Grok", ["grok_account"]],
  ["pi", "Pi", []],
];

function snapshot(driver: string, name: string, methods: Methods): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    displayName: name,
    enabled: true,
    installed: true,
    version: "1.2.3",
    status: "warning",
    auth: { status: "unauthenticated", required: true },
    checkedAt: "2026-09-27T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    connection: {
      methods,
      canDisconnect: false,
      operation: null,
      runtime: {
        source: "scient_managed",
        supportTier: "fully_assisted",
        target: "darwin-arm64",
        actions: ["repair", "remove"],
        managedVersion: "1.2.3",
        previousManagedVersion: null,
        operation: null,
        message: `Scient is using its private ${name} runtime.`,
      },
    },
  };
}

function notInstalled(provider: ServerProvider): ServerProvider {
  return {
    ...provider,
    installed: false,
    version: null,
    auth: { status: "unknown", required: true },
    connection: {
      ...provider.connection!,
      runtime: {
        ...provider.connection!.runtime!,
        source: "missing",
        actions: ["install"],
        managedVersion: null,
      },
    },
  };
}

/** A system installation whose sign-in failed: the state that offers the switch inline. */
function signInFailedOnSystem(driver: string, name: string, methods: Methods): ServerProvider {
  const provider = snapshot(driver, name, methods);
  return {
    ...provider,
    version: "0.231.0",
    checkedAt: "2026-10-01T00:00:00.000Z",
    connection: {
      ...provider.connection!,
      operation: {
        operationId: `${driver}-sign-in`,
        method: methods[0]!,
        status: "failed",
        startedAt: "2026-10-01T00:00:00.000Z",
        finishedAt: "2026-10-01T00:00:00.000Z",
        message: "The sign-in window was closed.",
      },
      runtime: {
        source: "system",
        supportTier: "fully_assisted",
        target: "darwin-arm64",
        actions: ["install"],
        managedVersion: null,
        previousManagedVersion: null,
        operation: null,
        message: `Scient is using the healthy ${name} runtime already installed on this computer.`,
        diagnostics: {
          executable: `/usr/local/bin/${driver}`,
          version: "0.231.0",
          homePath: null,
          backend: "macOS native",
        },
      },
    },
  };
}

/** The composer's model picker marks its content; other hosts do not. */
function Container(props: { readonly picker: boolean; readonly children: ReactNode }) {
  return (
    <div
      className="flex h-86 w-90"
      data-container
      {...(props.picker ? { "data-model-picker-content": "true" } : {})}
    >
      {props.children}
    </div>
  );
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  runtime.plan.mockReset();
  runtime.start.mockReset();
});

const isVisible = (element: Element | null) =>
  element !== null && element.getBoundingClientRect().width > 0;
const visibleButton = (label: string) =>
  [...host!.querySelectorAll("button")].find(
    (button) => isVisible(button) && button.textContent!.trim() === label,
  );

describe.each(PROVIDERS)("%s setup mark", (driver, name, methods) => {
  const states = [
    ["install", notInstalled(snapshot(driver, name, methods))],
    ...(methods.length > 0 ? [["sign-in", snapshot(driver, name, methods)] as const] : []),
  ] as const;

  it.each(states)(
    "shows the provider logo in the model picker's %s state, and the shield elsewhere",
    async (_state, provider) => {
      for (const picker of [true, false]) {
        host = document.createElement("div");
        document.body.append(host);
        root = createRoot(host);
        root.render(
          <Container picker={picker}>
            <AssistedProviderSetupHost
              displayName={name}
              environmentId={EnvironmentId.make("local")}
              provider={provider}
              surface="composer"
            />
          </Container>,
        );
        await expect
          .poll(() => host!.querySelector("[data-assisted-setup-icon=true]"))
          .toBeTruthy();

        const logo = host.querySelector('[data-provider-setup-mark="logo"]');
        const shield = host.querySelector('[data-provider-setup-mark="shield"]');
        expect(isVisible(logo), `logo in ${picker ? "picker" : "other host"}`).toBe(picker);
        expect(isVisible(shield), `shield in ${picker ? "picker" : "other host"}`).toBe(!picker);
        if (picker) expect(logo!.querySelector("svg")!.getBoundingClientRect().width).toBe(32);

        root.unmount();
        host.remove();
        root = undefined;
        host = undefined;
      }
    },
  );
});

describe.each(PROVIDERS.filter(([, , methods]) => methods.length > 0))(
  "%s switch to an older Scient-managed release",
  (driver, name, methods) => {
    const provider = signInFailedOnSystem(driver, name, methods);
    const plan: ProviderRuntimePlan = {
      instanceId: provider.instanceId,
      action: "install",
      target: "darwin-arm64",
      version: "0.230.0",
      downloadBytes: null,
      sourceLabel: "Official release",
      catalogRevision: "reviewed:1:older-than-system",
      message: `Scient-managed ${name} 0.230.0 is older than your installed ${name} 0.231.0. Scient will use its own verified copy; your installation stays as it is. ${name} accounts in this environment that use the default runtime will use that copy; custom paths remain unchanged.`,
      systemVersion: "0.231.0",
      olderThanSystem: true,
    };

    it.each([true, false])(
      "shows the decision in place of the setup and fits its host (model picker: %s)",
      async (picker) => {
        runtime.plan.mockResolvedValue(plan);
        host = document.createElement("div");
        document.body.append(host);
        root = createRoot(host);
        root.render(
          <Container picker={picker}>
            <AssistedProviderSetupHost
              displayName={name}
              environmentId={EnvironmentId.make("local")}
              provider={provider}
              surface="composer"
            />
          </Container>,
        );
        await expect.poll(() => host!.textContent).toContain("The sign-in window was closed.");
        const useManaged = [...host.querySelectorAll("button")].find(
          (button) => button.textContent!.trim() === `Use Scient-managed ${name}`,
        )!;
        useManaged.click();

        await expect.poll(() => visibleButton("Back")).toBeTruthy();
        expect(runtime.start).not.toHaveBeenCalled();
        const frames = [...host.querySelectorAll("[data-provider-onboarding-view=assisted]")];
        const shown = frames.filter(isVisible);
        // One frame: the decision. The setup it replaced takes no space.
        expect(shown).toHaveLength(1);
        expect(frames).toHaveLength(2);
        expect(shown[0]!.textContent).toContain(`Use Scient-managed ${name} 0.230.0?`);
        expect(shown[0]!.textContent).toContain(plan.message);
        expect(shown[0]!.textContent).not.toContain("The sign-in window was closed.");

        const container = host.querySelector("[data-container]")!.getBoundingClientRect();
        for (const label of ["Back", "Use Scient-managed"]) {
          const box = visibleButton(label)!.getBoundingClientRect();
          expect(box.left, label).toBeGreaterThanOrEqual(container.left);
          expect(box.right, label).toBeLessThanOrEqual(container.right);
          expect(box.bottom, label).toBeLessThanOrEqual(container.bottom);
        }

        // Back returns to the setup as it was, with nothing started.
        visibleButton("Back")!.click();
        await expect.poll(() => host!.textContent).not.toContain(plan.message);
        expect(runtime.start).not.toHaveBeenCalled();
        const after = [...host.querySelectorAll("[data-provider-onboarding-view=assisted]")];
        expect(after.filter(isVisible)).toHaveLength(1);
        expect(after[0]!.textContent).toContain("The sign-in window was closed.");
      },
    );
  },
);

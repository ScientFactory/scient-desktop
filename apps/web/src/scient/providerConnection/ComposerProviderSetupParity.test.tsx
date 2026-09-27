// @vitest-environment happy-dom
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PROVIDER_ICON_BY_PROVIDER } from "../../components/chat/providerIconUtils";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

// The composer surface of every assisted provider, rendered through the same
// host the composer uses, so each lifecycle state can be compared across
// providers.
const controller = vi.hoisted((): ProviderLifecycleController => ({
  startConnection: vi.fn(),
  cancelConnection: vi.fn(),
  submitAuthorizationCode: vi.fn(),
  disconnect: vi.fn(),
  openAuthorizationPage: vi.fn(),
  planRuntime: vi.fn(),
  startRuntime: vi.fn(),
  cancelRuntime: vi.fn(),
  updateExternalRuntime: vi.fn(),
}));

vi.mock("./useProviderLifecycleController", () => ({
  useProviderLifecycleController: () => controller,
}));
vi.mock("./useProviderEnableAction", () => ({
  useProviderEnableAction: () => ({ access: "granted", canEnable: true, enable: vi.fn() }),
}));

import { AssistedProviderSetupHost } from "./AssistedProviderSetupHost";

type Runtime = NonNullable<NonNullable<ServerProvider["connection"]>["runtime"]>;
type Driver = (typeof DRIVERS)[number];

const T0 = "2026-09-27T10:00:00.000Z";
const SERVER_ERROR = "The private runtime could not start: the process exited with code 1.";
const INSTALL_ERROR = "Download failed: the release checksum did not match the reviewed catalog.";

const DRIVERS = [
  {
    driver: "codex",
    name: "Codex",
    methods: ["codex_browser", "codex_device_code"],
    auth: { status: "authenticated", required: true, email: "me@example.com" },
  },
  {
    driver: "claudeAgent",
    name: "Claude",
    methods: ["claude_subscription", "claude_console"],
    auth: { status: "authenticated", required: true, label: "Claude Max subscription" },
  },
  {
    driver: "cursor",
    name: "Cursor",
    methods: ["cursor_browser"],
    auth: { status: "authenticated", required: true, email: "me@example.com" },
  },
  {
    driver: "antigravity",
    name: "Antigravity",
    methods: ["antigravity_google"],
    auth: { status: "authenticated", required: true, email: "me@example.com" },
  },
  {
    driver: "droid",
    name: "Droid",
    methods: ["droid_device_pairing"],
    auth: { status: "authenticated", required: true, email: "me@example.com" },
  },
  {
    driver: "grok",
    name: "Grok",
    methods: ["grok_account", "grok_device_code"],
    auth: {
      status: "authenticated",
      required: true,
      type: "grok_account",
      email: "me@example.com",
    },
  },
  { driver: "pi", name: "Pi", methods: [], auth: { status: "unknown", required: false } },
] as const satisfies ReadonlyArray<{
  readonly driver: string;
  readonly name: string;
  readonly methods: NonNullable<ServerProvider["connection"]>["methods"];
  readonly auth: ServerProvider["auth"];
}>;
const ACCOUNT_DRIVERS = DRIVERS.filter((entry) => entry.methods.length > 0);

function ready(entry: Driver): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(entry.driver),
    driver: ProviderDriverKind.make(entry.driver),
    displayName: entry.name,
    enabled: true,
    installed: true,
    version: "1.2.3",
    status: "ready",
    auth: entry.auth,
    checkedAt: T0,
    models: [{ slug: "model-a", name: "Model A", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    connection: {
      methods: entry.methods,
      canDisconnect: entry.methods.length > 0,
      operation: null,
      runtime: {
        source: "scient_managed",
        supportTier: "fully_assisted",
        target: "darwin-arm64",
        actions: ["repair", "remove"],
        managedVersion: "1.2.3",
        previousManagedVersion: null,
        operation: null,
        message: `Scient is using its private ${entry.name} runtime.`,
        diagnostics: {
          executable: `/runtimes/${entry.driver}/1.2.3/bin/${entry.driver}`,
          version: "1.2.3",
          homePath: null,
          backend: "macOS native",
        },
      },
    },
  };
}

function withRuntime(provider: ServerProvider, patch: Partial<Runtime>): ServerProvider {
  return {
    ...provider,
    connection: {
      ...provider.connection!,
      runtime: { ...provider.connection!.runtime!, ...patch },
    },
  };
}

function notInstalled(entry: Driver): ServerProvider {
  return withRuntime(
    {
      ...ready(entry),
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown", required: entry.methods.length > 0 },
      models: [],
      message: `${entry.name} is not installed.`,
    },
    { source: "missing", actions: ["install"], managedVersion: null },
  );
}

function installFailed(entry: Driver): ServerProvider {
  return withRuntime(notInstalled(entry), {
    operation: {
      operationId: `${entry.driver}-install`,
      action: "install",
      status: "failed",
      startedAt: T0,
      finishedAt: T0,
      message: INSTALL_ERROR,
    },
  });
}

function installing(entry: Driver): ServerProvider {
  return withRuntime(notInstalled(entry), {
    operation: {
      operationId: `${entry.driver}-install`,
      action: "install",
      status: "downloading",
      startedAt: T0,
      finishedAt: null,
      message: `Downloading ${entry.name}…`,
      downloadedBytes: 42,
      totalBytes: 100,
    },
  });
}

function needsRepair(entry: Driver): ServerProvider {
  return {
    ...ready(entry),
    status: "error",
    auth: { status: "unknown", required: entry.methods.length > 0 },
    models: [],
    message: SERVER_ERROR,
  };
}

function managedUpdate(entry: Driver): ServerProvider {
  return withRuntime(ready(entry), {
    actions: ["update", "repair", "remove"],
    availableManagedVersion: "1.3.0",
  });
}

function failedOperation(
  entry: Driver,
  action: "install" | "update" | "repair",
  message: string,
): NonNullable<Runtime["operation"]> {
  return {
    operationId: `${entry.driver}-${action}-failed`,
    action,
    status: "failed",
    startedAt: T0,
    finishedAt: T0,
    message,
  };
}

function signIn(entry: Driver): ServerProvider {
  return {
    ...ready(entry),
    status: "warning",
    auth: { status: "unauthenticated", required: true },
    models: [],
  };
}

function signInFailed(entry: Driver): ServerProvider {
  const provider = signIn(entry);
  return {
    ...provider,
    connection: {
      ...provider.connection!,
      operation: {
        operationId: `${entry.driver}-sign-in`,
        method: entry.methods[0]!,
        status: "failed",
        startedAt: T0,
        finishedAt: T0,
        message: "The sign-in window was closed.",
      },
    },
  };
}

function markupFor(provider: ServerProvider): string {
  return renderToStaticMarkup(
    <AssistedProviderSetupHost
      displayName={provider.displayName!}
      environmentId={EnvironmentId.make("local")}
      provider={provider}
      surface="composer"
    />,
  );
}

function view(provider: ServerProvider): HTMLElement {
  const element = document.createElement("div");
  element.innerHTML = markupFor(provider);
  return element;
}

function buttonLabels(element: HTMLElement): string[] {
  return [...element.querySelectorAll("button")].map((button) => button.textContent!.trim());
}

/** Icons outside the status icon, actions and links: extra logos or title spinners. */
function strayIcons(element: HTMLElement): number {
  return [...element.querySelectorAll("svg")].filter(
    (svg) => !svg.closest("[data-assisted-setup-icon=true], button, a"),
  ).length;
}

type StatusIcon = "setup" | "spinner" | "check" | "warning" | "other";

/**
 * The kind of each status icon. `setup` is the provider setup mark: the
 * provider's logo in the model picker, a shield elsewhere (CSS picks one, so
 * markup carries both).
 */
function statusIcons(element: HTMLElement): StatusIcon[] {
  return [...element.querySelectorAll("[data-assisted-setup-icon=true]")].map((icon) => {
    if (icon.querySelector("[data-provider-setup-mark]")) return "setup";
    if (icon.querySelector(".animate-spin")) return "spinner";
    if (icon.querySelector(".lucide-circle-check")) return "check";
    if (icon.querySelector(".lucide-triangle-alert")) return "warning";
    return "other";
  });
}

/** The setup mark shows this provider's own logo, beside the fallback shield. */
function expectProviderLogo(element: HTMLElement, entry: Driver) {
  const Logo = PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make(entry.driver)]!;
  const logo = element.querySelector('[data-provider-setup-mark="logo"] svg');
  const expected = document.createElement("div");
  expected.innerHTML = renderToStaticMarkup(<Logo />);
  expect(logo?.getAttribute("viewBox")).toBe(expected.firstElementChild!.getAttribute("viewBox"));
  expect(logo?.innerHTML).toBe(expected.firstElementChild!.innerHTML);
  expect(element.querySelector('[data-provider-setup-mark="shield"]')).not.toBeNull();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(DRIVERS)("$name composer setup", (entry) => {
  it("shows a ready state with a check, no inline Repair and no extra marks", () => {
    const element = view(ready(entry));

    expect(element.textContent).toContain(`${entry.name} is ready`);
    expect(statusIcons(element)).toEqual(["check"]);
    expect(strayIcons(element)).toBe(0);
    expect(buttonLabels(element).filter((label) => /repair/i.test(label))).toEqual([]);
  });

  it("shows the provider logo while it waits for installation", () => {
    const element = view(notInstalled(entry));

    expect(element.textContent).toContain(`Install ${entry.name}`);
    expect(statusIcons(element)).toEqual(["setup"]);
    expectProviderLogo(element, entry);
    expect(strayIcons(element)).toBe(0);
  });

  it("shows installation progress with one spinner as its status icon", () => {
    const element = view(installing(entry));

    expect(element.textContent).toContain(`Installing ${entry.name}`);
    expect(statusIcons(element)).toEqual(["spinner"]);
    expect(element.querySelectorAll(".animate-spin")).toHaveLength(1);
    expect(strayIcons(element)).toBe(0);
    expect(buttonLabels(element)).toEqual(["Cancel"]);
  });

  it("offers a reviewed managed update as its primary action", () => {
    const element = view(managedUpdate(entry));

    expect(element.textContent).toContain(`${entry.name} update available`);
    // Droid and Pi add a quiet Connect models under it.
    expect(buttonLabels(element).filter((label) => label !== "Connect models")).toHaveLength(1);
  });

  it("shows a server-side installation failure with its error and a retry", () => {
    const element = view(installFailed(entry));

    expect(element.textContent).toContain(`${entry.name} installation couldn’t finish`);
    expect(element.textContent).toContain(INSTALL_ERROR);
    expect(element.querySelector('[role="alert"]')).not.toBeNull();
    expect(statusIcons(element)).toEqual(["warning"]);
    expect(buttonLabels(element)).toEqual(["Retry installation"]);
  });

  it("asks for repair with the server's error", () => {
    const element = view(needsRepair(entry));

    expect(element.textContent).toContain(`${entry.name} needs repair`);
    expect(element.textContent).toContain(SERVER_ERROR);
    expect(statusIcons(element)).toEqual(["warning"]);
    expect(strayIcons(element)).toBe(0);
    expect(buttonLabels(element)).toEqual([`Repair ${entry.name}`]);
  });

  it("keeps the server's error when an earlier runtime operation succeeded", () => {
    const element = view(
      withRuntime(needsRepair(entry), {
        operation: {
          operationId: `${entry.driver}-install`,
          action: "install",
          status: "succeeded",
          startedAt: T0,
          finishedAt: T0,
          message: `${entry.name} 1.2.3 was installed and verified.`,
        },
      }),
    );

    expect(element.textContent).toContain(SERVER_ERROR);
    expect(element.textContent).not.toContain("was installed and verified");
  });

  it("asks for repair with the server's error, not an earlier failed update or install", () => {
    for (const action of ["update", "install"] as const) {
      const element = view(
        withRuntime(needsRepair(entry), {
          operation: failedOperation(entry, action, `The earlier ${action} failed.`),
        }),
      );

      expect(element.textContent).toContain(`${entry.name} needs repair`);
      expect(element.textContent).toContain(SERVER_ERROR);
      expect(element.textContent).not.toContain(`The earlier ${action} failed.`);
    }
  });

  it("explains a failed repair in the repair frame", () => {
    const element = view(
      withRuntime(needsRepair(entry), {
        operation: failedOperation(entry, "repair", "The repaired runtime failed its smoke test."),
      }),
    );

    expect(element.textContent).toContain("The repaired runtime failed its smoke test.");
  });
});

describe.each(ACCOUNT_DRIVERS)("$name composer sign-in", (entry) => {
  it("shows the provider logo before sign-in", () => {
    const element = view(signIn(entry));

    expect(element.textContent).toContain("Sign in required");
    expect(statusIcons(element)).toEqual(["setup"]);
    expectProviderLogo(element, entry);
    expect(strayIcons(element)).toBe(0);
  });

  it("shows sign-in progress with one spinner as its status icon", () => {
    const provider = signIn(entry);
    const element = view({
      ...provider,
      connection: {
        ...provider.connection!,
        operation: {
          operationId: `${entry.driver}-sign-in`,
          method: entry.methods[0]!,
          status: "waiting_for_browser",
          startedAt: T0,
          finishedAt: null,
          message: "Complete sign-in in your browser.",
        },
      },
    });

    expect(statusIcons(element)).toEqual(["spinner"]);
    expect(element.querySelectorAll(".animate-spin")).toHaveLength(1);
    expect(strayIcons(element)).toBe(0);
  });
});

const UPDATING_DRIVERS = DRIVERS.filter(
  (entry) => entry.driver === "droid" || entry.driver === "grok",
);

describe.each(UPDATING_DRIVERS)("$name composer update", (entry) => {
  const externalUpdate = (): ServerProvider => ({
    ...withRuntime(ready(entry), { source: "system", actions: ["install"], managedVersion: null }),
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      updateCommand: `${entry.driver} update`,
      canUpdate: true,
      canInstallVersion: false,
      checkedAt: T0,
      message: `${entry.name} 1.3.0 is available.`,
    },
  });

  it("offers a managed and an external update with an Update action", () => {
    for (const provider of [managedUpdate(entry), externalUpdate()]) {
      const element = view(provider);
      expect(element.textContent).toContain(`${entry.name} update available`);
      expect(statusIcons(element)).toEqual(["other"]);
      expect(buttonLabels(element)[0]).toBe("Update");
    }
  });

  it("shows a running and a failed update", () => {
    const running = view({
      ...managedUpdate(entry),
      updateState: {
        status: "running",
        startedAt: T0,
        finishedAt: null,
        message: `Updating ${entry.name} to 1.3.0…`,
        output: null,
      },
    });
    const failed = view({
      ...managedUpdate(entry),
      updateState: {
        status: "failed",
        startedAt: T0,
        finishedAt: T0,
        message: "The updater exited with code 2.",
        output: null,
      },
    });

    expect(running.textContent).toContain(`Updating ${entry.name}`);
    expect(statusIcons(running)).toEqual(["spinner"]);
    expect(buttonLabels(running)).toEqual([]);
    expect(failed.textContent).toContain(`${entry.name} couldn’t be updated`);
    expect(failed.textContent).toContain("The updater exited with code 2.");
    expect(statusIcons(failed)).toEqual(["warning"]);
    expect(buttonLabels(failed)[0]).toBe("Try again");
  });

  describe("actions", () => {
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

    const clickUpdate = async (provider: ServerProvider) => {
      await act(() =>
        root.render(
          <AssistedProviderSetupHost
            displayName={entry.name}
            environmentId={EnvironmentId.make("local")}
            provider={provider}
            surface="composer"
          />,
        ),
      );
      const button = [...host.querySelectorAll("button")].find(
        (element) => element.textContent?.trim() === "Update",
      );
      await act(async () => button!.click());
    };

    it("plans and starts the reviewed managed update", async () => {
      const provider = managedUpdate(entry);
      const plan = {
        instanceId: provider.instanceId,
        action: "update" as const,
        target: "darwin-arm64",
        version: "1.3.0",
        downloadBytes: null,
        sourceLabel: "Official release",
        catalogRevision: "revision",
        message: `Update ${entry.name}.`,
      };
      vi.mocked(controller.planRuntime).mockResolvedValueOnce(plan);
      vi.mocked(controller.startRuntime).mockResolvedValueOnce(provider);

      await clickUpdate(provider);

      expect(controller.planRuntime).toHaveBeenCalledWith("update");
      expect(controller.startRuntime).toHaveBeenCalledWith(plan);
      expect(controller.updateExternalRuntime).not.toHaveBeenCalled();
    });

    it("runs the external installation's own updater", async () => {
      const provider = externalUpdate();
      vi.mocked(controller.updateExternalRuntime).mockResolvedValueOnce(provider);

      await clickUpdate(provider);

      expect(controller.updateExternalRuntime).toHaveBeenCalledOnce();
      expect(controller.planRuntime).not.toHaveBeenCalled();
    });
  });
});

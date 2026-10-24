import type { ReactNode } from "react";
import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";

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
  signInKey: {
    environmentId: "environment-test",
    instanceId: "sign-in-test",
  } as ProviderLifecycleController["signInKey"],
  openAuthorizationPage: vi.fn(),
  planRuntime: vi.fn(),
  startRuntime: vi.fn(),
  cancelRuntime: vi.fn(),
  updateExternalRuntime: vi.fn(),
  refresh: vi.fn(),
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
/** Antigravity's composer offers only reviewed managed updates. */
const EXTERNAL_UPDATE_DRIVERS = DRIVERS.filter((entry) => entry.driver !== "antigravity");

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

function externalUpdate(
  entry: Driver,
  updateState?: ServerProvider["updateState"],
): ServerProvider {
  return {
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
    ...(updateState ? { updateState } : {}),
  };
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

async function markupFor(_fixture: _Fixture, provider: ServerProvider): Promise<string> {
  return await _renderMarkup(
    _fixture,
    <AssistedProviderSetupHost
      displayName={provider.displayName!}
      environmentId={EnvironmentId.make("local")}
      provider={provider}
      surface="composer"
    />,
  );
}

async function view(_fixture: _Fixture, provider: ServerProvider): Promise<HTMLElement> {
  const element = document.createElement("div");
  element.innerHTML = await markupFor(_fixture, provider);
  return element;
}

/** The frame's actions, leaving out controls inside the diagnostics disclosure. */
function frameButtons(element: HTMLElement): HTMLButtonElement[] {
  return [...element.querySelectorAll("button")].filter((button) => !button.closest("details"));
}

function buttonLabels(element: HTMLElement): string[] {
  return frameButtons(element).map((button) => button.textContent!.trim());
}

/** What assistive technology announces for each of the frame's actions. */
function accessibleNames(element: HTMLElement): string[] {
  return frameButtons(element).map(
    (button) => button.getAttribute("aria-label") ?? button.textContent!.trim(),
  );
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
async function expectProviderLogo(_fixture: _Fixture, element: HTMLElement, entry: Driver) {
  const Logo = PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make(entry.driver)]!;
  const logo = element.querySelector('[data-provider-setup-mark="logo"] svg');
  const expected = document.createElement("div");
  expected.innerHTML = await _renderMarkup(_fixture, <Logo />);
  expect(logo?.getAttribute("viewBox")).toBe(expected.firstElementChild!.getAttribute("viewBox"));
  expect(logo?.innerHTML).toBe(expected.firstElementChild!.innerHTML);
  expect(element.querySelector('[data-provider-setup-mark="shield"]')).not.toBeNull();
}

async function _setupFixture0(_fixture: _Fixture) {
  vi.clearAllMocks();
}

describe.each(DRIVERS)("$name composer setup", (entry) => {
  const runtimeName = entry.driver === "cursor" ? "Cursor CLI" : entry.name;
  it("shows a ready state with a check, no inline Repair and no extra marks", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const element = await view(_fixture, ready(entry));

    expect(element.textContent).toContain(`${entry.name} is ready`);
    expect(statusIcons(element)).toEqual(["check"]);
    expect(strayIcons(element)).toBe(0);
    expect(buttonLabels(element).filter((label) => /repair/i.test(label))).toEqual([]);
  });

  it("shows the provider logo while it waits for installation", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const element = await view(_fixture, notInstalled(entry));

    expect(element.textContent).toContain(`Install ${runtimeName}`);
    expect(statusIcons(element)).toEqual(["setup"]);
    await expectProviderLogo(_fixture, element, entry);
    expect(strayIcons(element)).toBe(0);
  });

  it("shows installation progress with one spinner as its status icon", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const element = await view(_fixture, installing(entry));

    expect(element.textContent).toContain(`Installing ${runtimeName}`);
    expect(statusIcons(element)).toEqual(["spinner"]);
    expect(element.querySelectorAll(".animate-spin")).toHaveLength(1);
    expect(strayIcons(element)).toBe(0);
    expect(buttonLabels(element)).toEqual(["Cancel"]);
    expect(accessibleNames(element)).toEqual([`Cancel ${runtimeName} installation`]);
  });

  it("shows a server-side installation failure with its error and a retry", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const element = await view(_fixture, installFailed(entry));

    expect(element.textContent).toContain(`${runtimeName} installation couldn’t finish`);
    expect(element.textContent).toContain(INSTALL_ERROR);
    expect(element.querySelector('[role="alert"]')).not.toBeNull();
    expect(statusIcons(element)).toEqual(["warning"]);
    expect(buttonLabels(element)).toEqual(["Retry installation"]);
    expect(accessibleNames(element)).toEqual([`Retry installation of ${runtimeName}`]);
  });

  it("asks for repair with the server's error", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const element = await view(_fixture, needsRepair(entry));

    expect(element.textContent).toContain(
      entry.driver === "cursor" ? "Cursor needs attention" : `${runtimeName} needs repair`,
    );
    expect(element.textContent).toContain(SERVER_ERROR);
    expect(statusIcons(element)).toEqual(["warning"]);
    expect(strayIcons(element)).toBe(0);
    // Droid re-checks a failed start only on request, so it offers one beside Repair.
    expect(buttonLabels(element)).toEqual(
      entry.driver === "cursor"
        ? []
        : entry.driver === "droid"
          ? ["Try again", "Repair Droid"]
          : [`Repair ${runtimeName}`],
    );
    expect(
      frameButtons(element).filter((button) => button.dataset.variant === "ghost-primary"),
    ).toHaveLength(entry.driver === "cursor" ? 0 : 1);
  });

  it("keeps the server's error when an earlier runtime operation succeeded", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const element = await view(
      _fixture,
      withRuntime(needsRepair(entry), {
        operation: {
          operationId: `${entry.driver}-install`,
          action: "install",
          status: "succeeded",
          startedAt: T0,
          finishedAt: T0,
          message: `${runtimeName} 1.2.3 was installed and verified.`,
        },
      }),
    );

    expect(element.textContent).toContain(SERVER_ERROR);
    expect(element.textContent).not.toContain("was installed and verified");
  });

  it("asks for repair with the server's error, not an earlier failed update or install", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    for (const action of ["update", "install"] as const) {
      const element = await view(
        _fixture,
        withRuntime(needsRepair(entry), {
          operation: failedOperation(entry, action, `The earlier ${action} failed.`),
        }),
      );

      expect(element.textContent).toContain(
        entry.driver === "cursor" ? "Cursor needs attention" : `${runtimeName} needs repair`,
      );
      expect(element.textContent).toContain(SERVER_ERROR);
      expect(element.textContent).not.toContain(`The earlier ${action} failed.`);
    }
  });

  it("explains a failed repair in the repair frame", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const element = await view(
      _fixture,
      withRuntime(needsRepair(entry), {
        operation: failedOperation(entry, "repair", "The repaired runtime failed its smoke test."),
      }),
    );

    expect(element.textContent).toContain("The repaired runtime failed its smoke test.");
  });

  it("stops showing a failed update once a newer version is offered", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const failed = withRuntime(managedUpdate(entry), {
      operation: failedOperation(entry, "update", "The 1.3.0 update did not pass its smoke test."),
    });
    const newer = withRuntime(failed, { availableManagedVersion: "1.4.0" });

    expect((await view(_fixture, failed)).textContent).toContain(
      "The 1.3.0 update did not pass its smoke test.",
    );
    const element = await view(_fixture, newer);
    expect(element.textContent).not.toContain("did not pass its smoke test");
    expect(element.textContent).toContain(`${runtimeName} update available`);
    expect(accessibleNames(element)[0]).toBe(`Update ${runtimeName}`);
  });

  it("shows a failed managed update with its error and a retry", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const element = await view(
      _fixture,
      withRuntime(managedUpdate(entry), {
        operation: failedOperation(
          entry,
          "update",
          "The reviewed update did not pass its smoke test.",
        ),
      }),
    );

    expect(element.textContent).toContain(`${runtimeName} couldn’t be updated`);
    expect(element.textContent).toContain("The reviewed update did not pass its smoke test.");
    expect(statusIcons(element)).toEqual(["warning"]);
    expect(buttonLabels(element)[0]).toBe("Try again");
    expect(accessibleNames(element)[0]).toBe(`Try again to update ${runtimeName}`);
    expect(element.textContent).toContain("Runtime diagnostics");
  });

  it("labels its install and update actions with short verbs and names the provider", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    expect(buttonLabels(await view(_fixture, notInstalled(entry)))).toEqual(["Install"]);
    expect(accessibleNames(await view(_fixture, notInstalled(entry)))).toEqual([
      `Install ${runtimeName}`,
    ]);
    expect(buttonLabels(await view(_fixture, managedUpdate(entry)))[0]).toBe("Update");
    expect(accessibleNames(await view(_fixture, managedUpdate(entry)))[0]).toBe(
      `Update ${runtimeName}`,
    );
  });

  it("keeps runtime diagnostics out of healthy and first-run states", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    for (const provider of [ready(entry), notInstalled(entry), managedUpdate(entry)]) {
      expect(await markupFor(_fixture, provider)).not.toContain("Runtime diagnostics");
    }
  });

  it("shows runtime diagnostics in failure and repair states", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const failedWithDiagnostics = withRuntime(installFailed(entry), {
      diagnostics: ready(entry).connection!.runtime!.diagnostics!,
    });
    expect(await markupFor(_fixture, failedWithDiagnostics)).toContain("Runtime diagnostics");
    if (entry.driver === "cursor") {
      expect(await markupFor(_fixture, needsRepair(entry))).not.toContain("Runtime diagnostics");
    } else {
      expect(await markupFor(_fixture, needsRepair(entry))).toContain("Runtime diagnostics");
    }
  });
});

describe.each(ACCOUNT_DRIVERS)("$name composer sign-in", (entry) => {
  it("shows the provider logo before sign-in", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const element = await view(_fixture, signIn(entry));

    expect(element.textContent).toContain("Sign in required");
    expect(statusIcons(element)).toEqual(["setup"]);
    await expectProviderLogo(_fixture, element, entry);
    expect(strayIcons(element)).toBe(0);
  });

  it("shows sign-in progress with one spinner as its status icon", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const provider = signIn(entry);
    const element = await view(_fixture, {
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

  it("shows runtime diagnostics only once sign-in fails", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const failed = await view(_fixture, signInFailed(entry));

    expect(await markupFor(_fixture, signIn(entry))).not.toContain("Runtime diagnostics");
    expect(failed.textContent).toContain("The sign-in window was closed.");
    expect(statusIcons(failed)).toEqual(["warning"]);
    expect(failed.textContent).toContain("Runtime diagnostics");
  });

  it("offers the Scient-managed runtime when sign-in fails on a system installation", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const system = withRuntime(signInFailed(entry), {
      source: "system",
      actions: ["install"],
      managedVersion: null,
    });

    if (entry.driver === "cursor") {
      expect(await markupFor(_fixture, system)).not.toContain("Use Scient-managed");
    } else {
      expect(await markupFor(_fixture, system)).toContain(`Use Scient-managed ${entry.name}`);
    }
    expect(await markupFor(_fixture, signInFailed(entry))).not.toContain("Use Scient-managed");
  });
});

// Cursor SDK sign-in is independent of CLI selection. Its switch safeguards
// are exercised through ProviderRuntimeSection, which owns the CLI controls.
describe.each(ACCOUNT_DRIVERS.filter((entry) => entry.driver !== "cursor"))(
  "$name composer switch to the Scient-managed runtime",
  (entry) => {
    async function _setupFixture1(_fixture: _Fixture) {
      _fixture.host = document.createElement("div");
      document.body.append(_fixture.host);
      _fixture.root0 = _fixture.stack.use(
        await _fixtureRender(null, { container: _fixture.host, router: false }),
      );
    }
    async function _cleanupFixture2(_fixture: _Fixture) {
      await act(async () => await _fixture.root0.unmount());
      _fixture.host.remove();
      vi.unstubAllGlobals();
      vi.mocked(controller.planRuntime).mockReset();
      vi.mocked(controller.startRuntime).mockReset();
    }

    // The switch is offered where a system installation fails to sign in.
    const system = withRuntime(signInFailed(entry), {
      source: "system",
      actions: ["install"],
      managedVersion: null,
    });
    const older = {
      instanceId: system.instanceId,
      action: "install" as const,
      target: "darwin-arm64",
      version: "1.2.0",
      downloadBytes: null,
      sourceLabel: "Official release",
      catalogRevision: "revision:older-than-system",
      message: `Scient-managed ${entry.name} 1.2.0 is older than your installed ${entry.name} 1.2.3. Scient will use its own verified copy; your installation stays as it is.`,
      systemVersion: "1.2.3",
      olderThanSystem: true,
    };
    const notOlder = {
      ...older,
      version: "1.3.0",
      catalogRevision: "revision",
      message: `Scient will install private ${entry.name} 1.3.0 and use it instead of the system installation (1.2.3), which stays untouched.`,
      olderThanSystem: false,
    };

    const button = (_fixture: _Fixture, label: string) =>
      [..._fixture.host.querySelectorAll("button")].find(
        (candidate) => candidate.textContent!.trim() === label,
      );
    const useManaged = async (_fixture: _Fixture) => {
      await act(
        async () =>
          await _fixture.root0.rerender(
            <AssistedProviderSetupHost
              displayName={entry.name}
              environmentId={EnvironmentId.make("local")}
              provider={system}
              surface="composer"
            />,
          ),
      );
      await act(async () => button(_fixture, `Use Scient-managed ${entry.name}`)!.click());
    };
    const decisionText = (_fixture: _Fixture) =>
      [..._fixture.host.querySelectorAll("[data-provider-onboarding-view=assisted]")]
        .filter((frame) => !frame.closest("[hidden]"))
        .map((frame) => frame.textContent)
        .join("");

    // regression: 2d693058ea fix(providers): install managed runtimes without version confirmation
    // The web never reads the plan's version comparison; older and unknown are
    // the two cases that used to ask before starting.
    it.each(["older", "unknown"])(
      "starts the %s managed release from the first explicit click",
      async (versionCase) => {
        await using _fixture = _createFixture();
        _fixture.cleanup.defer(() => _cleanupFixture2(_fixture));
        await _setupFixture0(_fixture);
        await _setupFixture1(_fixture);

        const selected = versionCase === "older" ? older : { ...notOlder, systemVersion: null };
        vi.mocked(controller.planRuntime).mockResolvedValue(selected);
        vi.mocked(controller.startRuntime).mockResolvedValue(system);
        await useManaged(_fixture);
        expect(controller.planRuntime).toHaveBeenCalledExactlyOnceWith("install");
        expect(controller.startRuntime).toHaveBeenCalledExactlyOnceWith(selected);
        expect(decisionText(_fixture)).not.toContain(selected.message);
        expect(button(_fixture, "Back")).toBeUndefined();
      },
    );
  },
);

describe.each(EXTERNAL_UPDATE_DRIVERS)("$name composer external update", (entry) => {
  const runtimeName = entry.driver === "cursor" ? "Cursor CLI" : entry.name;
  it("says it will run the installation's own updater, not that it installs a reviewed update", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const element = await view(_fixture, externalUpdate(entry));

    expect(element.textContent).toContain(`${runtimeName} update available`);
    expect(element.textContent).toContain(
      `${runtimeName} 1.3.0 is available. Scient will run ${entry.driver} update to update the ${runtimeName} installed on this Mac.`,
    );
    expect(element.querySelector("code")?.textContent).toBe(`${entry.driver} update`);
    expect(element.textContent).not.toContain("reviewed update");
    expect(element.textContent).not.toContain("remains available");
    expect(accessibleNames(element)[0]).toBe(`Update ${runtimeName}`);
  });

  it("keeps a truthful generic line when the updater command is unknown", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const provider = externalUpdate(entry);
    const element = await view(_fixture, {
      ...provider,
      versionAdvisory: { ...provider.versionAdvisory!, updateCommand: null },
    });

    expect(element.textContent).toContain(
      `${runtimeName} 1.3.0 is available. Scient will update the ${runtimeName} installed on this Mac with its own updater.`,
    );
    expect(element.textContent).not.toContain("remains available");
  });

  it("shows the running external updater, whatever the account state", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const running = async (provider: ServerProvider) =>
      await view(_fixture, {
        ...provider,
        updateState: {
          status: "running",
          startedAt: T0,
          finishedAt: null,
          message: "Updating provider.",
          output: null,
        },
      });

    for (const element of [
      await running(externalUpdate(entry)),
      ...(entry.methods.length > 0
        ? [await running({ ...externalUpdate(entry), ...signIn(entry) })]
        : []),
    ]) {
      expect(element.textContent).toContain(`Updating ${runtimeName}`);
      expect(element.textContent).toContain(`Running ${entry.driver} update on this Mac.`);
      expect(element.querySelector('[role="status"]')).not.toBeNull();
      expect(statusIcons(element)).toEqual(["spinner"]);
      expect(buttonLabels(element)).toEqual([]);
    }
  });

  it("says a finished update left the old version in place", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const element = await view(
      _fixture,
      externalUpdate(entry, {
        status: "unchanged",
        startedAt: T0,
        finishedAt: T0,
        message: "Update command completed, but Scient still detects an outdated provider version.",
        output: null,
      }),
    );

    expect(element.textContent).toContain(`${runtimeName} update didn’t take effect`);
    expect(element.textContent).toContain("still detects an outdated provider version");
    expect(element.querySelector('[role="alert"]')).not.toBeNull();
    expect(accessibleNames(element)[0]).toBe(`Try again to update ${runtimeName}`);
  });

  it("shows a failed external update with a retry", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const element = await view(
      _fixture,
      externalUpdate(entry, {
        status: "failed",
        startedAt: T0,
        finishedAt: T0,
        message: "The updater exited with code 2.",
        output: null,
      }),
    );

    expect(element.textContent).toContain(`${runtimeName} couldn’t be updated`);
    expect(element.textContent).toContain("The updater exited with code 2.");
    expect(statusIcons(element)).toEqual(["warning"]);
    expect(buttonLabels(element)[0]).toBe("Try again");
  });

  describe("actions", () => {
    async function _setupFixture3(_fixture: _Fixture) {
      _fixture.host2 = document.createElement("div");
      document.body.append(_fixture.host2);
      _fixture.root1 = _fixture.stack.use(
        await _fixtureRender(null, { container: _fixture.host2, router: false }),
      );
    }
    async function _cleanupFixture4(_fixture: _Fixture) {
      await act(async () => await _fixture.root1.unmount());
      _fixture.host2.remove();
      vi.unstubAllGlobals();
    }

    const clickUpdate = async (_fixture: _Fixture, provider: ServerProvider) => {
      await act(
        async () =>
          await _fixture.root1.rerender(
            <AssistedProviderSetupHost
              displayName={entry.name}
              environmentId={EnvironmentId.make("local")}
              provider={provider}
              surface="composer"
            />,
          ),
      );
      const button = frameButtons(_fixture.host2).find(
        (element) => element.getAttribute("aria-label") === `Update ${runtimeName}`,
      );
      await act(async () => button!.click());
    };

    it("plans and starts the reviewed managed update", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture4(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture3(_fixture);

      const provider = managedUpdate(entry);
      const plan = {
        instanceId: provider.instanceId,
        action: "update" as const,
        target: "darwin-arm64",
        version: "1.3.0",
        downloadBytes: null,
        sourceLabel: "Official release",
        catalogRevision: "revision",
        message: `Update ${runtimeName}.`,
      };
      vi.mocked(controller.planRuntime).mockResolvedValueOnce(plan);
      vi.mocked(controller.startRuntime).mockResolvedValueOnce(provider);

      await clickUpdate(_fixture, provider);

      expect(controller.planRuntime).toHaveBeenCalledWith("update");
      expect(controller.startRuntime).toHaveBeenCalledWith(plan);
      expect(controller.updateExternalRuntime).not.toHaveBeenCalled();
    });

    it("runs the external installation's own updater and says so while it runs", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture4(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture3(_fixture);

      const provider = externalUpdate(entry);
      vi.mocked(controller.updateExternalRuntime).mockReturnValueOnce(new Promise(() => undefined));

      await clickUpdate(_fixture, provider);

      expect(controller.updateExternalRuntime).toHaveBeenCalledOnce();
      expect(controller.planRuntime).not.toHaveBeenCalled();
      expect(_fixture.host2.textContent).toContain(`Updating ${runtimeName}`);
      expect(_fixture.host2.textContent).toContain(`Running ${entry.driver} update on this Mac.`);
      expect(_fixture.host2.textContent).not.toContain("Preparing");
      expect(_fixture.host2.textContent).not.toContain("private");
    });
  });
});

describe("Droid and Pi Connect models", () => {
  const droid = DRIVERS.find((entry) => entry.driver === "droid")!;
  const pi = DRIVERS.find((entry) => entry.driver === "pi")!;
  const connectModels = (element: HTMLElement) =>
    frameButtons(element).filter((button) => button.textContent?.trim() === "Connect models");

  it("keeps Connect models as the ready frame's one primary action", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    for (const entry of [droid, pi]) {
      const element = await view(_fixture, ready(entry));
      expect(connectModels(element)).toHaveLength(1);
      expect(connectModels(element)[0]!.dataset.variant).toBe("ghost-primary");
    }
  });

  it("offers Connect models as a quiet secondary action under another primary action", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    for (const provider of [managedUpdate(droid), managedUpdate(pi), signIn(droid)]) {
      const element = await view(_fixture, provider);
      const buttons = frameButtons(element);
      expect(connectModels(element)).toHaveLength(1);
      expect(buttons.at(-1)!.textContent?.trim()).toBe("Connect models");
      expect(buttons.at(-1)!.dataset.variant).toBe("ghost-muted");
      expect(buttons.filter((button) => button.dataset.variant === "ghost-primary")).toHaveLength(
        1,
      );
    }
  });

  it("leaves Connect models out until Droid is installed and its probe has finished", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    expect(connectModels(await view(_fixture, notInstalled(droid)))).toHaveLength(0);
    expect(
      connectModels(await view(_fixture, { ...ready(droid), probePending: true })),
    ).toHaveLength(0);
    expect(connectModels(await view(_fixture, { ...ready(pi), probePending: true }))).toHaveLength(
      0,
    );
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
    host2: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    root1: undefined! as Screen,
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

async function _renderMarkup(_fixture: _Fixture, ui: ReactNode): Promise<string> {
  const screen = _fixture.stack.use(await _fixtureRender(ui, { router: false }));
  return screen.container.innerHTML;
}

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

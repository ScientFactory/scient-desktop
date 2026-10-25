import { act as _fixtureAct, render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimePlan,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({ plan: vi.fn(), start: vi.fn() }));
const atoms = vi.hoisted(() => ({ plan: Symbol("planRuntime"), start: Symbol("startRuntime") }));

vi.mock("../../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      planProviderRuntime: atoms.plan,
      startProviderRuntime: atoms.start,
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: unknown) => async () => {
    if (atom === atoms.plan) return { _tag: "Success", value: await runtime.plan() };
    if (atom === atoms.start) return { _tag: "Success", value: await runtime.start() };
    return new Promise<never>(() => undefined);
  },
}));

vi.mock("./useProviderLifecycleController", () => {
  const never = () => new Promise<never>(() => undefined);
  const controller = {
    startConnection: never,
    cancelConnection: never,
    submitAuthorizationCode: never,
    disconnect: never,
    signInKey: { environmentId: "environment-test", instanceId: "sign-in-test" },
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
import { ProviderRuntimeSection } from "./ProviderRuntimeSection";

type Methods = NonNullable<ServerProvider["connection"]>["methods"];

// Every provider renders the same setup mark and diagnostics switch; which
// state uses them is checked per provider in ComposerProviderSetupParity.
const PROVIDERS: ReadonlyArray<readonly [driver: string, name: string, methods: Methods]> = [
  ["codex", "Codex", ["codex_browser"]],
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

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
  runtime.plan.mockReset();
  runtime.start.mockReset();
}

const isVisible = (element: Element | null) =>
  element !== null && element.getBoundingClientRect().width > 0;
const visibleButton = (_fixture: _Fixture, label: string) =>
  [..._fixture.host!.querySelectorAll("button")].find(
    (button) =>
      isVisible(button) &&
      button.closest("details")?.open !== false &&
      button.textContent!.trim() === label,
  );

describe("optional provider runtime summaries", () => {
  it.each([
    ["cursor", "Cursor", ["cursor_browser"]],
    ["droid", "Droid", ["droid_device_pairing"]],
  ] as const)(
    "keeps %s hook order when a summary appears and disappears",
    async (driver, name, methods) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      const provider = snapshot(driver, name, [...methods]);
      const withoutRuntime: ServerProvider = {
        ...provider,
        connection: { methods: [...methods], canDisconnect: false, operation: null },
      };
      _fixture.host = document.createElement("div");
      document.body.append(_fixture.host);
      _fixture.root0 = _fixture.stack.use(
        await _fixtureRender(null, { container: _fixture.host, router: false }),
      );
      const render = async (next: ServerProvider) => {
        await _fixtureAct(async () => {
          await _fixture.root0!.rerender(
            <ProviderRuntimeSection
              displayName={name}
              environmentId={EnvironmentId.make("local")}
              provider={next}
            />,
          );
        });
      };

      await render(withoutRuntime);
      expect(_fixture.host.childElementCount).toBe(0);
      await render(provider);
      expect(_fixture.host.textContent).toContain(
        driver === "cursor" ? "Cursor CLI managed by Scient" : "Managed by Scient",
      );
      expect(visibleButton(_fixture, "Repair")).toBeTruthy();
      await render(withoutRuntime);
      expect(_fixture.host.childElementCount).toBe(0);
      expect(runtime.plan).not.toHaveBeenCalled();
      expect(runtime.start).not.toHaveBeenCalled();
    },
  );
});

// regression: 40c5dea2e5 fix(web): give every composer setup state the same status icon
describe.each(PROVIDERS)("%s setup mark", (driver, name, methods) => {
  const states = [
    ["install", notInstalled(snapshot(driver, name, methods))],
    ...(methods.length > 0 ? [["sign-in", snapshot(driver, name, methods)] as const] : []),
  ] as const;

  it.each(states)(
    "shows the provider logo in the model picker's %s state, and the shield elsewhere",
    async (_state, provider) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      for (const picker of [true, false]) {
        _fixture.host = document.createElement("div");
        document.body.append(_fixture.host);
        _fixture.root0 = _fixture.stack.use(
          await _fixtureRender(null, { container: _fixture.host, router: false }),
        );
        await _fixture.root0.rerender(
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
          .poll(() => _fixture.host!.querySelector("[data-assisted-setup-icon=true]"))
          .toBeTruthy();

        const logo = _fixture.host.querySelector('[data-provider-setup-mark="logo"]');
        const shield = _fixture.host.querySelector('[data-provider-setup-mark="shield"]');
        expect(isVisible(logo), `logo in ${picker ? "picker" : "other host"}`).toBe(picker);
        expect(isVisible(shield), `shield in ${picker ? "picker" : "other host"}`).toBe(!picker);
        if (picker) expect(logo!.querySelector("svg")!.getBoundingClientRect().width).toBe(32);

        await _fixture.root0.unmount();
        _fixture.host.remove();
        _fixture.root0 = undefined;
        _fixture.host = undefined;
      }
    },
  );
});

// regression: 2d693058ea fix(providers): install managed runtimes without version confirmation
describe.each(PROVIDERS)("%s single-click Scient-managed installation", (driver, name, methods) => {
  const provider = signInFailedOnSystem(driver, name, methods);
  const plan: ProviderRuntimePlan = {
    instanceId: provider.instanceId,
    action: "install",
    target: "darwin-arm64",
    version: "0.230.0",
    downloadBytes: null,
    sourceLabel: "Official release",
    catalogRevision: "reviewed:1:older-than-system",
    message: `Scient-managed ${name} 0.230.0 is older than your installed ${name} 0.231.0.`,
    systemVersion: "0.231.0",
    olderThanSystem: true,
  };

  it.each([true, false])(
    "starts from its blue action without another frame (model picker: %s)",
    async (picker) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      runtime.plan.mockResolvedValue(plan);
      runtime.start.mockResolvedValue(provider);
      _fixture.host = document.createElement("div");
      document.body.append(_fixture.host);
      _fixture.root0 = _fixture.stack.use(
        await _fixtureRender(null, { container: _fixture.host, router: false }),
      );
      await _fixture.root0.rerender(
        <Container picker={picker}>
          <AssistedProviderSetupHost
            displayName={name}
            environmentId={EnvironmentId.make("local")}
            provider={provider}
            surface="composer"
          />
        </Container>,
      );
      await expect.poll(() => _fixture.host!.querySelector("details")).toBeTruthy();
      _fixture.host.querySelector("details")!.open = true;
      await expect.poll(() => visibleButton(_fixture, `Use Scient-managed ${name}`)).toBeTruthy();
      const action = visibleButton(_fixture, `Use Scient-managed ${name}`)!;
      expect(action.className).toContain("text-primary");
      const container = _fixture.host.querySelector("[data-container]")!.getBoundingClientRect();
      const box = action.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(container.left);
      expect(box.right).toBeLessThanOrEqual(container.right);
      action.click();

      await expect.poll(() => runtime.start.mock.calls.length).toBe(1);
      expect(runtime.start).toHaveBeenCalledExactlyOnceWith(plan);
      expect(visibleButton(_fixture, "Back")).toBeUndefined();
      expect(_fixture.host.textContent).not.toContain(plan.message);
      const frames = [
        ..._fixture.host.querySelectorAll("[data-provider-onboarding-view=assisted]"),
      ];
      expect(frames).toHaveLength(1);
      expect(frames.filter(isVisible)).toHaveLength(1);
    },
  );
});

// Cursor account sign-in uses its bundled SDK. The optional CLI is managed
// through the shared runtime section rather than the account setup action.
describe("Cursor CLI single-click Scient-managed installation", () => {
  const provider = signInFailedOnSystem("cursor", "Cursor CLI", ["cursor_browser"]);
  const plan: ProviderRuntimePlan = {
    instanceId: provider.instanceId,
    action: "install",
    target: "darwin-arm64",
    version: "0.230.0",
    downloadBytes: null,
    sourceLabel: "Official Cursor CLI release",
    catalogRevision: "reviewed:1:older-than-system",
    message: "Scient-managed Cursor CLI 0.230.0 is older than the system CLI 0.231.0.",
    systemVersion: "0.231.0",
    olderThanSystem: true,
  };

  // The compact row is ProviderRuntimeSection's "Cursor one-click managed selection".
  it.each([false])(
    "starts from its blue action without a version review (compact: %s)",
    async (compact) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      runtime.plan.mockResolvedValue(plan);
      runtime.start.mockResolvedValue({ providers: [provider] });
      _fixture.host = document.createElement("div");
      document.body.append(_fixture.host);
      _fixture.root0 = _fixture.stack.use(
        await _fixtureRender(null, { container: _fixture.host, router: false }),
      );
      await _fixture.root0.rerender(
        <Container picker={false}>
          <ProviderRuntimeSection
            compact={compact}
            displayName="Cursor"
            environmentId={EnvironmentId.make("local")}
            provider={provider}
          />
        </Container>,
      );
      await expect.poll(() => visibleButton(_fixture, "Use Scient-managed")).toBeTruthy();
      const action = visibleButton(_fixture, "Use Scient-managed")!;
      expect(action.className).toContain("text-primary");
      expect(_fixture.host.textContent).toContain("Conversations use the bundled Cursor SDK.");
      action.click();
      await expect.poll(() => runtime.start.mock.calls.length).toBe(1);
      expect(visibleButton(_fixture, "Back")).toBeUndefined();
      expect(_fixture.host.textContent).not.toContain(plan.message);
    },
  );
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
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

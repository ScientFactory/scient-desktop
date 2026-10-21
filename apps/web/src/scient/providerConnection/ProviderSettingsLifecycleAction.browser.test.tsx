import { act as _fixtureAct, render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionMethod,
  type ProviderConnectionOperation,
  type ProviderRuntimeOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import { useState } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

const commands = vi.hoisted(() => ({ plan: vi.fn(), start: vi.fn(), connect: vi.fn() }));
const locality = vi.hoisted(() => ({ onThisDevice: true }));

vi.mock("./environmentLocality", () => ({
  useEnvironmentIsOnThisDevice: () => locality.onThisDevice,
}));

vi.mock("./useProviderLifecycleController", () => ({
  useProviderLifecycleController: () => ({
    planRuntime: commands.plan,
    startRuntime: commands.start,
    startConnection: commands.connect,
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
import { resetProviderSignInForTests, startProviderSignIn } from "./providerSignInFlow";

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

async function renderSurface(
  _fixture: _Fixture,
  surface: (typeof SURFACES)[number],
  provider: ServerProvider,
) {
  if (!_fixture.host) {
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  await _fixtureAct(async () => {
    await _fixture.root0!.rerender(
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

async function _setupFixture0(_fixture: _Fixture) {
  vi.clearAllMocks();
  locality.onThisDevice = true;
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
}

async function _cleanupFixture1(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}

describe.each(SURFACES)("%s runtime progress", (surface) => {
  it("survives start acknowledgement, closing details and remount without another transaction", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await page.viewport(1280, 800);
    await renderSurface(_fixture, surface, snapshot());
    await page.getByRole("button", { name: "Install Codex", exact: true }).click();
    await expect.poll(() => commands.start.mock.calls.length).toBe(1);

    // Acknowledgement ends local pending; canonical snapshots own ongoing progress.
    await commands.start.mock.results[0]!.value;
    await renderSurface(_fixture, surface, operation({}));
    await expect.element(page.getByLabelText("Download progress 42%")).toBeVisible();
    const busy = _fixture.host!.querySelector<HTMLButtonElement>(
      'button[aria-label="Installing Codex"]',
    )!;
    const loader = busy.querySelector("svg")!;
    const percent = busy.querySelector<HTMLElement>('[aria-label="Download progress 42%"]')!;
    expect(percent.className).toContain("text-muted-foreground");
    expect(parseFloat(getComputedStyle(percent).fontSize)).toBeLessThan(
      parseFloat(getComputedStyle(busy).fontSize),
    );
    expect(getComputedStyle(loader).animationName).not.toBe("none");
    const initialRotation = getComputedStyle(loader).transform;
    await expect.poll(() => getComputedStyle(loader).transform).not.toBe(initialRotation);
    await page.getByRole("button", { name: "Installing Codex", exact: true }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Close details" }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

    await renderSurface(_fixture, surface, operation({ downloadedBytes: 73 }));
    await expect.element(page.getByLabelText("Download progress 73%")).toBeVisible();
    const manage = _fixture.host!.querySelector<HTMLButtonElement>(
      'button[aria-label="Manage Codex"]',
    )!;
    expect(manage.textContent).not.toContain("Manage");
    expect(manage.disabled).toBe(false);

    await _fixtureAct(async () => await _fixture.root0!.unmount());
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host!, router: false }),
    );
    await renderSurface(_fixture, surface, operation({ downloadedBytes: 73 }));
    await expect.element(page.getByLabelText("Download progress 73%")).toBeVisible();
    await page.getByRole("button", { name: "Manage Codex", exact: true }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Close details" }).click();

    await renderSurface(_fixture, surface, operation({ status: "testing" }));
    await expect.element(page.getByRole("button", { name: "Verifying Codex" })).toBeVisible();
    expect(_fixture.host!.textContent).not.toContain("73%");
    for (const status of ["succeeded", "cancelled", "failed"] as const) {
      await renderSurface(
        _fixture,
        surface,
        operation({ status, finishedAt: "2026-10-08T00:01:00.000Z" }),
      );
      expect(_fixture.host!.querySelector('[role="status"]')).toBeNull();
      expect(_fixture.host!.textContent).not.toContain("Verifying");
    }
    expect(commands.plan).toHaveBeenCalledTimes(1);
    expect(commands.start).toHaveBeenCalledTimes(1);
  });
});

it.each([1280, 390])(
  "keeps the shortened onboarding description and list compact at %spx",
  async (width) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await page.viewport(width, 800);
    await renderSurface(_fixture, "onboarding", snapshot());
    const description = _fixture.host!.querySelector("header p")!;
    const heading = _fixture.host!.querySelector("header h1")!;
    const content = heading.closest("header")!.parentElement!.parentElement!;
    const list = _fixture.host!.querySelector<HTMLElement>('[aria-label="AI providers"]')!;
    expect(description.textContent).toBe(
      "Use a ChatGPT, Claude, or Google subscription you already have.",
    );
    expect(getComputedStyle(list).marginTop).toBe("12px");
    expect(getComputedStyle(heading).fontSize).toBe(width >= 640 ? "24px" : "22px");
    expect(getComputedStyle(description).marginTop).toBe("4px");
    expect(getComputedStyle(content).marginTop).toBe("8px");
    expect(list.getBoundingClientRect().top - description.getBoundingClientRect().bottom).toBe(12);
    expect(_fixture.host!.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
    await expect.element(page.getByRole("button", { name: "Skip", exact: true })).toBeVisible();
  },
);

describe("row sign-in", () => {
  function signedOut(
    driver: string,
    methods: ReadonlyArray<ProviderConnectionMethod>,
    current: ProviderConnectionOperation | null = null,
  ): ServerProvider {
    return {
      ...snapshot(),
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      displayName: "Provider",
      installed: true,
      version: "1.0.0",
      connection: { methods: [...methods], canDisconnect: false, operation: current },
    };
  }

  function waiting(patch: Partial<ProviderConnectionOperation>): ProviderConnectionOperation {
    return {
      operationId: "connect-1",
      method: "antigravity_google",
      status: "waiting_for_browser",
      startedAt: "2026-10-18T00:00:00.000Z",
      finishedAt: null,
      message: "Finish signing in.",
      ...patch,
    };
  }

  async function renderRow(_fixture: _Fixture, provider: ServerProvider, onManage: () => void) {
    if (!_fixture.host) {
      _fixture.host = document.createElement("div");
      document.body.append(_fixture.host);
      _fixture.root0 = _fixture.stack.use(
        await _fixtureRender(null, { container: _fixture.host, router: false }),
      );
    }
    await _fixtureAct(async () => {
      await _fixture.root0!.rerender(
        <ProviderSettingsLifecycleAction
          displayName="Provider"
          environmentId={EnvironmentId.make("local")}
          onManage={onManage}
          provider={provider}
        />,
      );
    });
  }

  it.each([
    ["antigravity", "antigravity_google"],
    ["cursor", "cursor_browser"],
    ["codex", "codex_browser"],
  ] as const)("starts %s sign-in with one click", async (driver, method) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onManage = vi.fn();
    const provider = signedOut(driver, [method]);
    commands.connect.mockResolvedValue(
      signedOut(driver, [method], waiting({ method, authorizationUrlKind: "primary" })),
    );
    await renderRow(_fixture, provider, onManage);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect.poll(() => commands.connect.mock.calls).toEqual([[method]]);
    await commands.connect.mock.results[0]!.value;
    expect(onManage).not.toHaveBeenCalled();
  });

  it.each([
    ["claudeAgent", ["claude_subscription", "claude_console"]],
    ["grok", ["grok_account", "grok_device_code"]],
    ["droid", ["droid_device_pairing"]],
    ["antigravity", ["antigravity_credentials"]],
  ] as const)("opens the setup view for %s instead", async (driver, methods) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onManage = vi.fn();
    await renderRow(_fixture, signedOut(driver, methods), onManage);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(commands.connect).not.toHaveBeenCalled();
  });

  it("also opens the setup view on another device, for pasting the return URL", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    locality.onThisDevice = false;
    const onManage = vi.fn();
    commands.connect.mockResolvedValue(
      signedOut(
        "antigravity",
        ["antigravity_google"],
        waiting({ authorizationUrlKind: "primary", authorizationResponseKind: "callback_url" }),
      ),
    );
    await renderRow(_fixture, signedOut("antigravity", ["antigravity_google"]), onManage);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect.poll(() => commands.connect.mock.calls).toEqual([["antigravity_google"]]);
    await commands.connect.mock.results[0]!.value;
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it("continues in the setup view when the started flow asks for something", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onManage = vi.fn();
    commands.connect.mockResolvedValue(
      signedOut(
        "antigravity",
        ["antigravity_google"],
        waiting({ authorizationUrlKind: "manual_fallback", acceptsAuthorizationCode: true }),
      ),
    );
    await renderRow(_fixture, signedOut("antigravity", ["antigravity_google"]), onManage);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect.poll(() => onManage.mock.calls.length).toBe(1);
  });

  it("shows the server's starting state from the click", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    resetProviderSignInForTests({ open: async () => undefined });
    const onManage = vi.fn();
    const provider = {
      ...signedOut("antigravity", ["antigravity_google"]),
      connection: {
        ...signedOut("antigravity", ["antigravity_google"]).connection!,
        startingMessage: "Antigravity can take up to a minute to start.",
      },
    };
    // As the controller does: the start runs through the shared opener and is slow.
    commands.connect.mockImplementation(() =>
      startProviderSignIn({
        key: { environmentId: EnvironmentId.make("local"), instanceId: provider.instanceId },
        providerName: "Provider",
        previousOperationId: null,
        start: () => new Promise<never>(() => undefined),
        operationOf: () => null,
      }),
    );
    await renderRow(_fixture, provider, onManage);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    const progress = page.getByRole("button", { name: "Starting Provider", exact: true });
    await expect.element(progress).toBeVisible();
    await progress.hover();
    await expect
      .element(page.getByText("Antigravity can take up to a minute to start."))
      .toBeVisible();
    resetProviderSignInForTests();
  });

  it("retries a failed sign-in, with the reason on hover", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onManage = vi.fn();
    await renderRow(
      _fixture,
      signedOut(
        "antigravity",
        ["antigravity_google"],
        waiting({
          status: "failed",
          finishedAt: "2026-10-18T00:01:00.000Z",
          message: "Antigravity authenticated, but could not initialize a session or load models.",
          failedAfterSignIn: true,
        }),
      ),
      onManage,
    );
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await expect.element(retry).toBeVisible();
    await retry.hover();
    await expect
      .element(page.getByText("Signed in, but Provider couldn’t start. Try again."))
      .toBeVisible();
  });

  it("shows a slow start on the row and opens the setup view from it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const onManage = vi.fn();
    await renderRow(
      _fixture,
      signedOut(
        "antigravity",
        ["antigravity_google"],
        waiting({
          status: "starting",
          message: "Antigravity can take up to a minute to start.",
        }),
      ),
      onManage,
    );
    const progress = page.getByRole("button", { name: "Starting Provider", exact: true });
    await expect.element(progress).toBeVisible();
    await progress.hover();
    await expect
      .element(page.getByText("Antigravity can take up to a minute to start."))
      .toBeVisible();
    await progress.click();
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(commands.connect).not.toHaveBeenCalled();
  });
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

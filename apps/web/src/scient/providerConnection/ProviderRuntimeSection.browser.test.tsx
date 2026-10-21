import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { type ReactNode } from "react";

import {
  EnvironmentId,
  ProviderConnectionError,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderManagedRuntimeAction,
  type ProviderRuntimeCatalogFreshness,
  type ProviderRuntimePlan,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type { ComponentProps, ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderRuntimeSection,
  resolveProviderRuntimeForPresentation,
} from "./ProviderRuntimeSection";

async function _setupFixture0(_fixture: _Fixture) {
  await undefined;
}

async function mount(_fixture: _Fixture, node: ReactNode) {
  if (!_fixture.root0) {
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  await act(async () => await _fixture.root0!.rerender(node));
  return _fixture.host;
}
async function _cleanupFixture1(_fixture: _Fixture) {
  if (_fixture.root0) await act(async () => await _fixture.root0!.unmount());
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  vi.unstubAllGlobals();
}

const atoms = vi.hoisted(() => ({
  plan: Symbol("planProviderRuntime"),
  start: Symbol("startProviderRuntime"),
  cancel: Symbol("cancelProviderRuntime"),
}));

const commands = vi.hoisted(() => ({
  plan: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    planProviderRuntime: atoms.plan,
    startProviderRuntime: atoms.start,
    cancelProviderRuntime: atoms.cancel,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === atoms.plan ? commands.plan : atom === atoms.start ? commands.start : commands.cancel,
}));

vi.mock("../../components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const environmentId = EnvironmentId.make("local");
const instanceId = ProviderInstanceId.make("antigravity");

const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("antigravity"),
  enabled: true,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unknown", required: true },
  checkedAt: "2026-08-22T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["antigravity_google"],
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
      message: "Scient can install Antigravity.",
    },
  },
};

async function renderSection(
  _fixture: _Fixture,
  props: ComponentProps<typeof ProviderRuntimeSection>,
) {
  return await mount(_fixture, <ProviderRuntimeSection {...props} />);
}
function serialize(element: HTMLElement) {
  return element.innerHTML;
}
function findActionButton(node: HTMLElement, label: string) {
  return [...node.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.endsWith(label),
  );
}

describe("ProviderRuntimeSection", () => {
  it("offers the shared removal command for a Scient-owned registry installation", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const registryProvider: ServerProvider = {
      ...provider,
      driver: ProviderDriverKind.make("acpRegistry"),
      installed: true,
      connection: {
        ...provider.connection!,
        runtime: {
          ...provider.connection!.runtime!,
          source: "registry",
          target: "registry:example:/owned/example",
          actions: ["remove"],
          managedVersion: "1.2.3",
        },
      },
    };
    commands.plan.mockResolvedValue({
      _tag: "Success",
      value: {
        instanceId,
        action: "remove",
        target: "registry:example:/owned/example",
        version: "1.2.3",
        downloadBytes: null,
        sourceLabel: "Scient-owned ACP Registry installation",
        catalogRevision: "owned-installation:1",
        message: "Remove this owned registry installation.",
      },
    });
    commands.start.mockResolvedValue({ _tag: "Success", value: { providers: [provider] } });
    const props = {
      environmentId,
      provider: registryProvider,
      displayName: "Registry Agent",
      initialAction: "remove" as const,
    };

    await renderSection(_fixture, props);
    await vi.waitFor(() =>
      expect(commands.plan).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId, action: "remove" },
      }),
    );
    expect(commands.start).not.toHaveBeenCalled();

    const plan = await renderSection(_fixture, props);
    expect(serialize(plan)).toContain("Remove Registry Agent?");
    const remove = findActionButton(plan, "Remove");
    expect(remove).toBeDefined();
    if (!remove || typeof remove.click !== "function")
      throw new Error("Expected registry removal action");
    await act(() => remove.click());
    await vi.waitFor(() =>
      expect(commands.start).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId, action: "remove", catalogRevision: "owned-installation:1" },
      }),
    );
  });

  it("labels registry ownership without presenting it as a system executable", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const markup = serialize(
      await renderSection(_fixture, {
        environmentId,
        displayName: "Registry Agent",
        provider: {
          ...provider,
          driver: ProviderDriverKind.make("acpRegistry"),
          connection: {
            ...provider.connection!,
            runtime: { ...provider.connection!.runtime!, source: "registry", actions: ["remove"] },
          },
        },
      }),
    );
    expect(markup).toContain("ACP Registry installation managed by Scient");
    expect(markup).toContain('aria-label="Remove Registry Agent"');
    expect(markup).not.toContain("System installation");
  });

  it("presents a missing Cursor CLI as separate from bundled SDK execution", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const markup = serialize(
      await renderSection(_fixture, {
        environmentId,
        displayName: "Cursor",
        provider: {
          ...provider,
          driver: ProviderDriverKind.make("cursor"),
          instanceId: ProviderInstanceId.make("cursor"),
        },
      }),
    );
    expect(markup).toContain("Cursor CLI not installed");
    expect(markup).toContain("Conversations use the bundled Cursor SDK.");
    expect(markup).toContain('aria-label="Install Cursor CLI"');
    expect(markup).not.toContain("Provider tool required");
  });

  describe("settings row presentation", () => {
    const managedProvider: ServerProvider = {
      ...provider,
      installed: true,
      version: "1.1.17",
      status: "ready",
      connection: {
        ...provider.connection!,
        runtime: {
          ...provider.connection!.runtime!,
          source: "scient_managed",
          actions: ["repair", "remove"],
          managedVersion: "1.1.17",
          message: "Managed Antigravity is ready.",
        },
      },
    };
    const render = async (
      _fixture: _Fixture,
      input: {
        readonly provider: ServerProvider;
        readonly presentation?: "card" | "row";
      },
    ) => {
      return serialize(
        await renderSection(_fixture, {
          environmentId,
          provider: input.provider,
          displayName: "Antigravity",
          ...(input.presentation ? { presentation: input.presentation } : {}),
        }),
      );
    };

    it("renders the managed runtime as a frameless row with its actions beside the status", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      const markup = await render(_fixture, { provider: managedProvider, presentation: "row" });
      expect(markup).toContain("Managed by Scient");
      expect(markup).toContain("Repair");
      expect(markup).toContain("Remove");
      // The surrounding settings section is the only frame.
      expect(markup).not.toContain("rounded-lg border");
      // Status and actions share one line once the row is wide enough.
      expect(markup).toContain("@min-[32rem]/runtime-row:grid-cols-[minmax(0,1fr)_auto]");
      expect(markup).toContain("px-3 py-3 sm:px-4");
    });

    it("says when Scient last checked for a newer release, and why a check failed", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      const runtime = managedProvider.connection!.runtime!;
      const withCatalog = (catalog: ProviderRuntimeCatalogFreshness): ServerProvider => ({
        ...managedProvider,
        connection: {
          ...managedProvider.connection!,
          runtime: { ...runtime, qualifiedVersion: "1.1.17", catalog },
        },
      });
      const checkedAt = new Date(Date.now() - 5 * 60_000).toISOString();
      expect(
        await render(_fixture, {
          provider: withCatalog({ checkedAt, failure: null, checksDisabled: false }),
          presentation: "row",
        }),
      ).toContain("Up to date · checked 5m ago");
      const failed = await render(_fixture, {
        provider: withCatalog({
          checkedAt,
          failure: { at: new Date().toISOString(), message: "The check timed out." },
          checksDisabled: false,
        }),
        presentation: "row",
      });
      expect(failed).toContain(
        "Couldn't check for updates just now, last checked 5m ago. The check timed out.",
      );
      expect(failed).toContain("text-warning-foreground");
    });

    it("keeps its own frame outside settings", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      expect(await render(_fixture, { provider: managedProvider })).toContain(
        "rounded-lg border p-3",
      );
    });

    it("keeps an in-progress operation frameless in a settings row", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      const markup = await render(_fixture, {
        presentation: "row",
        provider: {
          ...managedProvider,
          connection: {
            ...managedProvider.connection!,
            runtime: {
              ...managedProvider.connection!.runtime!,
              operation: {
                operationId: "repair-running",
                action: "repair",
                status: "downloading",
                startedAt: "2026-08-22T12:00:00.000Z",
                finishedAt: null,
                message: "Downloading Antigravity.",
                downloadedBytes: 50,
                totalBytes: 100,
              },
            },
          },
        },
      });
      expect(markup).toContain("Downloading Antigravity.");
      expect(markup).toContain("Cancel");
      expect(markup).not.toContain("rounded-lg border");
    });
  });

  it.each([true, false])(
    "keeps Pi installation concise without hiding unsupported-platform guidance (canInstall=%s)",
    async (canInstall) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      const piProvider: ServerProvider = {
        ...provider,
        driver: ProviderDriverKind.make("pi"),
        instanceId: ProviderInstanceId.make("pi"),
        connection: {
          ...provider.connection!,
          runtime: {
            ...provider.connection!.runtime!,
            actions: canInstall ? ["install"] : [],
            message: "Pi installation guidance.",
          },
        },
      };

      const markup = serialize(
        await renderSection(_fixture, {
          environmentId,
          provider: piProvider,
          displayName: "Pi",
          compact: true,
        }),
      );
      expect(markup).toContain("Provider tool required");
      if (canInstall) {
        expect(markup).toContain("Install");
        expect(markup).not.toContain("Pi installation guidance.");
      } else {
        expect(markup).toContain("Pi installation guidance.");
      }
    },
  );

  it("preserves a failed Pi install above its retry action", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const piProvider: ServerProvider = {
      ...provider,
      driver: ProviderDriverKind.make("pi"),
      instanceId: ProviderInstanceId.make("pi"),
      connection: {
        ...provider.connection!,
        runtime: {
          ...provider.connection!.runtime!,
          operation: {
            operationId: "pi-install-failed",
            action: "install",
            status: "failed",
            startedAt: "2026-09-05T00:00:00.000Z",
            finishedAt: "2026-09-05T00:00:05.000Z",
            message: "Pi download checksum mismatch.",
          },
        },
      },
    };

    const markup = serialize(
      await renderSection(_fixture, {
        environmentId,
        provider: piProvider,
        displayName: "Pi",
        compact: true,
      }),
    );
    expect(markup).toContain("Pi download checksum mismatch.");
    expect(markup).toContain("Install");
  });

  async function _setupFixture2(_fixture: _Fixture) {
    commands.start
      .mockReset()
      .mockImplementation(
        async ({ input }: { input: { action: ProviderManagedRuntimeAction } }) => ({
          _tag: "Success",
          value: {
            providers: [
              {
                ...provider,
                connection: {
                  ...provider.connection!,
                  runtime: {
                    ...provider.connection!.runtime!,
                    operation: {
                      operationId: "runtime-active",
                      action: input.action,
                      status: "preparing",
                      startedAt: provider.checkedAt,
                      finishedAt: null,
                      message: "Preparing the provider runtime operation.",
                    },
                  },
                },
              },
            ],
          },
        }),
      );
    commands.cancel.mockReset();
    commands.plan
      .mockReset()
      .mockImplementation(
        async ({ input }: { input: { action: ProviderManagedRuntimeAction } }) => ({
          _tag: "Success",
          value: {
            instanceId,
            action: input.action,
            target: "darwin-arm64",
            version: "1.1.17",
            downloadBytes: 42,
            sourceLabel: "Official Google Antigravity CLI release",
            catalogRevision: "reviewed:1",
            message: "Install the reviewed Antigravity release.",
          },
        }),
      );
  }

  it.each(["install", "update", "repair"] as const)(
    "starts %s once after preflight for an explicit action entry point",
    async (action) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      const actionableProvider = {
        ...provider,
        connection: {
          ...provider.connection!,
          runtime: {
            ...provider.connection!.runtime!,
            actions: [action],
          },
        },
      };

      await renderSection(_fixture, {
        environmentId,
        provider: actionableProvider,
        displayName: "Antigravity",
        initialAction: action,
      });

      await vi.waitFor(() => expect(commands.start).toHaveBeenCalledTimes(1));

      expect(commands.plan).toHaveBeenCalledTimes(1);
      expect(commands.plan).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId, action },
      });
      expect(commands.start).toHaveBeenCalledWith({
        environmentId,
        input: {
          instanceId,
          action,
          catalogRevision: "reviewed:1",
        },
      });

      const markup = serialize(
        await renderSection(_fixture, {
          environmentId,
          provider: actionableProvider,
          displayName: "Antigravity",
          initialAction: action,
        }),
      );
      expect(markup).toContain("Preparing the provider runtime operation.");
      expect(markup).not.toContain("Review Antigravity setup");
      expect(markup).not.toContain(">Back<");
      expect(commands.plan).toHaveBeenCalledTimes(1);
      expect(commands.start).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])("opening the runtime card is passive (compact=%s)", async (compact) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const markup = serialize(
      await renderSection(_fixture, {
        compact,
        environmentId,
        provider,
        displayName: "Antigravity",
      }),
    );
    expect(markup).toContain(">Install</button>");
    expect(commands.plan).not.toHaveBeenCalled();
    expect(commands.start).not.toHaveBeenCalled();
  });

  it.each([
    [false, "install"],
    [true, "install"],
    [false, "update"],
    [true, "update"],
  ] as const)(
    "starts %s card action %s from one click, after preflight completes",
    async (compact, action) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      const actionableProvider = {
        ...provider,
        connection: {
          ...provider.connection!,
          runtime: {
            ...provider.connection!.runtime!,
            actions: [action],
          },
        },
      };
      const props = {
        compact,
        environmentId,
        provider: actionableProvider,
        displayName: "Antigravity",
      };
      const planResult = {
        _tag: "Success",
        value: {
          instanceId,
          action,
          target: "darwin-arm64",
          version: "1.1.17",
          downloadBytes: 42,
          sourceLabel: "Official release",
          catalogRevision: "fresh:2",
          message: "Ready",
        },
      };
      let finishPlan!: (result: typeof planResult) => void;
      commands.plan.mockReturnValue(
        new Promise<typeof planResult>((resolve) => {
          finishPlan = resolve;
        }),
      );

      const button = findActionButton(
        await renderSection(_fixture, props),
        action === "install" ? "Install" : "Update",
      );
      expect(button).toBeDefined();
      await act(() => button!.click());
      expect(commands.plan).toHaveBeenCalledTimes(1);
      expect(commands.start).not.toHaveBeenCalled();

      expect(
        findActionButton(
          await renderSection(_fixture, props),
          action === "install" ? "Install" : "Update",
        )?.disabled,
      ).toBe(true);
      finishPlan(planResult);
      await vi.waitFor(() =>
        expect(commands.start).toHaveBeenCalledWith({
          environmentId,
          input: {
            instanceId,
            action,
            catalogRevision: "fresh:2",
          },
        }),
      );
      expect(commands.start).toHaveBeenCalledTimes(1);
    },
  );

  it("presents a qualified system-to-managed action as a blue primary choice", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const markup = serialize(
      await renderSection(_fixture, {
        compact: true,
        environmentId,
        displayName: "Grok",
        provider: {
          ...provider,
          instanceId: ProviderInstanceId.make("grok"),
          driver: ProviderDriverKind.make("grok"),
          displayName: "Grok",
          installed: true,
          version: "1.0.5",
          connection: {
            methods: ["grok_account"],
            canDisconnect: false,
            operation: null,
            runtime: {
              ...provider.connection!.runtime!,
              source: "system",
              actions: ["install"],
              message: "Using a compatible system Grok runtime.",
            },
          },
        },
      }),
    );

    expect(markup).toContain("System installation");
    expect(markup).toContain('aria-label="Use Scient-managed Grok"');
    expect(markup).toContain(">Use Scient-managed</button>");
    expect(markup).toContain("Your system installation stays unchanged and remains available.");
    expect(markup).not.toContain("Use Scient-managed Codex");
    const actionIndex = markup.indexOf(">Use Scient-managed</button>");
    const actionStart = markup.lastIndexOf("<button", actionIndex);
    const actionMarkup = markup.slice(actionStart, actionIndex);
    expect(actionMarkup).toContain("text-primary");
  });

  describe.each([
    { driver: "codex", name: "Codex" },
    { driver: "claudeAgent", name: "Claude" },
    { driver: "antigravity", name: "Antigravity" },
    { driver: "droid", name: "Droid" },
    { driver: "grok", name: "Grok" },
    { driver: "opencode", name: "OpenCode" },
    { driver: "pi", name: "Pi" },
    { driver: "cursor", name: "Cursor" },
  ] as const)("$name one-click managed selection", ({ driver, name }) => {
    const id = ProviderInstanceId.make(driver);
    const systemProvider = {
      ...provider,
      instanceId: id,
      driver: ProviderDriverKind.make(driver),
      installed: true,
      connection: {
        ...provider.connection!,
        runtime: {
          ...provider.connection!.runtime!,
          source: "system" as const,
          actions: ["install" as const],
        },
      },
    };
    const props = { compact: true, environmentId, provider: systemProvider, displayName: name };
    const render = async (_fixture: _Fixture) => {
      return await renderSection(_fixture, props);
    };
    const click = async (_fixture: _Fixture) => {
      const button = findActionButton(await render(_fixture), "Use Scient-managed");
      expect(button).toBeDefined();
      await act(() => button!.click());
    };
    const plan = (systemVersion: string | null, olderThanSystem: boolean) => ({
      instanceId: id,
      action: "install" as const,
      target: "darwin-arm64",
      version: "1.2.0",
      downloadBytes: null,
      sourceLabel: "Official release",
      catalogRevision: "reviewed:1",
      message: "Private copy installation.",
      systemVersion,
      olderThanSystem,
    });
    it.each([
      ["older", "1.3.0", true],
      ["equal", "1.2.0", false],
      ["newer", "1.1.0", false],
      ["unknown", null, false],
    ] as const)(
      "starts when the managed version is %s without another decision",
      async (_case, version, older) => {
        await using _fixture = _createFixture();
        _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
        await _setupFixture0(_fixture);
        await _setupFixture2(_fixture);

        const reviewed = plan(version, older);
        commands.plan.mockResolvedValue({ _tag: "Success", value: reviewed });
        expect(commands.plan).not.toHaveBeenCalled();
        await click(_fixture);
        await vi.waitFor(() =>
          expect(commands.start).toHaveBeenCalledExactlyOnceWith({
            environmentId,
            input: { instanceId: id, action: "install", catalogRevision: reviewed.catalogRevision },
          }),
        );
        const markup = serialize(await render(_fixture));
        expect(markup).not.toContain(">Back</button>");
        expect(markup).not.toContain("Private copy installation.");
        expect(markup).toContain("text-primary");
      },
    );
    it("refreshes a stale plan once and starts the current managed release", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      commands.plan
        .mockResolvedValueOnce({ _tag: "Success", value: plan("1.1.0", false) })
        .mockResolvedValueOnce({
          _tag: "Success",
          value: { ...plan("1.3.0", true), catalogRevision: "reviewed:2" },
        });
      commands.start.mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(
          new ProviderConnectionError({
            provider: systemProvider.driver,
            instanceId: id,
            reason: "runtime_plan_stale",
            message: "Plan changed.",
          }),
        ),
      });
      await click(_fixture);
      await vi.waitFor(() => expect(commands.start).toHaveBeenCalledTimes(2));
      expect(commands.plan).toHaveBeenCalledTimes(2);
      expect(commands.start.mock.calls[1]![0].input.catalogRevision).toBe("reviewed:2");
      expect(serialize(await render(_fixture))).not.toContain(">Back</button>");
    });
    const staleResult = () => ({
      _tag: "Failure",
      cause: Cause.fail(
        new ProviderConnectionError({
          provider: systemProvider.driver,
          instanceId: id,
          reason: "runtime_plan_stale",
          message: "Plan changed.",
        }),
      ),
    });
    it("stops after a second stale plan instead of reopening confirmation", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      commands.plan.mockResolvedValue({ _tag: "Success", value: plan(null, false) });
      commands.start.mockResolvedValue(staleResult());
      await click(_fixture);
      await vi.waitFor(() => expect(commands.start).toHaveBeenCalledTimes(2));
      expect(commands.plan).toHaveBeenCalledTimes(2);
      const markup = serialize(await render(_fixture));
      expect(markup).toContain("Plan changed.");
      expect(markup).not.toContain(">Back</button>");
    });
    it("reports a failed refresh without dispatching another start", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      commands.plan
        .mockResolvedValueOnce({ _tag: "Success", value: plan(null, false) })
        .mockResolvedValueOnce({
          _tag: "Failure",
          cause: Cause.fail(new Error("Catalog unavailable.")),
        });
      commands.start.mockResolvedValueOnce(staleResult());
      await click(_fixture);
      await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(2));
      expect(commands.start).toHaveBeenCalledTimes(1);
      expect(serialize(await render(_fixture))).toContain("Catalog unavailable.");
    });
    it("ignores another click while the preflight is pending", async () => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      let finish!: (value: { _tag: "Success"; value: ProviderRuntimePlan }) => void;
      commands.plan.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await click(_fixture);
      await click(_fixture);
      expect(commands.plan).toHaveBeenCalledTimes(1);
      finish({ _tag: "Success", value: plan("1.3.0", true) });
      await vi.waitFor(() => expect(commands.start).toHaveBeenCalledTimes(1));
    });
  });

  it("still starts a first installation from its explicit action", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const section = await renderSection(_fixture, {
      compact: true,
      environmentId,
      provider,
      displayName: "Antigravity",
    });
    const button = findActionButton(section, "Install");
    expect(button).toBeDefined();
    await act(() => button!.click());

    await vi.waitFor(() => expect(commands.start).toHaveBeenCalledTimes(1));
    expect(commands.start).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, action: "install", catalogRevision: "reviewed:1" },
    });
  });

  it.each([
    ["install", "plan"],
    ["install", "start"],
    ["update", "plan"],
    ["update", "start"],
  ] as const)("shows %s %s failures without automatically retrying", async (action, stage) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    commands[stage].mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(
        new ProviderConnectionError({
          provider: provider.driver,
          instanceId,
          reason: "connection_failed",
          message: "The provider service is unavailable. Try again.",
        }),
      ),
    });
    const actionableProvider = {
      ...provider,
      connection: {
        ...provider.connection!,
        runtime: {
          ...provider.connection!.runtime!,
          actions: [action],
        },
      },
    };
    const props = {
      compact: true,
      environmentId,
      provider: actionableProvider,
      displayName: "Antigravity",
      initialAction: action,
    };

    await renderSection(_fixture, props);
    await vi.waitFor(async () => {
      const markup = serialize(await renderSection(_fixture, props));
      expect(markup).toContain('role="alert"');
      expect(markup).toContain("The provider service is unavailable. Try again.");
    });
    expect(commands.plan).toHaveBeenCalledTimes(1);
    expect(commands.start).toHaveBeenCalledTimes(stage === "plan" ? 0 : 1);
  });

  it("drops an install-plan failure superseded by an active runtime operation", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    let settlePlan:
      | ((result: {
          readonly _tag: "Failure";
          readonly cause: Cause.Cause<ProviderConnectionError>;
        }) => void)
      | undefined;
    commands.plan.mockImplementation(
      () =>
        new Promise((resolve) => {
          settlePlan = resolve;
        }),
    );
    const droidProvider: ServerProvider = {
      ...provider,
      instanceId: ProviderInstanceId.make("droid"),
      driver: ProviderDriverKind.make("droid"),
      displayName: "Droid",
    };

    await renderSection(_fixture, {
      compact: true,
      environmentId,
      provider: droidProvider,
      displayName: "Droid",
      initialAction: "install",
    });
    await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(1));

    const installingDroidProvider: ServerProvider = {
      ...droidProvider,
      connection: {
        ...droidProvider.connection!,
        runtime: {
          ...droidProvider.connection!.runtime!,
          // The actions list can briefly lag behind the canonical operation.
          // Once installation is active, it still supersedes an older plan.
          actions: ["install"],
          operation: {
            operationId: "droid-install-active",
            action: "install",
            status: "activating",
            startedAt: "2026-08-25T12:00:00.000Z",
            finishedAt: null,
            message: "Activating the verified Droid runtime.",
          },
        },
      },
    };

    await renderSection(_fixture, {
      compact: true,
      environmentId,
      provider: installingDroidProvider,
      displayName: "Droid",
    });

    settlePlan?.({
      _tag: "Failure",
      cause: Cause.fail(
        new ProviderConnectionError({
          provider: ProviderDriverKind.make("droid"),
          instanceId: ProviderInstanceId.make("droid"),
          reason: "invalid_runtime_action",
          message: "The install action is not available for this Droid runtime.",
        }),
      ),
    });
    await Promise.resolve();

    const markup = serialize(
      await renderSection(_fixture, {
        compact: true,
        environmentId,
        provider: installingDroidProvider,
        displayName: "Droid",
      }),
    );

    expect(markup).toContain("Activating the verified Droid runtime");
    expect(markup).toContain(">Cancel<");
    expect(markup).not.toContain("install action is not available");
  });

  it("does not request an initial plan while a runtime operation is active", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const installingProvider: ServerProvider = {
      ...provider,
      connection: {
        ...provider.connection!,
        runtime: {
          ...provider.connection!.runtime!,
          operation: {
            operationId: "install-active",
            action: "install",
            status: "activating",
            startedAt: "2026-08-25T12:00:00.000Z",
            finishedAt: null,
            message: "Activating the verified Antigravity runtime.",
          },
        },
      },
    };

    const markup = serialize(
      await renderSection(_fixture, {
        compact: true,
        environmentId,
        provider: installingProvider,
        displayName: "Antigravity",
        initialAction: "install",
      }),
    );
    await Promise.resolve();

    expect(markup).toContain("Activating the verified Antigravity runtime");
    expect(commands.plan).not.toHaveBeenCalled();
  });

  it("keeps a plan failure visible while its runtime action remains current", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    commands.plan.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(
        new ProviderConnectionError({
          provider: ProviderDriverKind.make("antigravity"),
          instanceId,
          reason: "connection_failed",
          message: "Scient could not load the installation details.",
        }),
      ),
    });

    await renderSection(_fixture, {
      compact: true,
      environmentId,
      provider,
      displayName: "Antigravity",
      initialAction: "install",
    });
    await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(1));

    const markup = serialize(
      await renderSection(_fixture, {
        compact: true,
        environmentId,
        provider,
        displayName: "Antigravity",
        initialAction: "install",
      }),
    );

    expect(markup).toContain("Scient could not load the installation details");
  });

  it("closes a prepared plan when a newer runtime no longer offers its action", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const onPlanOpenChange = vi.fn();
    const removableProvider = {
      ...provider,
      connection: {
        ...provider.connection!,
        runtime: {
          ...provider.connection!.runtime!,
          actions: ["remove" as const],
        },
      },
    };

    await renderSection(_fixture, {
      compact: true,
      environmentId,
      provider: removableProvider,
      displayName: "Antigravity",
      initialAction: "remove",
      onPlanOpenChange,
    });
    await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(1));

    expect(
      serialize(
        await renderSection(_fixture, {
          compact: true,
          environmentId,
          provider: removableProvider,
          displayName: "Antigravity",
          initialAction: "remove",
          onPlanOpenChange,
        }),
      ),
    ).toContain("Remove Antigravity?");
    expect(commands.start).not.toHaveBeenCalled();

    const managedProvider: ServerProvider = {
      ...provider,
      installed: true,
      version: "1.1.17",
      status: "ready",
      connection: {
        ...provider.connection!,
        runtime: {
          ...provider.connection!.runtime!,
          source: "scient_managed",
          actions: ["repair"],
          managedVersion: "1.1.17",
        },
      },
    };

    const markup = serialize(
      await renderSection(_fixture, {
        compact: true,
        environmentId,
        provider: managedProvider,
        displayName: "Antigravity",
        onPlanOpenChange,
      }),
    );

    expect(markup).toContain("Managed by Scient");
    expect(markup).not.toContain("Remove Antigravity?");
    expect(onPlanOpenChange).toHaveBeenLastCalledWith(false);
  });

  it.each(["Back", "Remove"])("keeps removal confirmed and honors %s", async (choice) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const removableProvider: ServerProvider = {
      ...provider,
      installed: true,
      version: "1.1.17",
      connection: {
        ...provider.connection!,
        runtime: {
          ...provider.connection!.runtime!,
          source: "scient_managed",
          actions: ["repair", "remove"],
          managedVersion: "1.1.17",
        },
      },
    };
    commands.plan.mockResolvedValue({
      _tag: "Success",
      value: {
        instanceId,
        action: "remove",
        target: "darwin-arm64",
        version: "1.1.17",
        downloadBytes: null,
        sourceLabel: "Official Google Antigravity CLI release",
        catalogRevision: "reviewed:remove-1",
        message: "Remove Scient's managed Antigravity runtime.",
      },
    });

    await renderSection(_fixture, {
      compact: true,
      environmentId,
      provider: removableProvider,
      displayName: "Antigravity",
      initialAction: "remove",
    });

    await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(1));

    const markup = serialize(
      await renderSection(_fixture, {
        compact: true,
        environmentId,
        provider: removableProvider,
        displayName: "Antigravity",
        initialAction: "remove",
      }),
    );

    expect(markup).toContain("Remove Antigravity?");
    expect(markup).toContain("Only Scient’s managed copy will be removed");
    expect(markup).toContain(">Remove<");
    expect(markup).not.toContain("Computer");
    expect(markup).not.toContain("Version");
    expect(markup).not.toContain("Source");
    expect(markup).not.toContain("Official Google Antigravity CLI release");
    expect(markup).not.toContain("Remove managed Antigravity");

    const removeButtonStart = markup.lastIndexOf("<button", markup.indexOf(">Remove<"));
    const removeButton = markup.slice(
      removeButtonStart,
      markup.indexOf("</button>", removeButtonStart),
    );
    expect(removeButton).toContain("border-transparent");
    expect(removeButton).toContain("text-destructive");
    expect(removeButton).not.toContain("text-white");
    expect(commands.start).not.toHaveBeenCalled();

    const section = await renderSection(_fixture, {
      compact: true,
      environmentId,
      provider: removableProvider,
      displayName: "Antigravity",
      initialAction: "remove",
    });
    const button = findActionButton(section, choice);
    expect(button).toBeDefined();
    await act(() => button!.click());
    if (choice === "Remove") {
      await vi.waitFor(() =>
        expect(commands.start).toHaveBeenCalledWith({
          environmentId,
          input: {
            instanceId,
            action: "remove",
            catalogRevision: "reviewed:remove-1",
          },
        }),
      );
    } else {
      expect(
        serialize(
          await renderSection(_fixture, {
            compact: true,
            environmentId,
            provider: removableProvider,
            displayName: "Antigravity",
            initialAction: "remove",
          }),
        ),
      ).not.toContain("Remove Antigravity?");
      expect(commands.start).not.toHaveBeenCalled();
    }
  });

  it("shows compact download progress beside the quiet cancel action", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const activeProvider: ServerProvider = {
      ...provider,
      installed: true,
      connection: {
        ...provider.connection!,
        runtime: {
          ...provider.connection!.runtime!,
          source: "scient_managed",
          managedVersion: "1.1.17",
          operation: {
            operationId: "repair-active",
            action: "repair",
            status: "downloading",
            startedAt: "2026-08-22T12:00:00.000Z",
            finishedAt: null,
            message: "Downloading Antigravity from the reviewed official release.",
            downloadedBytes: 64,
            totalBytes: 100,
          },
        },
      },
    };

    const markup = serialize(
      await renderSection(_fixture, {
        compact: true,
        environmentId,
        provider: activeProvider,
        displayName: "Antigravity",
      }),
    );

    expect(markup).toContain("Downloading Antigravity from the reviewed official release");
    expect(markup).not.toContain("previous working runtime");
    expect(markup).not.toContain("Provider download progress");
    expect(markup).toContain('aria-label="Download progress 64%"');
    expect(markup).toContain(">64%<");
    expect(markup).toContain("space-y-4 py-1");
    expect(markup).not.toContain("min-h-44");
    expect(markup).toContain('class="flex items-center justify-end gap-3 pt-1"');
    const cancelButtonStart = markup.lastIndexOf("<button", markup.indexOf(">Cancel<"));
    const cancelButton = markup.slice(
      cancelButtonStart,
      markup.indexOf("</button>", cancelButtonStart),
    );
    expect(cancelButton).toContain("border-transparent");
    expect(cancelButton).toContain("text-destructive/80");
    expect(cancelButton).not.toContain("border-input");
  });

  it("drops stale local removal progress once the server reports the runtime missing", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const localRuntime = {
      ...provider.connection!.runtime!,
      source: "scient_managed" as const,
      actions: ["repair", "remove"] as const,
      managedVersion: "1.1.17",
      operation: {
        operationId: "remove-active",
        action: "remove" as const,
        status: "removing" as const,
        startedAt: "2026-08-23T12:00:00.000Z",
        finishedAt: null,
        message: "Removing Scient's private provider runtime.",
      },
    };
    const serverRuntime = {
      ...provider.connection!.runtime!,
      source: "missing" as const,
      actions: ["install"] as const,
      managedVersion: null,
      operation: null,
    };

    expect(resolveProviderRuntimeForPresentation(serverRuntime, localRuntime)).toBe(serverRuntime);
  });

  it("keeps optimistic install progress while the streamed server snapshot catches up", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const localRuntime = {
      ...provider.connection!.runtime!,
      operation: {
        operationId: "install-active",
        action: "install" as const,
        status: "preparing" as const,
        startedAt: "2026-08-23T12:00:00.000Z",
        finishedAt: null,
        message: "Preparing the provider runtime operation.",
      },
    };

    expect(resolveProviderRuntimeForPresentation(provider.connection!.runtime, localRuntime)).toBe(
      localRuntime,
    );
  });

  it("drops stale local install progress once the server reports a managed runtime", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const localRuntime = {
      ...provider.connection!.runtime!,
      source: "missing" as const,
      operation: {
        operationId: "install-active",
        action: "install" as const,
        status: "activating" as const,
        startedAt: "2026-08-23T12:00:00.000Z",
        finishedAt: null,
        message: "Activating the verified provider runtime.",
      },
    };
    const serverRuntime = {
      ...provider.connection!.runtime!,
      source: "scient_managed" as const,
      actions: ["repair", "remove"] as const,
      managedVersion: "1.1.17",
      operation: null,
    };

    expect(resolveProviderRuntimeForPresentation(serverRuntime, localRuntime)).toBe(serverRuntime);
  });

  it("reports repair success only after the matching streamed operation succeeds", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const onActionSucceeded = vi.fn();
    const repairableProvider: ServerProvider = {
      ...provider,
      installed: true,
      version: "1.1.17",
      connection: {
        ...provider.connection!,
        runtime: {
          ...provider.connection!.runtime!,
          source: "scient_managed",
          actions: ["repair", "remove"],
          managedVersion: "1.1.17",
        },
      },
    };
    commands.plan.mockResolvedValue({
      _tag: "Success",
      value: {
        instanceId,
        action: "repair",
        target: "darwin-arm64",
        version: "1.1.17",
        downloadBytes: 42,
        sourceLabel: "Official Google Antigravity CLI release",
        catalogRevision: "reviewed:repair-1",
        message: "Repair the managed Antigravity release.",
      },
    });
    commands.start.mockResolvedValue({
      _tag: "Success",
      value: {
        providers: [
          {
            ...provider,
            connection: {
              ...provider.connection!,
              runtime: {
                ...provider.connection!.runtime!,
                operation: {
                  operationId: "repair-active",
                  action: "repair",
                  status: "preparing",
                  startedAt: "2026-08-22T12:00:00.000Z",
                  finishedAt: null,
                  message: "Preparing the provider runtime operation.",
                },
              },
            },
          },
        ],
      },
    });

    await renderSection(_fixture, {
      environmentId,
      provider: repairableProvider,
      displayName: "Antigravity",
      initialAction: "repair",
      onActionSucceeded,
    });

    await vi.waitFor(() => {
      expect(commands.start).toHaveBeenCalledWith({
        environmentId,
        input: {
          instanceId,
          action: "repair",
          catalogRevision: "reviewed:repair-1",
        },
      });
    });

    expect(onActionSucceeded).not.toHaveBeenCalled();

    const otherRepairProvider: ServerProvider = {
      ...provider,
      connection: {
        ...provider.connection!,
        runtime: {
          ...provider.connection!.runtime!,
          operation: {
            operationId: "other-repair",
            action: "repair",
            status: "succeeded",
            startedAt: "2026-08-22T12:00:00.000Z",
            finishedAt: "2026-08-22T12:00:05.000Z",
            message: "Another provider runtime operation completed.",
          },
        },
      },
    };

    await renderSection(_fixture, {
      environmentId,
      provider: otherRepairProvider,
      displayName: "Antigravity",
      initialAction: "repair",
      onActionSucceeded,
    });

    expect(onActionSucceeded).not.toHaveBeenCalled();

    const repairedProvider: ServerProvider = {
      ...provider,
      connection: {
        ...provider.connection!,
        runtime: {
          ...provider.connection!.runtime!,
          operation: {
            operationId: "repair-active",
            action: "repair",
            status: "succeeded",
            startedAt: "2026-08-22T12:00:00.000Z",
            finishedAt: "2026-08-22T12:00:05.000Z",
            message: "The provider runtime was repaired and verified successfully.",
          },
        },
      },
    };

    await renderSection(_fixture, {
      environmentId,
      provider: repairedProvider,
      displayName: "Antigravity",
      initialAction: "repair",
      onActionSucceeded,
    });

    expect(onActionSucceeded).toHaveBeenCalledTimes(1);
    expect(onActionSucceeded).toHaveBeenCalledWith("repair");

    await renderSection(_fixture, {
      environmentId,
      provider: repairedProvider,
      displayName: "Antigravity",
      initialAction: "repair",
      onActionSucceeded,
    });

    expect(onActionSucceeded).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale successful repair that this section did not start", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const onActionSucceeded = vi.fn();
    const repairedProvider: ServerProvider = {
      ...provider,
      connection: {
        ...provider.connection!,
        runtime: {
          ...provider.connection!.runtime!,
          operation: {
            operationId: "stale-repair",
            action: "repair",
            status: "succeeded",
            startedAt: "2026-08-22T12:00:00.000Z",
            finishedAt: "2026-08-22T12:00:05.000Z",
            message: "The provider runtime was repaired and verified successfully.",
          },
        },
      },
    };

    await renderSection(_fixture, {
      environmentId,
      provider: repairedProvider,
      displayName: "Antigravity",
      onActionSucceeded,
    });

    expect(onActionSucceeded).not.toHaveBeenCalled();
  });

  it("does not persist a successful repair message in the runtime row", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const repairedProvider: ServerProvider = {
      ...provider,
      installed: true,
      version: "1.1.17",
      status: "ready",
      auth: { status: "authenticated", required: true, label: "Google account" },
      connection: {
        methods: ["antigravity_google"],
        canDisconnect: true,
        operation: null,
        runtime: {
          source: "scient_managed",
          supportTier: "fully_assisted",
          target: "darwin-arm64",
          actions: ["repair", "remove"],
          managedVersion: "1.1.17",
          previousManagedVersion: null,
          operation: {
            operationId: "repair-succeeded",
            action: "repair",
            status: "succeeded",
            startedAt: "2026-08-22T12:00:00.000Z",
            finishedAt: "2026-08-22T12:00:05.000Z",
            message: "The provider runtime was repaired and verified successfully.",
          },
          message: "Managed Antigravity is ready.",
        },
      },
    };

    const markup = serialize(
      await renderSection(_fixture, {
        compact: true,
        environmentId,
        provider: repairedProvider,
        displayName: "Antigravity",
      }),
    );

    expect(markup).toContain("Managed by Scient");
    expect(markup).not.toContain("Repaired successfully");
    expect(markup).not.toContain("repaired and verified successfully");
  });

  it.each(["1.1.17", "agy_acp_server_20260818_01_RC01"])(
    "keeps managed maintenance clear for %s",
    async (version) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      const managedProvider: ServerProvider = {
        ...provider,
        installed: true,
        version,
        status: "ready",
        auth: { status: "authenticated", required: true, label: "Google account" },
        connection: {
          methods: ["antigravity_google"],
          canDisconnect: true,
          operation: null,
          runtime: {
            source: "scient_managed",
            supportTier: "fully_assisted",
            target: "darwin-arm64",
            actions: ["update", "repair", "remove"],
            managedVersion: version,
            previousManagedVersion: null,
            operation: null,
            message: "The provider runtime is installed and verified.",
            diagnostics: {
              executable: "/Applications/Scient.app/Contents/Resources/antigravity",
              version,
              homePath: "/Users/server/.gemini",
              backend: "macOS native",
            },
          },
        },
      };

      const markup = serialize(
        await renderSection(_fixture, {
          compact: true,
          environmentId,
          provider: managedProvider,
          displayName: "Antigravity",
        }),
      );

      expect(markup).toContain("Managed by Scient");
      const [summaryMarkup, diagnosticsMarkup] = markup.split("<details");
      expect(summaryMarkup).not.toContain(version);
      expect(summaryMarkup).not.toContain("2026-08-18");
      expect(diagnosticsMarkup).toContain(version);
      const updateIndex = markup.indexOf(">Update<");
      const updateStart = markup.lastIndexOf("<button", updateIndex);
      const updateMarkup = markup.slice(updateStart, updateIndex);
      expect(updateMarkup).toContain("lucide-refresh-cw");
      expect(updateMarkup).toContain("text-primary");
      expect(updateMarkup).not.toContain("lucide-wrench");
      const diagnosticsIndex = markup.indexOf("Runtime diagnostics");
      expect(markup.indexOf(">Repair<")).toBeLessThan(diagnosticsIndex);
      expect(markup.indexOf(">Remove<")).toBeLessThan(diagnosticsIndex);
      expect(diagnosticsIndex).toBeLessThan(updateIndex);
      expect(markup).toContain("flex items-center justify-between gap-3 pt-1");
      expect(markup).toContain(">Repair<");
      expect(markup).toContain(">Remove<");
      expect(markup).not.toContain("installed and verified");
      expect(markup).not.toContain("Private version");
      expect(markup).not.toContain("rounded-lg border p-3");
      expect(markup).not.toContain("border-input");
    },
  );

  it.each([true, false])("keeps the version in diagnostics only (compact=%s)", async (compact) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const version = "2026.09.02-c22c1a3";
    const managedProvider: ServerProvider = {
      ...provider,
      instanceId: ProviderInstanceId.make("cursor"),
      driver: ProviderDriverKind.make("cursor"),
      installed: true,
      version,
      status: "ready",
      connection: {
        ...provider.connection!,
        methods: ["cursor_browser"],
        runtime: {
          ...provider.connection!.runtime!,
          source: "scient_managed",
          actions: ["repair", "remove"],
          managedVersion: version,
          diagnostics: {
            executable: "/private/qa/cursor-agent",
            version,
            homePath: "/private/qa",
            backend: "macOS native",
          },
        },
      },
    };

    const markup = serialize(
      await renderSection(_fixture, {
        compact,
        environmentId,
        provider: managedProvider,
        displayName: "Cursor",
      }),
    );
    const diagnosticsStart = markup.indexOf("<details");
    expect(diagnosticsStart).toBeGreaterThan(-1);
    const summary = markup.slice(0, diagnosticsStart);
    expect(summary).toContain("Cursor CLI managed by Scient");
    expect(summary).not.toContain(version);
    expect(summary).toContain(">Repair<");
    expect(summary).toContain(">Remove<");
    expect(markup.slice(diagnosticsStart)).toContain(version);
    expect(markup).not.toContain(`Cursor ${version}`);
  });

  it.each([true, false])(
    "keeps a terminal runtime failure visible (compact=%s)",
    async (compact) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);
      await _setupFixture2(_fixture);

      const failedProvider: ServerProvider = {
        ...provider,
        installed: true,
        version: "1.1.17",
        connection: {
          methods: ["antigravity_google"],
          canDisconnect: false,
          operation: null,
          runtime: {
            source: "scient_managed",
            supportTier: "fully_assisted",
            target: "darwin-arm64",
            actions: ["repair", "remove"],
            managedVersion: "1.1.17",
            previousManagedVersion: null,
            operation: {
              operationId: "repair-failed",
              action: "repair",
              status: "failed",
              startedAt: "2026-08-22T12:00:00.000Z",
              finishedAt: "2026-08-22T12:00:05.000Z",
              message: "Verification failed after repair.",
            },
            message: "Managed Antigravity needs repair.",
          },
        },
      };

      const markup = serialize(
        await renderSection(_fixture, {
          environmentId,
          compact,
          provider: failedProvider,
          displayName: "Antigravity",
        }),
      );

      expect(markup).toContain("Verification failed after repair");
      expect(markup).not.toContain("Antigravity 1.1.17");
    },
  );

  it("returns to the current runtime state after setup is cancelled", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const cancelledProvider: ServerProvider = {
      ...provider,
      installed: true,
      version: "2.1.170",
      status: "ready",
      connection: {
        methods: ["claude_subscription"],
        canDisconnect: true,
        operation: null,
        runtime: {
          source: "system",
          supportTier: "fully_assisted",
          target: "darwin-arm64",
          actions: ["install"],
          managedVersion: null,
          previousManagedVersion: null,
          operation: {
            operationId: "install-cancelled",
            action: "install",
            status: "cancelled",
            startedAt: "2026-08-22T12:00:00.000Z",
            finishedAt: "2026-08-22T12:00:05.000Z",
            message:
              "Provider runtime setup cancelled. The previous working runtime was preserved.",
          },
          message: "Using a compatible system Claude runtime.",
        },
      },
    };

    const markup = serialize(
      await renderSection(_fixture, {
        compact: true,
        environmentId,
        provider: cancelledProvider,
        displayName: "Claude",
      }),
    );

    expect(markup).toContain("System installation");
    expect(markup).toContain('aria-label="Use Scient-managed Claude"');
    expect(markup).not.toContain("Provider runtime setup cancelled");
    expect(markup).not.toContain("previous working runtime");
  });

  it("shows the current missing-runtime state after removal instead of a stale success row", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await _setupFixture2(_fixture);

    const removedProvider: ServerProvider = {
      ...provider,
      connection: {
        methods: ["antigravity_google"],
        canDisconnect: false,
        operation: null,
        runtime: {
          ...provider.connection!.runtime!,
          operation: {
            operationId: "remove-1",
            action: "remove",
            status: "succeeded",
            startedAt: "2026-08-22T12:00:00.000Z",
            finishedAt: "2026-08-22T12:00:05.000Z",
            message: "Scient's private provider runtime was removed.",
          },
        },
      },
    };

    const markup = serialize(
      await renderSection(_fixture, {
        environmentId,
        provider: removedProvider,
        displayName: "Antigravity",
      }),
    );

    expect(markup).toContain("Provider tool required");
    expect(markup).toContain(">Install</button>");
    expect(markup).not.toContain("Antigravity removed");
    expect(markup).not.toContain("private provider runtime was removed");
  });
});

describe("ProviderRuntimeSection accessible names", () => {
  const managed = (actions: ProviderManagedRuntimeAction[]): ServerProvider => ({
    ...provider,
    installed: true,
    status: "ready",
    connection: {
      ...provider.connection!,
      runtime: {
        ...provider.connection!.runtime!,
        source: "scient_managed",
        managedVersion: "1.1.17",
        actions,
      },
    },
  });
  const render = async (_fixture: _Fixture, snapshot: ServerProvider) => {
    return serialize(
      await renderSection(_fixture, {
        environmentId,
        provider: snapshot,
        displayName: "Antigravity",
      }),
    );
  };

  it("names the provider on its short-verb runtime actions", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    expect(await render(_fixture, provider)).toContain('aria-label="Install Antigravity"');
    const markup = await render(_fixture, managed(["update", "repair", "remove"]));
    expect(markup).toContain('aria-label="Update Antigravity"');
    expect(markup).toContain('aria-label="Repair Antigravity"');
    expect(markup).toContain('aria-label="Remove Antigravity"');
  });

  it("names the provider and the operation on Cancel", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const snapshot = managed(["repair", "remove"]);
    const markup = await render(_fixture, {
      ...snapshot,
      connection: {
        ...snapshot.connection!,
        runtime: {
          ...snapshot.connection!.runtime!,
          operation: {
            operationId: "repair-active",
            action: "repair",
            status: "downloading",
            startedAt: "2026-08-22T12:00:00.000Z",
            finishedAt: null,
            message: "Downloading Antigravity.",
          },
        },
      },
    });
    expect(markup).toContain('aria-label="Cancel Antigravity repair"');
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
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

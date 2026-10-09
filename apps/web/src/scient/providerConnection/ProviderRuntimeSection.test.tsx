import {
  EnvironmentId,
  ProviderConnectionError,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderManagedRuntimeAction,
  type ProviderRuntimePlan,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";

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

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void | (() => void)) => {
      effect();
    },
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

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

import {
  ProviderRuntimeSection,
  resolveProviderRuntimeForPresentation,
} from "./ProviderRuntimeSection";

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

function findActionButton(
  node: unknown,
  label: string,
): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findActionButton(child, label);
      if (found) return found;
    }
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (
    typeof node.props.onClick === "function" &&
    renderToStaticMarkup(<>{node.props.children as ReactNode}</>).endsWith(label)
  )
    return node;
  for (const value of Object.values(node.props)) {
    const found = findActionButton(value, label);
    if (found) return found;
  }
  return undefined;
}

describe("ProviderRuntimeSection", () => {
  it("offers the shared removal command for a Scient-owned registry installation", async () => {
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
    hooks.beginRender();
    ProviderRuntimeSection(props);
    await vi.waitFor(() =>
      expect(commands.plan).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId, action: "remove" },
      }),
    );
    expect(commands.start).not.toHaveBeenCalled();
    hooks.beginRender();
    const plan = ProviderRuntimeSection(props);
    expect(renderToStaticMarkup(plan)).toContain("Remove Registry Agent?");
    const remove = findActionButton(plan, "Remove");
    expect(remove).toBeDefined();
    if (!remove || typeof remove.props.onClick !== "function")
      throw new Error("Expected registry removal action");
    remove.props.onClick();
    await vi.waitFor(() =>
      expect(commands.start).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId, action: "remove", catalogRevision: "owned-installation:1" },
      }),
    );
  });

  it("labels registry ownership without presenting it as a system executable", () => {
    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
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

  it("presents a missing Cursor CLI as separate from bundled SDK execution", () => {
    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
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
    const render = (input: {
      readonly provider: ServerProvider;
      readonly presentation?: "card" | "row";
    }) => {
      hooks.beginRender();
      return renderToStaticMarkup(
        ProviderRuntimeSection({
          environmentId,
          provider: input.provider,
          displayName: "Antigravity",
          ...(input.presentation ? { presentation: input.presentation } : {}),
        }),
      );
    };

    it("renders the managed runtime as a frameless row with its actions beside the status", () => {
      const markup = render({ provider: managedProvider, presentation: "row" });
      expect(markup).toContain("Managed by Scient");
      expect(markup).toContain("Repair");
      expect(markup).toContain("Remove");
      // The surrounding settings section is the only frame.
      expect(markup).not.toContain("rounded-lg border");
      // Status and actions share one line once the row is wide enough.
      expect(markup).toContain("@min-[32rem]/runtime-row:grid-cols-[minmax(0,1fr)_auto]");
      expect(markup).toContain("px-3 py-3 sm:px-4");
    });

    it("keeps its own frame outside settings", () => {
      expect(render({ provider: managedProvider })).toContain("rounded-lg border p-3");
    });

    it("keeps an in-progress operation frameless in a settings row", () => {
      const markup = render({
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
    (canInstall) => {
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
      hooks.beginRender();
      const markup = renderToStaticMarkup(
        ProviderRuntimeSection({
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

  it("preserves a failed Pi install above its retry action", () => {
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
    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
        environmentId,
        provider: piProvider,
        displayName: "Pi",
        compact: true,
      }),
    );
    expect(markup).toContain("Pi download checksum mismatch.");
    expect(markup).toContain("Install");
  });

  beforeEach(() => {
    hooks.reset();
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
  });

  it.each(["install", "update", "repair"] as const)(
    "starts %s once after preflight for an explicit action entry point",
    async (action) => {
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
      hooks.beginRender();
      ProviderRuntimeSection({
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
      hooks.beginRender();
      const markup = renderToStaticMarkup(
        ProviderRuntimeSection({
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

  it.each([false, true])("opening the runtime card is passive (compact=%s)", (compact) => {
    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
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
      hooks.beginRender();
      const button = findActionButton(
        ProviderRuntimeSection(props),
        action === "install" ? "Install" : "Update",
      );
      expect(button).toBeDefined();
      (button!.props.onClick as () => void)();
      expect(commands.plan).toHaveBeenCalledTimes(1);
      expect(commands.start).not.toHaveBeenCalled();
      hooks.beginRender();
      expect(
        findActionButton(ProviderRuntimeSection(props), action === "install" ? "Install" : "Update")
          ?.props.disabled,
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

  it("presents a qualified system-to-managed action as a blue primary choice", () => {
    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
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
    const render = () => {
      hooks.beginRender();
      return ProviderRuntimeSection(props);
    };
    const click = () =>
      (findActionButton(render(), "Use Scient-managed")!.props.onClick as () => void)();
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
        const reviewed = plan(version, older);
        commands.plan.mockResolvedValue({ _tag: "Success", value: reviewed });
        expect(commands.plan).not.toHaveBeenCalled();
        click();
        await vi.waitFor(() =>
          expect(commands.start).toHaveBeenCalledExactlyOnceWith({
            environmentId,
            input: { instanceId: id, action: "install", catalogRevision: reviewed.catalogRevision },
          }),
        );
        const markup = renderToStaticMarkup(render());
        expect(markup).not.toContain(">Back</button>");
        expect(markup).not.toContain("Private copy installation.");
        expect(markup).toContain("text-primary");
      },
    );
    it("refreshes a stale plan once and starts the current managed release", async () => {
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
      click();
      await vi.waitFor(() => expect(commands.start).toHaveBeenCalledTimes(2));
      expect(commands.plan).toHaveBeenCalledTimes(2);
      expect(commands.start.mock.calls[1]![0].input.catalogRevision).toBe("reviewed:2");
      expect(renderToStaticMarkup(render())).not.toContain(">Back</button>");
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
      commands.plan.mockResolvedValue({ _tag: "Success", value: plan(null, false) });
      commands.start.mockResolvedValue(staleResult());
      click();
      await vi.waitFor(() => expect(commands.start).toHaveBeenCalledTimes(2));
      expect(commands.plan).toHaveBeenCalledTimes(2);
      const markup = renderToStaticMarkup(render());
      expect(markup).toContain("Plan changed.");
      expect(markup).not.toContain(">Back</button>");
    });
    it("reports a failed refresh without dispatching another start", async () => {
      commands.plan
        .mockResolvedValueOnce({ _tag: "Success", value: plan(null, false) })
        .mockResolvedValueOnce({
          _tag: "Failure",
          cause: Cause.fail(new Error("Catalog unavailable.")),
        });
      commands.start.mockResolvedValueOnce(staleResult());
      click();
      await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(2));
      expect(commands.start).toHaveBeenCalledTimes(1);
      expect(renderToStaticMarkup(render())).toContain("Catalog unavailable.");
    });
    it("ignores another click while the preflight is pending", async () => {
      let finish!: (value: { _tag: "Success"; value: ProviderRuntimePlan }) => void;
      commands.plan.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      click();
      click();
      expect(commands.plan).toHaveBeenCalledTimes(1);
      finish({ _tag: "Success", value: plan("1.3.0", true) });
      await vi.waitFor(() => expect(commands.start).toHaveBeenCalledTimes(1));
    });
  });

  it("still starts a first installation from its explicit action", async () => {
    hooks.beginRender();
    const section = ProviderRuntimeSection({
      compact: true,
      environmentId,
      provider,
      displayName: "Antigravity",
    });
    const button = findActionButton(section, "Install");
    expect(button).toBeDefined();
    (button!.props.onClick as () => void)();

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
    hooks.beginRender();
    ProviderRuntimeSection(props);
    await vi.waitFor(() => {
      hooks.beginRender();
      const markup = renderToStaticMarkup(ProviderRuntimeSection(props));
      expect(markup).toContain('role="alert"');
      expect(markup).toContain("The provider service is unavailable. Try again.");
    });
    expect(commands.plan).toHaveBeenCalledTimes(1);
    expect(commands.start).toHaveBeenCalledTimes(stage === "plan" ? 0 : 1);
  });

  it("drops an install-plan failure superseded by an active runtime operation", async () => {
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

    hooks.beginRender();
    ProviderRuntimeSection({
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
    hooks.beginRender();
    ProviderRuntimeSection({
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

    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
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

    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
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

    hooks.beginRender();
    ProviderRuntimeSection({
      compact: true,
      environmentId,
      provider,
      displayName: "Antigravity",
      initialAction: "install",
    });
    await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(1));

    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
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

    hooks.beginRender();
    ProviderRuntimeSection({
      compact: true,
      environmentId,
      provider: removableProvider,
      displayName: "Antigravity",
      initialAction: "remove",
      onPlanOpenChange,
    });
    await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(1));

    hooks.beginRender();
    expect(
      renderToStaticMarkup(
        ProviderRuntimeSection({
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
    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
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

    hooks.beginRender();
    ProviderRuntimeSection({
      compact: true,
      environmentId,
      provider: removableProvider,
      displayName: "Antigravity",
      initialAction: "remove",
    });

    await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(1));

    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
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

    hooks.beginRender();
    const section = ProviderRuntimeSection({
      compact: true,
      environmentId,
      provider: removableProvider,
      displayName: "Antigravity",
      initialAction: "remove",
    });
    const button = findActionButton(section, choice);
    expect(button).toBeDefined();
    (button!.props.onClick as () => void)();
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
      hooks.beginRender();
      expect(
        renderToStaticMarkup(
          ProviderRuntimeSection({
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

  it("shows compact download progress beside the quiet cancel action", () => {
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

    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
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

  it("drops stale local removal progress once the server reports the runtime missing", () => {
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

  it("keeps optimistic install progress while the streamed server snapshot catches up", () => {
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

  it("drops stale local install progress once the server reports a managed runtime", () => {
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

    hooks.beginRender();
    ProviderRuntimeSection({
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

    hooks.beginRender();
    ProviderRuntimeSection({
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

    hooks.beginRender();
    ProviderRuntimeSection({
      environmentId,
      provider: repairedProvider,
      displayName: "Antigravity",
      initialAction: "repair",
      onActionSucceeded,
    });

    expect(onActionSucceeded).toHaveBeenCalledTimes(1);
    expect(onActionSucceeded).toHaveBeenCalledWith("repair");

    hooks.beginRender();
    ProviderRuntimeSection({
      environmentId,
      provider: repairedProvider,
      displayName: "Antigravity",
      initialAction: "repair",
      onActionSucceeded,
    });

    expect(onActionSucceeded).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale successful repair that this section did not start", () => {
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

    hooks.beginRender();
    ProviderRuntimeSection({
      environmentId,
      provider: repairedProvider,
      displayName: "Antigravity",
      onActionSucceeded,
    });

    expect(onActionSucceeded).not.toHaveBeenCalled();
  });

  it("does not persist a successful repair message in the runtime row", () => {
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

    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
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
    (version) => {
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

      hooks.beginRender();
      const markup = renderToStaticMarkup(
        ProviderRuntimeSection({
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

  it.each([true, false])("keeps the version in diagnostics only (compact=%s)", (compact) => {
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
    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
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

  it.each([true, false])("keeps a terminal runtime failure visible (compact=%s)", (compact) => {
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

    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
        environmentId,
        compact,
        provider: failedProvider,
        displayName: "Antigravity",
      }),
    );

    expect(markup).toContain("Verification failed after repair");
    expect(markup).not.toContain("Antigravity 1.1.17");
  });

  it("returns to the current runtime state after setup is cancelled", () => {
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

    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
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

  it("shows the current missing-runtime state after removal instead of a stale success row", () => {
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

    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
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
  const render = (snapshot: ServerProvider) => {
    hooks.beginRender();
    return renderToStaticMarkup(
      ProviderRuntimeSection({ environmentId, provider: snapshot, displayName: "Antigravity" }),
    );
  };

  it("names the provider on its short-verb runtime actions", () => {
    expect(render(provider)).toContain('aria-label="Install Antigravity"');
    const markup = render(managed(["update", "repair", "remove"]));
    expect(markup).toContain('aria-label="Update Antigravity"');
    expect(markup).toContain('aria-label="Repair Antigravity"');
    expect(markup).toContain('aria-label="Remove Antigravity"');
  });

  it("names the provider and the operation on Cancel", () => {
    const snapshot = managed(["repair", "remove"]);
    const markup = render({
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

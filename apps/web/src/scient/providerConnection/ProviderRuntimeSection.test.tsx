import {
  EnvironmentId,
  ProviderConnectionError,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderManagedRuntimeAction,
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

  it("presents a qualified system-to-managed action as a compact secondary choice", () => {
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
    expect(actionMarkup).toContain("text-muted-foreground");
    expect(actionMarkup).not.toContain("bg-primary");
  });

  it.each(["Back", "Use Scient-managed"])(
    "names both versions before a system-to-managed switch and honors %s",
    async (choice) => {
      const systemProvider: ServerProvider = {
        ...provider,
        installed: true,
        version: "1.0.9",
        connection: {
          ...provider.connection!,
          runtime: {
            ...provider.connection!.runtime!,
            source: "system",
            actions: ["install"],
            message: "Using a compatible system Antigravity runtime.",
          },
        },
      };
      const switchMessage =
        "Scient will install private Antigravity 1.1.27 and use it instead of the system installation (1.0.9), which stays untouched.";
      commands.plan.mockResolvedValue({
        _tag: "Success",
        value: {
          instanceId,
          action: "install",
          target: "darwin-arm64",
          version: "1.1.27",
          downloadBytes: 1024,
          sourceLabel: "Official Google Antigravity CLI release",
          catalogRevision: "reviewed:1",
          message: switchMessage,
        },
      });
      const onPlanOpenChange = vi.fn();
      const props = {
        compact: true,
        environmentId,
        provider: systemProvider,
        displayName: "Antigravity",
        onPlanOpenChange,
      };

      hooks.beginRender();
      const section = ProviderRuntimeSection(props);
      expect(commands.plan).not.toHaveBeenCalled();
      const button = findActionButton(section, "Use Scient-managed");
      expect(button).toBeDefined();
      (button!.props.onClick as () => void)();
      await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(1));

      // The switch waits for a decision made with both versions in view.
      hooks.beginRender();
      const review = renderToStaticMarkup(ProviderRuntimeSection(props));
      expect(review).toContain("Use Scient-managed Antigravity 1.1.27?");
      expect(review).toContain(switchMessage);
      expect(review).toContain(">Back</button>");
      expect(commands.start).not.toHaveBeenCalled();
      expect(onPlanOpenChange).toHaveBeenLastCalledWith(true);

      hooks.beginRender();
      const decision = findActionButton(ProviderRuntimeSection(props), choice);
      expect(decision).toBeDefined();
      (decision!.props.onClick as () => void)();
      if (choice === "Back") {
        hooks.beginRender();
        const markup = renderToStaticMarkup(ProviderRuntimeSection(props));
        expect(markup).not.toContain("Use Scient-managed Antigravity 1.1.27?");
        expect(markup).toContain("System installation");
        expect(commands.start).not.toHaveBeenCalled();
        expect(onPlanOpenChange).toHaveBeenLastCalledWith(false);
        return;
      }
      await vi.waitFor(() =>
        expect(commands.start).toHaveBeenCalledWith({
          environmentId,
          input: { instanceId, action: "install", catalogRevision: "reviewed:1" },
        }),
      );
      hooks.beginRender();
      expect(renderToStaticMarkup(ProviderRuntimeSection(props))).toContain(
        "Preparing the provider runtime operation.",
      );
    },
  );

  describe.each([
    { driver: "droid", name: "Droid", runtimeName: "Droid" },
    { driver: "cursor", name: "Cursor", runtimeName: "Cursor CLI" },
  ] as const)("$runtimeName switch to a managed release older than the system runtime", (entry) => {
    const systemProvider: ServerProvider = {
      ...provider,
      instanceId: ProviderInstanceId.make(entry.driver),
      driver: ProviderDriverKind.make(entry.driver),
      installed: true,
      version: "0.231.0",
      status: "ready",
      connection: {
        ...provider.connection!,
        runtime: {
          ...provider.connection!.runtime!,
          source: "system",
          actions: ["install"],
          message: `Scient is using the healthy ${entry.runtimeName} runtime already installed on this computer.`,
        },
      },
    };
    const runtimeInstanceId = systemProvider.instanceId;
    const olderMessage = `Scient-managed ${entry.runtimeName} 0.230.0 is older than your installed ${entry.runtimeName} 0.231.0. Scient will use its own verified copy; your installation stays as it is.`;
    const olderPlan = {
      instanceId: runtimeInstanceId,
      action: "install" as const,
      target: "darwin-arm64",
      version: "0.230.0",
      downloadBytes: 1024,
      sourceLabel: `Official Factory ${entry.runtimeName} release`,
      catalogRevision: "reviewed:1:older-than-system",
      message: olderMessage,
      systemVersion: "0.231.0",
      olderThanSystem: true,
    };
    const stale = () => ({
      _tag: "Failure" as const,
      cause: Cause.fail(
        new ProviderConnectionError({
          provider: systemProvider.driver,
          instanceId: runtimeInstanceId,
          reason: "runtime_plan_stale",
          message: "The provider setup plan changed. Review it again before continuing.",
        }),
      ),
    });
    const props = {
      compact: true,
      environmentId,
      provider: systemProvider,
      displayName: entry.name,
    };
    const render = () => {
      hooks.beginRender();
      return ProviderRuntimeSection(props);
    };
    const click = (label: string) => {
      const button = findActionButton(render(), label);
      expect(button).toBeDefined();
      (button!.props.onClick as () => void)();
    };

    it("is offered, and starts only once both versions were shown and accepted", async () => {
      commands.plan.mockResolvedValue({ _tag: "Success", value: olderPlan });

      expect(renderToStaticMarkup(render())).toContain(
        `aria-label="Use Scient-managed ${entry.runtimeName}"`,
      );
      click("Use Scient-managed");
      await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(1));

      const review = renderToStaticMarkup(render());
      expect(review).toContain(`Use Scient-managed ${entry.runtimeName} 0.230.0?`);
      expect(review).toContain(olderMessage);
      expect(review).toContain("lucide-triangle-alert");
      expect(review).toContain(">Back</button>");
      expect(commands.start).not.toHaveBeenCalled();

      click("Use Scient-managed");
      await vi.waitFor(() =>
        expect(commands.start).toHaveBeenCalledWith({
          environmentId,
          input: {
            instanceId: runtimeInstanceId,
            action: "install",
            catalogRevision: olderPlan.catalogRevision,
            acceptOlderThanSystem: true,
          },
        }),
      );
    });

    it("returns to runtime controls on Back without starting", async () => {
      commands.plan.mockResolvedValue({ _tag: "Success", value: olderPlan });
      click("Use Scient-managed");
      await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(1));
      expect(renderToStaticMarkup(render())).toContain(olderMessage);

      click("Back");

      const markup = renderToStaticMarkup(render());
      expect(markup).not.toContain(olderMessage);
      expect(markup).toContain(`aria-label="Use Scient-managed ${entry.runtimeName}"`);
      expect(commands.start).not.toHaveBeenCalled();
    });

    it("accepts a switch from a system runtime of unknown version from its decision", async () => {
      const unknownPlan = {
        ...olderPlan,
        catalogRevision: "reviewed:1:system-version-unknown",
        message: `Scient does not know which ${entry.runtimeName} version, if any, is installed on this computer (system version unknown), so Scient-managed ${entry.runtimeName} 0.230.0 may be older than it.`,
        systemVersion: null,
        olderThanSystem: false,
      };
      commands.plan.mockResolvedValue({ _tag: "Success", value: unknownPlan });
      click("Use Scient-managed");
      await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(1));

      const review = renderToStaticMarkup(render());
      expect(review).toContain("system version unknown");
      expect(review).toContain("lucide-triangle-alert");
      expect(commands.start).not.toHaveBeenCalled();

      click("Use Scient-managed");
      await vi.waitFor(() => expect(commands.start).toHaveBeenCalledTimes(1));
      expect(commands.start.mock.calls[0]![0].input).toMatchObject({
        catalogRevision: unknownPlan.catalogRevision,
        acceptOlderThanSystem: true,
      });
    });

    it.each([
      ["a system runtime that is not newer", "0.229.0", false, false],
      ["a newer system runtime", "0.231.0", true, true],
      ["a system runtime of unknown version", null, false, true],
    ] as const)(
      "asks before a Repair that puts a never-selected copy in use beside %s",
      async (_label, systemVersion, olderThanSystem, accepts) => {
        // The copy looked like the runtime in use; the plan found the system one.
        const legacy = {
          ...props,
          provider: {
            ...systemProvider,
            connection: {
              ...systemProvider.connection!,
              runtime: {
                ...systemProvider.connection!.runtime!,
                source: "scient_managed" as const,
                actions: ["repair" as const, "remove" as const],
                managedVersion: "0.230.0",
              },
            },
          },
        };
        const repairPlan = {
          ...olderPlan,
          action: "repair" as const,
          catalogRevision: "reviewed:1:repair",
          message: `Repair plan beside ${systemVersion ?? "an unknown version"}.`,
          systemVersion,
          olderThanSystem,
        };
        commands.plan.mockResolvedValue({ _tag: "Success", value: repairPlan });
        const renderLegacy = () => {
          hooks.beginRender();
          return ProviderRuntimeSection(legacy);
        };
        const button = findActionButton(renderLegacy(), "Repair");
        (button!.props.onClick as () => void)();
        await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(1));

        // The same decision as "Use Scient-managed": nothing starts from the click.
        const review = renderToStaticMarkup(renderLegacy());
        expect(review).toContain(`Use Scient-managed ${entry.runtimeName} 0.230.0?`);
        expect(review).toContain(repairPlan.message);
        expect(commands.start).not.toHaveBeenCalled();

        const confirm = findActionButton(renderLegacy(), "Use Scient-managed");
        (confirm!.props.onClick as () => void)();
        await vi.waitFor(() => expect(commands.start).toHaveBeenCalledTimes(1));
        expect(commands.start.mock.calls[0]![0].input).toEqual({
          instanceId: runtimeInstanceId,
          action: "repair",
          catalogRevision: repairPlan.catalogRevision,
          ...(accepts ? { acceptOlderThanSystem: true } : {}),
        });
      },
    );

    it("asks before an install that turns out to replace a newer system runtime", async () => {
      // Offered as a first installation; the plan found a system runtime installed since.
      const missing = {
        ...props,
        provider: {
          ...systemProvider,
          connection: {
            ...systemProvider.connection!,
            runtime: {
              ...systemProvider.connection!.runtime!,
              source: "missing" as const,
            },
          },
        },
      };
      commands.plan.mockResolvedValue({ _tag: "Success", value: olderPlan });
      const onPlanOpenChange = vi.fn();
      hooks.beginRender();
      const button = findActionButton(
        ProviderRuntimeSection({ ...missing, onPlanOpenChange }),
        "Install",
      );
      (button!.props.onClick as () => void)();
      await vi.waitFor(() => expect(onPlanOpenChange).toHaveBeenLastCalledWith(true));

      hooks.beginRender();
      expect(
        renderToStaticMarkup(ProviderRuntimeSection({ ...missing, onPlanOpenChange })),
      ).toContain(olderMessage);
      expect(commands.start).not.toHaveBeenCalled();
    });

    it("shows the switch again when the system runtime was upgraded after the plan", async () => {
      const reviewed = {
        ...olderPlan,
        catalogRevision: "reviewed:1",
        message: `Scient will install private ${entry.runtimeName} 0.230.0 and use it instead of the system installation (0.229.0), which stays untouched.`,
        systemVersion: "0.229.0",
        olderThanSystem: false,
      };
      commands.plan.mockResolvedValueOnce({ _tag: "Success", value: reviewed });
      click("Use Scient-managed");
      await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(1));
      expect(renderToStaticMarkup(render())).toContain("system installation (0.229.0)");

      // Droid updated itself meanwhile: the server does not carry out the plan as it was.
      commands.start.mockResolvedValueOnce(stale());
      commands.plan.mockResolvedValueOnce({ _tag: "Success", value: olderPlan });
      click("Use Scient-managed");
      await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(2));
      expect(commands.start).toHaveBeenCalledTimes(1);
      expect(commands.start.mock.calls[0]![0].input).not.toHaveProperty("acceptOlderThanSystem");

      // Not an error and not a silent start: the current decision.
      const updated = renderToStaticMarkup(render());
      expect(updated).toContain(olderMessage);
      expect(updated).not.toContain('role="alert"');
      expect(updated).toContain(">Back</button>");

      click("Use Scient-managed");
      await vi.waitFor(() => expect(commands.start).toHaveBeenCalledTimes(2));
      expect(commands.start.mock.calls[1]![0].input).toMatchObject({
        catalogRevision: olderPlan.catalogRevision,
        acceptOlderThanSystem: true,
      });
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

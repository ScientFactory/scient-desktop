import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";
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

describe("ProviderRuntimeSection", () => {
  beforeEach(() => {
    hooks.reset();
    commands.start.mockReset();
    commands.cancel.mockReset();
    commands.plan.mockReset().mockResolvedValue({
      _tag: "Success",
      value: {
        instanceId,
        action: "install",
        target: "darwin-arm64",
        version: "1.1.17",
        downloadBytes: 42,
        sourceLabel: "Official Google Antigravity CLI release",
        catalogRevision: "reviewed:1",
        message: "Install the reviewed Antigravity release.",
      },
    });
  });

  it("prepares the install review immediately for an explicit install entry point", async () => {
    hooks.beginRender();
    ProviderRuntimeSection({
      environmentId,
      provider,
      displayName: "Antigravity",
      initialAction: "install",
    });

    await Promise.resolve();

    expect(commands.plan).toHaveBeenCalledTimes(1);
    expect(commands.plan).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, action: "install" },
    });
    expect(commands.start).not.toHaveBeenCalled();
  });

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

  it("keeps the managed install review flat in the Antigravity dialog", async () => {
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

    expect(markup).toContain("Install Antigravity");
    expect(markup).toContain("Version 1.1.17 · macOS · Apple silicon · about 1 MB");
    expect(markup).not.toContain("Official Google release");
    expect(markup).toContain(">Install<");
    expect(markup).not.toContain("download, verify, stage, test, and activate");
    expect(markup).not.toContain("Computer");
    expect(markup).not.toContain(">Version<");
    expect(markup).not.toContain("Source");
    expect(markup).not.toContain("rounded-lg border");
    expect(markup).not.toContain("bg-primary/[0.03]");
    expect(markup).toContain("border-transparent");
    expect(markup).toContain("text-primary");
    expect(markup).not.toContain("text-primary-foreground");
  });

  it("keeps removal confirmation focused on the decision", async () => {
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
      provider,
      displayName: "Antigravity",
      initialAction: "remove",
    });

    await vi.waitFor(() => expect(commands.plan).toHaveBeenCalledTimes(1));

    hooks.beginRender();
    const markup = renderToStaticMarkup(
      ProviderRuntimeSection({
        compact: true,
        environmentId,
        provider,
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
  });

  it("uses a quiet cancel action for compact runtime progress", () => {
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
            status: "testing",
            startedAt: "2026-08-22T12:00:00.000Z",
            finishedAt: null,
            message: "Testing the installed Antigravity runtime.",
            downloadedBytes: 0,
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

    expect(markup).toContain("Testing the installed Antigravity runtime");
    expect(markup).not.toContain("previous working runtime");
    expect(markup).not.toContain("Provider download progress");
    expect(markup).not.toContain(">0%<");
    expect(markup).toContain("space-y-4 py-1");
    expect(markup).not.toContain("min-h-44");
    expect(markup).toContain('class="flex justify-end pt-1"><button');
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
      provider,
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

    expect(markup).toContain("Antigravity 1.1.17");
    expect(markup).not.toContain("Repaired successfully");
    expect(markup).not.toContain("repaired and verified successfully");
  });

  it("keeps healthy managed runtime maintenance clear and preserves its actions", () => {
    const managedProvider: ServerProvider = {
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
          operation: null,
          message: "The provider runtime is installed and verified.",
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
    expect(markup).toContain("Antigravity 1.1.17");
    expect(markup).toContain(">Repair<");
    expect(markup).toContain(">Remove<");
    expect(markup).not.toContain("installed and verified");
    expect(markup).not.toContain("Private version");
    expect(markup).not.toContain("rounded-lg border p-3");
    expect(markup).not.toContain("border-input");
  });

  it("never hides a terminal runtime failure behind the installed version", () => {
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
        provider: failedProvider,
        displayName: "Antigravity",
      }),
    );

    expect(markup).toContain("Verification failed after repair");
    expect(markup).toContain("Antigravity 1.1.17");
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
    expect(markup).toContain("Review setup");
    expect(markup).not.toContain("Antigravity removed");
    expect(markup).not.toContain("private provider runtime was removed");
  });
});

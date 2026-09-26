// @vitest-environment happy-dom

import {
  type EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildLocalEnvironmentUpdateGroups,
  type LocalEnvironmentUpdateGroup,
} from "./ProviderUpdateLaunchNotification.logic";

interface RecordedToast {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly description?: string;
  readonly actionProps?: { readonly children?: unknown; readonly onClick?: () => void };
  readonly data?: {
    readonly onClose?: () => void;
    readonly secondaryActionProps?: { readonly children?: unknown; readonly onClick?: () => void };
  };
}

const testState = vi.hoisted(() => ({
  groups: [] as LocalEnvironmentUpdateGroup[],
  toasts: [] as RecordedToast[],
  closed: [] as string[],
  navigate: vi.fn(),
  startRuntimeAction: vi.fn(),
  dismissNotificationKey: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => testState.navigate }));
vi.mock("~/state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("~/connection/desktopLocal", () => ({ isDesktopLocalConnectionTarget: () => false }));
vi.mock("~/scient/providerConnection/useProviderLifecycleController", () => ({
  useStartProviderRuntimeAction: () => testState.startRuntimeAction,
}));
vi.mock("../providerUpdateDismissal", () => ({
  useDismissedProviderUpdateNotificationKeys: () => ({
    dismissedNotificationKeys: new Set<string>(),
    dismissNotificationKey: testState.dismissNotificationKey,
  }),
}));
vi.mock("./ProviderUpdateEnvironmentRows", () => ({ ProviderUpdateEnvironmentRows: () => null }));
vi.mock("./ProviderUpdatePrimaryNotification", () => ({
  ProviderUpdatePrimaryNotification: () => null,
}));
vi.mock("./ProviderUpdateLaunchNotification.environments", () => ({
  useLocalEnvironmentUpdateGroups: () => ({ groups: testState.groups, isAnySettling: false }),
}));
vi.mock("./ui/toast", () => ({
  hiddenToastActionProps: { children: null },
  stackedThreadToast: (options: object) => options,
  toastManager: {
    add: (options: Omit<RecordedToast, "id">) => {
      const id = `toast-${testState.toasts.length + 1}`;
      testState.toasts.push({ ...options, id });
      return id;
    },
    close: (id: string) => {
      testState.closed.push(id);
    },
    update: (id: string, patch: Partial<RecordedToast>) => {
      const index = testState.toasts.findIndex((toast) => toast.id === id);
      if (index >= 0) testState.toasts[index] = { ...testState.toasts[index]!, ...patch };
    },
  },
}));

// Prompts are shown once per app session, so each test loads a fresh module.
let ManagedRuntimeUpdateNotification: typeof import("./ProviderUpdateLaunchNotification").ManagedRuntimeUpdateNotification;

const macos = "local:macos" as EnvironmentId;
const wsl = "local:wsl" as EnvironmentId;

function codex(
  patch: {
    readonly managedVersion?: string;
    readonly actions?: ReadonlyArray<"update" | "repair" | "remove">;
    readonly operation?: Partial<ProviderRuntimeOperation> | null;
  } = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: patch.managedVersion ?? "0.157.0",
    status: "ready",
    auth: { status: "authenticated", required: true },
    checkedAt: "2026-09-26T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    connection: {
      methods: ["codex_browser"],
      canDisconnect: true,
      operation: null,
      runtime: {
        source: "scient_managed",
        supportTier: "fully_assisted",
        target: "darwin-arm64",
        actions: [...(patch.actions ?? ["update", "repair", "remove"])],
        managedVersion: patch.managedVersion ?? "0.157.0",
        availableManagedVersion: "0.157.1",
        previousManagedVersion: null,
        message: "Managed Codex.",
        operation: patch.operation
          ? {
              operationId: "op-1",
              action: "update",
              status: "downloading",
              startedAt: "2026-09-26T10:00:00.000Z",
              finishedAt: null,
              message: "Downloading.",
              ...patch.operation,
            }
          : null,
      },
    },
  };
}

function setGroups(
  ...environments: ReadonlyArray<{ id: EnvironmentId; label: string; providers: ServerProvider[] }>
) {
  testState.groups = buildLocalEnvironmentUpdateGroups(
    environments.map(({ id, label, providers }) => ({
      environmentId: id,
      label,
      isPrimary: id === macos,
      connectionState: "ready" as const,
      providers,
    })),
  ).groups;
}

const roots: ReturnType<typeof createRoot>[] = [];
let root: ReturnType<typeof createRoot>;

async function render() {
  await act(async () => root.render(<ManagedRuntimeUpdateNotification />));
}

function toastTitled(title: string) {
  const toast = testState.toasts.find((candidate) => candidate.title === title);
  if (!toast) {
    throw new Error(
      `No toast titled "${title}"; saw ${testState.toasts.map((t) => t.title).join(", ")}`,
    );
  }
  return toast;
}

async function click(action: { readonly onClick?: () => void } | undefined) {
  await act(async () => {
    action?.onClick?.();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  vi.resetModules();
  ({ ManagedRuntimeUpdateNotification } = await import("./ProviderUpdateLaunchNotification"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.groups = [];
  testState.toasts = [];
  testState.closed = [];
  testState.navigate.mockReset();
  testState.dismissNotificationKey.mockReset();
  testState.startRuntimeAction.mockReset();
  testState.startRuntimeAction.mockResolvedValue(codex({ operation: { status: "preparing" } }));
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  roots.push(root);
});

afterEach(async () => {
  for (const mounted of roots.splice(0)) await act(() => mounted.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("managed runtime update notification", () => {
  it("offers Update first and keeps Settings pointed at the exact provider", async () => {
    setGroups({ id: macos, label: "macOS", providers: [codex()] });
    await render();

    const prompt = toastTitled("Update available for Codex v0.157.1 in macOS");
    expect(prompt.actionProps?.children).toBe("Update");
    expect(prompt.data?.secondaryActionProps?.children).toBe("Settings");

    await click(prompt.data?.secondaryActionProps);
    expect(testState.navigate).toHaveBeenCalledWith({
      to: "/settings/providers",
      search: { environmentId: macos, instanceId: "codex" },
    });
    expect(testState.startRuntimeAction).not.toHaveBeenCalled();
    expect(testState.dismissNotificationKey).not.toHaveBeenCalled();
  });

  it("installs in place and reports the verified version", async () => {
    setGroups({ id: macos, label: "macOS", providers: [codex()] });
    await render();
    const prompt = toastTitled("Update available for Codex v0.157.1 in macOS");

    await click(prompt.actionProps);
    await click(prompt.actionProps);
    expect(testState.startRuntimeAction).toHaveBeenCalledTimes(1);
    expect(testState.startRuntimeAction).toHaveBeenCalledWith({
      environmentId: macos,
      instanceId: "codex",
      action: "update",
    });
    expect(testState.closed).toContain(prompt.id);
    expect(testState.dismissNotificationKey).not.toHaveBeenCalled();
    expect(toastTitled("Updating Codex v0.157.1").type).toBe("loading");

    setGroups({ id: macos, label: "macOS", providers: [codex({ operation: {} })] });
    await render();
    setGroups({
      id: macos,
      label: "macOS",
      providers: [
        codex({
          managedVersion: "0.157.1",
          actions: ["repair", "remove"],
          operation: { status: "succeeded" },
        }),
      ],
    });
    await render();
    expect(toastTitled("Codex updated to v0.157.1").type).toBe("success");
  });

  it("shows the server's wait for running turns and keeps Settings reachable", async () => {
    setGroups({ id: macos, label: "macOS", providers: [codex()] });
    await render();
    await click(toastTitled("Update available for Codex v0.157.1 in macOS").actionProps);

    setGroups({
      id: macos,
      label: "macOS",
      providers: [
        codex({
          operation: {
            status: "activating",
            waitingForIdle: true,
            message: "Ready. Waiting for running Codex turns to finish before switching.",
          },
        }),
      ],
    });
    await render();
    const waiting = toastTitled("Codex will update when idle");
    expect(waiting.description).toBe(
      "Ready. Waiting for running Codex turns to finish before switching.",
    );
    expect(waiting.actionProps?.children).toBe("Settings");

    await click(waiting.actionProps);
    expect(testState.navigate).toHaveBeenCalledWith({
      to: "/settings/providers",
      search: { environmentId: macos, instanceId: "codex" },
    });
  });

  it("stays quiet when the update is cancelled from Settings", async () => {
    setGroups({ id: macos, label: "macOS", providers: [codex()] });
    await render();
    await click(toastTitled("Update available for Codex v0.157.1 in macOS").actionProps);
    const toastCount = testState.toasts.length;

    setGroups({
      id: macos,
      label: "macOS",
      providers: [codex({ operation: { status: "cancelled", message: "Cancelled." } })],
    });
    await render();
    expect(testState.toasts).toHaveLength(toastCount);
    expect(testState.closed).toContain(toastTitled("Updating Codex v0.157.1").id);
  });

  it("surfaces a failed install and retries it", async () => {
    setGroups({ id: macos, label: "macOS", providers: [codex()] });
    await render();
    await click(toastTitled("Update available for Codex v0.157.1 in macOS").actionProps);

    setGroups({
      id: macos,
      label: "macOS",
      providers: [codex({ operation: { status: "failed", message: "Checksum mismatch." } })],
    });
    await render();
    const failure = toastTitled("Codex update failed");
    expect(failure).toMatchObject({ type: "error", description: "Checksum mismatch." });
    expect(failure.data?.secondaryActionProps?.children).toBe("Settings");

    await click(failure.actionProps);
    expect(testState.startRuntimeAction).toHaveBeenCalledTimes(2);
  });

  it("reports a rejected start instead of waiting forever", async () => {
    testState.startRuntimeAction.mockRejectedValue(new Error("The plan changed."));
    setGroups({ id: macos, label: "macOS", providers: [codex()] });
    await render();
    await click(toastTitled("Update available for Codex v0.157.1 in macOS").actionProps);
    await render();
    expect(toastTitled("Codex update failed").description).toBe("The plan changed.");
  });

  it("opens every provider in Settings when updates span environments", async () => {
    setGroups(
      { id: macos, label: "macOS", providers: [codex()] },
      { id: wsl, label: "WSL", providers: [codex()] },
    );
    await render();
    await click(toastTitled("2 managed provider updates available").data?.secondaryActionProps);
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/settings/providers" });
  });
});

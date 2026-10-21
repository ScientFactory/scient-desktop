import { render as _fixtureRender, type Screen, act } from "../../test/render";
import {
  type EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeOperation,
  type ServerProvider,
} from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";

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
  offersToasts: true,
  primaryPrompt: vi.fn(() => null),
}));

vi.mock("@tanstack/react-router", async (_actualRouter) => ({
  ...(await _actualRouter<typeof import("@tanstack/react-router")>()),
  useNavigate: () => testState.navigate,
}));
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
  ProviderUpdatePrimaryNotification: testState.primaryPrompt,
}));
vi.mock("~/scient/desktopUpdate/updateAvailabilityToasts", () => ({
  offersProviderUpdateToasts: () => testState.offersToasts,
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

// Browser module caches survive vi.resetModules; a fresh entry preserves each test's app session.
let ManagedRuntimeUpdateNotification: typeof import("./ProviderUpdateLaunchNotification").ManagedRuntimeUpdateNotification;
let ProviderUpdateLaunchNotification: typeof import("./ProviderUpdateLaunchNotification").ProviderUpdateLaunchNotification;
let notificationSession = 0;

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

async function render(_fixture: _Fixture) {
  await act(async () => await _fixture.root1.rerender(<ManagedRuntimeUpdateNotification />));
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

async function _setupFixture0(_fixture: _Fixture) {
  ({ ProviderUpdateLaunchNotification } = await import("./ProviderUpdateLaunchNotification"));
  const entry = new URL(
    "../scient/providerConnection/ManagedRuntimeUpdateNotification.tsx",
    import.meta.url,
  );
  entry.searchParams.set("notificationSession", String(++notificationSession));
  const notification: typeof import("../scient/providerConnection/ManagedRuntimeUpdateNotification") =
    await import(/* @vite-ignore */ entry.href);
  ManagedRuntimeUpdateNotification = notification.ManagedRuntimeUpdateNotification;
  testState.offersToasts = true;
  testState.primaryPrompt.mockClear();

  testState.groups = [];
  testState.toasts = [];
  testState.closed = [];
  testState.navigate.mockReset();
  testState.dismissNotificationKey.mockReset();
  testState.startRuntimeAction.mockReset();
  testState.startRuntimeAction.mockResolvedValue(codex({ operation: { status: "preparing" } }));
  const host = document.createElement("div");
  document.body.append(_ownDOM(_fixture, host));
  _fixture.root1 = _fixture.stack.use(
    await _fixtureRender(null, { container: host, router: false }),
  );
  _fixture.root0.push(_fixture.root1);
}

async function _cleanupFixture1(_fixture: _Fixture) {
  for (const mounted of _fixture.root0.splice(0)) await act(() => mounted.unmount());
  _clearOwnedDOM(_fixture);
  vi.unstubAllGlobals();
}

describe("managed runtime update notification", () => {
  it("offers Update first and keeps Settings pointed at the exact provider", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    setGroups({ id: macos, label: "macOS", providers: [codex()] });
    await render(_fixture);

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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    setGroups({ id: macos, label: "macOS", providers: [codex()] });
    await render(_fixture);
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
    await render(_fixture);
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
    await render(_fixture);
    expect(toastTitled("Codex updated to v0.157.1").type).toBe("success");
  });

  it("shows the server's wait for running turns and keeps Settings reachable", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    setGroups({ id: macos, label: "macOS", providers: [codex()] });
    await render(_fixture);
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
    await render(_fixture);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    setGroups({ id: macos, label: "macOS", providers: [codex()] });
    await render(_fixture);
    await click(toastTitled("Update available for Codex v0.157.1 in macOS").actionProps);
    const toastCount = testState.toasts.length;

    setGroups({
      id: macos,
      label: "macOS",
      providers: [codex({ operation: { status: "cancelled", message: "Cancelled." } })],
    });
    await render(_fixture);
    expect(testState.toasts).toHaveLength(toastCount);
    expect(testState.closed).toContain(toastTitled("Updating Codex v0.157.1").id);
  });

  it("surfaces a failed install and retries it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    setGroups({ id: macos, label: "macOS", providers: [codex()] });
    await render(_fixture);
    await click(toastTitled("Update available for Codex v0.157.1 in macOS").actionProps);

    setGroups({
      id: macos,
      label: "macOS",
      providers: [codex({ operation: { status: "failed", message: "Checksum mismatch." } })],
    });
    await render(_fixture);
    const failure = toastTitled("Codex update failed");
    expect(failure).toMatchObject({ type: "error", description: "Checksum mismatch." });
    expect(failure.data?.secondaryActionProps?.children).toBe("Settings");

    await click(failure.actionProps);
    expect(testState.startRuntimeAction).toHaveBeenCalledTimes(2);
  });

  it("reports a rejected start instead of waiting forever", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    testState.startRuntimeAction.mockRejectedValue(new Error("The plan changed."));
    setGroups({ id: macos, label: "macOS", providers: [codex()] });
    await render(_fixture);
    await click(toastTitled("Update available for Codex v0.157.1 in macOS").actionProps);
    await render(_fixture);
    expect(toastTitled("Codex update failed").description).toBe("The plan changed.");
  });

  it("opens every provider in Settings when updates span environments", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    setGroups(
      { id: macos, label: "macOS", providers: [codex()] },
      { id: wsl, label: "WSL", providers: [codex()] },
    );
    await render(_fixture);
    await click(toastTitled("2 managed provider updates available").data?.secondaryActionProps);
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/settings/providers" });
  });
});

describe("update availability on desktop", () => {
  it("leaves the managed runtime offer to the sidebar circle", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    testState.offersToasts = false;
    setGroups({ id: macos, label: "macOS", providers: [codex()] });
    await render(_fixture);
    expect(testState.toasts).toEqual([]);
  });

  it("mounts the provider CLI prompts only where toasts offer updates", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    testState.offersToasts = false;
    await act(async () => await _fixture.root1.rerender(<ProviderUpdateLaunchNotification />));
    expect(testState.primaryPrompt).not.toHaveBeenCalled();

    testState.offersToasts = true;
    await act(
      async () => await _fixture.root1.rerender(<ProviderUpdateLaunchNotification key="browser" />),
    );
    expect(testState.primaryPrompt).toHaveBeenCalled();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    stack,
    cleanup,
    root0: [] as Screen[],
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

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}

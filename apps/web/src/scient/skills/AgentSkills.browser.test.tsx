import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environmentId: "local",
  providers: [] as ServerProvider[],
  setEnabled: vi.fn(),
  refreshProviders: vi.fn(),
  toast: vi.fn(),
  document: {
    instructions: "# External instructions",
    unavailableReason: undefined as string | undefined,
  },
}));

vi.mock("@effect/atom-react", async (actual) => ({
  ...(await actual<typeof import("@effect/atom-react")>()),
  useAtomValue: () => state.providers,
}));
vi.mock("../../state/server", () => ({
  primaryServerProvidersAtom: null,
  serverEnvironment: { refreshProviders: "refresh-providers" },
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => state.environmentId,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "refresh-providers" ? state.refreshProviders : state.setEnabled,
}));
vi.mock("./scientSkillsState", () => ({
  setProviderSkillEnabled: null,
  providerSkillDocument: (input: unknown) => input,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.document, error: null }),
}));
vi.mock("../extensions/ExtensionContentDialog", () => ({
  ExtensionContentDialog: ({
    children,
    footer,
  }: {
    children: React.ReactNode;
    footer: React.ReactNode;
  }) => (
    <div role="dialog">
      {children}
      {footer}
    </div>
  ),
}));
vi.mock("../../components/ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("@tanstack/react-router", async (_actualRouter) => ({
  ...(await _actualRouter<typeof import("@tanstack/react-router")>()),
  Link: "a",
}));
vi.mock("../../components/chat/ProviderInstanceIcon", () => ({
  ProviderInstanceIcon: () => null,
}));
vi.mock("../../components/chat/providerIconUtils", () => ({
  AVAILABLE_PROVIDER_OPTIONS: [{ value: "codex", label: "Codex" }],
}));
vi.mock("../../components/settings/settingsLayout", () => ({
  SettingsPageContainer: "main",
  SettingsSection: "section",
  SettingsRow: ({
    title,
    description,
    status,
    control,
    onClick,
  }: {
    title: React.ReactNode;
    description?: React.ReactNode;
    status: string;
    control?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLDivElement>;
  }) => (
    <div
      onClick={onClick}
      data-title={
        typeof title === "string"
          ? title
          : (title as React.ReactElement<{ children: string }>).props.children
      }
      data-status={status}
    >
      {title}
      <p data-description="">{description}</p>
      {control}
    </div>
  ),
}));
vi.mock("../../components/settings/SettingsSourceStrip", () => ({
  SettingsSourceGroup: "div",
  SettingsSourcePanel: "div",
  SettingsSourceStrip: "div",
  SettingsSourceStripItem: ({ label, onToggle }: { label: string; onToggle: () => void }) => (
    <button onClick={onToggle}>{label}</button>
  ),
}));
vi.mock("../../components/ui/switch", () => ({
  Switch: ({
    checked,
    disabled,
    motion,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
    motion?: "default" | "none";
    className?: string;
  }) => (
    <button
      {...props}
      data-switch=""
      data-checked={checked}
      data-motion={motion}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onCheckedChange(!checked);
      }}
    />
  ),
}));

import { AgentSkills } from "./AgentSkills";

const instanceId = ProviderInstanceId.make("codex-personal");

function provider(firstEnabled = true): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-21T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [
      {
        name: "first",
        path: "/skills/first/SKILL.md",
        scope: "user",
        enabled: firstEnabled,
        canSetEnabled: true,
      },
      {
        name: "second",
        path: "/skills/second/SKILL.md",
        scope: "user",
        enabled: true,
        canSetEnabled: true,
      },
    ],
  };
}

function deferredResult() {
  let resolve!: (value: { _tag: "Success" | "Failure" }) => void;
  const promise = new Promise<{ _tag: "Success" | "Failure" }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const switches = (_fixture: _Fixture) => [
  ..._fixture.container.querySelectorAll<HTMLButtonElement>("[data-switch]"),
];

describe("AgentSkills activation", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    state.environmentId = "local";
    state.providers = [provider()];
    state.setEnabled.mockReset();
    state.refreshProviders.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { providers: [provider()] },
    });
    state.toast.mockReset();
    await act(async () => {
      _fixture.container = document.createElement("div");
      document.body.append(_fixture.container);
      _fixture.root0 = _fixture.stack.use(
        await _fixtureRender(null, { container: _fixture.container, router: false }),
      );
      await _fixture.root0.rerender(
        <AgentSkills
          environmentId={state.environmentId as EnvironmentId}
          providers={state.providers}
        />,
      );
    });
    await act(() => {
      _fixture.container.querySelector("button")?.click();
    });
  }

  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    vi.unstubAllGlobals();
  }

  it("opens a virtual bundled skill with a muted explanation and keeps its switch separate", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    state.providers = [
      {
        ...provider(),
        driver: ProviderDriverKind.make("claudeAgent"),
        skills: [
          { name: "simplify", path: "claude://skills/simplify", enabled: true, scope: "app" },
        ],
      },
    ];
    state.document = {
      instructions: "",
      unavailableReason: "Bundled with Claude Code; its full text isn't available.",
    };
    _fixture.cleanup.defer(() => {
      state.document = { instructions: "# External instructions", unavailableReason: undefined };
    });
    await act(async () => {
      await _fixture.root0.rerender(
        <AgentSkills
          environmentId={state.environmentId as EnvironmentId}
          providers={state.providers}
        />,
      );
    });
    await act(() => {
      _fixture.container
        .querySelector<HTMLButtonElement>('[data-title="Simplify"] button')!
        .click();
    });
    await expect.element(document.querySelector<HTMLElement>('[role="dialog"]')!).toBeVisible();
    expect(document.body.textContent).toContain(state.document.unavailableReason);
    expect(state.setEnabled).not.toHaveBeenCalled();
  });

  it("opens read-only external instructions separately from enablement", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    await act(() => {
      _fixture.container.querySelector<HTMLButtonElement>('[data-title="First"] button')?.click();
    });
    await expect.element(document.querySelector<HTMLElement>('[role="dialog"]')!).toBeVisible();
    expect(document.body.textContent).toContain("External instructions");
    expect(state.setEnabled).not.toHaveBeenCalled();
  });

  it("opens a skill's card from anywhere on its row except its switch", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);
    const row = () => _fixture.container.querySelector<HTMLElement>('[data-title="First"]');
    await act(() => switches(_fixture)[0]?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(() => row()?.querySelector<HTMLElement>("[data-description]")?.click());
    await expect.element(document.querySelector<HTMLElement>('[role="dialog"]')!).toBeVisible();
  });

  it("keeps both switches responsive and coalesces repeated clicks on one skill", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const first = deferredResult();
    const second = deferredResult();
    state.setEnabled.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    await act(() => {
      switches(_fixture)[0]?.click();
    });
    expect(switches(_fixture).map((item) => item.dataset.checked === "true")).toEqual([
      false,
      true,
    ]);
    expect([
      ..._fixture.container.querySelectorAll('[data-status="Personal · Updating"]'),
    ]).toHaveLength(1);
    expect(switches(_fixture).map((item) => item.getAttribute("disabled"))).toEqual([null, null]);
    expect(switches(_fixture)[0]?.dataset.motion).toBe("none");

    await act(() => {
      switches(_fixture)[0]?.click();
    });
    expect(state.setEnabled).toHaveBeenCalledTimes(1);
    expect(switches(_fixture)[0]!.dataset.checked === "true").toBe(true);

    await act(() => {
      switches(_fixture)[0]?.click();
    });
    expect(state.setEnabled).toHaveBeenCalledTimes(1);
    expect(switches(_fixture)[0]!.dataset.checked === "true").toBe(false);

    await act(() => {
      switches(_fixture)[1]?.click();
    });
    expect(switches(_fixture).map((item) => item.dataset.checked === "true")).toEqual([
      false,
      false,
    ]);
    expect(switches(_fixture).map((item) => item.getAttribute("disabled"))).toEqual([null, null]);
    expect(state.setEnabled).toHaveBeenCalledTimes(2);
    await act(async () => {
      first.resolve({ _tag: "Success" });
      second.resolve({ _tag: "Success" });
    });
    expect(state.setEnabled).toHaveBeenCalledTimes(2);
    expect([
      ..._fixture.container.querySelectorAll('[data-status="Personal · Deactivated"]'),
    ]).toHaveLength(2);
  });

  it("applies only the last choice after an earlier write and ignores intermediate snapshots", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const first = deferredResult();
    const last = deferredResult();
    state.setEnabled.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);

    await act(() => switches(_fixture)[0]?.click());
    await act(() => switches(_fixture)[0]?.click());
    expect(switches(_fixture)[0]!.dataset.checked === "true").toBe(true);
    expect(state.setEnabled).toHaveBeenCalledTimes(1);

    await act(async () => {
      state.providers = [provider(true)];
      await _fixture.root0.rerender(
        <AgentSkills
          environmentId={state.environmentId as EnvironmentId}
          providers={state.providers}
        />,
      );
    });
    expect([
      ..._fixture.container.querySelectorAll('[data-status="Personal · Updating"]'),
    ]).toHaveLength(1);

    await act(async () => first.resolve({ _tag: "Success" }));
    expect(state.setEnabled).toHaveBeenCalledTimes(2);
    expect(state.setEnabled.mock.calls[1]?.[0].input.enabled).toBe(true);
    expect([
      ..._fixture.container.querySelectorAll('[data-status="Personal · Updating"]'),
    ]).toHaveLength(1);

    await act(async () => last.resolve({ _tag: "Success" }));
    expect(state.setEnabled).toHaveBeenCalledTimes(2);
    expect(switches(_fixture)[0]!.dataset.checked === "true").toBe(true);
    expect([
      ..._fixture.container.querySelectorAll('[data-status="Personal · Updating"]'),
    ]).toHaveLength(0);
  });

  it("releases the local choice when the provider snapshot arrives before the response", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const write = deferredResult();
    state.setEnabled.mockReturnValueOnce(write.promise);
    await act(() => switches(_fixture)[0]?.click());

    await act(async () => {
      state.providers = [provider(false)];
      await _fixture.root0.rerender(
        <AgentSkills
          environmentId={state.environmentId as EnvironmentId}
          providers={state.providers}
        />,
      );
    });
    expect([
      ..._fixture.container.querySelectorAll('[data-status="Personal · Updating"]'),
    ]).toHaveLength(1);
    await act(async () => write.resolve({ _tag: "Success" }));

    await act(async () => {
      state.providers = [provider(true)];
      await _fixture.root0.rerender(
        <AgentSkills
          environmentId={state.environmentId as EnvironmentId}
          providers={state.providers}
        />,
      );
    });
    expect(switches(_fixture)[0]!.dataset.checked === "true").toBe(true);
    expect([
      ..._fixture.container.querySelectorAll('[data-status="Personal · Updating"]'),
    ]).toHaveLength(0);
  });

  it("follows a changed choice even after the next provider write has started", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const first = deferredResult();
    const second = deferredResult();
    const last = deferredResult();
    state.setEnabled
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(last.promise);

    await act(() => switches(_fixture)[0]?.click());
    await act(() => switches(_fixture)[0]?.click());
    await act(async () => first.resolve({ _tag: "Success" }));
    expect(state.setEnabled.mock.calls[1]?.[0].input.enabled).toBe(true);

    await act(() => switches(_fixture)[0]?.click());
    expect(switches(_fixture)[0]!.dataset.checked === "true").toBe(false);
    await act(async () => second.resolve({ _tag: "Success" }));
    expect(state.setEnabled.mock.calls[2]?.[0].input.enabled).toBe(false);

    await act(async () => last.resolve({ _tag: "Success" }));
    expect(state.setEnabled).toHaveBeenCalledTimes(3);
    expect([
      ..._fixture.container.querySelectorAll('[data-status="Personal · Deactivated"]'),
    ]).toHaveLength(1);
  });

  it("refreshes and reports a failed write instead of replaying queued clicks", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const failure = deferredResult();
    state.setEnabled.mockReturnValueOnce(failure.promise);
    state.refreshProviders.mockResolvedValueOnce({
      _tag: "Success",
      value: { providers: [provider(false)] },
    });

    await act(() => switches(_fixture)[0]?.click());
    await act(() => switches(_fixture)[0]?.click());
    await act(async () => failure.resolve({ _tag: "Failure" }));

    expect(state.setEnabled).toHaveBeenCalledTimes(1);
    expect(state.refreshProviders).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("local"),
      input: { instanceId },
    });
    expect(switches(_fixture)[0]!.dataset.checked === "true").toBe(false);
    expect(state.toast).toHaveBeenCalledOnce();
  });

  it("reports an unverified state when both the write and refresh fail", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    state.setEnabled.mockResolvedValueOnce({ _tag: "Failure" });
    state.refreshProviders.mockResolvedValueOnce({ _tag: "Failure" });

    await act(async () => switches(_fixture)[0]?.click());

    expect(switches(_fixture)[0]!.dataset.checked === "true").toBe(true);
    expect([
      ..._fixture.container.querySelectorAll('[data-status="Personal · Updating"]'),
    ]).toHaveLength(0);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description: "Scient could not verify this skill's current state.",
      }),
    );
  });

  it("does not show an old environment's pending choice after switching environments", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const oldWrite = deferredResult();
    state.setEnabled.mockReturnValueOnce(oldWrite.promise);

    await act(() => switches(_fixture)[0]?.click());
    expect(switches(_fixture)[0]!.dataset.checked === "true").toBe(false);

    await act(async () => {
      state.environmentId = "other";
      state.providers = [provider()];
      await _fixture.root0.rerender(
        <AgentSkills
          environmentId={state.environmentId as EnvironmentId}
          providers={state.providers}
        />,
      );
    });
    expect(switches(_fixture)[0]!.dataset.checked === "true").toBe(true);
    expect([
      ..._fixture.container.querySelectorAll('[data-status="Personal · Updating"]'),
    ]).toHaveLength(0);

    await act(async () => oldWrite.resolve({ _tag: "Success" }));
    expect(switches(_fixture)[0]!.dataset.checked === "true").toBe(true);
  });

  it("reverts a failed write and releases a successful one to the provider snapshot", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const failure = deferredResult();
    state.setEnabled.mockReturnValueOnce(failure.promise);
    await act(() => {
      switches(_fixture)[0]?.click();
    });
    expect(switches(_fixture)[0]!.dataset.checked === "true").toBe(false);
    await act(async () => {
      failure.resolve({ _tag: "Failure" });
    });
    expect(switches(_fixture)[0]!.dataset.checked === "true").toBe(true);
    expect(switches(_fixture)[0]?.getAttribute("disabled")).toBeNull();

    const success = deferredResult();
    state.setEnabled.mockReturnValueOnce(success.promise);
    await act(() => {
      switches(_fixture)[0]?.click();
    });
    await act(async () => {
      success.resolve({ _tag: "Success" });
    });
    expect(switches(_fixture)[0]!.dataset.checked === "true").toBe(false);
    expect([
      ..._fixture.container.querySelectorAll('[data-status="Personal · Updating"]'),
    ]).toHaveLength(0);
    expect([
      ..._fixture.container.querySelectorAll('[data-status="Personal · Deactivated"]'),
    ]).toHaveLength(1);

    await act(async () => {
      state.providers = [provider(false)];
      await _fixture.root0.rerender(
        <AgentSkills
          environmentId={state.environmentId as EnvironmentId}
          providers={state.providers}
        />,
      );
    });
    expect(switches(_fixture)[0]!.dataset.checked === "true").toBe(false);
    await act(async () => {
      state.providers = [provider(true)];
      await _fixture.root0.rerender(
        <AgentSkills
          environmentId={state.environmentId as EnvironmentId}
          providers={state.providers}
        />,
      );
    });
    expect(switches(_fixture)[0]!.dataset.checked === "true").toBe(true);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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

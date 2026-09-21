import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environmentId: "local",
  providers: [] as ServerProvider[],
  setEnabled: vi.fn(),
  refreshProviders: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.providers }));
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
vi.mock("./scientSkillsState", () => ({ setProviderSkillEnabled: null }));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("@tanstack/react-router", () => ({ Link: "a" }));
vi.mock("../../components/chat/ProviderInstanceIcon", () => ({
  ProviderInstanceIcon: () => null,
}));
vi.mock("../../components/settings/settingsLayout", () => ({
  SettingsPageContainer: "main",
  SettingsSection: "section",
  SettingsRow: ({
    title,
    status,
    control,
  }: {
    title: string;
    status: string;
    control?: React.ReactNode;
  }) => (
    <div data-title={title} data-status={status}>
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
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
    className?: string;
  }) => (
    <button
      {...props}
      data-switch=""
      data-checked={checked}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onCheckedChange(!checked);
      }}
    />
  ),
}));

import { ExternalSkillsSettings } from "./ExternalSkillsSettings";

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

let renderer: ReactTestRenderer;
const switches = () => renderer.root.findAllByProps({ "data-switch": "" });

describe("ExternalSkillsSettings activation", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.environmentId = "local";
    state.providers = [provider()];
    state.setEnabled.mockReset();
    state.refreshProviders.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { providers: [provider()] },
    });
    state.toast.mockReset();
    act(() => {
      renderer = create(<ExternalSkillsSettings />);
    });
    act(() => {
      renderer.root.findAllByType("button")[0]?.props.onClick();
    });
  });

  afterEach(() => {
    act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });

  it("keeps both switches responsive and coalesces repeated clicks on one skill", async () => {
    const first = deferredResult();
    const second = deferredResult();
    state.setEnabled.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    act(() => {
      switches()[0]?.props.onClick();
    });
    expect(switches().map((item) => item.props["data-checked"])).toEqual([false, true]);
    expect(renderer.root.findAllByProps({ "data-status": "Personal · Updating" })).toHaveLength(1);
    expect(switches().map((item) => item.props.disabled)).toEqual([undefined, undefined]);
    expect(switches()[0]?.props.className).toContain("transition-none");
    expect(switches()[0]?.props.className).not.toContain("data-disabled:opacity-100");

    act(() => {
      switches()[0]?.props.onClick();
    });
    expect(state.setEnabled).toHaveBeenCalledTimes(1);
    expect(switches()[0]?.props["data-checked"]).toBe(true);

    act(() => {
      switches()[0]?.props.onClick();
    });
    expect(state.setEnabled).toHaveBeenCalledTimes(1);
    expect(switches()[0]?.props["data-checked"]).toBe(false);

    act(() => {
      switches()[1]?.props.onClick();
    });
    expect(switches().map((item) => item.props["data-checked"])).toEqual([false, false]);
    expect(switches().map((item) => item.props.disabled)).toEqual([undefined, undefined]);
    expect(state.setEnabled).toHaveBeenCalledTimes(2);
    await act(async () => {
      first.resolve({ _tag: "Success" });
      second.resolve({ _tag: "Success" });
    });
    expect(state.setEnabled).toHaveBeenCalledTimes(2);
    expect(renderer.root.findAllByProps({ "data-status": "Personal · Deactivated" })).toHaveLength(
      2,
    );
  });

  it("applies only the last choice after an earlier write and ignores intermediate snapshots", async () => {
    const first = deferredResult();
    const last = deferredResult();
    state.setEnabled.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);

    act(() => switches()[0]?.props.onClick());
    act(() => switches()[0]?.props.onClick());
    expect(switches()[0]?.props["data-checked"]).toBe(true);
    expect(state.setEnabled).toHaveBeenCalledTimes(1);

    act(() => {
      state.providers = [provider(true)];
      renderer.update(<ExternalSkillsSettings />);
    });
    expect(renderer.root.findAllByProps({ "data-status": "Personal · Updating" })).toHaveLength(1);

    await act(async () => first.resolve({ _tag: "Success" }));
    expect(state.setEnabled).toHaveBeenCalledTimes(2);
    expect(state.setEnabled.mock.calls[1]?.[0].input.enabled).toBe(true);
    expect(renderer.root.findAllByProps({ "data-status": "Personal · Updating" })).toHaveLength(1);

    await act(async () => last.resolve({ _tag: "Success" }));
    expect(state.setEnabled).toHaveBeenCalledTimes(2);
    expect(switches()[0]?.props["data-checked"]).toBe(true);
    expect(renderer.root.findAllByProps({ "data-status": "Personal · Updating" })).toHaveLength(0);
  });

  it("releases the local choice when the provider snapshot arrives before the response", async () => {
    const write = deferredResult();
    state.setEnabled.mockReturnValueOnce(write.promise);
    act(() => switches()[0]?.props.onClick());

    act(() => {
      state.providers = [provider(false)];
      renderer.update(<ExternalSkillsSettings />);
    });
    expect(renderer.root.findAllByProps({ "data-status": "Personal · Updating" })).toHaveLength(1);
    await act(async () => write.resolve({ _tag: "Success" }));

    act(() => {
      state.providers = [provider(true)];
      renderer.update(<ExternalSkillsSettings />);
    });
    expect(switches()[0]?.props["data-checked"]).toBe(true);
    expect(renderer.root.findAllByProps({ "data-status": "Personal · Updating" })).toHaveLength(0);
  });

  it("follows a changed choice even after the next provider write has started", async () => {
    const first = deferredResult();
    const second = deferredResult();
    const last = deferredResult();
    state.setEnabled
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(last.promise);

    act(() => switches()[0]?.props.onClick());
    act(() => switches()[0]?.props.onClick());
    await act(async () => first.resolve({ _tag: "Success" }));
    expect(state.setEnabled.mock.calls[1]?.[0].input.enabled).toBe(true);

    act(() => switches()[0]?.props.onClick());
    expect(switches()[0]?.props["data-checked"]).toBe(false);
    await act(async () => second.resolve({ _tag: "Success" }));
    expect(state.setEnabled.mock.calls[2]?.[0].input.enabled).toBe(false);

    await act(async () => last.resolve({ _tag: "Success" }));
    expect(state.setEnabled).toHaveBeenCalledTimes(3);
    expect(renderer.root.findAllByProps({ "data-status": "Personal · Deactivated" })).toHaveLength(
      1,
    );
  });

  it("refreshes and reports a failed write instead of replaying queued clicks", async () => {
    const failure = deferredResult();
    state.setEnabled.mockReturnValueOnce(failure.promise);
    state.refreshProviders.mockResolvedValueOnce({
      _tag: "Success",
      value: { providers: [provider(false)] },
    });

    act(() => switches()[0]?.props.onClick());
    act(() => switches()[0]?.props.onClick());
    await act(async () => failure.resolve({ _tag: "Failure" }));

    expect(state.setEnabled).toHaveBeenCalledTimes(1);
    expect(state.refreshProviders).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("local"),
      input: { instanceId },
    });
    expect(switches()[0]?.props["data-checked"]).toBe(false);
    expect(state.toast).toHaveBeenCalledOnce();
  });

  it("reports an unverified state when both the write and refresh fail", async () => {
    state.setEnabled.mockResolvedValueOnce({ _tag: "Failure" });
    state.refreshProviders.mockResolvedValueOnce({ _tag: "Failure" });

    await act(async () => switches()[0]?.props.onClick());

    expect(switches()[0]?.props["data-checked"]).toBe(true);
    expect(renderer.root.findAllByProps({ "data-status": "Personal · Updating" })).toHaveLength(0);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description: "Scient could not verify this skill's current state.",
      }),
    );
  });

  it("does not show an old environment's pending choice after switching environments", async () => {
    const oldWrite = deferredResult();
    state.setEnabled.mockReturnValueOnce(oldWrite.promise);

    act(() => switches()[0]?.props.onClick());
    expect(switches()[0]?.props["data-checked"]).toBe(false);

    act(() => {
      state.environmentId = "other";
      state.providers = [provider()];
      renderer.update(<ExternalSkillsSettings />);
    });
    expect(switches()[0]?.props["data-checked"]).toBe(true);
    expect(renderer.root.findAllByProps({ "data-status": "Personal · Updating" })).toHaveLength(0);

    await act(async () => oldWrite.resolve({ _tag: "Success" }));
    expect(switches()[0]?.props["data-checked"]).toBe(true);
  });

  it("reverts a failed write and releases a successful one to the provider snapshot", async () => {
    const failure = deferredResult();
    state.setEnabled.mockReturnValueOnce(failure.promise);
    act(() => {
      switches()[0]?.props.onClick();
    });
    expect(switches()[0]?.props["data-checked"]).toBe(false);
    await act(async () => {
      failure.resolve({ _tag: "Failure" });
    });
    expect(switches()[0]?.props["data-checked"]).toBe(true);
    expect(switches()[0]?.props.disabled).toBeUndefined();

    const success = deferredResult();
    state.setEnabled.mockReturnValueOnce(success.promise);
    act(() => {
      switches()[0]?.props.onClick();
    });
    await act(async () => {
      success.resolve({ _tag: "Success" });
    });
    expect(switches()[0]?.props["data-checked"]).toBe(false);
    expect(renderer.root.findAllByProps({ "data-status": "Personal · Updating" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ "data-status": "Personal · Deactivated" })).toHaveLength(
      1,
    );

    act(() => {
      state.providers = [provider(false)];
      renderer.update(<ExternalSkillsSettings />);
    });
    expect(switches()[0]?.props["data-checked"]).toBe(false);
    act(() => {
      state.providers = [provider(true)];
      renderer.update(<ExternalSkillsSettings />);
    });
    expect(switches()[0]?.props["data-checked"]).toBe(true);
  });
});

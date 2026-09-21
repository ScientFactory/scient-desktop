import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  providers: [] as ServerProvider[],
  setEnabled: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.providers }));
vi.mock("../../state/server", () => ({ primaryServerProvidersAtom: null }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("local"),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.setEnabled }));
vi.mock("./scientSkillsState", () => ({ setProviderSkillEnabled: null }));
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
    state.providers = [provider()];
    state.setEnabled.mockReset();
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

  it("blocks only the pending switch without dimming it or blocking another switch", async () => {
    const first = deferredResult();
    const second = deferredResult();
    state.setEnabled.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    act(() => {
      switches()[0]?.props.onClick();
    });
    expect(switches().map((item) => item.props["data-checked"])).toEqual([false, true]);
    expect(renderer.root.findAllByProps({ "data-status": "Personal · Updating" })).toHaveLength(1);
    expect(switches().map((item) => item.props.disabled)).toEqual([true, false]);
    expect(switches()[0]?.props.className).toContain("transition-none");
    expect(switches()[0]?.props.className).toContain("data-disabled:opacity-100");

    act(() => {
      switches()[0]?.props.onClick();
    });
    expect(state.setEnabled).toHaveBeenCalledTimes(1);

    act(() => {
      switches()[1]?.props.onClick();
    });
    expect(switches().map((item) => item.props["data-checked"])).toEqual([false, false]);
    expect(switches().map((item) => item.props.disabled)).toEqual([true, true]);
    expect(state.setEnabled).toHaveBeenCalledTimes(2);
    await act(async () => {
      first.resolve({ _tag: "Success" });
      second.resolve({ _tag: "Success" });
    });
    expect(switches().map((item) => item.props.disabled)).toEqual([false, false]);
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
    expect(switches()[0]?.props.disabled).toBe(false);

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

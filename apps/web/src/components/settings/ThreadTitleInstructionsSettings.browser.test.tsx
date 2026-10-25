import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { ThreadTitleInstructionsSettings } from "./ThreadTitleInstructionsSettings";

const state = vi.hoisted(() => ({
  value: "",
  mixed: false,
  environmentId: "first",
  update: vi.fn(),
}));

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "environment" },
    targets: [{ environmentId: state.environmentId, projectId: null }],
  }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({ threadTitleInstructions: state.value }),
  useScopedSettingsMixed: () => state.mixed,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ children, resetAction }: { children: ReactNode; resetAction?: ReactNode }) => (
    <div>
      {children}
      {resetAction}
    </div>
  ),
  SettingResetButton: ({ onClick }: { onClick: () => void }) => (
    <button onClick={onClick}>Reset instructions</button>
  ),
}));

function setup() {
  state.value = "";
  state.mixed = false;
  state.environmentId = "first";
  state.update.mockReset();
}

describe("thread title instructions", () => {
  it("preserves untouched mixed values, saves trimmed edits, and resets through the scoped adapter", async () => {
    setup();
    state.mixed = true;
    await using screen = await render(<ThreadTitleInstructionsSettings />);
    const instructions = screen.getByRole("textbox", { name: "Thread title instructions" });
    await instructions.click();
    await act(() => screen.getByRole("button", { name: "Reset instructions" }).element().focus());
    expect(state.update).not.toHaveBeenCalled();
    await instructions.fill("  Lead with the subject  ");
    await act(() => screen.getByRole("button", { name: "Reset instructions" }).element().focus());
    expect(state.update).toHaveBeenLastCalledWith({
      threadTitleInstructions: "Lead with the subject",
    });
    await screen.getByRole("button", { name: "Reset instructions" }).click();
    expect(state.update).toHaveBeenLastCalledWith({ threadTitleInstructions: "" });
  });

  it("does not carry an unfinished edit into another selected environment", async () => {
    setup();
    state.value = "First scope";
    await using screen = await render(<ThreadTitleInstructionsSettings />);
    await screen
      .getByRole("textbox", { name: "Thread title instructions" })
      .fill("Unfinished edit");
    state.environmentId = "second";
    state.value = "Second scope";
    await screen.rerender(<ThreadTitleInstructionsSettings />);
    const instructions = screen.getByRole("textbox", { name: "Thread title instructions" });
    await expect.element(instructions).toHaveValue("Second scope");
    await instructions.click();
    await act(() => screen.getByRole("button", { name: "Reset instructions" }).element().focus());
    expect(state.update).not.toHaveBeenCalled();
  });
});

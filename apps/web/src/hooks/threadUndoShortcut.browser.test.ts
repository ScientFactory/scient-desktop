import { AsyncResult } from "effect/reactivity";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { fakeTimers } from "../../test/render";
import { randomUUID } from "../lib/utils";
import { registerShortcutClaim } from "../scient/keyboard/ownership";
import { showThreadUndoNotice } from "./showThreadUndoNotice";
import * as ThreadUndo from "./threadUndo";
import { installThreadUndoShortcut } from "./threadUndoShortcut";

function setup(noticeVisible = true) {
  const stack = new DisposableStack();
  stack.use(fakeTimers());
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel"));
  const root = document.createElement("div");
  const input = document.createElement("input");
  root.append(input);
  document.body.append(root);
  stack.defer(() => root.remove());
  const heldUndoKey = { current: null as string | null };
  const install = () =>
    installThreadUndoShortcut({
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      noticeVisible,
      heldUndoKey,
      getContext: () => ({ terminalFocus: false, previewFocus: false }),
    });
  let uninstall = install();
  stack.defer(() => uninstall());
  input.focus();
  return {
    root,
    input,
    notice(action: "Moved" | "Archived" = "Moved") {
      const claim = ThreadUndo.begin("keyboard-test", randomUUID());
      stack.defer(() => claim.finish());
      const undo = vi.fn(async () => AsyncResult.success(undefined));
      showThreadUndoNotice({ action, claim, undo, failureTitle: "Undo failed" });
      return undo;
    },
    remount() {
      uninstall();
      uninstall = install();
    },
    [Symbol.dispose]: () => stack.dispose(),
  };
}

function press(overrides: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "z",
    code: "KeyZ",
    metaKey: true,
    bubbles: true,
    cancelable: true,
    composed: true,
    ...overrides,
  });
  let target = document.activeElement ?? document.body;
  while (target.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
  target.dispatchEvent(event);
  return event;
}

it("claims the current visible notice before the native composer's target handler", async () => {
  using app = setup();
  const undo = app.notice();
  const editorUndo = vi.fn();
  app.input.addEventListener("keydown", editorUndo);
  await userEvent.keyboard("{Meta>}z{/Meta}");
  expect(undo).toHaveBeenCalledOnce();
  expect(editorUndo.mock.calls.some(([event]) => event.key === "z")).toBe(false);
  expect(document.activeElement).toBe(app.input);
});

it("keeps one physical undo key claimed across navigation and modifier taps", () => {
  using app = setup();
  const first = app.notice("Archived");
  expect(press().defaultPrevented).toBe(true);
  expect(first).toHaveBeenCalledOnce();
  const next = app.notice();
  app.remount();
  press({ key: "Shift", code: "ShiftLeft", shiftKey: true });
  expect(press({ repeat: true }).defaultPrevented).toBe(true);
  expect(next).not.toHaveBeenCalled();
  app.input.dispatchEvent(new KeyboardEvent("keyup", { key: "z", code: "KeyZ", bubbles: true }));
  expect(press().defaultPrevented).toBe(true);
  expect(next).toHaveBeenCalledOnce();
});

it.each(["input", "other key"] as const)(
  "hands undo back after %s without removing the notice",
  (reason) => {
    using app = setup();
    const undo = app.notice();
    if (reason === "input") app.input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    else press({ key: "a", code: "KeyA", metaKey: false });
    expect(press().defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();
    app.input.blur();
    expect(press().defaultPrevented).toBe(true);
    expect(undo).toHaveBeenCalledOnce();
  },
);

it("does not suppress held repeats after a menu paste hands input back", () => {
  using app = setup();
  app.notice();
  press();
  const next = app.notice("Archived");
  app.input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  expect(press({ repeat: true }).defaultPrevented).toBe(false);
  expect(next).not.toHaveBeenCalled();
});

it.each(["palette", "model picker", "keybinding capture"] as const)(
  "leaves undo to an open %s",
  (owner) => {
    using app = setup();
    const undo = app.notice();
    if (owner === "palette") app.root.dataset.commandPalette = "";
    else if (owner === "model picker") app.root.dataset.modelPickerContent = "";
    else app.root.dataset.keybindingCapture = "";
    const editorUndo = vi.fn();
    app.input.addEventListener("keydown", editorUndo);
    expect(press().defaultPrevented).toBe(false);
    expect(editorUndo).toHaveBeenCalledOnce();
    expect(undo).not.toHaveBeenCalled();
  },
);

it("respects a shadow editor's explicit shortcut claim before consuming a held repeat", () => {
  using app = setup();
  app.notice();
  press();
  const undo = app.notice("Archived");
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const input = document.createElement("textarea");
  shadow.append(input);
  app.root.append(host);
  input.focus();
  using _claim = {
    [Symbol.dispose]: registerShortcutClaim(input, (event) => event.code === "KeyZ"),
  };
  expect(press({ repeat: true }).defaultPrevented).toBe(false);
  expect(undo).not.toHaveBeenCalled();
});

it("leaves already-handled and composing keys alone", () => {
  using app = setup();
  const undo = app.notice();
  const handled = new KeyboardEvent("keydown", {
    key: "z",
    code: "KeyZ",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  handled.preventDefault();
  app.input.dispatchEvent(handled);
  press({ isComposing: true });
  expect(undo).not.toHaveBeenCalled();
});

it.each(["hidden", "expired"] as const)(
  "does not take an editor's undo for a %s notice",
  (state) => {
    using app = setup(state !== "hidden");
    const undo = app.notice();
    if (state === "expired") vi.advanceTimersByTime(5_000);
    expect(press().defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();
  },
);

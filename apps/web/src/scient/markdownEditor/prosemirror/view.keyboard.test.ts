// @vitest-environment happy-dom
import { afterEach, expect, it } from "vite-plus/test";
import { TextSelection } from "prosemirror-state";
import { ScientMarkdownEditorView } from "./view";
import {
  DEFAULT_KEYBOARD_PREFERENCES,
  reloadKeyboardPreferences,
  saveKeyboardPreferences,
} from "../../keyboard/preferences";

let controller: ScientMarkdownEditorView | undefined;
afterEach(() => {
  controller?.destroy();
  controller = undefined;
  document.body.replaceChildren();
  localStorage.clear();
  reloadKeyboardPreferences();
});

it("applies rebind, disable, reset, and multi-stroke changes to a mounted editor without losing history", () => {
  localStorage.clear();
  reloadKeyboardPreferences();
  controller = new ScientMarkdownEditorView({
    source: "Text\n",
    revision: "keyboard-fixture",
    mode: "write",
    ariaLabel: "Keyboard fixture",
  });
  const host = document.createElement("div");
  document.body.append(host);
  const view = controller.mount(host);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)));
  const press = (key: string, ctrlKey = true) => {
    const event = new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true });
    view.dom.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const bind = (keys: readonly string[] | undefined) =>
    saveKeyboardPreferences({
      ...DEFAULT_KEYBOARD_PREFERENCES,
      overrides: keys ? { "markdown.bold": keys } : {},
    });

  bind(["ctrl+q"]);
  expect(press("b")).toBe(false);
  expect(press("q")).toBe(true);
  expect(controller.session.session.draftSource).toBe("**Text**\n");
  bind([]);
  expect(press("q")).toBe(false);
  expect(press("b")).toBe(false);
  expect(press("z")).toBe(true);
  expect(controller.session.session.draftSource).toBe("Text\n");

  bind(["ctrl+q b"]);
  expect(press("q")).toBe(true);
  expect(controller.session.session.draftSource).toBe("Text\n");
  expect(press("b", false)).toBe(true);
  expect(controller.session.session.draftSource).toBe("**Text**\n");
  bind(undefined);
  expect(press("q")).toBe(false);
  expect(press("z")).toBe(true);
  expect(controller.session.session.draftSource).toBe("Text\n");
  expect(press("b")).toBe(true);
  expect(controller.session.session.draftSource).toBe("**Text**\n");
});

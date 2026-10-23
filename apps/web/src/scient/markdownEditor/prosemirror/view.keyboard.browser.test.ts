import { nativeShortcut } from "../../../../test/nativeShortcut";
import { expect, it } from "vite-plus/test";
import { TextSelection } from "prosemirror-state";
import { ScientMarkdownEditorView } from "./view";
import {
  DEFAULT_KEYBOARD_PREFERENCES,
  reloadKeyboardPreferences,
  saveKeyboardPreferences,
} from "../../keyboard/preferences";

async function _cleanupFixture0(_fixture: _Fixture) {
  _fixture.controller?.destroy();
  _fixture.controller = undefined;
  _clearOwnedDOM(_fixture);
  localStorage.clear();
  reloadKeyboardPreferences();
}

it("applies rebind, disable, reset, and multi-stroke changes to a mounted editor without losing history", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  localStorage.clear();
  reloadKeyboardPreferences();
  _fixture.controller = new ScientMarkdownEditorView({
    source: "Text\n",
    revision: "keyboard-fixture",
    mode: "write",
    ariaLabel: "Keyboard fixture",
  });
  const host = document.createElement("div");
  document.body.append(_ownDOM(_fixture, host));
  const view = _fixture.controller.mount(host);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)));
  const press = (key: string, ctrlKey = true, native = true) => {
    const input = { key, ctrlKey, bubbles: true, cancelable: true };
    const event = new KeyboardEvent("keydown", native ? nativeShortcut(input) : input);
    view.dom.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const pressBinding = (key: string) => press(key, true, false);
  const bind = (keys: readonly string[] | undefined) =>
    saveKeyboardPreferences({
      ...DEFAULT_KEYBOARD_PREFERENCES,
      overrides: keys ? { "markdown.bold": keys } : {},
    });

  bind(["ctrl+q"]);
  expect(press("b")).toBe(false);
  expect(pressBinding("q")).toBe(true);
  expect(_fixture.controller.session.session.draftSource).toBe("**Text**\n");
  bind([]);
  expect(pressBinding("q")).toBe(false);
  expect(press("b")).toBe(false);
  expect(press("z")).toBe(true);
  expect(_fixture.controller.session.session.draftSource).toBe("Text\n");

  bind(["ctrl+q b"]);
  expect(pressBinding("q")).toBe(true);
  expect(_fixture.controller.session.session.draftSource).toBe("Text\n");
  expect(press("b", false)).toBe(true);
  expect(_fixture.controller.session.session.draftSource).toBe("**Text**\n");
  bind(undefined);
  expect(pressBinding("q")).toBe(false);
  expect(press("z")).toBe(true);
  expect(_fixture.controller.session.session.draftSource).toBe("Text\n");
  expect(press("b")).toBe(true);
  expect(_fixture.controller.session.session.draftSource).toBe("**Text**\n");
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    controller: undefined! as ScientMarkdownEditorView | undefined,
    stack,
    cleanup,
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

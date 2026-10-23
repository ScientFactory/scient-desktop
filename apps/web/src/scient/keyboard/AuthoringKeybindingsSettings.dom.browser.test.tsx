import {
  render as _fixtureRender,
  type Screen,
  stubGlobal as _fixtureStubGlobal,
  act,
} from "../../../test/render";

import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import { AuthoringKeybindingsSettings } from "./AuthoringKeybindingsSettings";
import { ShortcutKeys } from "../../components/settings/ShortcutRow";
import {
  DEFAULT_KEYBOARD_PREFERENCES,
  effectiveSurfaceBindings,
  getKeyboardPreferences,
  reloadKeyboardPreferences,
  saveKeyboardPreferences,
} from "./preferences";

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux"));

  localStorage.clear();
  reloadKeyboardPreferences();
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.host.remove();
  localStorage.clear();
  reloadKeyboardPreferences();
  vi.unstubAllGlobals();
}
function button(_fixture: _Fixture, label: string) {
  const found = [..._fixture.host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("aria-label") === label || button.textContent === label,
  );
  expect(found, label).toBeTruthy();
  return found!;
}
function buttonStartingWith(_fixture: _Fixture, prefix: string) {
  const found = [..._fixture.host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.getAttribute("aria-label")?.startsWith(prefix),
  );
  expect(found, prefix).toBeTruthy();
  return found!;
}
async function press(_fixture: _Fixture, key: string, modifiers: KeyboardEventInit = {}) {
  const input = _fixture.host.querySelector<HTMLInputElement>("[data-keybinding-capture]")!;
  const event = new KeyboardEvent("keydown", {
    key,
    ...modifiers,
    cancelable: true,
    bubbles: true,
  });
  await act(() => input.dispatchEvent(event));
}
it.each(["mod++", "alt+m +", "alt+plus"])(
  "shows exactly one literal plus key in %s",
  async (value) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await act(async () => await _fixture.root0.rerender(<ShortcutKeys value={value} />));
    expect(
      [..._fixture.host.querySelectorAll("kbd")].filter((key) => key.textContent === "+"),
    ).toHaveLength(1);
  },
);
it.each(["MacIntel", "Linux"])("renders the complete default catalog on %s", async (platform) => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const descriptor = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  try {
    await act(
      async () => await _fixture.root0.rerender(<AuthoringKeybindingsSettings scope="math" />),
    );
    expect(_fixture.host.querySelectorAll('[data-slot="settings-row"]').length).toBeGreaterThan(
      160,
    );
    expect(buttonStartingWith(_fixture, "Edit math.symbol.pm")).toBeTruthy();
  } finally {
    if (descriptor) Object.defineProperty(navigator, "platform", descriptor);
    else Reflect.deleteProperty(navigator, "platform");
  }
});
it("keeps the document sections isolated and presents compact profile actions", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(
    async () => await _fixture.root0.rerender(<AuthoringKeybindingsSettings scope="pdf" />),
  );
  expect(buttonStartingWith(_fixture, "Edit pdf.zoomIn")).toBeTruthy();
  expect(_fixture.host.querySelector('[aria-label^="Edit markdown.bold"]')).toBeNull();
  expect(_fixture.host.querySelector('[aria-label^="Edit math.symbol.alpha"]')).toBeNull();
  expect(button(_fixture, "Import")).toBeTruthy();
  expect(button(_fixture, "Export")).toBeTruthy();
  expect(button(_fixture, "Restore defaults")).toBeTruthy();
  expect(_fixture.host.querySelector("table")).toBeNull();
  expect(_fixture.host.querySelector("details")).toBeNull();
});
it("opens Math behavior above the shortcut list and saves changes from the popover", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(
    async () =>
      await _fixture.root0.rerender(
        <AuthoringKeybindingsSettings scope="math" query="math.symbol.alpha" />,
      ),
  );
  const trigger = button(_fixture, "Math input behavior and preset");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const card = document.querySelector<HTMLElement>("#math-input-behavior")!;
  expect(card).toBeTruthy();
  expect(_fixture.host.contains(card)).toBe(false);
  expect(card.classList.contains("sm:grid-cols-2")).toBe(true);
  expect(card.children).toHaveLength(3);
  expect(card.children[0]?.textContent).toContain("Math preset");
  expect(card.children[0]?.textContent).toContain("Command completion");
  expect(card.children[1]?.textContent).toContain("Enter adds a matrix row");
  expect(card.children[2]?.textContent).toContain("Sequence timeout");
  expect(_fixture.host.querySelector('[aria-label^="Edit math.symbol.alpha"]')).not.toBeNull();

  const preset = card.querySelector<HTMLButtonElement>('[aria-label="Math shortcut preset"]')!;
  await userEvent.click(preset);
  const minimal = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
    option.textContent?.includes("Minimal: palette and equation insertion"),
  );
  expect(minimal).toBeTruthy();
  await userEvent.click(minimal!);
  expect(getKeyboardPreferences().preferences.mathPreset).toBe("minimal");
  expect(preset.textContent).toContain("Minimal");
  expect(document.querySelector("#math-input-behavior")).not.toBeNull();

  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(document.querySelector("#math-input-behavior")).toBeNull());
  await act(() => trigger.click());
  await userEvent.click(document.body);
  await vi.waitFor(() => expect(document.querySelector("#math-input-behavior")).toBeNull());
});
it("edits, disables and resets a filtered command without changing application bindings", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(
    async () =>
      await _fixture.root0.rerender(
        <AuthoringKeybindingsSettings scope="markdown" query="markdown.bold" />,
      ),
  );
  await act(() => buttonStartingWith(_fixture, "Edit markdown.bold").click());
  expect(_fixture.host.querySelectorAll("[data-keybinding-capture]")).toHaveLength(1);
  expect(
    [..._fixture.host.querySelectorAll("button")].some(
      (candidate) => candidate.textContent === "Save",
    ),
  ).toBe(false);
  await press(_fixture, "q", { altKey: true });
  expect(_fixture.host.querySelector<HTMLInputElement>("[data-keybinding-capture]")?.value).toBe(
    "alt+q",
  );
  await act(() => button(_fixture, "Save").click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toEqual(["alt+q"]);
  expect(buttonStartingWith(_fixture, "Edit markdown.bold: Alt+Q")).toBeTruthy();
  await act(() => button(_fixture, "Actions for bold").click());
  await act(() => document.querySelector<HTMLElement>('[role="menuitem"]')?.click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toEqual([]);
  expect(_fixture.host.textContent).toContain("Disabled");
  await act(() => button(_fixture, "Actions for bold").click());
  await act(() => document.querySelector<HTMLElement>('[role="menuitem"]')?.click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toBeUndefined();
});
it("records a focused sequence and blocks unreachable bindings", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(
    async () =>
      await _fixture.root0.rerender(
        <AuthoringKeybindingsSettings scope="math" query="math.symbol.alpha" />,
      ),
  );
  await act(() => buttonStartingWith(_fixture, "Edit math.symbol.alpha").click());
  const input = _fixture.host.querySelector<HTMLInputElement>("[data-keybinding-capture]")!;
  expect(document.activeElement).toBe(input);
  expect(input.placeholder).toBe("Press shortcut");
  await press(_fixture, "i", { altKey: true });
  await press(_fixture, "s");
  await press(_fixture, "a");
  expect(input.value).toBe("alt+i s a");
  expect(_fixture.host.textContent).not.toContain("Record sequence");
  await act(() => button(_fixture, "Save").click());
  expect(_fixture.host.querySelector('[role="alert"]')?.textContent).toContain("conflict");
  expect(getKeyboardPreferences().preferences.overrides["math.symbol.alpha"]).toBeUndefined();
});
it("captures a valid multi-stroke sequence in the same inline field", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(
    async () =>
      await _fixture.root0.rerender(
        <AuthoringKeybindingsSettings scope="math" query="math.symbol.alpha" />,
      ),
  );
  await act(() => buttonStartingWith(_fixture, "Edit math.symbol.alpha").click());
  const input = _fixture.host.querySelector<HTMLInputElement>("[data-keybinding-capture]")!;
  await press(_fixture, "q", { altKey: true });
  await press(_fixture, "a");
  expect(input.value).toBe("alt+q a");
  await act(() => button(_fixture, "Save").click());
  expect(getKeyboardPreferences().preferences.overrides["math.symbol.alpha"]).toEqual(["alt+q a"]);
});
it("Escape cancels an inline edit without changing the binding", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(
    async () =>
      await _fixture.root0.rerender(
        <AuthoringKeybindingsSettings scope="markdown" query="markdown.bold" />,
      ),
  );
  await act(() => buttonStartingWith(_fixture, "Edit markdown.bold").click());
  await press(_fixture, "q", { altKey: true });
  await press(_fixture, "Escape");
  expect(_fixture.host.querySelector("[data-keybinding-capture]")).toBeNull();
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toBeUndefined();
});
it("cancels an inline edit when clicking elsewhere, without saving the draft", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(
    async () =>
      await _fixture.root0.rerender(
        <AuthoringKeybindingsSettings scope="markdown" query="markdown.bold" />,
      ),
  );
  const shortcut = buttonStartingWith(_fixture, "Edit markdown.bold");
  const add = button(_fixture, "Add shortcut for bold");
  const actions = button(_fixture, "Actions for bold");
  const rowButtons = [
    ...shortcut.closest('[data-slot="settings-row"]')!.querySelectorAll("button"),
  ];
  expect(rowButtons.indexOf(actions)).toBeLessThan(rowButtons.indexOf(add));
  expect(rowButtons.indexOf(add)).toBeLessThan(rowButtons.indexOf(shortcut));

  await act(() => shortcut.click());
  await press(_fixture, "q", { altKey: true });
  await act(() => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  expect(_fixture.host.querySelector("[data-keybinding-capture]")).toBeNull();
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toBeUndefined();
});
it("keeps the inline edit open for its Save and portaled row menu", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(
    async () =>
      await _fixture.root0.rerender(
        <AuthoringKeybindingsSettings scope="markdown" query="markdown.bold" />,
      ),
  );
  await act(() => buttonStartingWith(_fixture, "Edit markdown.bold").click());
  await press(_fixture, "q", { altKey: true });
  await act(() =>
    button(_fixture, "Save").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })),
  );
  expect(_fixture.host.querySelector("[data-keybinding-capture]")).not.toBeNull();
  await act(() => button(_fixture, "Save").click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toEqual(["alt+q"]);

  await act(() => buttonStartingWith(_fixture, "Edit markdown.bold").click());
  await act(() => button(_fixture, "Actions for bold").click());
  const remove = document.querySelector<HTMLElement>('[role="menuitem"]')!;
  await act(() => remove.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  expect(_fixture.host.querySelector("[data-keybinding-capture]")).not.toBeNull();
  await act(() => remove.click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toEqual([]);
});
it("does not overwrite newer profile preferences from an old draft", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(
    async () =>
      await _fixture.root0.rerender(
        <AuthoringKeybindingsSettings scope="markdown" query="markdown.bold" />,
      ),
  );
  await act(() => buttonStartingWith(_fixture, "Edit markdown.bold").click());
  await press(_fixture, "q", { altKey: true });
  await act(() =>
    saveKeyboardPreferences({ ...DEFAULT_KEYBOARD_PREFERENCES, automaticOperators: false }),
  );
  await act(() => button(_fixture, "Save").click());
  expect(_fixture.host.querySelector('[role="alert"]')?.textContent).toContain("changed elsewhere");
  expect(getKeyboardPreferences().preferences.automaticOperators).toBe(false);
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toBeUndefined();
});
it("adds, edits, and removes individual alternative shortcuts in one row", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const defaults = effectiveSurfaceBindings(DEFAULT_KEYBOARD_PREFERENCES, false)
    .filter((binding) => binding.command === "markdown.bold")
    .map((binding) => binding.keys);
  await act(
    async () =>
      await _fixture.root0.rerender(
        <AuthoringKeybindingsSettings scope="markdown" query="markdown.bold" />,
      ),
  );
  await act(() => button(_fixture, "Add shortcut for bold").click());
  await press(_fixture, "q", { altKey: true });
  await act(() => button(_fixture, "Save").click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toEqual([
    ...defaults,
    "alt+q",
  ]);
  await act(() => buttonStartingWith(_fixture, "Edit markdown.bold: Alt+Q").click());
  await press(_fixture, "w", { altKey: true });
  await act(() => button(_fixture, "Save").click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toEqual([
    ...defaults,
    "alt+w",
  ]);
  await act(() => buttonStartingWith(_fixture, "Edit markdown.bold: Alt+W").click());
  await act(() => button(_fixture, "Actions for bold").click());
  await act(() => document.querySelector<HTMLElement>('[role="menuitem"]')?.click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toEqual(defaults);
});
it("imports and restores the one document profile without touching application bindings", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const confirm = vi.fn(() => true);
  _fixture.stack.use(_fixtureStubGlobal("confirm", confirm));
  await act(
    async () => await _fixture.root0.rerender(<AuthoringKeybindingsSettings scope="pdf" />),
  );
  const file = _fixture.host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(file, "files", {
    configurable: true,
    value: [
      {
        size: 300,
        text: async () =>
          JSON.stringify({
            ...DEFAULT_KEYBOARD_PREFERENCES,
            overrides: { "pdf.zoomIn": ["alt+q"] },
          }),
      },
    ],
  });
  await act(async () => file.dispatchEvent(new Event("change", { bubbles: true })));
  expect(confirm).toHaveBeenCalled();
  expect(getKeyboardPreferences().preferences.overrides["pdf.zoomIn"]).toEqual(["alt+q"]);
  await act(() => button(_fixture, "Restore defaults").click());
  const restoreCard = document.querySelector<HTMLElement>(
    '[aria-label="Restore document shortcut defaults"]',
  )!;
  expect(restoreCard).toBeTruthy();
  expect(_fixture.host.contains(restoreCard)).toBe(false);
  expect(getKeyboardPreferences().preferences.overrides["pdf.zoomIn"]).toEqual(["alt+q"]);
  await act(() =>
    [...restoreCard.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "Cancel")!
      .click(),
  );
  expect(getKeyboardPreferences().preferences.overrides["pdf.zoomIn"]).toEqual(["alt+q"]);
  await act(() => button(_fixture, "Restore defaults").click());
  const reopenedCard = document.querySelector<HTMLElement>(
    '[aria-label="Restore document shortcut defaults"]',
  )!;
  await act(() =>
    [...reopenedCard.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "Restore")!
      .click(),
  );
  expect(getKeyboardPreferences().preferences).toEqual(DEFAULT_KEYBOARD_PREFERENCES);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[aria-label="Restore document shortcut defaults"]')).toBeNull();
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
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

import { MathfieldElement } from "mathlive";
import { expect, it, vi } from "vite-plus/test";

MathfieldElement.fontsDirectory = null;
MathfieldElement.soundsDirectory = null;

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.previousRestoration = MathfieldElement.restoreFocusWhenDocumentFocused;
  MathfieldElement.restoreFocusWhenDocumentFocused = true;
  _fixture.field = new MathfieldElement({ mathVirtualKeyboardPolicy: "manual" });
  _fixture.field.value = "x^2+1";
  document.body.append(_fixture.field);
  const focused = new Promise<void>((resolve) =>
    _fixture.field.addEventListener("focus", () => resolve(), { once: true }),
  );
  _fixture.field.focus();
  await focused;
  await expect.poll(() => _fixture.field.hasFocus()).toBe(true);
}

async function _cleanupFixture1(_fixture: _Fixture) {
  _fixture.field.remove();
  // Clear unpatched listeners too when demonstrating the regression.
  document.dispatchEvent(new FocusEvent("focusin"));
  document.dispatchEvent(new MouseEvent("click"));
  window.dispatchEvent(new Event("focus"));
  MathfieldElement.restoreFocusWhenDocumentFocused = _fixture.previousRestoration;
  vi.restoreAllMocks();
}

async function blurAndObserveRestoration(_fixture: _Fixture) {
  const registrations = vi.spyOn(document, "addEventListener");
  _fixture.field.blur();
  const restorationCalls = () =>
    registrations.mock.calls.filter(
      ([type, , options]) =>
        (type === "focusin" || type === "click") && typeof options === "object" && options.once,
    );
  await expect.poll(() => restorationCalls().length).toBe(2);
  const calls = restorationCalls();
  return calls.map(([, , options]) => (options as AddEventListenerOptions).signal);
}

it("releases pending document-focus restoration when the math field is removed", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const signals = await blurAndObserveRestoration(_fixture);
  _fixture.field.remove();
  expect(signals.every((signal) => signal?.aborted)).toBe(true);
  expect(_fixture.field.value).toBe("x^2+1");
});

it.each(["focusin", "click"])("cancels both restoration listeners on document %s", async (type) => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const signals = await blurAndObserveRestoration(_fixture);
  document.dispatchEvent(new Event(type));
  expect(signals.every((signal) => signal?.aborted)).toBe(true);
  window.dispatchEvent(new Event("blur"));
  window.dispatchEvent(new Event("focus"));
  expect(_fixture.field.hasFocus()).toBe(false);
  expect(_fixture.field.value).toBe("x^2+1");
});

it("keeps window-focus restoration for a connected field", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await blurAndObserveRestoration(_fixture);
  window.dispatchEvent(new Event("blur"));
  window.dispatchEvent(new Event("focus"));
  await expect.poll(() => _fixture.field.hasFocus()).toBe(true);
  expect(_fixture.field.value).toBe("x^2+1");
});

it("does not restore a removed field after the window loses focus", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const signals = await blurAndObserveRestoration(_fixture);
  window.dispatchEvent(new Event("blur"));
  _fixture.field.remove();
  window.dispatchEvent(new Event("focus"));
  expect(_fixture.field.hasFocus()).toBe(false);
  expect(signals.every((signal) => signal?.aborted)).toBe(true);
  expect(_fixture.field.value).toBe("x^2+1");
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    field: undefined! as MathfieldElement,
    previousRestoration: undefined! as boolean,

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

import { MathfieldElement } from "mathlive";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

MathfieldElement.fontsDirectory = null;
MathfieldElement.soundsDirectory = null;

let field: MathfieldElement;
let previousRestoration: boolean;

beforeEach(async () => {
  previousRestoration = MathfieldElement.restoreFocusWhenDocumentFocused;
  MathfieldElement.restoreFocusWhenDocumentFocused = true;
  field = new MathfieldElement({ mathVirtualKeyboardPolicy: "manual" });
  field.value = "x^2+1";
  document.body.append(field);
  const focused = new Promise<void>((resolve) =>
    field.addEventListener("focus", () => resolve(), { once: true }),
  );
  field.focus();
  await focused;
  await expect.poll(() => field.hasFocus()).toBe(true);
});

afterEach(() => {
  field.remove();
  // Clear unpatched listeners too when demonstrating the regression.
  document.dispatchEvent(new FocusEvent("focusin"));
  document.dispatchEvent(new MouseEvent("click"));
  window.dispatchEvent(new Event("focus"));
  MathfieldElement.restoreFocusWhenDocumentFocused = previousRestoration;
  vi.restoreAllMocks();
});

async function blurAndObserveRestoration() {
  const registrations = vi.spyOn(document, "addEventListener");
  field.blur();
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
  const signals = await blurAndObserveRestoration();
  field.remove();
  expect(signals.every((signal) => signal?.aborted)).toBe(true);
  expect(field.value).toBe("x^2+1");
});

it.each(["focusin", "click"])("cancels both restoration listeners on document %s", async (type) => {
  const signals = await blurAndObserveRestoration();
  document.dispatchEvent(new Event(type));
  expect(signals.every((signal) => signal?.aborted)).toBe(true);
  window.dispatchEvent(new Event("blur"));
  window.dispatchEvent(new Event("focus"));
  expect(field.hasFocus()).toBe(false);
  expect(field.value).toBe("x^2+1");
});

it("keeps window-focus restoration for a connected field", async () => {
  await blurAndObserveRestoration();
  window.dispatchEvent(new Event("blur"));
  window.dispatchEvent(new Event("focus"));
  await expect.poll(() => field.hasFocus()).toBe(true);
  expect(field.value).toBe("x^2+1");
});

it("does not restore a removed field after the window loses focus", async () => {
  const signals = await blurAndObserveRestoration();
  window.dispatchEvent(new Event("blur"));
  field.remove();
  window.dispatchEvent(new Event("focus"));
  expect(field.hasFocus()).toBe(false);
  expect(signals.every((signal) => signal?.aborted)).toBe(true);
  expect(field.value).toBe("x^2+1");
});

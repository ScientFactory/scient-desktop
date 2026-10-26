// @effect-diagnostics nodeBuiltinImport:off -- Generate ephemeral synthetic values instead of credential fixtures.
import * as NodeCrypto from "node:crypto";
import { expect, it, vi } from "vite-plus/test";
import { loginFillScript, loginDocumentState } from "./loginFields.ts";
import { installLoginFormDetection } from "./autofill.ts";
import { installSignInCapture } from "./capture.ts";

function fixture() {
  document.body.innerHTML =
    '<form><input autocomplete="username"><input type="password"><input autocomplete="one-time-code"><button type="submit"><span>Go</span></button></form>';
  const inputs = [...document.querySelectorAll("input")];
  const stack = new DisposableStack();
  for (const input of inputs)
    stack.use(vi.spyOn(input, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList));
  return {
    inputs,
    [Symbol.dispose]() {
      stack.dispose();
      document.body.replaceChildren();
    },
  };
}

it("fills through native setters and input/change events while refusing a changed origin", () => {
  using f = fixture();
  document.body.insertAdjacentHTML(
    "afterbegin",
    '<form id="newsletter"><input type="email"></form>',
  );
  const newsletter = document.querySelector<HTMLInputElement>("#newsletter input")!;
  using _newsletterRect = vi
    .spyOn(newsletter, "getClientRects")
    .mockReturnValue({ length: 1 } as DOMRectList);
  const values = {
    username: NodeCrypto.randomBytes(16).toString("hex"),
    password: NodeCrypto.randomBytes(16).toString("hex"),
    otp: NodeCrypto.randomBytes(16).toString("hex"),
  };
  const events: string[] = [];
  for (const input of f.inputs) {
    for (const type of ["input", "change"]) input.addEventListener(type, () => events.push(type));
    Object.defineProperty(input, "value", {
      get: () =>
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.get?.call(input),
      set: () => {
        throw new Error("Framework override must be bypassed.");
      },
    });
  }
  expect(window.eval(loginFillScript(values, "https://other.example.test"))).toBe(false);
  expect(f.inputs.every((input) => input.value === "")).toBe(true);
  expect(window.eval(loginFillScript(values, location.origin))).toBe(true);
  expect(f.inputs.every((input, index) => input.value === Object.values(values)[index])).toBe(true);
  expect(newsletter.value === "").toBe(true);
  expect(events).toEqual(["input", "change", "input", "change", "input", "change"]);
});

it("captures trusted submit controls and Enter once, after guest permission and a nonempty password", () => {
  using f = fixture();
  let permitted = false;
  const captured: { username: string; password: string }[] = [];
  using _capture = {
    [Symbol.dispose]: installSignInCapture(
      () => permitted,
      (value) => captured.push(value),
    ),
  };
  using time = vi.spyOn(performance, "now").mockReturnValue(0);
  const form = document.querySelector("form")!;
  const dispatch = (target: Element, event: Event) => {
    Object.defineProperty(event, "isTrusted", { value: true });
    target.dispatchEvent(event);
  };
  const username = NodeCrypto.randomBytes(16).toString("hex");
  const password = NodeCrypto.randomBytes(16).toString("hex");
  f.inputs[0]!.value = username;
  f.inputs[1]!.value = password;
  dispatch(form, new Event("submit", { bubbles: true, cancelable: true }));
  expect(captured).toHaveLength(0);
  permitted = true;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(captured).toHaveLength(0);
  dispatch(
    document.querySelector("span")!,
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  dispatch(f.inputs[1]!, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  dispatch(form, new Event("submit", { bubbles: true, cancelable: true }));
  expect(captured).toHaveLength(1);
  expect(captured[0]?.username === username && captured[0]?.password === password).toBe(true);
  time.mockReturnValue(5_000);
  f.inputs[1]!.value = "";
  dispatch(form, new Event("submit", { bubbles: true }));
  expect(captured).toHaveLength(1);
  f.inputs[1]!.value = password;
  dispatch(f.inputs[1]!, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(captured).toHaveLength(2);
  time.mockReturnValue(10_000);
  dispatch(form, new Event("submit", { bubbles: true, cancelable: true }));
  expect(captured).toHaveLength(3);
});

it("automatically fills one untouched document only and rejects typed values or a stale same-origin page", () => {
  using f = fixture();
  using _detection = {
    [Symbol.dispose]: installLoginFormDetection(
      () => true,
      () => undefined,
    ),
  };
  const state = loginDocumentState()!;
  const values = { password: NodeCrypto.randomUUID() };
  const options = { documentId: state.documentId, automatic: true };
  expect(
    window.eval(loginFillScript(values, location.origin, { ...options, documentId: "stale" })),
  ).toBe(false);
  f.inputs[0]!.value = NodeCrypto.randomUUID();
  expect(window.eval(loginFillScript(values, location.origin, options))).toBe(false);
  f.inputs[0]!.value = "";
  const edited = new Event("input", { bubbles: true });
  Object.defineProperty(edited, "isTrusted", { value: true });
  f.inputs[0]!.dispatchEvent(edited);
  expect(window.eval(loginFillScript(values, location.origin, options))).toBe(false);
  state.userEdited = false;
  expect(window.eval(loginFillScript(values, location.origin, options))).toBe(true);
  f.inputs[1]!.value = "";
  expect(window.eval(loginFillScript(values, location.origin, options))).toBe(false);
  expect(window.eval(loginFillScript(values, location.origin))).toBe(true);
});

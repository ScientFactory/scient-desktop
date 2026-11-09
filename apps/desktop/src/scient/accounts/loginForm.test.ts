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
  // A username step on its own, which the desktop carries to the password step.
  dispatch(form, new Event("submit", { bubbles: true }));
  expect(captured).toHaveLength(2);
  expect(captured[1]).toMatchObject({ step: "username", password: "" });
  f.inputs[1]!.value = password;
  dispatch(f.inputs[1]!, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(captured).toHaveLength(3);
  expect(captured[2]).toMatchObject({ step: "password", path: location.pathname });
  time.mockReturnValue(10_000);
  dispatch(form, new Event("submit", { bubbles: true, cancelable: true }));
  expect(captured).toHaveLength(4);
});

it("never takes a code field masked as a password for the password", () => {
  document.body.innerHTML =
    '<form><input type="password" autocomplete="one-time-code"><button type="submit">Go</button></form>';
  const input = document.querySelector("input")!;
  using _rect = vi.spyOn(input, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
  const captured: unknown[] = [];
  using _capture = {
    [Symbol.dispose]: installSignInCapture(
      () => true,
      (value) => captured.push(value),
    ),
  };
  input.value = NodeCrypto.randomBytes(3).toString("hex");
  const submit = new Event("submit", { bubbles: true });
  Object.defineProperty(submit, "isTrusted", { value: true });
  document.querySelector("form")!.dispatchEvent(submit);
  expect(captured).toEqual([]);
  document.body.replaceChildren();
});

it("automatically fills each box once, never a typed one, and rejects a stale same-origin page", () => {
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
  state.edited.delete(f.inputs[0]!);
  expect(window.eval(loginFillScript(values, location.origin, options))).toBe(true);
  f.inputs[1]!.value = "";
  expect(window.eval(loginFillScript(values, location.origin, options))).toBe(false);
  expect(window.eval(loginFillScript(values, location.origin))).toBe(true);
});

it("puts an ID and an email each in its own box, and fills a login tab when it shows", async () => {
  document.body.innerHTML =
    '<form id="code"><input name="tz9" minlength="9" maxlength="9"><input type="email" name="email"></form>' +
    '<form id="password" hidden><input name="username"><input type="password" name="password"></form>';
  const inputs = [...document.querySelectorAll("input")];
  const stack = new DisposableStack();
  for (const input of inputs)
    stack.use(vi.spyOn(input, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList));
  using _rects = stack;
  using _page = { [Symbol.dispose]: () => document.body.replaceChildren() };
  const [tz9, email, username, password] = inputs as [
    HTMLInputElement,
    HTMLInputElement,
    HTMLInputElement,
    HTMLInputElement,
  ];
  const reports: Array<{ readonly fields: string; readonly boxes: ReadonlyArray<object> }> = [];
  using _detection = {
    [Symbol.dispose]: installLoginFormDetection(
      () => true,
      (form) => reports.push(form),
    ),
  };
  const id = String(NodeCrypto.randomInt(100_000_000, 999_999_999));
  const address = `${NodeCrypto.randomBytes(4).toString("hex")}@example.test`;
  expect(reports).toHaveLength(1);
  expect(reports[0]!.boxes).toEqual([
    { email: true, minLength: -1, maxLength: -1, pattern: "" },
    { email: false, minLength: 9, maxLength: 9, pattern: "" },
  ]);
  // An ID never goes into the email box.
  expect(window.eval(loginFillScript({ username: id }, location.origin))).toBe(true);
  expect([tz9.value, email.value]).toEqual([id, ""]);
  tz9.value = "";
  const options = { documentId: loginDocumentState()!.documentId, automatic: true };
  expect(
    window.eval(
      loginFillScript({ username: address, otherUsername: id }, location.origin, options),
    ),
  ).toBe(true);
  expect([tz9.value, email.value]).toEqual([id, address]);
  // The password tab shows without a new page: a new report, and its boxes fill.
  document.querySelector("#code")!.toggleAttribute("hidden", true);
  document.querySelector("#password")!.toggleAttribute("hidden", false);
  await vi.waitFor(() => expect(reports).toHaveLength(2));
  const secret = NodeCrypto.randomUUID();
  expect(
    window.eval(loginFillScript({ username: id, password: secret }, location.origin, options)),
  ).toBe(true);
  expect([username.value, password.value]).toEqual([id, secret]);
  // Clicking into an empty login box asks again; one that was filled does not.
  const focus = (input: HTMLInputElement) => {
    const event = new FocusEvent("focusin", { bubbles: true });
    Object.defineProperty(event, "isTrusted", { value: true });
    input.dispatchEvent(event);
  };
  focus(username);
  expect(reports).toHaveLength(2);
  username.value = "";
  focus(username);
  expect(reports).toHaveLength(3);
});

it("submits only a complete sign-in, and only when asked", () => {
  using f = fixture();
  const form = document.querySelector("form")!;
  const submitted = vi.spyOn(form, "requestSubmit").mockImplementation(() => undefined);
  const username = NodeCrypto.randomBytes(8).toString("hex");
  const password = NodeCrypto.randomBytes(8).toString("hex");
  window.eval(loginFillScript({ username, password }, location.origin));
  expect(submitted).not.toHaveBeenCalled();
  window.eval(loginFillScript({ password }, location.origin, { submit: true }));
  expect(submitted).not.toHaveBeenCalled();
  window.eval(loginFillScript({ username, password }, location.origin, { submit: true }));
  expect(submitted).toHaveBeenCalledOnce();
  expect(f.inputs[1]?.value).toBe(password);
});

it("ticks remember me beside a filled password, but never a shared-computer option", () => {
  using f = fixture();
  const form = document.querySelector("form")!;
  form.insertAdjacentHTML(
    "beforeend",
    '<label><input type="checkbox" id="shared">Public computer, do not remember me</label>' +
      '<label><input type="checkbox" id="keep">Keep me signed in</label>',
  );
  const password = NodeCrypto.randomBytes(16).toString("hex");
  expect(window.eval(loginFillScript({ password }, location.origin))).toBe(true);
  expect(f.inputs[1]?.value).toBe(password);
  expect(document.querySelector<HTMLInputElement>("#keep")?.checked).toBe(true);
  expect(document.querySelector<HTMLInputElement>("#shared")?.checked).toBe(false);
});

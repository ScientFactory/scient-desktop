// @effect-diagnostics nodeBuiltinImport:off -- Generate ephemeral synthetic values instead of credential fixtures.
import * as NodeCrypto from "node:crypto";
import { expect, it, vi } from "vite-plus/test";
import {
  loginFillScript,
  loginDocumentState,
  loginFormReportScript,
  pageSecretsScript,
  signInPageStateScript,
  submitPageLookScript,
} from "./loginFields.ts";
import { installLoginFormDetection } from "./autofill.ts";
import { installSignInCapture } from "./capture.ts";
import { loginFieldsKitSource, type LoginFieldsKit } from "@t3tools/shared/scientLoginFields";

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

it("reads a box's visible label and title, so a masked code box gets no password and no save", () => {
  document.body.innerHTML =
    '<form><label for="code">Temporary code</label><input id="code" name="code" type="password"><button type="submit">Enter</button></form>' +
    '<form hidden><input name="username"><input type="password" name="o_password" title="OTP code"></form>';
  const [code, , otpBox] = [...document.querySelectorAll("input")] as HTMLInputElement[];
  using _rect = vi.spyOn(code!, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
  using _page = { [Symbol.dispose]: () => document.body.replaceChildren() };
  const captured: unknown[] = [];
  using _capture = {
    [Symbol.dispose]: installSignInCapture(
      () => true,
      (value) => captured.push(value),
    ),
  };
  const secret = NodeCrypto.randomUUID();
  expect(window.eval(loginFillScript({ password: secret }, location.origin))).toBe(false);
  expect(code!.value).toBe("");
  // A code the user typed is not a sign-in to save.
  code!.value = String(NodeCrypto.randomInt(100_000, 999_999));
  const submit = new Event("submit", { bubbles: true });
  Object.defineProperty(submit, "isTrusted", { value: true });
  document.querySelector("form")!.dispatchEvent(submit);
  expect(captured).toEqual([]);
  // HUJI's OTP tab: o_password titled "OTP code" takes only a code.
  document.querySelector("form")!.toggleAttribute("hidden", true);
  document.querySelectorAll("form")[1]!.toggleAttribute("hidden", false);
  using _otpRect = vi
    .spyOn(otpBox!, "getClientRects")
    .mockReturnValue({ length: 1 } as DOMRectList);
  expect(window.eval(loginFillScript({ password: secret }, location.origin))).toBe(false);
  expect(otpBox!.value).toBe("");
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

it("replaces a refused password only while the box still holds Scient's own typing", () => {
  using f = fixture();
  using _detection = {
    [Symbol.dispose]: installLoginFormDetection(
      () => true,
      () => undefined,
    ),
  };
  const state = loginDocumentState()!;
  const options = { documentId: state.documentId, automatic: true };
  const [refused, next] = [NodeCrypto.randomUUID(), NodeCrypto.randomUUID()];
  expect(
    window.eval(loginFillScript({ username: "ada", password: refused }, location.origin, options)),
  ).toBe(true);
  const again = { username: "ada", password: next, passwordExpected: refused };
  // Not what Scient typed there: kept.
  f.inputs[1]!.value = "person-typed";
  expect(window.eval(loginFillScript(again, location.origin, options))).toBe(false);
  expect(f.inputs[1]!.value).toBe("person-typed");
  // Scient's own typing, untouched: the next version goes over it.
  f.inputs[1]!.value = refused;
  expect(window.eval(loginFillScript(again, location.origin, options))).toBe(true);
  expect(f.inputs[1]!.value).toBe(next);
  // The person typed in the box (even the same value back): never replaced.
  const edited = new Event("input", { bubbles: true });
  Object.defineProperty(edited, "isTrusted", { value: true });
  f.inputs[1]!.dispatchEvent(edited);
  const third = { username: "ada", password: refused, passwordExpected: next };
  expect(window.eval(loginFillScript(third, location.origin, options))).toBe(false);
  expect(f.inputs[1]!.value).toBe(next);
});

it("reports the same form drawn anew, and fills its fresh empty boxes as usual", async () => {
  using f = fixture();
  const reports: unknown[] = [];
  using _detection = {
    [Symbol.dispose]: installLoginFormDetection(
      () => true,
      (form) => reports.push(form),
    ),
  };
  const options = { documentId: loginDocumentState()!.documentId, automatic: true };
  const [refused, next] = [NodeCrypto.randomUUID(), NodeCrypto.randomUUID()];
  expect(
    window.eval(loginFillScript({ username: "ada", password: refused }, location.origin, options)),
  ).toBe(true);
  expect(reports).toHaveLength(1);
  // The page draws the same form again: same layout, fresh empty boxes.
  const drawn = f.inputs[0]!.form!;
  // A clone of the form element is a form element.
  const fresh = drawn.cloneNode(true) as HTMLFormElement;
  const boxes = [...fresh.querySelectorAll("input")];
  const stack = new DisposableStack();
  for (const input of boxes)
    stack.use(vi.spyOn(input, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList));
  using _rects = stack;
  drawn.replaceWith(fresh);
  // MutationObserver delivers its records in a microtask.
  await Promise.resolve();
  expect(reports).toHaveLength(2);
  const again = { username: "ada", password: next, passwordExpected: refused };
  expect(window.eval(loginFillScript(again, location.origin, options))).toBe(true);
  expect(boxes.slice(0, 2).map((input) => input.value)).toEqual(["ada", next]);
});

it("keeps an ID out of a plain text box the page labels as for an email", () => {
  document.body.innerHTML =
    '<form><label for="mail">Email</label><input id="mail" name="username"><input type="password"></form>' +
    '<form><input name="login" placeholder="Email or ID"><input type="password"></form>';
  const [labelled, , either] = [...document.querySelectorAll("input")] as HTMLInputElement[];
  using _page = { [Symbol.dispose]: () => document.body.replaceChildren() };
  const login = window.eval(loginFieldsKitSource) as LoginFieldsKit;
  expect(login.box(labelled!).email).toBe(true);
  expect(login.box(either!).email).toBe(false);
});

it("never fills an automatic password whose username fits no box, as on HUJI's email tab", () => {
  document.body.innerHTML =
    '<form><label for="mail">Email</label><input id="mail" name="username"><input type="password"></form>';
  const [mail, password] = [...document.querySelectorAll("input")] as HTMLInputElement[];
  const stack = new DisposableStack();
  for (const input of [mail!, password!])
    stack.use(vi.spyOn(input, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList));
  using _rects = stack;
  using _page = { [Symbol.dispose]: () => document.body.replaceChildren() };
  using _detection = {
    [Symbol.dispose]: installLoginFormDetection(
      () => true,
      () => undefined,
    ),
  };
  const options = { documentId: loginDocumentState()!.documentId, automatic: true };
  const id = { username: "123456789", password: NodeCrypto.randomUUID() };
  expect(window.eval(loginFillScript(id, location.origin, options))).toBe(false);
  expect([mail!.value, password!.value]).toEqual(["", ""]);
  // The person's own choice from the key goes in whole.
  expect(window.eval(loginFillScript(id, location.origin))).toBe(true);
  expect([mail!.value, password!.value]).toEqual([id.username, id.password]);
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

it("reports a code box beside a QR-sized picture as a 2FA setup, and a lone code box not at all", () => {
  document.body.innerHTML =
    '<main><svg width="200" height="200"></svg><input name="code" autocomplete="one-time-code"></main>';
  const [code] = [...document.querySelectorAll("input")];
  const svg = document.querySelector("svg")!;
  const stack = new DisposableStack();
  stack.use(vi.spyOn(code!, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList));
  stack.use(vi.spyOn(svg, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList));
  const square = stack.use(
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ width: 200, height: 200 } as DOMRect),
  );
  using _rects = stack;
  using _page = { [Symbol.dispose]: () => document.body.replaceChildren() };
  const reports: Array<{ readonly fields: string; readonly offer?: string | undefined }> = [];
  using _detection = {
    [Symbol.dispose]: installLoginFormDetection(
      () => true,
      (form) => reports.push(form),
    ),
  };
  expect(reports.map((report) => report.offer)).toEqual(["two-factor-setup"]);
  // A wide banner is no QR: a sign-in's code step alone is left to the sign-in.
  square.mockReturnValue({ width: 600, height: 120 } as DOMRect);
  document.body.append(document.createElement("p"));
  expect(reports).toHaveLength(1);
  expect(window.eval(loginFormReportScript)).toBeNull();
});

it("fills a change form's new boxes and its current one, reports its rules, and sends the new one", () => {
  document.body.innerHTML =
    '<form><p>Use at least 12 characters, with a symbol. Your code is 482913.</p><input type="password" name="old"><input type="password" name="next" minlength="12"><input type="password" name="again"><button type="submit">Change</button></form>';
  const inputs = [...document.querySelectorAll("input")] as [
    HTMLInputElement,
    HTMLInputElement,
    HTMLInputElement,
  ];
  const stack = new DisposableStack();
  for (const input of inputs)
    stack.use(vi.spyOn(input, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList));
  using _rects = stack;
  using _page = { [Symbol.dispose]: () => document.body.replaceChildren() };
  const reports: Array<{ readonly newPassword?: object }> = [];
  using _detection = {
    [Symbol.dispose]: installLoginFormDetection(
      () => true,
      (form) => reports.push(form),
    ),
  };
  // What the form's words state leaves the page; the words themselves (a code here) don't.
  expect(reports[0]?.newPassword).toEqual({
    minLength: 12,
    maxLength: -1,
    pattern: "",
    passwordRules: "",
    statedMinLength: 12,
    statedMaxLength: -1,
    required: ["symbol"],
    noSymbols: false,
    refusal: false,
  });
  expect(JSON.stringify(reports[0])).not.toContain("482913");
  const [current, fresh] = [NodeCrypto.randomUUID(), NodeCrypto.randomUUID()];
  expect(
    window.eval(loginFillScript({ password: current, newPassword: fresh }, location.origin)),
  ).toBe(true);
  expect(inputs.map((input) => input.value)).toEqual([current, fresh, fresh]);
  const captured: Array<{ password: string; newPassword?: string }> = [];
  using _capture = {
    [Symbol.dispose]: installSignInCapture(
      () => true,
      (value) => captured.push(value),
    ),
  };
  const submit = new Event("submit", { bubbles: true, cancelable: true });
  Object.defineProperty(submit, "isTrusted", { value: true });
  document.querySelector("form")!.dispatchEvent(submit);
  expect(captured).toMatchObject([{ password: current, newPassword: fresh }]);
});

it("fills one change form only, never one naming another account, and sends only a valid one", () => {
  // The change form for "bea", and another form with a new-password box below it.
  document.body.innerHTML =
    '<form id="change"><input type="email" name="email" value="bea@example.test"><input type="password" name="next" autocomplete="new-password" required><button type="submit">Change</button></form><form id="other"><input type="password" name="pin" autocomplete="new-password"></form>';
  const inputs = [...document.querySelectorAll("input")];
  const stack = new DisposableStack();
  for (const input of inputs)
    stack.use(vi.spyOn(input, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList));
  using _rects = stack;
  using _page = { [Symbol.dispose]: () => document.body.replaceChildren() };
  const fresh = NodeCrypto.randomUUID();
  // The first new-password box's form, and nothing outside it.
  expect(window.eval(loginFillScript({ newPassword: fresh }, location.origin))).toBe(true);
  expect(inputs.map((input) => input.value)).toEqual(["bea@example.test", fresh, ""]);
  // A Fix for "ada" types nothing into a form that shows "bea".
  const next = inputs[1]!;
  next.value = "";
  expect(
    window.eval(
      loginFillScript({ username: "ada@example.test", newPassword: fresh }, location.origin),
    ),
  ).toBe(false);
  expect(next.value).toBe("");
  // A click on Change while the form can't be sent (its new password still empty) sends nothing.
  const captured: unknown[] = [];
  using _capture = {
    [Symbol.dispose]: installSignInCapture(
      () => true,
      (value) => captured.push(value),
    ),
  };
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  Object.defineProperty(click, "isTrusted", { value: true });
  document.querySelector("button")!.dispatchEvent(click);
  expect(captured).toEqual([]);
});

it("never fills a password for another username than the one in the username box", () => {
  using f = fixture();
  const [username, password] = f.inputs as [HTMLInputElement, HTMLInputElement];
  username.value = "someone@example.test";
  const secret = NodeCrypto.randomUUID();
  expect(window.eval(loginFillScript({ password: secret }, location.origin))).toBe(false);
  expect(password.value).toBe("");
  expect(
    window.eval(
      loginFillScript({ username: "someone@example.test", password: secret }, location.origin),
    ),
  ).toBe(true);
  expect(password.value).toBe(secret);
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

it("tells a finished sign-in from a code step: only no login or code box left is done", () => {
  const shows = (html: string) => {
    document.body.innerHTML = html;
    const stack = new DisposableStack();
    for (const input of document.querySelectorAll("input"))
      stack.use(vi.spyOn(input, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList));
    using _rects = stack;
    return window.eval(signInPageStateScript) as string;
  };
  expect(shows('<form><input autocomplete="username"><input type="password"></form>')).toBe(
    "login",
  );
  // regression: a redirect to a code-only step read as no login form, so as success.
  expect(shows('<form><input autocomplete="one-time-code"></form>')).toBe("code");
  expect(shows('<main><input type="search" name="q"></main>')).toBe("done");
  document.body.replaceChildren();
});

it("fills a formless change box only inside its own container, never by a search's button", () => {
  // No forms: the change box with its button, then a search box with its own password field.
  document.body.innerHTML =
    '<div id="change"><input type="password" name="next" autocomplete="new-password"><input type="password" name="again" autocomplete="new-password"><button>Change password</button></div><div id="search"><input type="password" name="pin" autocomplete="new-password"><button>Find</button></div>';
  const inputs = [...document.querySelectorAll("input")];
  const stack = new DisposableStack();
  for (const input of inputs)
    stack.use(vi.spyOn(input, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList));
  using _rects = stack;
  using _page = { [Symbol.dispose]: () => document.body.replaceChildren() };
  // The change box's own container only, nothing in the search's.
  const fresh = NodeCrypto.randomUUID();
  expect(window.eval(loginFillScript({ newPassword: fresh }, location.origin))).toBe(true);
  expect(inputs.map((input) => input.value)).toEqual([fresh, fresh, ""]);
  // The search's box first: its "Find" button makes no change form of it, so nothing is filled.
  document.body.prepend(document.querySelector("#search")!);
  for (const input of inputs) input.value = "";
  expect(window.eval(loginFillScript({ newPassword: fresh }, location.origin))).toBe(false);
  expect(inputs.map((input) => input.value)).toEqual(["", "", ""]);
  // A wrapper whose only "Save" sits above its boxes (another section's) is no change form.
  document.body.innerHTML =
    '<div><button>Save layout</button><input type="password" name="next" autocomplete="new-password"><input type="password" name="again" autocomplete="new-password"></div>';
  for (const input of document.querySelectorAll("input"))
    stack.use(vi.spyOn(input, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList));
  expect(window.eval(loginFillScript({ newPassword: fresh }, location.origin))).toBe(false);
});

it("reads a page's secrets only in the document its form report named", () => {
  using f = fixture();
  const reports: Array<{ readonly documentId: string }> = [];
  using _detection = {
    [Symbol.dispose]: installLoginFormDetection(
      () => true,
      (form) => reports.push(form),
    ),
  };
  const key = "otpauth://totp/Example:ada?secret=JBSWY3DPEHPK3PXP";
  const link = document.createElement("a");
  link.href = key;
  link.textContent = "Can't scan?";
  f.inputs[0]!.form!.append(link);
  const documentId = reports[0]!.documentId;
  expect(window.eval(pageSecretsScript("two-factor-setup", documentId))).toMatchObject({
    setup: { uris: [key] },
  });
  expect(window.eval(pageSecretsScript("two-factor-setup", "another-document"))).toBeNull();
});

it("fills a formless change box with no container of its own nowhere, never the whole page", () => {
  // regression: no form and no button beside the box used to fall back to the whole document,
  // and a button anywhere on the page made the body its container.
  document.body.innerHTML =
    '<div><div><input type="password" name="next" autocomplete="new-password"></div></div><div><input type="password" name="pin" autocomplete="new-password"></div><button>Search</button>';
  const inputs = [...document.querySelectorAll("input")];
  const stack = new DisposableStack();
  for (const input of inputs)
    stack.use(vi.spyOn(input, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList));
  using _rects = stack;
  using _page = { [Symbol.dispose]: () => document.body.replaceChildren() };
  const fresh = NodeCrypto.randomUUID();
  expect(window.eval(loginFillScript({ newPassword: fresh }, location.origin))).toBe(false);
  expect(inputs.map((input) => input.value)).toEqual(["", ""]);
});

it("refreshes a code only over Scient's own earlier one, never over what the person typed", () => {
  document.body.innerHTML = '<form><input autocomplete="one-time-code" name="code"></form>';
  const box = document.querySelector("input")!;
  using _rect = vi.spyOn(box, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
  using _page = { [Symbol.dispose]: () => document.body.replaceChildren() };
  box.value = "123456";
  expect(
    window.eval(loginFillScript({ otp: "654321", otpExpected: "111111" }, location.origin)),
  ).toBe(false);
  expect(box.value).toBe("123456");
  box.value = "111111";
  expect(
    window.eval(loginFillScript({ otp: "654321", otpExpected: "111111" }, location.origin)),
  ).toBe(true);
  expect(box.value).toBe("654321");
  // Cleared for a fresh one: the next code goes in.
  box.value = "";
  expect(
    window.eval(loginFillScript({ otp: "777777", otpExpected: "654321" }, location.origin)),
  ).toBe(true);
  expect(box.value).toBe("777777");
});

it("reads the page right after a change's answer: boxes gone, and its alerts' refusal", () => {
  document.body.innerHTML =
    '<main><p role="alert">Your current password is incorrect.</p><p>Welcome back</p></main>';
  const alert = document.querySelector("p")!;
  using _rect = vi.spyOn(alert, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
  using _page = { [Symbol.dispose]: () => document.body.replaceChildren() };
  expect(window.eval(submitPageLookScript)).toMatchObject({
    formGone: true,
    refusal: true,
    origin: location.origin,
  });
  alert.textContent = "Password changed.";
  expect(window.eval(submitPageLookScript)).toMatchObject({ formGone: true, refusal: false });
});

it("never takes a shared wrapper's button for a formless change box's own", () => {
  // The change boxes and a site search share one wrapper with the search's button.
  document.body.innerHTML =
    '<div><input type="search" name="q"><input type="password" name="next" autocomplete="new-password"><input type="password" name="again" autocomplete="new-password"><button>Search</button></div>';
  const inputs = [...document.querySelectorAll("input")];
  const stack = new DisposableStack();
  for (const input of inputs)
    stack.use(vi.spyOn(input, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList));
  using _rects = stack;
  using _page = { [Symbol.dispose]: () => document.body.replaceChildren() };
  const fresh = NodeCrypto.randomUUID();
  expect(window.eval(loginFillScript({ newPassword: fresh }, location.origin))).toBe(false);
  expect(inputs.map((input) => input.value)).toEqual(["", "", ""]);
});

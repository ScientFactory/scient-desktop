import { loginFieldsKit } from "@t3tools/shared/scientLoginFields";

import { loginFormReport, type LoginDocumentState } from "./loginFields.ts";

const OBSERVED = ["hidden", "style", "type", "autocomplete"];

/**
 * Reports a login form when one shows, again when another set of login boxes shows (a page
 * switching tabs) and when the user clicks into an empty login box, as Chrome fills then.
 */
export function installLoginFormDetection(
  allowed: () => boolean,
  send: (form: NonNullable<ReturnType<typeof loginFormReport>>) => void,
) {
  const state: LoginDocumentState = {
    documentId: crypto.getRandomValues(new Uint32Array(4)).join("-"),
    edited: new WeakSet(),
    filled: new WeakSet(),
  };
  Object.defineProperty(globalThis, "__scientAccountsLogin", { configurable: true, value: state });
  let reported: string | null = null;
  const observer = new MutationObserver(() => report());
  const observe = (attributeFilter: Array<string>) => {
    observer.disconnect();
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter,
    });
  };
  const report = (again = false) => {
    const form = loginFormReport();
    if (!form || (form.fields === reported && !again) || !allowed()) return;
    // Once a login form shows, class changes can show its other tabs too.
    if (reported === null) observe([...OBSERVED, "class"]);
    reported = form.fields;
    send(form);
  };
  const edited = (event: Event) => {
    if (event.isTrusted && event.target instanceof HTMLInputElement) state.edited.add(event.target);
  };
  const focused = (event: FocusEvent) => {
    const input = event.target;
    if (!event.isTrusted || !(input instanceof HTMLInputElement) || input.value) return;
    const fields = loginFieldsKit.collect(Array.from(document.querySelectorAll("input")));
    const boxes = [fields.username, fields.other, fields.password, fields.otp];
    if (boxes.some((index) => fields.inputs[index] === input)) report(true);
  };
  const loaded = () => report();
  observe(OBSERVED);
  document.addEventListener("input", edited, true);
  document.addEventListener("focusin", focused, true);
  document.addEventListener("DOMContentLoaded", loaded);
  window.addEventListener("load", loaded);
  report();
  return () => {
    observer.disconnect();
    document.removeEventListener("input", edited, true);
    document.removeEventListener("focusin", focused, true);
    document.removeEventListener("DOMContentLoaded", loaded);
    window.removeEventListener("load", loaded);
    Reflect.deleteProperty(globalThis, "__scientAccountsLogin");
  };
}

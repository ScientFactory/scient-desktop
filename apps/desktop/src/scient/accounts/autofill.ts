import { loginFormReport, type LoginDocumentState } from "./loginFields.ts";

export function installLoginFormDetection(
  allowed: () => boolean,
  send: (form: NonNullable<ReturnType<typeof loginFormReport>>) => void,
) {
  const state: LoginDocumentState = {
    documentId: crypto.getRandomValues(new Uint32Array(4)).join("-"),
    userEdited: false,
    autoFilled: false,
  };
  Object.defineProperty(globalThis, "__scientAccountsLogin", { configurable: true, value: state });
  let reported = false;
  const report = () => {
    if (reported) return;
    const form = loginFormReport();
    if (!form || !allowed()) return;
    reported = true;
    observer.disconnect();
    send(form);
  };
  const edited = (event: Event) => {
    if (event.isTrusted && event.target instanceof HTMLInputElement) state.userEdited = true;
  };
  const observer = new MutationObserver(report);
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "style", "type", "autocomplete"],
  });
  document.addEventListener("input", edited, true);
  document.addEventListener("DOMContentLoaded", report);
  window.addEventListener("load", report);
  report();
  return () => {
    observer.disconnect();
    document.removeEventListener("input", edited, true);
    document.removeEventListener("DOMContentLoaded", report);
    window.removeEventListener("load", report);
    Reflect.deleteProperty(globalThis, "__scientAccountsLogin");
  };
}

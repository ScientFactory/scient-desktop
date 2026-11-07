import { collectLoginFields } from "@t3tools/shared/scientLoginFields";

/** What a submit sent: the password step, or a username step before it (empty password). */
export interface CapturedStep {
  readonly url: string;
  readonly path: string;
  readonly step: "password" | "username";
  readonly username: string;
  readonly password: string;
}

export function createCaptureDeduplicator() {
  let last: CapturedStep | undefined;
  let lastAt = -Infinity;
  return (capture: CapturedStep, now: number) => {
    if (
      last &&
      now - lastAt < 5_000 &&
      last.url === capture.url &&
      last.step === capture.step &&
      last.username === capture.username &&
      last.password === capture.password
    )
      return false;
    last = capture;
    lastAt = now;
    return true;
  };
}

/**
 * Sends what a real form submits: by the form, or by a trusted click on a submit button or Enter in
 * a field. Script-only buttons and logins with no form aren't seen.
 */
export function installSignInCapture(
  allowed: () => boolean,
  send: (capture: CapturedStep) => void,
) {
  const accept = createCaptureDeduplicator();
  const capture = (form: HTMLFormElement | null) => {
    if (!form || !allowed() || !/^https?:$/.test(location.protocol)) return;
    const fields = collectLoginFields(Array.from(form.querySelectorAll("input")));
    const password = fields.inputs[fields.password]?.value ?? "";
    const username = fields.inputs[fields.username]?.value ?? "";
    if (!password && !username) return;
    const value: CapturedStep = {
      url: location.origin,
      path: location.pathname,
      step: password ? "password" : "username",
      username,
      password,
    };
    if (accept(value, performance.now())) send(value);
  };
  const submit = (event: SubmitEvent) => {
    if (event.isTrusted && event.target instanceof HTMLFormElement) capture(event.target);
  };
  const click = (event: MouseEvent) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const control = event.target.closest("button, input");
    if (
      (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) &&
      control.type === "submit"
    )
      capture(control.form);
  };
  const key = (event: KeyboardEvent) => {
    if (!event.isTrusted || event.key !== "Enter") return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement)
      capture(target.form);
  };
  document.addEventListener("submit", submit, true);
  document.addEventListener("click", click, true);
  document.addEventListener("keydown", key, true);
  return () => {
    document.removeEventListener("submit", submit, true);
    document.removeEventListener("click", click, true);
    document.removeEventListener("keydown", key, true);
  };
}

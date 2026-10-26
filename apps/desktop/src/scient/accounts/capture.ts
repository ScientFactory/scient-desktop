import { collectLoginFields } from "./loginFields.ts";

export function createCaptureDeduplicator() {
  let last: { url: string; username: string; password: string } | undefined;
  let lastAt = -Infinity;
  return (capture: { url: string; username: string; password: string }, now: number) => {
    if (
      last &&
      now - lastAt < 5_000 &&
      last.url === capture.url &&
      last.username === capture.username &&
      last.password === capture.password
    )
      return false;
    last = capture;
    lastAt = now;
    return true;
  };
}

export function installSignInCapture(
  allowed: () => boolean,
  send: (capture: { url: string; username: string; password: string }) => void,
) {
  const accept = createCaptureDeduplicator();
  const capture = (form: HTMLFormElement | null) => {
    if (!form || !allowed() || !/^https?:$/.test(location.protocol)) return;
    const fields = collectLoginFields(form);
    const password = fields.inputs[fields.password]?.value;
    if (!password) return;
    const value = {
      url: location.origin,
      username: fields.inputs[fields.username]?.value ?? "",
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

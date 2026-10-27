import * as Schema from "effect/Schema";

export const ProfileDetection = Schema.Struct({
  finalUrl: Schema.String,
  title: Schema.String,
  passwordField: Schema.Boolean,
  deniedText: Schema.Boolean,
});
export type ProfileDetection = typeof ProfileDetection.Type;

export const profileDetectionScript = String.raw`(() => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };
  return {
    finalUrl: location.href,
    title: document.title,
    passwordField: Array.from(document.querySelectorAll('input[type="password"]')).some(visible),
    deniedText: /you need access|request access|access denied|permission denied|not authorized|403\s+forbidden/i.test(document.body?.innerText ?? ""),
  };
})()`;

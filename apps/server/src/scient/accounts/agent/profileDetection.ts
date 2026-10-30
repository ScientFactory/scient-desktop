import * as Schema from "effect/Schema";

export const ProfileDetection = Schema.Struct({
  finalUrl: Schema.String,
  title: Schema.String,
  passwordField: Schema.Boolean,
  deniedText: Schema.Boolean,
  signOutLink: Schema.optional(Schema.Boolean),
  signInLink: Schema.optional(Schema.Boolean),
});
export type ProfileDetection = typeof ProfileDetection.Type;

export const profileDetectionScript = String.raw`(() => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };
  const controls = Array.from(document.querySelectorAll('a, button, [role="button"], [role="menuitem"]')).filter(visible).map(element => element.textContent?.trim() ?? "");
  return {
    signOutLink: controls.some(text => /^(sign out|log out|logout|sign off)$/i.test(text)),
    signInLink: controls.some(text => /^(sign in|log in|login|sign up)$/i.test(text)),
    finalUrl: location.href,
    title: document.title,
    passwordField: Array.from(document.querySelectorAll('input[type="password"]')).some(visible),
    deniedText: /you need access|request access|access denied|permission denied|not authorized|403\s+forbidden/i.test(document.body?.innerText ?? ""),
  };
})()`;

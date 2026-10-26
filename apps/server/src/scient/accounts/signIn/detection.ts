import * as Schema from "effect/Schema";

export const SignInDetection = Schema.Struct({
  origin: Schema.String,
  username: Schema.NullOr(Schema.String),
  password: Schema.NullOr(Schema.String),
  otp: Schema.NullOr(Schema.String),
  submit: Schema.NullOr(Schema.String),
  challenge: Schema.NullOr(Schema.Literals(["captcha", "passkey", "push"])),
  signedIn: Schema.Boolean,
});
export type SignInDetection = typeof SignInDetection.Type;

export const signInDetectionScript = String.raw`(() => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const inputs = Array.from(document.querySelectorAll("input")).filter(input => visible(input) && !input.disabled && !input.readOnly);
  const path = (element) => {
    if (!element) return null;
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement) {
      const index = Array.from(current.parentElement.children).filter(child => child.tagName === current.tagName).indexOf(current) + 1;
      parts.unshift(current.tagName.toLowerCase() + ":nth-of-type(" + index + ")");
      current = current.parentElement;
    }
    return "html > " + parts.join(" > ");
  };
  const password = inputs.find(input => input.type === "password");
  const otp = inputs.find(input => input.autocomplete === "one-time-code" || /^(otp|totp|verification.?code|one.?time.?code)$/i.test(input.name || input.id));
  const username = inputs.find(input => input.autocomplete === "username" || input.type === "email") ?? inputs.find(input => /^(user(name)?|email|login)$/i.test(input.name || input.id));
  const form = (password ?? otp ?? username)?.form;
  const submit = Array.from((form ?? document).querySelectorAll("button, input[type=submit]")).find(element => visible(element) && !element.hasAttribute("disabled") && (element instanceof HTMLInputElement || element.type === "submit"));
  const text = document.body?.innerText ?? "";
  const captcha = Array.from(document.querySelectorAll('[class*=captcha], [id*=captcha], iframe[src*=captcha]')).some(visible);
  return {
    origin: location.origin,
    username: path(username), password: path(password), otp: path(otp), submit: path(submit),
    challenge: captcha ? "captcha" : /use (a |your )?passkey|touch id|security key/i.test(text) ? "passkey" : /approve.*(phone|device)|check your (phone|device)/i.test(text) ? "push" : null,
    signedIn: !username && !password && !otp && Array.from(document.querySelectorAll("a, button")).some(element => visible(element) && /^(sign out|log out|logout)$/i.test(element.textContent?.trim() ?? "")),
  };
})()`;

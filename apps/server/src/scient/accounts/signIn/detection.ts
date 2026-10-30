import {
  FORGET_SIGN_IN_LABEL,
  REMEMBER_SIGN_IN_LABEL,
  SITE_LIMITED_TEXT,
} from "@t3tools/shared/scientSignInPage";
import * as Schema from "effect/Schema";

export const SignInDetection = Schema.Struct({
  origin: Schema.String,
  username: Schema.NullOr(Schema.String),
  password: Schema.NullOr(Schema.String),
  otp: Schema.NullOr(Schema.String),
  submit: Schema.NullOr(Schema.String),
  challenge: Schema.NullOr(Schema.Literals(["captcha", "passkey", "push"])),
  number: Schema.optional(Schema.String),
  remember: Schema.optional(Schema.String),
  stay: Schema.optional(Schema.String),
  signInLink: Schema.optional(Schema.String),
  limited: Schema.optional(Schema.Boolean),
  broken: Schema.optional(Schema.Boolean),
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
  const label = (input) => [input.name, input.id, input.placeholder, input.getAttribute("aria-label")].join(" ");
  const otp = inputs.find(input => input.autocomplete === "one-time-code")
    ?? inputs.find(input => input.type !== "password" && input.type !== "email" && /otp|mfa|2fa|two.?factor|verification|one.?time|(auth|security|sms).?code|\bcode\b/i.test(label(input)))
    ?? inputs.find(input => input.type !== "password" && input.inputMode === "numeric" && input.maxLength >= 4 && input.maxLength <= 8);
  const username = inputs.find(input => input !== otp && (input.autocomplete === "username" || input.type === "email"))
    ?? inputs.find(input => input !== otp && /^(user(name)?|email|login)$/i.test(input.name || input.id))
    ?? (password ? inputs.slice(0, inputs.indexOf(password)).reverse().find(input => input !== otp && (input.type === "text" || input.type === "tel")) : undefined);
  const form = (password ?? otp ?? username)?.form;
  const submit = Array.from((form ?? document).querySelectorAll("button, input[type=submit]")).find(element => visible(element) && !element.hasAttribute("disabled") && (element instanceof HTMLInputElement || element.type === "submit"));
  const text = document.body?.innerText ?? "";
  const rememberLabel = new RegExp(${JSON.stringify(REMEMBER_SIGN_IN_LABEL)}, "i");
  const forgetLabel = new RegExp(${JSON.stringify(FORGET_SIGN_IN_LABEL)}, "i");
  const boxLabel = (box) => [label(box), ...Array.from(box.labels ?? []).map(item => item.textContent)].join(" ");
  // Styled checkboxes hide the input and show its label.
  const remember = Array.from((form ?? document).querySelectorAll("input[type=checkbox]")).find(box => !box.checked && !box.disabled && (visible(box) || Array.from(box.labels ?? []).some(visible)) && rememberLabel.test(boxLabel(box)) && !forgetLabel.test(boxLabel(box)));
  const stay = !password && !otp && /stay signed in\?/i.test(text)
    ? Array.from(document.querySelectorAll("button, input[type=submit]")).find(element => visible(element) && /^yes$/i.test((element.value || element.textContent || "").trim()))
    : undefined;
  const captcha = Array.from(document.querySelectorAll('[class*=captcha], [id*=captcha], iframe[src*=captcha]')).some(visible);
  const push = /approve.*(phone|device)|check your (phone|device)|enter the number|number shown|tap the number|matching number|verification code shown|verify with (a )?number/i.test(text);
  const numbers = new Set();
  if (push) for (const element of document.querySelectorAll("p, div, span, section")) {
    if (!visible(element) || !/enter the number|number shown|tap the number|matching number|verification code shown|verify with (a )?number/i.test(element.innerText ?? "")) continue;
    // Only a small local prompt with a separate, visible numeric element is trusted.
    if ((element.innerText ?? "").length > 240) continue;
    for (const candidate of element.querySelectorAll("span, strong, b, p, div")) {
      const value = candidate.innerText?.trim() ?? "";
      if (visible(candidate) && /^\d{1,3}$/.test(value)) numbers.add(value);
    }
  }
  const signInLink = !password && !otp && !username
    ? Array.from(document.querySelectorAll('a, button, [role="button"]')).find(element => visible(element) && /^(sign in|log in|login)$/i.test(element.textContent?.trim() ?? ""))
    : undefined;
  const limited = !password && !otp && new RegExp(${JSON.stringify(SITE_LIMITED_TEXT)}, "i").test(text);
  // Some sign-in pages answer 401, so a status only counts on a page with no form.
  const status = performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0;
  const broken = !password && !otp && !username && !limited && !captcha && (location.protocol === "chrome-error:" || status >= 400);
  return {
    ...(limited ? { limited: true } : {}),
    ...(broken ? { broken: true } : {}),
    ...(signInLink ? { signInLink: path(signInLink) } : {}),
    ...(push && numbers.size === 1 ? { number: [...numbers][0] } : {}),
    ...(remember ? { remember: path(remember) } : {}),
    ...(stay ? { stay: path(stay) } : {}),
    origin: location.origin,
    username: path(username), password: path(password), otp: path(otp), submit: path(submit),
    challenge: captcha ? "captcha" : /use (a |your )?passkey|touch id|security key/i.test(text) ? "passkey" : push ? "push" : null,
    signedIn: !username && !password && !otp && Array.from(document.querySelectorAll("a, button")).some(element => visible(element) && /^(sign out|log out|logout)$/i.test(element.textContent?.trim() ?? "")),
  };
})()`;

/** Ticks a detected checkbox with the page's own click, so its form sees the change. */
export const tickRememberScript = (selector: string) =>
  `document.querySelector(${JSON.stringify(selector)})?.click()`;

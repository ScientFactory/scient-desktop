import {
  FORGET_SIGN_IN_LABEL,
  REMEMBER_SIGN_IN_LABEL,
  SITE_LIMITED_TEXT,
} from "@t3tools/shared/scientSignInPage";
import { loginFieldsKitSource } from "@t3tools/shared/scientLoginFields";
import * as Schema from "effect/Schema";

export const SignInDetection = Schema.Struct({
  origin: Schema.String,
  /** The whole address, where the path tells a finished sign-in from its start. */
  url: Schema.optional(Schema.String),
  username: Schema.NullOr(Schema.String),
  password: Schema.NullOr(Schema.String),
  otp: Schema.NullOr(Schema.String),
  submit: Schema.NullOr(Schema.String),
  challenge: Schema.NullOr(Schema.Literals(["captcha", "passkey", "push"])),
  number: Schema.optional(Schema.String),
  remember: Schema.optional(Schema.String),
  stay: Schema.optional(Schema.String),
  signInLink: Schema.optional(Schema.String),
  anotherWay: Schema.optional(Schema.String),
  limited: Schema.optional(Schema.Boolean),
  broken: Schema.optional(Schema.Boolean),
  accountChoices: Schema.optional(
    Schema.Array(Schema.Struct({ email: Schema.String, selector: Schema.String })),
  ),
  signedIn: Schema.Boolean,
});
export type SignInDetection = typeof SignInDetection.Type;

export const signInDetectionScript = String.raw`(() => {
  const login = ${loginFieldsKitSource};
  const visible = login.visible;
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
  // Sign-up and change-password pages ask for a password too; a saved one must not go there.
  const fields = login.collect(Array.from(document.querySelectorAll("input")), { refuseNewPasswordPage: true });
  const password = fields.inputs[fields.password];
  const otp = fields.inputs[fields.otp];
  const username = fields.inputs[fields.username];
  const form = (password ?? otp ?? username)?.form;
  const submit = Array.from((form ?? document).querySelectorAll("button, input[type=submit]")).find(element => visible(element) && !element.hasAttribute("disabled") && (element instanceof HTMLInputElement || element.type === "submit"));
  const text = document.body?.innerText ?? "";
  const rememberLabel = new RegExp(${JSON.stringify(REMEMBER_SIGN_IN_LABEL)}, "i");
  const forgetLabel = new RegExp(${JSON.stringify(FORGET_SIGN_IN_LABEL)}, "i");
  const remember = login.rememberBox(Array.from((form ?? document).querySelectorAll("input[type=checkbox]")), rememberLabel, forgetLabel, true);
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
  const links = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"]')).filter(visible);
  const linkNamed = (name) => links.find(element => name.test(element.textContent?.trim() ?? ""));
  const useAnother = linkNamed(/^use another account$/i);
  // "Choose an account" lists remembered accounts before any field appears; later steps show the
  // chosen account as a chip that goes back to the start. A row is the innermost element, since a
  // click on the list item around it may do nothing.
  const markedRows = Array.from(document.querySelectorAll("[data-identifier], [data-email]"));
  const possibleRows = markedRows.length > 0 ? markedRows : useAnother ? links.concat(Array.from(document.querySelectorAll("li"))) : [];
  const accountChoices = !password && !otp && !username
    ? possibleRows.filter(row => row !== useAnother && !possibleRows.some(other => other !== row && row.contains(other))).flatMap(element => {
        const text = element.innerText ?? "";
        const email = element.dataset?.identifier ?? element.dataset?.email ?? (text.length < 120 ? text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0] : undefined);
        return email && visible(element) ? [{ email, selector: path(element) }] : [];
      })
    : [];
  const signInLink = !password && !otp && !username
    ? linkNamed(/^enter your password$/i) ?? linkNamed(/^(sign in|log in|login)$/i) ?? useAnother
    : undefined;
  const anotherWay = !password && !otp && !username ? linkNamed(/^try another way$/i) : undefined;
  const limited = !password && !otp && new RegExp(${JSON.stringify(SITE_LIMITED_TEXT)}, "i").test(text);
  // Some sign-in pages answer 401, so a status only counts on a page with no form.
  const status = performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0;
  const broken = !password && !otp && !username && !limited && !captcha && (location.protocol === "chrome-error:" || status >= 400);
  return {
    ...(limited ? { limited: true } : {}),
    ...(broken ? { broken: true } : {}),
    ...(accountChoices.length > 0 ? { accountChoices } : {}),
    ...(signInLink ? { signInLink: path(signInLink) } : {}),
    ...(anotherWay ? { anotherWay: path(anotherWay) } : {}),
    ...(push && numbers.size === 1 ? { number: [...numbers][0] } : {}),
    ...(remember ? { remember: path(remember) } : {}),
    ...(stay ? { stay: path(stay) } : {}),
    origin: location.origin,
    url: location.href,
    username: path(username), password: path(password), otp: path(otp), submit: path(submit),
    challenge: captcha ? "captcha" : /use (a |your )?passkey|touch id|security key/i.test(text) ? "passkey" : push ? "push" : null,
    signedIn: !username && !password && !otp && Array.from(document.querySelectorAll("a, button")).some(element => visible(element) && /^(sign out|log out|logout)$/i.test(element.textContent?.trim() ?? "")),
  };
})()`;

/** Ticks a detected checkbox with the page's own click, so its form sees the change. */
export const tickRememberScript = (selector: string) =>
  `document.querySelector(${JSON.stringify(selector)})?.click()`;

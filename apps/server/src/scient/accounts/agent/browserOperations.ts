import * as Schema from "effect/Schema";
import type { CDPSession, Page } from "playwright-core";

const TypeInput = Schema.Struct({
  origin: Schema.String,
  selector: Schema.String,
  text: Schema.String,
  clear: Schema.Literal(true),
  /** Clearing only: leave the field alone unless it still holds what was typed. */
  expected: Schema.optional(Schema.String),
});
const WaitInput = Schema.Struct({
  settleMs: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 5000 }))),
});
const CookiesInput = Schema.Struct({
  urls: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
});

const decodeType = Schema.decodeUnknownSync(TypeInput);
const encodeType = Schema.encodeSync(Schema.fromJsonString(TypeInput));
const decodeCookies = Schema.decodeUnknownSync(CookiesInput);
const decodeWait = Schema.decodeUnknownSync(WaitInput);

export async function typeAccountValue(page: Page, input: unknown) {
  try {
    const decoded = decodeType(input);
    const serialized = encodeType(decoded);
    const filled = await page.evaluate(`(({ origin, selector, text, expected }) => {
      if (location.origin !== origin || location.protocol !== "https:") return expected !== undefined;
      const field = document.querySelector(selector);
      if (expected !== undefined && (!(field instanceof HTMLInputElement) || field.value !== expected)) return true;
      if (!(field instanceof HTMLInputElement) || field.disabled || field.readOnly || !field.getClientRects().length) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) return false;
      field.focus();
      setter.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })(${serialized})`);
    if (!filled) throw new Error();
    return {};
  } catch {
    throw new Error("The sign-in field could not be filled on the allowed origin.");
  }
}

export async function waitForAccountPage(page: Page, input: unknown, timeoutMs: number) {
  const { settleMs } = decodeWait(input ?? {});
  await page.waitForLoadState("load", { timeout: timeoutMs });
  if (settleMs) await page.waitForTimeout(settleMs);
  return {};
}

export async function readAccountCookies(cdp: CDPSession, input: unknown) {
  try {
    const { urls } = decodeCookies(input);
    if (
      urls.some(
        (value) =>
          !URL.canParse(value) ||
          new URL(value).protocol !== "https:" ||
          new URL(value).username ||
          new URL(value).password,
      )
    )
      throw new Error();
    const result = await cdp.send("Network.getCookies", { urls: [...urls] });
    return result.cookies.map(({ name, value, domain, path, secure, httpOnly, expires }) => ({
      name,
      value,
      domain,
      path,
      secure,
      httpOnly,
      expires,
    }));
  } catch {
    throw new Error("The browser session could not be read.");
  }
}

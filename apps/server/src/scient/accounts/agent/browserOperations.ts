// @effect-diagnostics globalTimers:off -- This CDP boundary owns and clears its evaluation deadline.
import { SessionCookie } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { cookieValueDigest } from "@t3tools/shared/scientCookieWriteBack";
import {
  deleteCookies,
  sessionCookieFromCdp,
  setCookies,
  type CdpCookie,
  type CdpSend,
} from "@t3tools/shared/scientSessionCookies";
import type { CDPSession, Page, Request } from "playwright-core";
import { DELIVERY_CHANNELS, VERIFY_NAME, signInDetectionScript } from "../signIn/detection.ts";

const TypeInput = Schema.Struct({
  origin: Schema.String,
  selector: Schema.String,
  text: Schema.String,
  clear: Schema.Literal(true),
  /** Clearing only: leave the field alone unless it still holds what was typed. */
  expected: Schema.optional(Schema.String),
  /** A password or code: kept out of the tab's recorded traffic, and never typed while debugging. */
  secret: Schema.optional(Schema.Literal(true)),
  /** The field as inspected (`otpField`) in this page load (`document`): found by it, not the selector. */
  instance: Schema.optional(Schema.String),
  document: Schema.optional(Schema.Number),
  /** Its container as inspected (`otpContainer`): the field must still be in it when the code goes in. */
  container: Schema.optional(Schema.String),
  /**
   * The saved key's code by itself (`automatic`: on an authenticator's instructions; `generic`: the
   * page's one plain box, with no cue of a delivered code) or by the person's Use saved
   * (`explicit`: never past the veto), checked again after focus.
   */
  mode: Schema.optional(Schema.Literals(["automatic", "generic", "explicit"])),
  /** The run sent the password: a plain box after it is a code challenge without code words. */
  passwordSent: Schema.optional(Schema.Literal(true)),
  /** Focus and check only, nothing typed: the server reads the page again before the value goes in. */
  focusOnly: Schema.optional(Schema.Literal(true)),
});
const WaitInput = Schema.Struct({
  settleMs: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 5000 }))),
  /** At most this long for the load; then it goes on, loaded or not. */
  loadMs: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 5000 }))),
});
const CookiesInput = Schema.Struct({
  urls: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
});

const decodeType = Schema.decodeUnknownSync(TypeInput);
const encodeType = Schema.encodeSync(Schema.fromJsonString(TypeInput));
const WriteInput = Schema.Struct({
  url: Schema.String,
  name: Schema.String,
  path: Schema.String,
  /** The value's digest when Scient read it; the slot is written only while it still holds it. */
  expected: Schema.String,
  /** The slot's SameSite when Scient read it: tightened since, it is another cookie now. */
  sameSite: SessionCookie.fields.sameSite,
  /** The cookie to write in its place; absent deletes the slot. */
  cookie: Schema.optional(SessionCookie),
});
const decodeCookies = Schema.decodeUnknownSync(CookiesInput);
const decodeWrite = Schema.decodeUnknownSync(WriteInput);
const decodeWait = Schema.decodeUnknownSync(WaitInput);

/** The secrets Scient typed into each page, so its recorded traffic never shows them. */
const typed = new WeakMap<Page, Set<string>>();
export const typedSecrets = (page: Page): ReadonlyArray<string> => [...(typed.get(page) ?? [])];

/** Playwright's log categories (`pw:` + one): its protocol, API and channel logs print scripts. */
const PLAYWRIGHT_LOGS = [
  "api",
  "protocol",
  "channel",
  "server",
  "server:channel",
  "server:metadata",
  "browser",
  "error",
  "recorder",
  "socks",
  "install",
  "download",
];

/**
 * Whether a `DEBUG` setting, read as the `debug` package reads it (names split at commas or
 * spaces, `*` any run of characters, a leading `-` excluding), turns on any Playwright log.
 */
function playwrightLogsOn(setting: string) {
  const patterns = setting.split(/[\s,]+/).filter(Boolean);
  const covers = (pattern: string, name: string) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*?")}$`).test(
      name,
    );
  return PLAYWRIGHT_LOGS.some((category) => {
    const name = `pw:${category}`;
    return (
      patterns.some((pattern) => !pattern.startsWith("-") && covers(pattern, name)) &&
      !patterns.some((pattern) => pattern.startsWith("-") && covers(pattern.slice(1), name))
    );
  });
}

/** Playwright's logs carry every evaluated script, typed values included. */
const browserDebugging = () => playwrightLogsOn(globalThis.process?.env.DEBUG ?? "");

/**
 * One named isolated world per document, where Scient's element instances live: the page can't see
 * or reset them. Recreated when the frame loads another document.
 */
const ACCOUNTS_WORLD = "scient-accounts";
const worlds = new WeakMap<CDPSession, { frameId: string; loaderId: string; contextId: number }>();
const WORLD_SETUP = `globalThis.__scientInstances ??= { prefix: crypto.randomUUID().slice(0, 8), next: 1, ids: new WeakMap(), elements: new Map() }; true`;

const accountsWorld = async (cdp: CDPSession, fresh: boolean) => {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { id: frameId, loaderId } = frameTree.frame;
  const known = worlds.get(cdp);
  if (!fresh && known?.frameId === frameId && known.loaderId === loaderId) return known.contextId;
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId,
    worldName: ACCOUNTS_WORLD,
  });
  await cdp.send("Runtime.evaluate", { expression: WORLD_SETUP, contextId: executionContextId });
  worlds.set(cdp, { frameId, loaderId, contextId: executionContextId });
  return executionContextId;
};

/** Runs Scient's own script in the accounts world of the tab's current document. */
export async function evaluateInAccountsWorld(
  cdp: CDPSession,
  expression: string,
  timeoutMs: number,
) {
  for (let attempt = 0; ; attempt++) {
    const contextId = await accountsWorld(cdp, attempt > 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void cdp.send("Runtime.terminateExecution").catch(() => undefined);
        reject(new Error("The page could not be read in time."));
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([
        cdp.send("Runtime.evaluate", {
          expression,
          contextId,
          returnByValue: true,
          awaitPromise: true,
        }),
        expired,
      ]);
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
        );
      return "value" in result.result ? result.result.value : null;
    } catch (error) {
      // The document went between finding its world and running in it: once more, in the new one.
      if (attempt === 0 && /context/i.test(String(error))) continue;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The sign-in detection in the accounts world, asked for with `world: "accounts"`; else undefined. */
export const accountsWorldEvaluation = (cdp: CDPSession, input: unknown, timeoutMs: number) => {
  const { expression, world } = (input ?? {}) as { expression?: unknown; world?: unknown };
  return world === "accounts" && expression === signInDetectionScript
    ? evaluateInAccountsWorld(cdp, expression, timeoutMs).then(async (read) => {
        if (typeof read !== "object" || read === null) return read;
        let seen: Record<string, unknown> = { ...read };
        if (!("codeCue" in seen) && (await namedCue(cdp))) seen = { ...seen, codeCue: true };
        // The one submitter Chromium names for delivery or a new code is none to press.
        if (typeof seen.otpField === "string" && seen.submitInstance !== undefined)
          if (await submitsForDelivery(cdp, seen.otpField)) {
            const { submitInstance: _gone, ...rest } = seen;
            seen = { ...rest, submit: null, otpNoSubmit: true };
          }
        return seen;
      })
    : undefined;
};

const CONTROL_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
]);
const CODE_WORD = /\b(code|codes|otp|pin|passcode|verification|2fa)\b/i;
const DELIVERY_WORD = new RegExp(
  `\\b(${DELIVERY_CHANNELS.join("|")}|e-?mail|resend|re-send)\\b`,
  "i",
);
const ASKS = /\b(send|resend|request|get|new|another|again)\b/i;
const asMatched = (value: unknown) =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/[\s\u200b]+/g, " ")
    .trim();

/**
 * Whether the code field's one sendable submitter is refused by Chromium's own name for it: one
 * that isn't a verify word (Verify, Continue…), or one for delivery or a new code. An ignored
 * node, an empty name, or one that can't be read, is refused too.
 */
async function submitsForDelivery(cdp: CDPSession, field: string) {
  try {
    const contextId = await accountsWorld(cdp, false);
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `(() => { const table = globalThis.__scientInstances; const field = table?.elements.get(${JSON.stringify(field)})?.deref(); return (field && table.check?.(field)?.sendable) ?? null; })()`,
      contextId,
    });
    if (result.objectId === undefined) return false;
    const { node } = await cdp.send("DOM.describeNode", { objectId: result.objectId });
    void cdp.send("Runtime.releaseObject", { objectId: result.objectId }).catch(() => undefined);
    const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
      backendNodeId: node.backendNodeId,
      fetchRelatives: false,
    });
    const [own] = nodes;
    if (own === undefined || own.ignored) return true;
    const name = asMatched(own.name?.value);
    const said = `${name} ${asMatched(own.value?.value)}`;
    return (
      !VERIFY_NAME.test(name.toLowerCase()) ||
      DELIVERY_WORD.test(said) ||
      (CODE_WORD.test(said) && ASKS.test(said))
    );
  } catch {
    return true;
  }
}

/**
 * Whether a control Chromium itself names with a code (its computed name or value: ARIA, an image's
 * alt, a title, whatever it uses) is a cue on this page, as the detection's page-side test says.
 * A tree that can't be read counts as one.
 */
async function namedCue(cdp: CDPSession) {
  try {
    const contextId = await accountsWorld(cdp, false);
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    for (const node of nodes) {
      if (node.ignored || node.backendDOMNodeId === undefined) continue;
      if (!CONTROL_ROLES.has(String(node.role?.value))) continue;
      const name = `${asMatched(node.name?.value)} ${asMatched(node.value?.value)}`;
      if (!CODE_WORD.test(name)) continue;
      const { object } = await cdp.send("DOM.resolveNode", {
        backendNodeId: node.backendDOMNodeId,
        executionContextId: contextId,
      });
      if (object.objectId === undefined) continue;
      const { result } = await cdp.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration:
          "function (asks) { return globalThis.__scientInstances?.counts?.(this, asks) === true; }",
        // Whether the name asks for one, which even the code's own submit may not.
        arguments: [{ value: ASKS.test(name) }],
        returnByValue: true,
      });
      void cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => undefined);
      if (result.value === true) return true;
    }
    return false;
  } catch {
    return true;
  }
}

const DispatchInput = Schema.Struct({
  world: Schema.Literal("accounts"),
  origin: Schema.String,
  /** The code field, its container and the submit button as inspected, in this page load. */
  instance: Schema.String,
  document: Schema.Number,
  container: Schema.optional(Schema.String),
  submitInstance: Schema.optional(Schema.String),
  mode: Schema.Literals(["automatic", "generic", "explicit"]),
  passwordSent: Schema.optional(Schema.Literal(true)),
  /** How long the page has to send or show anything before it is taken as silent. */
  answerMs: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 100, maximum: 10_000 })),
  ),
  /** How long a request the submission sent may take to be answered. */
  responseMs: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 100, maximum: 30_000 })),
  ),
});
const decodeDispatch = Schema.decodeUnknownSync(DispatchInput);
const DISPATCH_ANSWER_MS = 3_000;
const DISPATCH_RESPONSE_MS = 30_000;
const ANSWER_LOOK_MS = 250;
const STATIC_REQUESTS = new Set([
  "image",
  "media",
  "font",
  "script",
  "stylesheet",
  "texttrack",
  "manifest",
  "prefetch",
]);
/**
 * What a key's send came to, when the site may still have it: a request it hadn't answered
 * (`in flight`), or nothing seen at all (`silent`), which a request no listener sees looks like.
 */
export interface KeyDispatch {
  readonly unanswered?: "in flight" | "silent";
}

/**
 * Sends a typed key from the accounts world, re-checked in the same task: only the very field,
 * container and button inspected, unfocused. A request it sent is waited for; a page that sends
 * and shows nothing may still have the code, so it is left as it is.
 */
export const accountsWorldDispatch = (page: Page, cdp: CDPSession, input: unknown) => {
  const { world } = (input ?? {}) as { world?: unknown; instance?: unknown };
  if (world !== "accounts" || (input as { instance?: unknown }).instance === undefined)
    return undefined;
  return dispatchKey(page, cdp, decodeDispatch(input));
};

async function dispatchKey(
  page: Page,
  cdp: CDPSession,
  input: typeof DispatchInput.Type,
): Promise<KeyDispatch> {
  // Every request the page starts from just before the send, from any origin, its workers and
  // frames in other processes included, but the static files a page loads anyway: a stray one
  // only lengthens the bounded wait.
  const open = new Map<Request, boolean>();
  const sent = (request: Request) => {
    if (!STATIC_REQUESTS.has(request.resourceType())) open.set(request, true);
  };
  const ended = (request: Request) => {
    if (open.has(request)) open.set(request, false);
  };
  page.on("request", sent);
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);
  try {
    // A control named with a code since the last read, as Chromium names it, stops a plain box's send.
    if (input.mode === "generic" && (await namedCue(cdp)))
      throw new Error("The sign-in page changed before the code was sent, so Scient sent nothing.");
    // The button to press, as Chromium names it, still isn't one for delivery or a new code.
    if (await submitsForDelivery(cdp, input.instance))
      throw new Error("The sign-in page changed before the code was sent, so Scient sent nothing.");
    const outcome = await evaluateInAccountsWorld(
      cdp,
      `((input) => {
      if (location.origin !== input.origin || performance.timeOrigin !== input.document) return "changed";
      const seen = ${signInDetectionScript};
      const table = globalThis.__scientInstances;
      if (!table || seen.otpField !== input.instance) return "changed";
      if (input.container !== undefined && seen.otpContainer !== input.container) return "changed";
      if (seen.limited === true || seen.challenge === "captcha") return "stopped";
      if (seen.otpSent !== undefined || seen.otpDelivery === true || (input.mode === "automatic" && seen.otpApp !== true)) return "changed";
      const plain = seen.otpOnly === true && (seen.otpContext === true || input.passwordSent === true);
      if (input.mode === "generic" && ((seen.otpApp !== true && !plain) || seen.codeCue === true)) return "changed";
      if (input.submitInstance !== undefined && seen.submitInstance !== input.submitInstance) return "changed";
      const field = table.elements.get(input.instance)?.deref();
      if (!field || !field.isConnected) return "changed";
      const submitter = input.submitInstance === undefined ? undefined : table.elements.get(input.submitInstance)?.deref();
      if (input.submitInstance !== undefined && (!submitter || !submitter.isConnected)) return "changed";
      // Only as the person would send it: pressing an enabled native submitter the code field's own
      // form owns. No such button means no way to send it; a custom control's script could do
      // anything, and a form submitted without its button might go where the site never sends it.
      const owner = field.form;
      if (!owner || !owner.isConnected || !submitter) return "no-path";
      // Still the form's one usable native submitter, and not one for delivery, as it is pressed.
      const live = table.check?.(field);
      if (!live || live.sendable !== submitter || submitter.form !== owner || !live.usable) return "changed";
      table.sent = { field, value: field.value, form: owner, submitter, url: location.href };
      submitter.click();
      return "submitted";
    })(${JSON.stringify({ ...input, answerMs: undefined, responseMs: undefined })})`,
      10_000,
    );
    if (outcome !== "submitted")
      throw new Error(
        outcome === "stopped"
          ? "The site asks for a check or is limiting sign-ins, so Scient sent nothing."
          : outcome === "no-path"
            ? "The code box has no button or form Scient can send it with, so it sent nothing."
            : "The sign-in page changed before the code was sent, so Scient sent nothing.",
      );
    // The page answers by sending a request, navigating, removing or disabling the form or field,
    // changing the value or marking itself busy. Silence may be a press it ignored or a request
    // nothing here sees: either way the site may have the code, so nothing is touched.
    let answered = false;
    const answerMs = input.answerMs ?? DISPATCH_ANSWER_MS;
    for (let waited = 0; waited < answerMs && open.size === 0; waited += ANSWER_LOOK_MS) {
      answered ||= await evaluateInAccountsWorld(
        cdp,
        `(() => {
        const sent = globalThis.__scientInstances?.sent;
        if (!sent) return true;
        return location.href !== sent.url || !sent.field.isConnected || (sent.form && !sent.form.isConnected) ||
          sent.field.value !== sent.value || sent.field.disabled || sent.field.readOnly ||
          (sent.submitter && (sent.submitter.disabled || !sent.submitter.isConnected)) ||
          [sent.form, sent.submitter].some((element) => element?.getAttribute("aria-busy") === "true");
      })()`,
        2_000,
      ).then(
        (value) => value === true,
        () => true,
      );
      await page.waitForTimeout(ANSWER_LOOK_MS);
    }
    if (open.size === 0) {
      return answered ? {} : { unanswered: "silent" };
    }
    // The site has the code: its answer is waited for, and the page is read after it.
    const responseMs = input.responseMs ?? DISPATCH_RESPONSE_MS;
    for (let waited = 0; waited < responseMs; waited += ANSWER_LOOK_MS) {
      if (![...open.values()].includes(true)) return {};
      await page.waitForTimeout(ANSWER_LOOK_MS);
    }
    return [...open.values()].includes(true) ? { unanswered: "in flight" } : {};
  } finally {
    page.off("request", sent);
    page.off("requestfinished", ended);
    page.off("requestfailed", ended);
  }
}

export async function typeAccountValue(
  page: Page,
  cdp: CDPSession,
  input: unknown,
  recording = false,
) {
  const decoded = decodeType(input);
  if (decoded.secret && decoded.text && browserDebugging())
    throw new Error("Browser debugging is on, so Scient won't type a saved secret here.");
  if (decoded.secret && decoded.text)
    typed.set(page, (typed.get(page) ?? new Set<string>()).add(decoded.text));
  // A recording shows what a text field holds, so a code typed there would be in the video.
  const unmasked = decoded.secret === true && recording;
  let filled: unknown;
  // As at the send: a control Chromium names with a code stops a plain box's fill.
  if (decoded.mode === "generic" && decoded.text && (await namedCue(cdp)))
    throw new Error("The sign-in field changed after Scient read it, so it typed nothing there.");
  // Nor goes in where the button that would send it is, by Chromium's name, for delivery.
  if (
    decoded.mode !== undefined &&
    decoded.text &&
    decoded.instance !== undefined &&
    (await submitsForDelivery(cdp, decoded.instance))
  )
    throw new Error("The sign-in field changed after Scient read it, so it typed nothing there.");
  try {
    const { secret: _secret, ...fill } = decoded;
    const run = (values: typeof fill) =>
      evaluateInAccountsWorld(
        cdp,
        `(async ({ origin, selector, text, expected, instance, document: load, container, mode, passwordSent, focusOnly }, unmasked) => {
      if (location.origin !== origin || location.protocol !== "https:") return expected !== undefined;
      // The very element inspected, in the same page load; a replacement since is refused.
      let field;
      if (instance !== undefined) {
        // Another page load took what was typed with it. In this one, a clear finds the field by
        // its instance, moved or not; a field gone or detached can't be shown clear, so it fails.
        if (performance.timeOrigin !== load) return expected !== undefined ? true : "replaced";
        field = globalThis.__scientInstances?.elements.get(instance)?.deref();
        if (!field || !field.isConnected) return expected !== undefined ? false : "replaced";
      } else field = document.querySelector(selector);
      // Asked before focus and again at the setter, since focus may change any of it: a clear
      // leaves a value it didn't type; nothing goes into a field that can't take it, or into one
      // a recording would show unmasked.
      const guards = () => {
        if (expected !== undefined && (!(field instanceof HTMLInputElement) || field.value !== expected)) return true;
        if (!(field instanceof HTMLInputElement) || !field.isConnected || field.disabled || field.readOnly || !field.getClientRects().length) return false;
        if (unmasked && text && field.type !== "password") return "recorded";
        return undefined;
      };
      const before = guards();
      if (before !== undefined) return before;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) return false;
      const formBefore = field.form;
      field.focus();
      // A page may redraw its challenge on focus: the live field, its container, its form and what
      // it asks for must still be what was inspected, or nothing goes in.
      if (instance !== undefined && text) {
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const table = globalThis.__scientInstances;
        if (!field.isConnected || table?.elements.get(instance)?.deref() !== field) return "replaced";
        const live = table.check?.(field);
        if (!live || (container !== undefined && live.container !== container)) return "changed";
        // The field and the one button that would send it are still usable as the platform says.
        if (mode !== undefined && (!live.usable || !live.sendable)) return "changed";
        if (mode !== undefined && (!formBefore || field.form !== formBefore)) return "changed";
        if (mode !== undefined && (live.sent || live.delivery || (mode === "automatic" && !live.app))) return "changed";
        if (mode === "generic" && ((!live.app && !(live.only && (live.context || passwordSent === true))) || live.cue)) return "changed";
        if (focusOnly) return "focused";
      }
      const atSetter = guards();
      if (atSetter !== undefined) return atSetter;
      setter.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })(${encodeType(values)}, ${JSON.stringify(unmasked)})`,
        10_000,
      );
    // A plain box: focused first, then Chromium's names read again, the classifier run again with
    // them, and only then the value set: a control focus reveals stops it.
    if (fill.mode === "generic" && fill.text) {
      const focused = await run({ ...fill, focusOnly: true });
      filled =
        focused === "focused" ? ((await namedCue(cdp)) ? "changed" : await run(fill)) : focused;
    } else filled = await run(fill);
  } catch {
    filled = false;
  }
  if (filled === "replaced" || filled === "changed")
    throw new Error("The sign-in field changed after Scient read it, so it typed nothing there.");
  if (filled === "recorded")
    throw new Error("This tab is being recorded, so Scient won't type a code here.");
  if (!filled) throw new Error("The sign-in field could not be filled on the allowed origin.");
  return {};
}

export async function waitForAccountPage(page: Page, input: unknown, timeoutMs: number) {
  const { settleMs, loadMs } = decodeWait(input ?? {});
  if (loadMs === undefined) await page.waitForLoadState("load", { timeout: timeoutMs });
  else await page.waitForLoadState("load", { timeout: loadMs }).catch(() => undefined);
  if (settleMs) await page.waitForTimeout(settleMs);
  return {};
}

const sessionUrls = (input: unknown) => {
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
  return urls;
};

/** Ends the sessions a tab's jar holds for these sites: what a sign-in that came too late made. */
export async function clearAccountCookies(cdp: CDPSession, input: unknown) {
  try {
    const result = await cdp.send("Network.getCookies", { urls: [...sessionUrls(input)] });
    for (const cookie of result.cookies)
      await cdp.send("Network.deleteCookies", {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
      });
    return { cleared: result.cookies.length };
  } catch {
    throw new Error("The browser session could not be cleared.");
  }
}

export async function readAccountCookies(cdp: CDPSession, input: unknown) {
  try {
    const urls = sessionUrls(input);
    const result = await cdp.send("Network.getCookies", { urls: [...urls] });
    // Every attribute travels; a cookie whose partition can't be carried exactly is left out.
    return result.cookies.flatMap((cookie) => {
      const converted = sessionCookieFromCdp(cookie);
      return "unsupported" in converted ? [] : [converted];
    });
  } catch {
    throw new Error("The browser session could not be read.");
  }
}

/**
 * Rotates or deletes one host-only cookie slot, only while it holds the value Scient last read:
 * a slot the page or another writer changed since is newer, and stays. Read back after writing.
 */
export async function writeAccountCookie(cdp: CDPSession, input: unknown) {
  const { url, name, path, expected, sameSite, cookie } = decodeWrite(input);
  const [checked] = sessionUrls({ urls: [url] });
  const host = new URL(checked!).hostname;
  const send: CdpSend = (method, params) =>
    cdp.send(method as Parameters<CDPSession["send"]>[0], params as never);
  const slotOf = async () => {
    const result = await cdp.send("Network.getCookies", { urls: [checked!] });
    return result.cookies.find(
      (found) =>
        found.name === name && found.domain === host && found.path === path && !found.partitionKey,
    );
  };
  // The slot as Scient read it: still Secure, HttpOnly and its SameSite, or it is another cookie now.
  const sameSlot = (found: CdpCookie) => {
    const read = sessionCookieFromCdp(found);
    return found.secure && found.httpOnly && "sameSite" in read && read.sameSite === sameSite;
  };

  try {
    const current = await slotOf();
    if (current === undefined) return { outcome: "gone" as const };
    if (!sameSlot(current) || cookieValueDigest(current.value) !== expected)
      return { outcome: "changed" as const };
    if (cookie === undefined) await deleteCookies(send, [{ name, domain: host, path }]);
    else await setCookies(send, [cookie]);
    const after = await slotOf();
    const landed = cookie === undefined ? after === undefined : after?.value === cookie.value;
    return { outcome: landed ? ("written" as const) : ("lost" as const) };
  } catch {
    throw new Error("The browser session could not be updated.");
  }
}

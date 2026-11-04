import type { SessionCookie } from "@t3tools/contracts";
import {
  deleteCookies,
  readJar,
  setCookies,
  unitCookies,
  type CdpSend,
  type CookieStore,
} from "@t3tools/shared/scientSessionCookies";
import * as Data from "effect/Data";
import type { BrowserContext, Page } from "playwright-core";
import { getDomain } from "tldts";

/** The registrable site of a host, such as `huji.ac.il` for `idp.cc.huji.ac.il`. */
export const siteOf = (host: string) => {
  const bare = host.replace(/^\./, "").toLowerCase();
  return getDomain(bare, { allowPrivateDomains: true }) ?? bare;
};

/** One persistent server-browser profile's jar, held against new tabs and clears while open. */
export interface ProfileCookieJar extends CookieStore {
  /** Every cookie of the jar, for counts by site. */
  readonly readAll: () => Promise<ReadonlyArray<SessionCookie>>;
  /** Registrable sites of the profile's open pages. */
  readonly openTabSites: () => ReadonlyArray<string>;
  /** A tab or clear has waited too long for this hold: stop before the next unit. */
  readonly stopping: () => boolean;
  /** A cookie operation passed its deadline and was aborted: stop, and give the hold back. */
  readonly stalled: () => boolean;
  /** Reads through Playwright's own context API rather than CDP, for the qualification. */
  readonly independent: {
    readonly names: (url?: string) => Promise<ReadonlyArray<string>>;
    readonly pages: () => number;
  };
}

export class ProfileCookiesError extends Data.TaggedError("ProfileCookiesError")<{
  readonly profileId: string;
  readonly cause: unknown;
}> {
  override get message() {
    return "This computer's browser could not open the profile's sign-ins.";
  }
}

/** A cookie operation longer than this has stalled: its helper page is closed to abort it. */
const COOKIE_OPERATION_DEADLINE_MS = 30_000;

class CookieOperationStalled extends Error {}

/**
 * CDP runs on a blank helper page in the profile's own context, so every Network command acts on
 * that context's jar. The page is never a tab: tabs adopt only pages an open tab opened. A stalled
 * command closes its page, and the next one opens a fresh page, so a restore can still run.
 */
export async function openProfileCookieJar(
  context: BrowserContext,
  stopping = () => false,
  deadlineMs = COOKIE_OPERATION_DEADLINE_MS,
) {
  const helpers = new Set<Page>();
  const open = async () => {
    const page = await context.newPage();
    helpers.add(page);
    try {
      return { page, cdp: await context.newCDPSession(page) };
    } catch (cause) {
      await page.close().catch(() => undefined);
      throw cause;
    }
  };
  let current: Awaited<ReturnType<typeof open>> | undefined = await open();
  let stalled = false;
  const send: CdpSend = async (method, params) => {
    const helper = (current ??= await open());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      // @effect-diagnostics-next-line globalTimers:off -- Playwright calls live outside Effect.
      timer = setTimeout(() => reject(new CookieOperationStalled()), deadlineMs);
    });
    try {
      return await Promise.race([
        helper.cdp.send(method as Parameters<typeof helper.cdp.send>[0], params as never),
        deadline,
      ]);
    } catch (cause) {
      if (cause instanceof CookieOperationStalled) {
        stalled = true;
        if (current === helper) current = undefined;
        await helper.page.close().catch(() => undefined);
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  };
  const readAll = async () => (await readJar(send)).cookies;
  const jar: ProfileCookieJar = {
    readAll,
    readUnit: async (unit) => unitCookies(unit, await readAll(), siteOf),
    set: (cookies) => setCookies(send, cookies),
    remove: (cookies) => deleteCookies(send, cookies),
    stopping,
    stalled: () => stalled,
    openTabSites: () =>
      context.pages().flatMap((page) => {
        if (helpers.has(page) || page.isClosed()) return [];
        const url = URL.parse(page.url());
        return url && /^https?:$/.test(url.protocol) ? [siteOf(url.hostname)] : [];
      }),
    independent: {
      names: async (url) => (await context.cookies(url)).map((cookie) => cookie.name),
      pages: () => context.pages().length,
    },
  };
  return {
    jar,
    close: async () => {
      await Promise.all([...helpers].map((page) => page.close().catch(() => undefined)));
    },
  };
}

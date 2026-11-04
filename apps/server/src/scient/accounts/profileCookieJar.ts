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
import type { BrowserContext } from "playwright-core";
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

/**
 * CDP runs on a blank helper page in the profile's own context, so every Network command acts on
 * that context's jar. The page is never a tab: tabs adopt only pages an open tab opened.
 */
export async function openProfileCookieJar(context: BrowserContext) {
  const page = await context.newPage();
  try {
    const cdp = await context.newCDPSession(page);
    const send: CdpSend = (method, params) =>
      cdp.send(method as Parameters<typeof cdp.send>[0], params as never);
    const readAll = async () => (await readJar(send)).cookies;
    const jar: ProfileCookieJar = {
      readAll,
      readUnit: async (unit) => unitCookies(unit, await readAll(), siteOf),
      set: (cookies) => setCookies(send, cookies),
      remove: (cookies) => deleteCookies(send, cookies),
      openTabSites: () =>
        context.pages().flatMap((open) => {
          if (open === page || open.isClosed()) return [];
          const url = URL.parse(open.url());
          return url && /^https?:$/.test(url.protocol) ? [siteOf(url.hostname)] : [];
        }),
      independent: {
        names: async (url) => (await context.cookies(url)).map((cookie) => cookie.name),
        pages: () => context.pages().length,
      },
    };
    return { jar, close: () => page.close().catch(() => undefined) };
  } catch (cause) {
    await page.close().catch(() => undefined);
    throw cause;
  }
}

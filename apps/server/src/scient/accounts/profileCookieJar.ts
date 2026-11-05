import type { SessionCookie } from "@t3tools/contracts";
import {
  deleteCookies,
  readJar,
  setCookies,
  unitCookies,
  type CdpSend,
  type CookieStore,
} from "@t3tools/shared/scientSessionCookies";
import { siteOf } from "@t3tools/shared/scientSiteMatch";
import * as Schema from "effect/Schema";
import type { BrowserContext, Page } from "playwright-core";

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
  /** Opening, attaching or closing a helper stalled: the context is discarded on release. */
  readonly quarantined: () => boolean;
}

/** Reads through Playwright's own context API rather than CDP: the qualification's second look. */
export interface IndependentReads {
  readonly names: (url?: string) => Promise<ReadonlyArray<string>>;
  readonly pages: () => number;
}

const independentReads = new WeakMap<ProfileCookieJar, IndependentReads>();

/** The qualification's own reads of a jar this module opened; never used by delivery. */
export const independentReadsOf = (jar: ProfileCookieJar) => independentReads.get(jar);

export class ProfileCookiesError extends Schema.TaggedError<ProfileCookiesError>()(
  "ProfileCookiesError",
  { profileId: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "This computer's browser could not open the profile's sign-ins.";
  }
}

/** A cookie operation, or a helper page's opening or closing, longer than this has stalled. */
const COOKIE_OPERATION_DEADLINE_MS = 30_000;

class CookieOperationStalled extends Schema.TaggedError<CookieOperationStalled>()(
  "CookieOperationStalled",
  {},
) {}
const isCookieOperationStalled = Schema.is(CookieOperationStalled);

/** Rejects once `ms` passes; the operation itself may still be running. */
const withinDeadline = <A>(operation: Promise<A>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    // @effect-diagnostics-next-line globalTimers:off -- Playwright calls live outside Effect.
    timer = setTimeout(() => reject(new CookieOperationStalled()), ms);
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
};

/**
 * CDP runs on a blank helper page in the profile's own context, never a tab. Every step has a
 * deadline: a stalled command closes its page and the next opens a fresh one, so a restore runs.
 * A stalled open, attach or close quarantines the jar: later operations fail, the holder discards it.
 */
export async function openProfileCookieJar(
  context: BrowserContext,
  stopping = () => false,
  deadlineMs = COOKIE_OPERATION_DEADLINE_MS,
) {
  const helpers = new Set<Page>();
  let stalled = false;
  let quarantined = false;
  const bounded = async <A>(operation: () => Promise<A>, lifecycle: boolean) => {
    if (quarantined) throw new CookieOperationStalled();
    try {
      return await withinDeadline(operation(), deadlineMs);
    } catch (cause) {
      if (isCookieOperationStalled(cause)) {
        stalled = true;
        if (lifecycle) quarantined = true;
      }
      throw cause;
    }
  };
  const closeHelper = (page: Page) =>
    bounded(() => page.close(), true).then(
      () => void helpers.delete(page),
      () => undefined,
    );
  const open = async () => {
    const page = await bounded(() => context.newPage(), true);
    helpers.add(page);
    try {
      return { page, cdp: await bounded(() => context.newCDPSession(page), true) };
    } catch (cause) {
      if (!quarantined) await closeHelper(page);
      throw cause;
    }
  };
  let current: Awaited<ReturnType<typeof open>> | undefined = await open();
  const send: CdpSend = async (method, params) => {
    const helper = (current ??= await open());
    try {
      return await bounded(
        () => helper.cdp.send(method as Parameters<typeof helper.cdp.send>[0], params as never),
        false,
      );
    } catch (cause) {
      if (isCookieOperationStalled(cause) && current === helper) {
        current = undefined;
        await closeHelper(helper.page);
      }
      throw cause;
    }
  };
  // Every unit read is fresh: the hold keeps new tabs out, but open pages, their responses and
  // workers still write, and this context has no change signal to say when.
  const readAll = async () => (await readJar(send)).cookies;
  const jar: ProfileCookieJar = {
    readAll,
    readUnit: async (unit) => unitCookies(unit, await readAll()),
    set: (cookies) => setCookies(send, cookies),
    remove: (cookies) => deleteCookies(send, cookies),
    stopping,
    stalled: () => stalled,
    quarantined: () => quarantined,
    openTabSites: () =>
      context.pages().flatMap((page) => {
        if (helpers.has(page) || page.isClosed()) return [];
        const url = URL.parse(page.url());
        return url && /^https?:$/.test(url.protocol) ? [siteOf(url.hostname)] : [];
      }),
  };
  independentReads.set(jar, {
    names: async (url) => (await context.cookies(url)).map((cookie) => cookie.name),
    pages: () => context.pages().length,
  });
  return {
    jar,
    close: async () => {
      if (!quarantined) await Promise.all([...helpers].map(closeHelper));
    },
  };
}

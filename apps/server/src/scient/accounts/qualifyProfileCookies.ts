// @effect-diagnostics cryptoRandomUUID:off -- Plain async browser work.
import type { DesktopQualifyCase } from "@t3tools/contracts";
import {
  COPY_CASES,
  domainCookie,
  failureText,
  named,
  recordCase,
  runCases,
  type QualifyCase,
  type QualifyJar,
} from "@t3tools/shared/scientSessionQualify";

import { independentReadsOf, type ProfileCookieJar } from "./profileCookieJar.ts";

/**
 * Checks that the server browser's cookie adapter copies exactly, on this computer's Chromium, in
 * two throwaway profiles that are deleted afterwards. Item 3's cases 1–9, then persistence across a
 * restart of the profile's browser, and the helper page never showing as a page of the profile.
 */
export interface QualifyBrowser {
  /** Holds a profile's jar; `release` closes the context the hold opened. */
  readonly open: (
    profileId: string,
  ) => Promise<{ readonly jar: ProfileCookieJar; readonly release: () => Promise<void> }>;
  readonly clear: (profileId: string) => Promise<void>;
}

type Held = Awaited<ReturnType<QualifyBrowser["open"]>>;

const independent = (held: Held) => {
  const reads = independentReadsOf(held.jar);
  if (!reads) throw new Error("The jar was not opened by the server browser.");
  return reads;
};

const UNIT = ["qualify.test"];

/** A held profile as the shared cases see it. */
const qualifyJar = (held: Held): QualifyJar & { readonly held: Held } => ({
  held,
  set: (cookies) => held.jar.set(cookies),
  read: () => held.jar.readUnit(UNIT),
  remove: (cookies) => held.jar.remove(cookies),
  sentTo: (url) => independent(held).names(url),
});

const CASES: ReadonlyArray<QualifyCase<ReturnType<typeof qualifyJar>>> = [
  [
    "isolation",
    async (a, b) => {
      const name = `isolated-${crypto.randomUUID()}`;
      await a.set([domainCookie(name)]);
      if (!(await independent(a.held).names()).includes(name))
        return "the write did not land in A's own context";
      return (await independent(b.held).names()).includes(name) ||
        named(await b.read(), name).length
        ? "B sees A's cookie"
        : undefined;
    },
  ],
  ...COPY_CASES,
];

export async function qualifyProfileCookies(browser: QualifyBrowser) {
  const id = crypto.randomUUID();
  const profileA = `scient-qualify-a-${id}`;
  const profileB = `scient-qualify-b-${id}`;
  const results: DesktopQualifyCase[] = [];
  const record = (name: string, detail: string | undefined) => recordCase(results, name, detail);
  try {
    const a = await browser.open(profileA);
    let releasedA = false;
    try {
      const b = await browser.open(profileB);
      try {
        await runCases(CASES, qualifyJar(a), qualifyJar(b), results);
        record(
          "helper page",
          independent(a).pages() === 1 && a.jar.openTabSites().length === 0
            ? undefined
            : "the helper page shows as a page of the profile",
        );
      } finally {
        await b.release();
      }
      await a.release();
      releasedA = true;
      // The hold opened A's browser, so release closed it; a new one reads the same directory.
      const again = await browser.open(profileA);
      try {
        const kept = named(await again.jar.readUnit(UNIT), "unit-1");
        record(
          "persistence",
          kept.length === 1 ? undefined : "a cookie did not outlive the profile's browser",
        );
      } finally {
        await again.release();
      }
    } finally {
      if (!releasedA) await a.release();
    }
  } catch (cause) {
    record("setup", failureText(cause));
  } finally {
    await Promise.all([browser.clear(profileA), browser.clear(profileB)]).catch(() => undefined);
  }
  return results;
}

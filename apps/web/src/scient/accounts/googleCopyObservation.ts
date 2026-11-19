import type { DesktopGoogleSession, EnvironmentId } from "@t3tools/contracts";

import { randomUUID } from "~/lib/utils";
import {
  ageBucket,
  beginAccountBrowserObservation,
  recordInAccountBrowserContext,
  type AccountBrowserObservation,
  type GoogleCopySource,
} from "../analytics/accountBrowserAnalytics";

const KEEP_MS = 30 * 86_400_000;
const SOURCES: Record<GoogleCopySource, true> = {
  browser_window: true,
  browser_import: true,
  main_copy: true,
};

/** One copy of a Google sign-in into a profile, kept on this computer only and never sent. */
interface GoogleCopy {
  readonly v: 1;
  /** A new copy into the profile is a new generation; a read begun for an older one is dropped. */
  readonly generation: string;
  /**
   * The consent context the copy was made under. Its observations are recorded only under it, and
   * the copy is forgotten once consent changes, so nothing seen under other consent is sent.
   */
  readonly context: string;
  readonly source: GoogleCopySource;
  readonly copiedAt: number;
  readonly lastValidAt?: number;
  readonly checked: boolean;
}

type Ledger = Record<string, GoogleCopy>;

const storageKey = (environmentId: EnvironmentId) => `scient:google-copies:${environmentId}`;

const isGoogleCopy = (value: unknown): value is GoogleCopy => {
  if (typeof value !== "object" || value === null) return false;
  const copy = value as Record<string, unknown>;
  return (
    copy.v === 1 &&
    typeof copy.generation === "string" &&
    typeof copy.context === "string" &&
    typeof copy.source === "string" &&
    Object.hasOwn(SOURCES, copy.source) &&
    typeof copy.copiedAt === "number" &&
    (copy.lastValidAt === undefined || typeof copy.lastValidAt === "number") &&
    typeof copy.checked === "boolean"
  );
};

// Storage that throws or holds something else reads as empty: the ledger never breaks Accounts.
function readLedger(environmentId: EnvironmentId): Ledger {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(environmentId)) ?? "{}");
    if (typeof value !== "object" || value === null) return {};
    return Object.fromEntries(Object.entries(value).filter(([, copy]) => isGoogleCopy(copy)));
  } catch {
    return {};
  }
}

function writeLedger(environmentId: EnvironmentId, ledger: Ledger) {
  try {
    if (Object.keys(ledger).length === 0) localStorage.removeItem(storageKey(environmentId));
    else localStorage.setItem(storageKey(environmentId), JSON.stringify(ledger));
  } catch {
    // The observation is lost; Accounts is not.
  }
}

function forget(environmentId: EnvironmentId, ledger: Ledger, profileId: string) {
  const { [profileId]: _forgotten, ...kept } = ledger;
  writeLedger(environmentId, kept);
}

/**
 * Google cookies were just written into a profile that held no session Google accepted: start
 * following how long Google keeps accepting them. Only when the work that copied them began under
 * the consent still in force; otherwise any earlier copy into the profile is forgotten too.
 */
export function noteGoogleCopy(
  environmentId: EnvironmentId,
  profileId: string,
  source: GoogleCopySource,
  observation: Pick<AccountBrowserObservation, "context">,
  now = Date.now(),
): void {
  const ledger = readLedger(environmentId);
  const { context } = observation;
  if (context === undefined || beginAccountBrowserObservation(environmentId).context !== context) {
    if (ledger[profileId]) forget(environmentId, ledger, profileId);
    return;
  }
  writeLedger(environmentId, {
    ...ledger,
    [profileId]: { v: 1, generation: randomUUID(), context, source, copiedAt: now, checked: false },
  });
}

/** The person signed the profile out of Google, cleared or removed it through Scient. */
export function forgetGoogleCopy(environmentId: EnvironmentId, profileId: string): void {
  const ledger = readLedger(environmentId);
  if (ledger[profileId]) forget(environmentId, ledger, profileId);
}

/** The copy a Google read about to start is about; pass it back to `observeGoogleCopy`. */
export function googleCopyGeneration(environmentId: EnvironmentId, profileId: string) {
  return readLedger(environmentId)[profileId]?.generation;
}

/**
 * Google's answer for the generation the read began with; `null` says nothing. The first definite
 * answer is `checked`. No accepted account (an empty list included) after one was accepted is
 * `ended`; before any was, the copy was never accepted. Either way the observation stops.
 */
export function observeGoogleCopy(
  environmentId: EnvironmentId,
  profileId: string,
  generation: string,
  sessions: ReadonlyArray<DesktopGoogleSession> | null,
  now = Date.now(),
): void {
  const ledger = readLedger(environmentId);
  const copy = ledger[profileId];
  if (!copy || copy.generation !== generation) return;
  // Consent off or unknown: nothing is recorded. Consent given again since: a new context, forgotten.
  const current = beginAccountBrowserObservation(environmentId).context;
  if (current === undefined) return;
  if (current !== copy.context) {
    forget(environmentId, ledger, profileId);
    return;
  }
  if (sessions === null) return;
  const valid = sessions.some((session) => session.valid);
  const record = recordInAccountBrowserContext;
  if (!copy.checked)
    record(environmentId, copy.context, "accounts.google_copy.checked", {
      variant: copy.source,
      outcome: valid ? "valid" : "invalid",
    });
  if (valid) {
    writeLedger(environmentId, {
      ...ledger,
      [profileId]: { ...copy, checked: true, lastValidAt: now },
    });
    return;
  }
  if (copy.lastValidAt !== undefined)
    record(environmentId, copy.context, "accounts.google_copy.ended", {
      variant: copy.source,
      ageBucket: ageBucket(now - copy.copiedAt),
      lastValidBucket: ageBucket(copy.lastValidAt - copy.copiedAt),
    });
  forget(environmentId, ledger, profileId);
}

/** Drops copies into profiles that are gone, and copies older than a month. */
export function pruneGoogleCopies(
  environmentId: EnvironmentId,
  profileIds: ReadonlyArray<string>,
  now = Date.now(),
): void {
  const ledger = readLedger(environmentId);
  const kept = Object.fromEntries(
    Object.entries(ledger).filter(
      ([profileId, copy]) => profileIds.includes(profileId) && now - copy.copiedAt < KEEP_MS,
    ),
  );
  if (Object.keys(kept).length !== Object.keys(ledger).length) writeLedger(environmentId, kept);
}

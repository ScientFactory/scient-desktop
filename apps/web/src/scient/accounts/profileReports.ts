import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  ACCOUNTS_PROTOCOL_2,
  BrowserProfileId,
  isBuiltInBrowserProfileId,
  type AccountsSnapshot,
  type BrowserSourceProfile,
  type EnvironmentId,
  type ReportingComputer,
  linksBrowserProfile,
} from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { getClientSettings, subscribeClientSettings } from "~/hooks/useSettings";
import { accountsState } from "./accountsState";

/** This client's own profiles, as it lists them; Main and private windows are no one's to name. */
function reportedProfiles(
  profiles: ReadonlyArray<{ readonly id: string; readonly name: string; readonly kind: string }>,
) {
  return profiles.flatMap((profile) =>
    profile.kind === "persistent" && !isBuiltInBrowserProfileId(profile.id) && profile.name.trim()
      ? [{ profileId: BrowserProfileId.make(profile.id), name: profile.name.trim().slice(0, 80) }]
      : [],
  );
}

/** A browser profile on this desktop, as its browser names it: never a cookie, password or history. */
export type DesktopSource = Omit<BrowserSourceProfile, "linkedTo">;

/** The desktop app this window runs in, which agents may import browser profiles through. */
export interface ThisDesktop {
  /** This desktop as other computers name it; none until it is known. */
  readonly computer: () => ReportingComputer | undefined;
  /** Its browser profiles to import from. */
  readonly sources: () => Promise<ReadonlyArray<DesktopSource>>;
  /** Whether it is this desktop's own backend: only it imports these browsers (round 6f). */
  readonly ownBackend: (environmentId: EnvironmentId) => boolean;
}

/** Seen within ten minutes, a desktop counts as on: it says so again every five. */
const HEARTBEAT_MS = 5 * 60 * 1000;

/** Each source with the profile on that computer it is linked to, matched as Refresh finds it. */
function linkedSources(
  sources: ReadonlyArray<DesktopSource>,
  records: AccountsSnapshot["profiles"],
  computer: ReportingComputer,
): Array<BrowserSourceProfile> {
  return sources.slice(0, 100).map((source) => {
    const linked = records.find(
      (record) =>
        !record.removed &&
        !record.retired &&
        record.source !== undefined &&
        // Linked on another desktop: its folder of the same name is not this one.
        linksBrowserProfile(record.source, { ...source, computerId: computer.id }),
    );
    return linked ? { ...source, linkedTo: linked.profileId } : { ...source };
  });
}

/**
 * Tells a computer's Accounts (protocol 2) the profiles this client lists and their names, so the
 * server's record names each one for agents and other clients. Sent again when the list changes.
 * From the desktop app, it also names this desktop's browser profiles, which agents may import
 * from (AMENDMENTS 58): on connect, on a change, and every five minutes while it is on.
 */
export function watchProfileReports(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  desktop?: ThisDesktop,
) {
  const atom = accountsState.snapshot({ environmentId, input: {} });
  let sent = "";
  let sources: ReadonlyArray<DesktopSource> | undefined;
  let reading = false;
  const report = () => {
    const result = registry.get(atom);
    if (!AsyncResult.isSuccess(result)) return;
    if ((result.value.accountsProtocol ?? 0) < ACCOUNTS_PROTOCOL_2) return;
    const profiles = reportedProfiles(getClientSettings().browserProfiles);
    const computer = desktop?.computer();
    const reported =
      computer && sources
        ? {
            computer,
            sources: desktop?.ownBackend(environmentId)
              ? linkedSources(sources, result.value.profiles, computer)
              : [],
          }
        : undefined;
    const key = JSON.stringify([profiles, reported]);
    if (key === sent || (profiles.length === 0 && !reported)) return;
    sent = key;
    void runAtomCommand(
      registry,
      accountsState.reportProfiles,
      { environmentId, input: { profiles, ...reported } },
      { reportFailure: false },
    ).catch(() => {
      sent = "";
    });
  };
  const readSources = () => {
    if (!desktop || reading) return;
    reading = true;
    void desktop
      .sources()
      .then((list) => {
        sources = list;
      })
      .catch(() => undefined)
      .finally(() => {
        reading = false;
        report();
      });
  };
  const stops = [
    registry.subscribe(atom, report, { immediate: true }),
    subscribeClientSettings(report),
  ];
  readSources();
  // Read again and told again, so the server knows the list is current and this desktop is on.
  const heartbeat = desktop
    ? setInterval(() => {
        sent = "";
        readSources();
      }, HEARTBEAT_MS)
    : undefined;
  return () => {
    for (const stop of stops) stop();
    if (heartbeat !== undefined) clearInterval(heartbeat);
  };
}

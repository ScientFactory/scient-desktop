import { useAtomValue } from "@effect/atom-react";
import {
  defaultBrowserProfileRecord,
  resolveBrowserProfiles,
  type AccountsSnapshot,
  type BrowserProfileRecord,
  type EnvironmentId,
} from "@t3tools/contracts";
import { SENDER_KEEP_DAYS, shareable } from "@t3tools/shared/scientSessionCookies";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useClientSettings } from "~/hooks/useSettings";
import { readDesktopSecondaryBootstraps } from "~/connection/desktopLocal";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { usePreparedConnection } from "~/state/session";

import { allowedRoute, sendAgain, sendingRemotesAtom } from "./remoteSessions";
import { useAccounts } from "./useAccounts";

/** "10:14", "yesterday 18:40", or a date: times on these lines are labels only. */
function when(iso: string, now = new Date()) {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (date: Date) => date.toDateString();
  if (day(at) === day(now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day(at) === day(yesterday)) return `yesterday ${time}`;
  return `${at.toLocaleDateString()} ${time}`;
}

export interface RemoteLineInput {
  readonly label: string;
  readonly phase: string;
  readonly sending: boolean;
  readonly refused: "relay" | "unencrypted" | undefined;
  /** The remote's snapshot while connected. */
  readonly remote: Pick<AccountsSnapshot, "features"> | undefined;
  /** This desktop's records of what the remote applied, one per profile. */
  readonly shared: ReadonlyArray<NonNullable<BrowserProfileRecord["sharedWith"]>[number]>;
  /** University rows here whose institution the remote has no row for. */
  readonly universities: ReadonlyArray<string>;
}

/** The first matching state, then the suffixes that apply. */
export function remoteLine(input: RemoteLineInput, now = new Date()) {
  const sentAt = input.shared
    .flatMap(({ sentAt }) => (sentAt ? [sentAt] : []))
    .sort()
    .at(-1);
  const seenAt = input.shared
    .flatMap(({ seenAt }) => (seenAt ? [seenAt] : []))
    .sort()
    .at(-1);
  const connected = input.phase === "connected";
  const state = input.sending
    ? "sending your sign-ins…"
    : input.refused
      ? `doesn't get sign-ins: ${input.refused === "relay" ? "connected through a relay" : "connected without encryption"}`
      : connected && input.remote && !input.remote.features?.sessionsReceive
        ? "can't receive sign-ins: update Scient there"
        : connected && sentAt
          ? `has your sign-ins from ${when(sentAt, now)}`
          : !connected && sentAt
            ? `offline${seenAt ? ` since ${when(seenAt, now)}` : ""} · has your sign-ins from ${when(sentAt, now)}, kept ${SENDER_KEEP_DAYS} days without this computer`
            : "gets your sign-ins when it connects";
  const needsYou = [...new Set(input.shared.flatMap(({ needsYou }) => needsYou))];
  const kept = input.shared.reduce((total, { kept }) => total + (kept ?? 0), 0);
  const waiting = input.shared.reduce((total, { waiting }) => total + waiting, 0);
  const suffixes = [
    ...(needsYou.length
      ? [`${needsYou.join(", ")} ${needsYou.length > 1 ? "need" : "needs"} you there`]
      : []),
    ...(kept ? [`${kept} kept its own`] : []),
    ...(waiting ? [`${waiting} waiting`] : []),
    ...input.universities.map((name) => `${name} isn't connected there`),
  ];
  return { text: [`${input.label} · ${state}`, ...suffixes].join(" · "), needsYou, waiting };
}

const NOT_SENT_REASONS = (record: BrowserProfileRecord) =>
  record.access === "off"
    ? "off for agents"
    : record.scope.type !== "all-projects"
      ? "limited to projects here"
      : "kept from scripts";

/** Persistent profiles that don't go to other computers, with why. */
export function notSentLine(
  profiles: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly record: BrowserProfileRecord;
  }>,
) {
  const held = profiles.filter(({ id, record }) => !shareable(id, record));
  return held.length
    ? `Not sent to other computers: ${held.map(({ name, record }) => `${name} (${NOT_SENT_REASONS(record)})`).join(", ")}.`
    : undefined;
}

const institutionsOf = (snapshot: Pick<AccountsSnapshot, "accounts"> | undefined) =>
  (snapshot?.accounts ?? []).flatMap(({ details }) =>
    details.kind === "website" && details.institution ? [details.institution.name] : [],
  );

function RemoteComputerRow({
  environmentId,
  label,
  phase,
  desktop,
}: {
  environmentId: EnvironmentId;
  label: string;
  phase: string;
  desktop: Pick<AccountsSnapshot, "accounts" | "profiles">;
}) {
  const navigate = useNavigate();
  const sending = useAtomValue(sendingRemotesAtom).has(environmentId);
  const prepared = usePreparedConnection(environmentId);
  const remote = useAccounts(environmentId).data ?? undefined;
  const refused = Option.isSome(prepared)
    ? allowedRoute(prepared.value, readDesktopSecondaryBootstraps())
    : undefined;
  const universities = institutionsOf(desktop).filter(
    (name) => remote !== undefined && !institutionsOf(remote).includes(name),
  );
  const line = remoteLine({
    label,
    phase,
    sending,
    refused,
    remote,
    shared: desktop.profiles.flatMap(
      (record) => record.sharedWith?.filter((entry) => entry.environmentId === environmentId) ?? [],
    ),
    universities,
  });
  const openThere = () =>
    void navigate({ to: "/settings/accounts", search: { machine: environmentId } });
  return (
    <SettingsRow
      title={
        line.waiting ? (
          <Tooltip>
            <TooltipTrigger render={<span />}>{line.text}</TooltipTrigger>
            <TooltipPopup>Busy or failed; they go with the next delivery.</TooltipPopup>
          </Tooltip>
        ) : (
          line.text
        )
      }
      control={
        line.needsYou.length || universities.length ? (
          <Button size="xs" variant="outline" onClick={openThere}>
            Sign in there
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * The desktop's line per other computer: what it holds of this desktop's sign-ins, and what
 * needs the user there. Sign-ins go one way, from this desktop, and never with passwords.
 */
export function RemoteComputers({
  environmentId,
  snapshot,
  canWrite,
}: {
  environmentId: EnvironmentId;
  snapshot: Pick<AccountsSnapshot, "accounts" | "profiles">;
  canWrite: boolean;
}) {
  const primaryId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const settings = useClientSettings();
  const [sendingAgain, setSendingAgain] = useState(false);
  if (environmentId !== primaryId) {
    const received = snapshot.profiles.flatMap((record) => record.received ?? []);
    const from = received[0]?.label;
    const at = received
      .map(({ sentAt }) => sentAt)
      .sort()
      .at(-1);
    return from && at ? (
      <p className="text-sm text-muted-foreground">
        Sign-ins from {from}, {when(at)} · change them there
      </p>
    ) : null;
  }
  if (!window.desktopBridge?.accounts?.readSessions) return null;
  const remotes = environments.filter((environment) => environment.environmentId !== primaryId);
  if (remotes.length === 0) return null;
  const profiles = resolveBrowserProfiles(settings.browserProfiles)
    .filter((profile) => profile.kind === "persistent")
    .map((profile) => ({
      id: profile.id,
      name: profile.name,
      record:
        snapshot.profiles.find((record) => record.profileId === profile.id) ??
        defaultBrowserProfileRecord(profile.id),
    }));
  const notSent = notSentLine(profiles);
  return (
    <SettingsSection
      id="accounts-other-computers"
      title="Other computers"
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={!canWrite || sendingAgain}
          onClick={async () => {
            setSendingAgain(true);
            await sendAgain(appAtomRegistry, environmentId).catch(() => undefined);
            setSendingAgain(false);
          }}
        >
          Send again
        </Button>
      }
    >
      {remotes.map((remote) => (
        <RemoteComputerRow
          key={remote.environmentId}
          environmentId={remote.environmentId}
          label={remote.label}
          phase={remote.connection.phase}
          desktop={snapshot}
        />
      ))}
      {notSent ? <SettingsRow title={notSent} /> : null}
    </SettingsSection>
  );
}

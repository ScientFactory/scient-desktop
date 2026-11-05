import { useAtomValue } from "@effect/atom-react";
import {
  ACCOUNTS_PROTOCOL,
  BrowserProfileId,
  defaultBrowserProfileRecord,
  resolveBrowserProfiles,
  type AccountsSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import { SENDER_KEEP_DAYS } from "@t3tools/shared/scientSessionCookies";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Switch } from "~/components/ui/switch";
import { updateClientSettings, useClientSettings } from "~/hooks/useSettings";
import { readDesktopSecondaryBootstraps } from "~/connection/desktopLocal";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { usePreparedConnection } from "~/state/session";

import {
  notSent,
  remoteView,
  type NotSentReason,
  type RemoteState,
  type RemoteView,
} from "./remoteComputersView";
import {
  allowedRoute,
  deliveryFailuresAtom,
  sendAgain,
  sendingRemotesAtom,
} from "./remoteSessions";
import { accountsState } from "./accountsState";
import { useAccountCommand, useAccounts } from "./useAccounts";
import { useSignIn } from "./useSignIn";

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

function stateText(state: RemoteState, now: Date) {
  switch (state.kind) {
    case "sharing-off":
      return "doesn't get your sign-ins: sending them is off";
    case "sending":
      return "sending your sign-ins…";
    case "failed":
      return `couldn't send your sign-ins at ${when(state.failure.at, now)}: ${state.failure.reason === "refused" ? "it refused this computer" : "the request failed"}`;
    case "refused":
      return `doesn't get sign-ins: ${state.route === "relay" ? "connected through a relay" : "connected without encryption"}`;
    case "outdated":
      return "can't receive sign-ins: update Scient there";
    case "delivered":
      return `has your sign-ins from ${when(state.sentAt, now)}`;
    case "offline":
      return `offline${state.seenAt ? ` since ${when(state.seenAt, now)}` : ""} · has your sign-ins from ${when(state.sentAt, now)}, kept ${SENDER_KEEP_DAYS} days without this computer`;
    case "on-connect":
      return "gets your sign-ins when it connects";
  }
}

function remoteText(label: string, view: RemoteView, now = new Date()) {
  const { needsYou } = view;
  return [
    `${label} · ${stateText(view.state, now)}`,
    ...(needsYou.length
      ? [`${needsYou.join(", ")} ${needsYou.length > 1 ? "need" : "needs"} you there`]
      : []),
    ...(view.kept ? [`${view.kept} kept its own`] : []),
    ...(view.waiting ? [`${view.waiting} waiting`] : []),
    ...view.universities.map((name) => `${name} isn't connected there`),
  ].join(" · ");
}

const NOT_SENT_TEXT: Record<NotSentReason, string> = {
  off: "off for agents",
  projects: "limited to projects here",
  scripts: "kept from scripts",
};

const institutionsOf = (snapshot: Pick<AccountsSnapshot, "accounts"> | undefined) =>
  (snapshot?.accounts ?? []).flatMap(({ details }) =>
    details.kind === "website" && details.institution ? [details.institution.name] : [],
  );

function RemoteComputerRow({
  environmentId,
  label,
  phase,
  sharing,
  desktop,
}: {
  environmentId: EnvironmentId;
  label: string;
  phase: string;
  sharing: boolean;
  desktop: Pick<AccountsSnapshot, "accounts" | "profiles">;
}) {
  const navigate = useNavigate();
  const sending = useAtomValue(sendingRemotesAtom).has(environmentId);
  const failure = useAtomValue(deliveryFailuresAtom).get(environmentId);
  const prepared = usePreparedConnection(environmentId);
  const remote = useAccounts(environmentId).data ?? undefined;
  const refused = Option.isSome(prepared)
    ? allowedRoute(prepared.value, readDesktopSecondaryBootstraps())
    : undefined;
  const universities = institutionsOf(desktop).filter(
    (name) => remote !== undefined && !institutionsOf(remote).includes(name),
  );
  const line = remoteView({
    phase,
    sharing,
    sending,
    failure,
    refused,
    remote,
    shared: desktop.profiles.flatMap(
      (record) => record.sharedWith?.filter((entry) => entry.environmentId === environmentId) ?? [],
    ),
    universities,
  });
  const openThere = () =>
    void navigate({ to: "/settings/accounts", search: { machine: environmentId } });
  const save = useAccountCommand(accountsState.save, environmentId);
  const signIn = useSignIn(environmentId);
  const needs = desktop.profiles.flatMap((record) =>
    (record.sharedWith ?? [])
      .filter((entry) => entry.environmentId === environmentId)
      .flatMap((entry) => entry.needsYou.map((site) => ({ profileId: record.profileId, site }))),
  );
  /**
   * The user signs in once on that computer, in its own browser: a row there for the site, then
   * its sign-in, which goes again if nothing comes of it. Older computers open their Accounts.
   */
  const signInThere = async () => {
    const first = needs[0];
    if (!first || (remote?.accountsProtocol ?? 0) < ACCOUNTS_PROTOCOL) return openThere();
    const saved = await save({
      name: first.site,
      details: {
        kind: "website",
        sites: [first.site],
        profileId: BrowserProfileId.make(first.profileId),
        origin: "browser-session",
      },
      secrets: {},
    });
    if (!saved.ok || !(await signIn(saved.value.accountId, { discardIfUnfinished: true })))
      openThere();
  };
  return (
    <SettingsRow
      title={
        line.waiting ? (
          <Tooltip>
            <TooltipTrigger render={<span />}>{remoteText(label, line)}</TooltipTrigger>
            <TooltipPopup>Busy or failed; they go with the next delivery.</TooltipPopup>
          </Tooltip>
        ) : (
          remoteText(label, line)
        )
      }
      control={
        line.needsYou.length || universities.length ? (
          <Button size="xs" variant="outline" onClick={() => void signInThere()}>
            Sign in there
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * On a computer that receives sign-ins: one line per desktop sending them. Forget this computer
 * deletes its copies, as it wrote them, and its registration, so a reinstalled desktop binds again.
 */
function SendersHere({
  environmentId,
  snapshot,
  canWrite,
}: {
  environmentId: EnvironmentId;
  snapshot: Pick<AccountsSnapshot, "profiles">;
  canWrite: boolean;
}) {
  const forget = useAccountCommand(accountsState.sessionsForget, environmentId);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const senders = new Map<EnvironmentId, { label: string; sentAt: string }>();
  for (const entry of snapshot.profiles.flatMap((record) => record.received ?? [])) {
    const seen = senders.get(entry.source);
    if (!seen || seen.sentAt < entry.sentAt)
      senders.set(entry.source, { label: entry.label, sentAt: entry.sentAt });
  }
  return [...senders].map(([source, { label, sentAt }]) => (
    <SettingsRow
      key={source}
      title={`Sign-ins from ${label}, ${when(sentAt)} · change them there`}
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={!canWrite || forgetting !== null}
          onClick={async () => {
            setForgetting(source);
            await forget({ source });
            setForgetting(null);
          }}
        >
          Forget this computer
        </Button>
      }
    />
  ));
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
  if (environmentId !== primaryId)
    return <SendersHere environmentId={environmentId} snapshot={snapshot} canWrite={canWrite} />;
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
  const held = notSent(profiles);
  const notSentText = held.length
    ? `Not sent to other computers: ${held.map(({ name, reason }) => `${name} (${NOT_SENT_TEXT[reason]})`).join(", ")}.`
    : undefined;
  return (
    <SettingsSection
      id="accounts-other-computers"
      title="Other computers"
      headerAction={
        settings.signInSharingEnabled ? (
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
        ) : undefined
      }
    >
      <SettingsRow
        title="Send sign-ins to other computers"
        description="Copies this computer's browser sign-ins for the sites in Accounts, never passwords, so agents there are signed in too."
        control={
          <Switch
            aria-label="Send sign-ins to other computers"
            checked={settings.signInSharingEnabled}
            onCheckedChange={(checked) =>
              void updateClientSettings({ signInSharingEnabled: Boolean(checked) })
            }
          />
        }
      />
      {remotes.map((remote) => (
        <RemoteComputerRow
          key={remote.environmentId}
          environmentId={remote.environmentId}
          label={remote.label}
          phase={remote.connection.phase}
          sharing={settings.signInSharingEnabled}
          desktop={snapshot}
        />
      ))}
      {notSentText && settings.signInSharingEnabled ? <SettingsRow title={notSentText} /> : null}
    </SettingsSection>
  );
}

import { msg, T, useGT, useMessages } from "gt-react";
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
import { m, type MessageResolver } from "~/i18n/messages";

/** "10:14", "yesterday 18:40", or a date: times on these lines are labels only. */
function when(iso: string, now = new Date(), resolve: MessageResolver = m) {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (date: Date) => date.toDateString();
  if (day(at) === day(now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day(at) === day(yesterday)) return resolve(msg("yesterday {time}", { time }));
  return `${at.toLocaleDateString()} ${time}`;
}

function stateText(state: RemoteState, now: Date, resolve: MessageResolver = m) {
  switch (state.kind) {
    case "sharing-off":
      return resolve(msg("doesn't get your sign-ins: sending them is off"));
    case "sending":
      return resolve(msg("sending your sign-ins…"));
    case "failed":
      return state.failure.reason === "refused"
        ? resolve(
            msg("couldn't send your sign-ins at {time}: it refused this computer", {
              time: when(state.failure.at, now, resolve),
            }),
          )
        : resolve(
            msg("couldn't send your sign-ins at {time}: the request failed", {
              time: when(state.failure.at, now, resolve),
            }),
          );
    case "refused":
      return state.route === "relay"
        ? resolve(msg("doesn't get sign-ins: connected through a relay"))
        : resolve(msg("doesn't get sign-ins: connected without encryption"));
    case "outdated":
      return resolve(msg("can't receive sign-ins: update Scient there"));
    case "delivered":
      return resolve(
        msg("has your sign-ins from {time}", { time: when(state.sentAt, now, resolve) }),
      );
    case "offline":
      return state.seenAt
        ? resolve(
            msg(
              "offline since {seen} · has your sign-ins from {time}, kept {days} days without this computer",
              {
                seen: when(state.seenAt, now, resolve),
                time: when(state.sentAt, now, resolve),
                days: SENDER_KEEP_DAYS,
              },
            ),
          )
        : resolve(
            msg("offline · has your sign-ins from {time}, kept {days} days without this computer", {
              time: when(state.sentAt, now, resolve),
              days: SENDER_KEEP_DAYS,
            }),
          );
    case "on-connect":
      return resolve(msg("gets your sign-ins when it connects"));
  }
}

function remoteText(
  label: string,
  view: RemoteView,
  now = new Date(),
  resolve: MessageResolver = m,
) {
  const { needsYou } = view;
  return [
    `${label} · ${stateText(view.state, now, resolve)}`,
    ...(needsYou.length
      ? [
          resolve(
            msg("{count, plural, one {{sites} needs you there} other {{sites} need you there}}", {
              count: needsYou.length,
              sites: needsYou.join(", "),
            }),
          ),
        ]
      : []),
    ...(view.kept ? [resolve(msg("{count} kept its own", { count: view.kept }))] : []),
    ...(view.waiting ? [resolve(msg("{count} waiting", { count: view.waiting }))] : []),
    ...view.universities.map((name) => resolve(msg("{name} isn't connected there", { name }))),
  ].join(" · ");
}

const NOT_SENT_TEXT: Record<NotSentReason, string> = {
  off: msg("off for agents"),
  projects: msg("limited to projects here"),
  scripts: msg("kept from scripts"),
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
  const messages = useMessages();
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
            <TooltipTrigger render={<span />}>
              {remoteText(label, line, undefined, messages)}
            </TooltipTrigger>
            <TooltipPopup>
              <T>Busy or failed; they go with the next delivery.</T>
            </TooltipPopup>
          </Tooltip>
        ) : (
          remoteText(label, line, undefined, messages)
        )
      }
      control={
        line.needsYou.length || universities.length ? (
          <Button size="xs" variant="outline" onClick={() => void signInThere()}>
            <T>Sign in there</T>
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
  const gt = useGT();
  const messages = useMessages();
  const senders = new Map<EnvironmentId, { label: string; sentAt: string }>();
  for (const entry of snapshot.profiles.flatMap((record) => record.received ?? [])) {
    const seen = senders.get(entry.source);
    if (!seen || seen.sentAt < entry.sentAt)
      senders.set(entry.source, { label: entry.label, sentAt: entry.sentAt });
  }
  return [...senders].map(([source, { label, sentAt }]) => (
    <SettingsRow
      key={source}
      title={gt("Sign-ins from {label}, {time} · change them there", {
        label,
        time: when(sentAt, undefined, messages),
      })}
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
          <T>Forget this computer</T>
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
  const gt = useGT();
  const messages = useMessages();
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
    ? gt("Not sent to other computers: {profiles}.", {
        profiles: held
          .map(({ name, reason }) => `${name} (${messages(NOT_SENT_TEXT[reason])})`)
          .join(", "),
      })
    : undefined;
  return (
    <SettingsSection
      id="accounts-other-computers"
      title={gt("Other computers")}
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
            <T>Send again</T>
          </Button>
        ) : undefined
      }
    >
      <SettingsRow
        title={gt("Send sign-ins to other computers")}
        description={gt(
          "Copies this computer's browser sign-ins for the sites in Accounts, never passwords, so agents there are signed in too.",
        )}
        control={
          <Switch
            aria-label={gt("Send sign-ins to other computers")}
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

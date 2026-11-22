import { msg, T, useGT, useMessages } from "gt-react";
import { shareLink, type ShareAccess, type ShareRecord } from "@scientfactory/scient-cloud/api";
import { EnvironmentId, ThreadId, type ScientCloudStatus } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useThreadShells } from "~/state/entities";

import { shareLinkOrigin, type CloudApi } from "./cloudApi";
import { InfoTip } from "./InfoTip";
import { deleteCloudCopies, turnOffCloudCopy, turnOnCloudCopy } from "./serverCloud";
import { openShareLinkDialog } from "./shareDialogState";
import { forgetShareKey, readShareKey } from "./shareKeys";
import { forgetShareSelection } from "./shareSelections";
import { expiryChoice, EXPIRY_CHOICES, expiresAtFor, type ExpiryChoice } from "./shareOptions";
import { hasCloudAccount, useCloudAccount } from "./useCloudAccount";
import { useCloudStatus } from "./useCloudStatus";
import { useCloudList } from "./useCloudList";
import { m, type MessageResolver } from "~/i18n/messages";

/** Settings → Sharing & access: the computer's cloud copy and the person's shared links. */
export function CloudSettingsSections({ environmentId }: { environmentId: EnvironmentId | null }) {
  if (!hasCloudAccount()) return null;
  return <CloudSettingsSignedIn environmentId={environmentId} />;
}

function CloudSettingsSignedIn({ environmentId }: { environmentId: EnvironmentId | null }) {
  const account = useCloudAccount();
  return (
    <>
      {environmentId !== null ? (
        <CloudCopySection
          environmentId={environmentId}
          api={account.api}
          userId={account.isSignedIn ? account.userId : null}
          onSignIn={account.openSignIn}
        />
      ) : null}
      {account.isSignedIn && account.userId !== null ? (
        // Keyed by account: another account never sees this one's links.
        <SharedLinksSection key={account.userId} api={account.api} userId={account.userId} />
      ) : null}
    </>
  );
}

const MB = 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusLine(status: ScientCloudStatus, resolve: MessageResolver = m): string {
  if (!status.enabled) return resolve(msg("Off", { $context: "sync is turned off" }));
  if (status.paused !== null) return status.paused.message;
  switch (status.state) {
    case "not-enrolled":
      return resolve(msg("Waiting to be linked to your account."));
    case "copying":
      return resolve(
        msg(
          "{count, plural, one {Syncing {count} conversation…} other {Syncing {count} conversations…}}",
          { count: status.pendingThreads },
        ),
      );
    case "retrying":
      return resolve(msg("Scient Cloud can't be reached right now. Trying again soon."));
    default:
      return status.lastCopiedAt === null
        ? resolve(msg("Nothing synced yet."))
        : resolve(
            msg(
              "{count, plural, one {Last synced {time} · {count} conversation} other {Last synced {time} · {count} conversations}}",
              { count: status.copiedThreads, time: formatWhen(status.lastCopiedAt) },
            ),
          );
  }
}

function CloudCopySection({
  environmentId,
  api,
  userId,
  onSignIn,
}: {
  environmentId: EnvironmentId;
  api: CloudApi;
  userId: string | null;
  onSignIn: () => void;
}) {
  const { status, replace } = useCloudStatus(environmentId);
  const [busy, setBusy] = useState<"switch" | "delete" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const gt = useGT();
  const messages = useMessages();
  if (status === null) return null;

  const act = async (kind: "switch" | "delete", run: () => Promise<ScientCloudStatus>) => {
    setBusy(kind);
    setProblem(null);
    try {
      replace(await run());
    } catch (error) {
      setProblem(error instanceof Error ? error.message : m(msg("That didn't work. Try again.")));
    }
    setBusy(null);
  };

  const used =
    status.usedBytes !== null && status.freeBytes !== null
      ? gt("{used} of {free} used", {
          used: formatBytes(status.usedBytes),
          free: formatBytes(status.freeBytes),
        })
      : status.copiedBytes > 0
        ? gt("{size} from this computer", { size: formatBytes(status.copiedBytes) })
        : null;

  return (
    <SettingsSection id="cloud-copy" title={gt("Sync", { $context: "noun, settings section" })}>
      <SettingsRow
        title={
          <span className="inline-flex items-center gap-1.5">
            <T>Sync conversations</T>
            <InfoTip label={gt("About sync")}>
              <T>
                Encrypted with a key unique to your account. Scient's service holds the key so the
                web app can open them. Turning this off keeps what's synced; delete it below.
              </T>
            </InfoTip>
          </span>
        }
        description={gt(
          "Read them at {site} or on your other computers. Project files stay here.",
          { site: "app.scientfactory.com" },
        )}
        status={
          problem ??
          (status.enabled ? (
            <span className="inline-flex flex-wrap items-center gap-x-2">
              {statusLine(status, messages)}
              <Link to="/cloud" className="text-foreground underline underline-offset-2">
                <T>Open</T>
              </Link>
            </span>
          ) : undefined)
        }
        control={
          userId === null && !status.enabled ? (
            <Button size="sm" variant="outline" onClick={onSignIn}>
              <T>Sign in</T>
            </Button>
          ) : (
            <Switch
              checked={status.enabled}
              disabled={busy !== null}
              aria-label={gt("Sync conversations")}
              onCheckedChange={(checked) =>
                act("switch", () =>
                  checked
                    ? turnOnCloudCopy({ environmentId, userId: userId!, api })
                    : turnOffCloudCopy(environmentId),
                )
              }
            />
          )
        }
      />
      {status.enrolledUserId !== null || status.copiedBytes > 0 ? (
        <SettingsRow
          title={gt("Synced conversations")}
          description={used ?? gt("This computer's conversations in Scient Cloud.")}
          control={
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busy !== null}
              onClick={() => act("delete", () => deleteCloudCopies(environmentId))}
            >
              {busy === "delete" ? gt("Deleting…") : gt("Delete from Scient Cloud")}
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

function accessLabel(access: ShareAccess, resolve: MessageResolver = m): string {
  switch (access.mode) {
    case "link":
      return resolve(msg("Anyone with the link"));
    case "me":
      return resolve(msg("Only me"));
    case "people":
      return resolve(
        msg("{count, plural, one {{count} person} other {{count} people}}", {
          count: access.emails.length,
        }),
      );
  }
}

function SharedLinksSection({ api, userId }: { api: CloudApi; userId: string }) {
  const shares = useCloudList(() => api.shares(), `shares:${userId}`);
  const threads = useThreadShells();
  const gt = useGT();
  if (shares.items === null || shares.items.length === 0) return null;
  const threadFor = (share: ShareRecord) =>
    threads.find(
      (thread) => thread.environmentId === share.source.env && thread.id === share.source.thread,
    );
  return (
    <SettingsSection id="shared-links" title={gt("Shared links")}>
      {shares.items.map((share) => (
        <SharedLinkRow
          key={share.id}
          share={share}
          title={threadFor(share)?.title ?? gt("Shared conversation")}
          canUpdate={threadFor(share) !== undefined}
          api={api}
          onChanged={shares.reload}
        />
      ))}
    </SettingsSection>
  );
}

function SharedLinkRow({
  share,
  title,
  canUpdate,
  api,
  onChanged,
}: {
  share: ShareRecord;
  title: string;
  canUpdate: boolean;
  api: CloudApi;
  onChanged: () => void;
}) {
  const key = share.encrypted ? readShareKey(share.id) : undefined;
  const link =
    share.encrypted && key === null
      ? null
      : shareLink(share.id, key ?? undefined, shareLinkOrigin());
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const gt = useGT();
  const messages = useMessages();
  const update = async (run: () => Promise<unknown>) => {
    setBusy(true);
    await run()
      .then(onChanged)
      .finally(() => setBusy(false));
  };
  const facts = [
    accessLabel(share.access, messages),
    share.expiresAt === null ? null : gt("expires {time}", { time: formatWhen(share.expiresAt) }),
    share.currentVersion !== null && share.versions.length > 1
      ? gt("version {version}", { version: share.currentVersion })
      : null,
    link === null ? gt("the full link can be copied only where it was created") : null,
  ].filter((fact): fact is string => fact !== null);
  return (
    <SettingsRow
      title={title}
      description={facts.join(" · ")}
      control={
        <div className="flex max-w-96 flex-wrap items-center justify-end gap-1.5">
          <Select
            value={share.access.mode === "people" ? "link" : share.access.mode}
            onValueChange={(mode) =>
              mode !== null && mode !== share.access.mode
                ? void update(() => api.updateShare(share.id, { access: { mode } }))
                : undefined
            }
          >
            <SelectTrigger size="sm" className="w-auto" aria-label={gt("Who can open it")}>
              <SelectValue>
                {(mode: "link" | "me") =>
                  mode === "me" ? gt("Only me") : gt("Anyone with the link")
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="link">
                <T>Anyone with the link</T>
              </SelectItem>
              <SelectItem hideIndicator value="me">
                <T>Only me</T>
              </SelectItem>
            </SelectPopup>
          </Select>
          <Select
            value={expiryChoice(share.expiresAt)}
            onValueChange={(choice: ExpiryChoice | null) =>
              choice === null
                ? undefined
                : void update(() => api.updateShare(share.id, { expiresAt: expiresAtFor(choice) }))
            }
          >
            <SelectTrigger size="sm" className="w-auto" aria-label={gt("Expires")}>
              <SelectValue>
                {(choice: ExpiryChoice) => {
                  const label = EXPIRY_CHOICES.find((entry) => entry.id === choice)?.label;
                  return label === undefined ? undefined : messages(label);
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {EXPIRY_CHOICES.map((entry) => (
                <SelectItem hideIndicator key={entry.id} value={entry.id}>
                  {messages(entry.label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {link !== null ? (
            <>
              <Button
                size="sm"
                variant="ghost-muted"
                render={<a href={link} target="_blank" rel="noreferrer" />}
              >
                <T>Open</T>
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void writeTextToClipboard(link);
                  setCopied(true);
                }}
              >
                {copied ? gt("Copied") : gt("Copy link")}
              </Button>
            </>
          ) : null}
          {canUpdate ? (
            <Button
              size="sm"
              variant="ghost-muted"
              onClick={() =>
                openShareLinkDialog({
                  environmentId: EnvironmentId.make(share.source.env),
                  threadId: ThreadId.make(share.source.thread),
                })
              }
            >
              <T>Update</T>
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost-destructive"
            disabled={busy}
            onClick={() =>
              void update(() =>
                api.deleteShare(share.id).then(() => {
                  forgetShareKey(share.id);
                  forgetShareSelection(share.id);
                }),
              )
            }
          >
            <T>Stop sharing</T>
          </Button>
        </div>
      }
    />
  );
}

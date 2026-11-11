import { useAtomValue } from "@effect/atom-react";
import {
  CloudConversation,
  shareLink,
  type ShareAccess,
  type ShareRecord,
} from "@scientfactory/scient-cloud/api";
import type { MessageId, ScientCloudShareBuild, ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { buildShare, fetchShareBlob } from "./serverCloud";
import { forgetShareKey, readShareKey, rememberShareKey } from "./shareKeys";
import { cloudShareDialogThreadAtom } from "./shareDialogState";
import { EXPIRY_CHOICES, expiresAtFor, expiryChoice, type ExpiryChoice } from "./shareOptions";
import { publishShare } from "./sharePublish";
import { SnapshotConversationView } from "./SnapshotConversationView";
import { shareLinkOrigin, type CloudApi } from "./cloudApi";
import { InfoTip } from "./InfoTip";
import { useCloudAccount } from "./useCloudAccount";

const decodeDocument = Schema.decodeUnknownSync(Schema.fromJsonString(CloudConversation));

/** Rendered once at the app root; the thread menu opens it for one thread. */
export function ShareLinkDialogHost() {
  const threadRef = useAtomValue(cloudShareDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <ShareLinkDialogSignedIn
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(cloudShareDialogThreadAtom, null)}
    />
  );
}

function ShareLinkDialogSignedIn({
  threadRef,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  onClose: () => void;
}) {
  const account = useCloudAccount();
  if (account.isSignedIn === false) {
    return (
      <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Share link</DialogTitle>
            <DialogDescription>
              Sign in to Scient to share a link to this conversation.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={account.openSignIn}>
              Sign in
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    );
  }
  // Keyed by account: another account never sees this one's link or preview.
  return (
    <ShareLinkDialog
      key={account.userId ?? "loading"}
      threadRef={threadRef}
      api={account.api}
      onClose={onClose}
    />
  );
}

type BuildState =
  | { readonly status: "building" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly build: ScientCloudShareBuild;
      readonly document: CloudConversation;
    };

type PublishState =
  | { readonly status: "idle" }
  | { readonly status: "publishing" }
  | { readonly status: "published"; readonly link: string }
  | { readonly status: "failed"; readonly message: string };

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function findShare(
  shares: ReadonlyArray<ShareRecord>,
  threadRef: ScopedThreadRef,
): ShareRecord | null {
  return (
    shares.find(
      (candidate) =>
        candidate.source.env === threadRef.environmentId &&
        candidate.source.thread === threadRef.threadId,
    ) ?? null
  );
}

function accessSummary(access: ShareAccess): string {
  switch (access.mode) {
    case "link":
      return "Anyone with the link";
    case "me":
      return "Only me";
    case "people":
      return access.emails.length === 1 ? "1 person" : `${access.emails.length} people`;
  }
}

/** Whether the conversation has messages newer than the link's last published version. */
function hasChangesSince(share: ShareRecord, document: CloudConversation): boolean {
  const published = share.versions.at(-1)?.publishedAt;
  if (published === undefined) return true;
  const publishedAt = Date.parse(published);
  return document.snapshot.messages.some((message) => Date.parse(message.updatedAt) > publishedAt);
}

/**
 * Making a link shows its settings; once it exists, the dialog is the link itself:
 * copy it, look at it, or open its settings again.
 */
function ShareLinkDialog({
  threadRef,
  api,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  api: CloudApi;
  onClose: () => void;
}) {
  const [existing, setExisting] = useState<ShareRecord | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const [excluded, setExcluded] = useState<ReadonlyArray<MessageId>>([]);
  const [keep, setKeep] = useState<ReadonlyArray<string>>([]);
  const [access, setAccess] = useState<ShareAccess>({ mode: "link" });
  const [emails, setEmails] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>("never");
  const [encrypted, setEncrypted] = useState(true);
  const [indexable, setIndexable] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const buildKey = JSON.stringify([reasoning, excluded, keep]);
  const [built, setBuilt] = useState<{ readonly key: string; readonly state: BuildState } | null>(
    null,
  );
  const build: BuildState = built?.key === buildKey ? built.state : { status: "building" };
  const [publish, setPublish] = useState<PublishState>({ status: "idle" });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "share link" });

  const adoptShare = (share: ShareRecord | null) => {
    setExisting(share);
    if (share === null) return;
    setEncrypted(share.encrypted);
    setIndexable(share.indexable);
    setAccess(share.access);
    setEmails(share.access.mode === "people" ? share.access.emails.join(", ") : "");
    setExpiry(expiryChoice(share.expiresAt));
  };

  const adoptFoundShare = useEffectEvent(adoptShare);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- finds this conversation's existing link in Scient Cloud
  useEffect(() => {
    let cancelled = false;
    api.shares().then(
      (shares) => {
        if (!cancelled) adoptFoundShare(findShare(shares, threadRef));
      },
      () => {
        if (!cancelled) setExisting(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, threadRef]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks this computer for the redacted copy the preview shows
  useEffect(() => {
    let cancelled = false;
    const key = JSON.stringify([reasoning, excluded, keep]);
    buildShare(threadRef.environmentId, {
      threadId: threadRef.threadId,
      reasoning,
      workLog: true,
      excludeMessageIds: [...excluded],
      keep: [...keep],
    }).then(
      (result) => {
        if (!cancelled) {
          setBuilt({
            key,
            state: {
              status: "ready",
              build: result,
              document: decodeDocument(result.documentJson),
            },
          });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setBuilt({
            key,
            state: {
              status: "failed",
              message: messageOf(error, "The copy couldn't be prepared."),
            },
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [threadRef, reasoning, excluded, keep]);

  const chosenAccess: ShareAccess =
    access.mode === "people"
      ? {
          mode: "people",
          emails: emails
            .split(/[\s,;]+/u)
            .map((email) => email.trim())
            .filter((email) => email.includes("@")),
        }
      : access;
  const lockedEncryption = existing != null;
  const ready = build.status === "ready" && existing !== undefined;
  const busy = publish.status === "publishing";

  const doPublish = async () => {
    if (build.status !== "ready" || existing === undefined) return;
    setPublish({ status: "publishing" });
    try {
      const result = await publishShare({
        api,
        threadRef,
        build: build.build,
        title: build.document.snapshot.thread.title,
        options: {
          encrypted,
          access: chosenAccess,
          expiresAt: expiresAtFor(expiry),
          indexable,
        },
        existing: existing === null ? null : { share: existing, key: readShareKey(existing.id) },
        readBlob: (relativeUrl) => fetchShareBlob(threadRef.environmentId, relativeUrl),
      });
      if (result.key !== null) rememberShareKey(result.id, result.key);
      if (existing === null) copyToClipboard(result.link);
      // The fresh record carries the new version, so "Update link" knows it's current.
      const refreshed = await api.shares().then(
        (shares) => shares.find((share) => share.id === result.id) ?? null,
        () => null,
      );
      if (refreshed !== null) adoptShare(refreshed);
      setEditing(false);
      setPublish({ status: "published", link: result.link });
    } catch (error) {
      setPublish({
        status: "failed",
        message: messageOf(error, "The link couldn't be published."),
      });
    }
  };

  const stopSharing = async () => {
    if (!existing) return;
    setPublish({ status: "publishing" });
    try {
      await api.deleteShare(existing.id);
      forgetShareKey(existing.id);
      onClose();
    } catch (error) {
      setConfirmingStop(false);
      setPublish({ status: "failed", message: messageOf(error, "Sharing couldn't be stopped.") });
    }
  };

  const loadBlob =
    build.status === "ready"
      ? async (sha256: string) => {
          const blob = build.build.blobs.find((entry) => entry.sha256 === sha256);
          if (blob === undefined) throw new Error("Not in this share.");
          return new Blob([
            Uint8Array.from(await fetchShareBlob(threadRef.environmentId, blob.relativeUrl)),
          ]);
        }
      : undefined;
  const redactedItems = new Set(
    build.status === "ready"
      ? build.build.redactions.flatMap((redaction) =>
          redaction.locations.flatMap((location) =>
            location.itemId === null ? [] : [location.itemId],
          ),
        )
      : [],
  );
  const existingKey = existing != null && existing.encrypted ? readShareKey(existing.id) : null;
  const existingKeyMissing = existing != null && existing.encrypted && existingKey === null;
  // The link view needs a link: the one just made, or the saved one.
  const link =
    publish.status === "published"
      ? publish.link
      : existing != null && !existingKeyMissing
        ? shareLink(existing.id, existingKey ?? undefined, shareLinkOrigin())
        : null;
  const showLink = existing != null && !editing;
  const outdated =
    existing != null && build.status === "ready" && hasChangesSince(existing, build.document);

  const settings = (
    <div className="flex flex-col gap-2 text-sm">
      <label className="flex items-center justify-between gap-3">
        <span>Who can open it</span>
        <Select
          value={access.mode}
          onValueChange={(mode) => {
            if (mode === null) return;
            setAccess(mode === "people" ? { mode, emails: [] } : { mode });
          }}
        >
          <SelectTrigger size="sm" className="w-auto" aria-label="Who can open it">
            <SelectValue>
              {(mode: ShareAccess["mode"]) =>
                mode === "link"
                  ? "Anyone with the link"
                  : mode === "me"
                    ? "Only me"
                    : "People I name"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="link">
              Anyone with the link
            </SelectItem>
            <SelectItem hideIndicator value="people">
              People I name
            </SelectItem>
            <SelectItem hideIndicator value="me">
              Only me
            </SelectItem>
          </SelectPopup>
        </Select>
      </label>
      {access.mode === "people" ? (
        <Input
          aria-label="Email addresses"
          placeholder="Email addresses, separated by commas"
          value={emails}
          onChange={(event) => setEmails(event.target.value)}
        />
      ) : null}
      <label className="flex items-center justify-between gap-3">
        <span>Expires</span>
        <Select value={expiry} onValueChange={(next) => next !== null && setExpiry(next)}>
          <SelectTrigger size="sm" className="w-auto" aria-label="Expires">
            <SelectValue>
              {(choice: ExpiryChoice) => EXPIRY_CHOICES.find((entry) => entry.id === choice)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {EXPIRY_CHOICES.map((entry) => (
              <SelectItem hideIndicator key={entry.id} value={entry.id}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </label>
      <label className="flex items-center justify-between gap-3">
        <span>Include reasoning</span>
        <Switch checked={reasoning} onCheckedChange={(checked) => setReasoning(Boolean(checked))} />
      </label>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5">
          <label htmlFor="share-link-encrypted">Encrypted</label>
          <InfoTip label="About encryption">
            {encrypted
              ? "The key is part of the link, so Scient Cloud can't read what you share."
              : "Scient Cloud can read it, and the link previews the title."}
            {lockedEncryption ? " A link keeps the encryption it was created with." : null}
          </InfoTip>
        </span>
        <Switch
          id="share-link-encrypted"
          checked={encrypted}
          disabled={lockedEncryption}
          onCheckedChange={(checked) => setEncrypted(Boolean(checked))}
        />
      </div>
      {!encrypted && access.mode === "link" ? (
        <label className="flex items-center justify-between gap-3">
          <span>Show in search engines</span>
          <Switch
            checked={indexable}
            onCheckedChange={(checked) => setIndexable(Boolean(checked))}
          />
        </label>
      ) : null}
      {build.status === "ready" ? (
        <RedactionList
          build={build.build}
          excludedCount={excluded.length}
          onShow={(id) => setKeep((current) => [...current, id])}
          onBlank={(id) => setKeep((current) => current.filter((entry) => entry !== id))}
          onPutBack={() => setExcluded([])}
        />
      ) : null}
    </div>
  );

  const linkView =
    existing != null ? (
      <div className="flex flex-col gap-2">
        {link !== null ? (
          <div className="flex items-center gap-2">
            <Input
              readOnly
              aria-label="Share link"
              value={link}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button size="sm" variant="outline" onClick={() => copyToClipboard(link)}>
              {isCopied ? <CheckIcon /> : <CopyIcon />}
              {isCopied ? "Copied" : "Copy"}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            This link was made on another computer. Update it here to get a link you can copy; the
            old one stops working.
          </p>
        )}
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          {accessSummary(existing.access)} ·{" "}
          {EXPIRY_CHOICES.find((entry) => entry.id === expiryChoice(existing.expiresAt))?.label}
          <Button size="xs" variant="ghost-muted" onClick={() => setEditing(true)}>
            Change
          </Button>
        </p>
      </div>
    ) : null;

  const title = showLink ? "Share link" : existing ? "Link settings" : "Share link";
  const description = showLink
    ? outdated
      ? "The conversation has changed since you shared it."
      : null
    : existing
      ? null
      : "Shares the conversation as it is now.";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description !== null ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {existing === undefined ? (
              <p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
            ) : showLink ? (
              linkView
            ) : (
              settings
            )}

            {existing !== undefined ? (
              <>
                <Button
                  size="sm"
                  variant="ghost-muted"
                  className="-ms-2 self-start"
                  aria-expanded={previewOpen}
                  onClick={() => setPreviewOpen((open) => !open)}
                >
                  {previewOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
                  Preview
                </Button>
                {previewOpen ? (
                  <div className="max-h-[50vh] min-h-32 overflow-auto rounded-lg border border-border px-3 py-4">
                    {build.status === "building" ? (
                      <p className="py-8 text-center text-sm text-muted-foreground">Preparing…</p>
                    ) : build.status === "failed" ? null : (
                      <SnapshotConversationView
                        conversation={build.document}
                        loadBlob={loadBlob}
                        preview={
                          showLink
                            ? { markedMessageIds: redactedItems }
                            : {
                                markedMessageIds: redactedItems,
                                messageAction: {
                                  label: "Leave out",
                                  onSelect: (messageId) =>
                                    setExcluded((current) => [...current, messageId]),
                                },
                              }
                        }
                      />
                    )}
                  </div>
                ) : null}
              </>
            ) : null}
            {build.status === "failed" ? (
              <p role="alert" className="text-xs text-destructive-foreground">
                {build.message}
              </p>
            ) : null}
            {editing && existingKeyMissing ? (
              <p className="text-xs text-muted-foreground">
                This link was made on another computer. Updating it here makes a new key, so send
                the new link again.
              </p>
            ) : null}
            {publish.status === "failed" ? (
              <p role="alert" className="text-xs text-destructive-foreground">
                {publish.message}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {showLink && confirmingStop ? (
            <>
              <p className="me-auto self-center text-xs text-muted-foreground">
                The link stops working for everyone.
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setConfirmingStop(false)}
              >
                Keep sharing
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => void stopSharing()}
              >
                {busy ? "Stopping…" : "Stop sharing"}
              </Button>
            </>
          ) : showLink ? (
            <>
              <Button
                size="sm"
                variant="ghost-destructive"
                className="me-auto"
                disabled={busy}
                onClick={() => setConfirmingStop(true)}
              >
                Stop sharing
              </Button>
              <Button
                size="sm"
                variant="ghost-muted"
                render={<Link to="/settings/connections" hash="shared-links" onClick={onClose} />}
              >
                All links
              </Button>
              {outdated || existingKeyMissing ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!ready || busy}
                  onClick={() => void doPublish()}
                >
                  {busy ? "Updating…" : "Update link"}
                </Button>
              ) : null}
              <Button size="sm" disabled={busy} onClick={onClose}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={existing ? () => setEditing(false) : onClose}
              >
                {existing ? "Back" : "Cancel"}
              </Button>
              <Button size="sm" disabled={!ready || busy} onClick={() => void doPublish()}>
                {busy
                  ? existing
                    ? "Saving…"
                    : "Creating link…"
                  : existing
                    ? "Save"
                    : "Create link"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RedactionList({
  build,
  excludedCount,
  onShow,
  onBlank,
  onPutBack,
}: {
  build: ScientCloudShareBuild;
  excludedCount: number;
  onShow: (id: string) => void;
  onBlank: (id: string) => void;
  onPutBack: () => void;
}) {
  if (build.redactions.length === 0 && build.kept.length === 0 && excludedCount === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1 text-sm">
      {build.redactions.length > 0 ? (
        <p className="text-xs text-muted-foreground">Hidden from the link:</p>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {build.redactions.map((redaction) => (
          <li key={redaction.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">
              {redaction.label}
              {redaction.count > 1 ? ` ×${redaction.count}` : ""}
              <span className="text-muted-foreground"> → {redaction.replacement}</span>
            </span>
            <Button size="xs" variant="ghost-muted" onClick={() => onShow(redaction.id)}>
              Show
            </Button>
          </li>
        ))}
        {build.kept.map((redaction) => (
          <li key={redaction.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {redaction.label}: shown
            </span>
            <Button size="xs" variant="ghost-muted" onClick={() => onBlank(redaction.id)}>
              Hide
            </Button>
          </li>
        ))}
      </ul>
      {excludedCount > 0 ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          {excludedCount} message{excludedCount === 1 ? "" : "s"} left out.
          <Button size="xs" variant="ghost-muted" onClick={onPutBack}>
            Put back
          </Button>
        </p>
      ) : null}
    </div>
  );
}

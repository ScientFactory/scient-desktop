import { useAtomValue } from "@effect/atom-react";
import type { ShareAccess, ShareRecord } from "@scientfactory/scient-cloud/api";
import { CloudConversation } from "@scientfactory/scient-cloud/api";
import type { MessageId, ScientCloudShareBuild, ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";

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
import type { CloudApi } from "./cloudApi";
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
  const [reasoning, setReasoning] = useState(false);
  const [excluded, setExcluded] = useState<ReadonlyArray<MessageId>>([]);
  const [keep, setKeep] = useState<ReadonlyArray<string>>([]);
  const [access, setAccess] = useState<ShareAccess>({ mode: "link" });
  const [emails, setEmails] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>("never");
  const [encrypted, setEncrypted] = useState(true);
  const [indexable, setIndexable] = useState(false);
  const buildKey = JSON.stringify([reasoning, excluded, keep]);
  const [built, setBuilt] = useState<{ readonly key: string; readonly state: BuildState } | null>(
    null,
  );
  const build: BuildState = built?.key === buildKey ? built.state : { status: "building" };
  const [publish, setPublish] = useState<PublishState>({ status: "idle" });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "share link" });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- finds this conversation's existing link in Scient Cloud
  useEffect(() => {
    let cancelled = false;
    api.shares().then(
      (shares) => {
        if (cancelled) return;
        const share =
          shares.find(
            (candidate) =>
              candidate.source.env === threadRef.environmentId &&
              candidate.source.thread === threadRef.threadId,
          ) ?? null;
        setExisting(share);
        if (share !== null) {
          setEncrypted(share.encrypted);
          setIndexable(share.indexable);
          setAccess(share.access);
          if (share.access.mode === "people") setEmails(share.access.emails.join(", "));
          setExpiry(expiryChoice(share.expiresAt));
        }
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
  const existingKeyMissing =
    existing != null && existing.encrypted && readShareKey(existing.id) === null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && publish.status !== "publishing") onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{existing ? "Update link" : "Share link"}</DialogTitle>
          <DialogDescription>
            A copy of this conversation as it is now. What you see below is exactly what the link
            shows; update the link later to share new messages.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            {publish.status === "published" ? (
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  aria-label="Share link"
                  value={publish.link}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(publish.link)}>
                  {isCopied ? <CheckIcon /> : <CopyIcon />}
                  {isCopied ? "Copied" : "Copy"}
                </Button>
              </div>
            ) : null}
            <div className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
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
              <label className="flex items-center justify-between gap-3">
                <span>Expires</span>
                <Select value={expiry} onValueChange={(next) => next !== null && setExpiry(next)}>
                  <SelectTrigger size="sm" className="w-auto" aria-label="Expires">
                    <SelectValue>
                      {(choice: ExpiryChoice) =>
                        EXPIRY_CHOICES.find((entry) => entry.id === choice)?.label
                      }
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
              {access.mode === "people" ? (
                <Input
                  className="sm:col-span-2"
                  aria-label="Email addresses"
                  placeholder="Email addresses, separated by commas"
                  value={emails}
                  onChange={(event) => setEmails(event.target.value)}
                />
              ) : null}
              <label className="flex items-center justify-between gap-3">
                <span>Include the agent's reasoning</span>
                <Switch
                  checked={reasoning}
                  onCheckedChange={(checked) => setReasoning(Boolean(checked))}
                />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span>
                  {lockedEncryption ? "Encrypted shared copy" : "Encrypt this shared copy"}
                </span>
                <Switch
                  checked={encrypted}
                  disabled={lockedEncryption}
                  onCheckedChange={(checked) => setEncrypted(Boolean(checked))}
                />
              </label>
              {!encrypted && access.mode === "link" ? (
                <label className="flex items-center justify-between gap-3">
                  <span>Let search engines show it</span>
                  <Switch
                    checked={indexable}
                    onCheckedChange={(checked) => setIndexable(Boolean(checked))}
                  />
                </label>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              Anyone with the complete link can open it, if "Who can open it" allows them.{" "}
              {encrypted
                ? "The key that unlocks it is part of the link, so Scient Cloud keeps only a copy it can't read."
                : "Without encryption, Scient Cloud can read the copy, and the link shows a preview with the conversation's title."}
              {lockedEncryption ? " A link keeps the encryption it was created with." : null}
            </p>

            {build.status === "ready" ? (
              <RedactionList
                build={build.build}
                excludedCount={excluded.length}
                onShow={(id) => setKeep((current) => [...current, id])}
                onBlank={(id) => setKeep((current) => current.filter((entry) => entry !== id))}
                onPutBack={() => setExcluded([])}
              />
            ) : null}

            <div className="max-h-[50vh] min-h-48 overflow-auto rounded-lg border border-border px-3 py-4">
              {build.status === "building" ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  Preparing the copy…
                </p>
              ) : build.status === "failed" ? (
                <p role="alert" className="py-12 text-center text-sm text-destructive-foreground">
                  {build.message}
                </p>
              ) : (
                <SnapshotConversationView
                  conversation={build.document}
                  loadBlob={loadBlob}
                  preview={{
                    markedMessageIds: redactedItems,
                    messageAction: {
                      label: "Leave out",
                      onSelect: (messageId) => setExcluded((current) => [...current, messageId]),
                    },
                  }}
                />
              )}
            </div>
            {existingKeyMissing ? (
              <p className="text-xs text-muted-foreground">
                This link was made on another device. Updating it here makes a new key, so send the
                new link again.
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
          {existing ? (
            <Button
              size="sm"
              variant="ghost-destructive"
              className="me-auto"
              disabled={publish.status === "publishing"}
              onClick={() => void stopSharing()}
            >
              Stop sharing
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={onClose}
            disabled={publish.status === "publishing"}
          >
            {publish.status === "published" ? "Done" : "Cancel"}
          </Button>
          {publish.status !== "published" ? (
            <Button
              size="sm"
              disabled={!ready || publish.status === "publishing"}
              onClick={() => void doPublish()}
            >
              {publish.status === "publishing"
                ? existing
                  ? "Updating link…"
                  : "Creating link…"
                : existing
                  ? "Update link"
                  : "Create link"}
            </Button>
          ) : null}
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
    return (
      <p className="text-xs text-muted-foreground">
        Nothing needed hiding. Saved passwords, tokens, email addresses and home folders are checked
        before anything is shared.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-sm">
      {build.redactions.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Hidden from the shared copy (marked in the preview):
        </p>
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
              Include in link
            </Button>
          </li>
        ))}
        {build.kept.map((redaction) => (
          <li key={redaction.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {redaction.label}: included in the link as written
            </span>
            <Button size="xs" variant="ghost-muted" onClick={() => onBlank(redaction.id)}>
              Hide from link
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

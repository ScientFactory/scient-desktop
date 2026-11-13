import { useEffect, useEffectEvent, useState, type FormEvent } from "react";

import * as Schema from "effect/Schema";

import { Button } from "~/components/ui/button";

import { SnapshotConversationView } from "../SnapshotConversationView";
import { saveFile, snapshotMarkdownFile } from "../snapshotExport";
import {
  openSharedConversation,
  reportShare,
  ShareOpenError,
  type ShareAddress,
  type ShareOpenFailure,
  type SharedConversation,
} from "./shareReader";

const isShareOpenError = Schema.is(ShareOpenError);

const FAILURE_TEXT: Record<ShareOpenFailure, string> = {
  "not-found": "This link has been turned off or has expired.",
  "sign-in": "This conversation is shared with specific people. Sign in to read it.",
  "not-shared-with-you": "This conversation isn't shared with the account you're signed in with.",
  "key-missing": "This link is missing the part that unlocks it. Ask the sender for the full link.",
  "key-wrong": "This link doesn't unlock the conversation. Ask the sender for the full link.",
  unavailable: "The conversation couldn't be loaded right now.",
};

export interface SharePageProps {
  readonly address: ShareAddress | null;
  readonly apiOrigin: string;
  readonly contentOrigin?: string | undefined;
  /** A Clerk session token, where the page has one, for shares limited to people. */
  readonly getToken?: (() => Promise<string | null>) | undefined;
  /** Where to sign in when a share needs it; the link's fragment rides along. */
  readonly signInHref?: string | undefined;
  /** Signs in on this page instead, where the page has an account of its own. */
  readonly onSignIn?: (() => void) | undefined;
}

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly reason: ShareOpenFailure }
  | { readonly status: "ready"; readonly share: SharedConversation };

/** The page behind a share link: decrypts the conversation in the browser and shows it. */
export function SharePage(props: SharePageProps) {
  const [attempt, setAttempt] = useState(0);
  return (
    <SharePageContent key={attempt} {...props} onRetry={() => setAttempt((value) => value + 1)} />
  );
}

function SharePageContent({
  address,
  apiOrigin,
  contentOrigin,
  getToken,
  signInHref,
  onSignIn,
  onRetry,
}: SharePageProps & { readonly onRetry: () => void }) {
  const [state, setState] = useState<LoadState>(
    address === null ? { status: "failed", reason: "not-found" } : { status: "loading" },
  );

  const readToken = useEffectEvent(async () => (await getToken?.()) ?? null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads and decrypts the share from the cloud
  useEffect(() => {
    if (address === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const token = await readToken();
        const share = await openSharedConversation({ apiOrigin, address, token });
        if (!cancelled) setState({ status: "ready", share });
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "failed",
            reason: isShareOpenError(error) ? error.reason : "unavailable",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, apiOrigin]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the document title follows the loaded conversation
  useEffect(() => {
    if (state.status === "ready")
      document.title = `${state.share.conversation.snapshot.thread.title} · Scient`;
  }, [state]);

  if (state.status === "loading") {
    return (
      <SharePageFrame>
        <p className="py-16 text-center text-sm text-muted-foreground">Opening the conversation…</p>
      </SharePageFrame>
    );
  }
  if (state.status === "failed") {
    return (
      <SharePageFrame>
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="max-w-md text-sm">{FAILURE_TEXT[state.reason]}</p>
          {state.reason === "unavailable" ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
          {state.reason === "sign-in" && onSignIn ? (
            <Button size="sm" onClick={onSignIn}>
              Sign in
            </Button>
          ) : state.reason === "sign-in" && signInHref ? (
            <Button size="sm" render={<a href={signInHref} />}>
              Sign in
            </Button>
          ) : null}
        </div>
      </SharePageFrame>
    );
  }

  const { conversation, info, loadBlob } = state.share;
  const { snapshot } = conversation;
  const sharedAt = info.versions.find(
    (version) => version.version === info.currentVersion,
  )?.publishedAt;
  return (
    <SharePageFrame
      header={
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-56">
            <h1 className="truncate text-base font-medium">{snapshot.thread.title}</h1>
            <p className="text-xs text-muted-foreground">
              Shared from Scient{sharedAt ? ` · ${formatDate(sharedAt)}` : ""}
              {info.versions.length > 1 ? ` · version ${info.currentVersion}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1 print:hidden">
            <Button
              variant="ghost-muted"
              size="sm"
              onClick={() => saveFile(snapshotMarkdownFile(snapshot))}
            >
              Markdown
            </Button>
            <Button variant="ghost-muted" size="sm" onClick={() => window.print()}>
              PDF
            </Button>
            <ContinueInScient onDownload={() => saveFile(snapshotMarkdownFile(snapshot))} />
          </div>
        </div>
      }
      footer={address ? <ReportShare apiOrigin={apiOrigin} shareId={address.shareId} /> : null}
    >
      <SnapshotConversationView
        conversation={conversation}
        loadBlob={loadBlob}
        contentOrigin={contentOrigin}
      />
    </SharePageFrame>
  );
}

/** In a build without Scient Cloud, a shared link can't be opened here; nothing is fetched. */
export function ShareUnavailablePage() {
  return (
    <SharePageFrame>
      <p className="py-16 text-center text-sm text-muted-foreground">
        Shared links can't be opened in this version of Scient.
      </p>
    </SharePageFrame>
  );
}

function SharePageFrame({
  header,
  footer,
  children,
}: {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      {header ? (
        <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur print:static print:border-none">
          <div className="mx-auto max-w-3xl px-4 py-3">{header}</div>
        </header>
      ) : null}
      <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
      <footer className="mx-auto max-w-3xl px-4 pb-10 text-xs text-muted-foreground print:hidden">
        {footer}
      </footer>
    </div>
  );
}

function ContinueInScient({ onDownload }: { onDownload: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="flex items-center gap-2">
      {saved ? (
        <span className="text-xs text-muted-foreground">Open the file in Scient to continue.</span>
      ) : null}
      <Button
        size="sm"
        onClick={() => {
          onDownload();
          setSaved(true);
        }}
      >
        Continue in Scient
      </Button>
    </div>
  );
}

function ReportShare({ apiOrigin, shareId }: { apiOrigin: string; shareId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim() === "") return;
    setStatus("sending");
    try {
      await reportShare({ apiOrigin, shareId, reason: reason.trim() });
      setStatus("sent");
    } catch {
      setStatus("failed");
    }
  };
  if (status === "sent") return <p>Thanks. We'll look at it.</p>;
  if (!open) {
    return (
      <p>
        Something wrong with this conversation?{" "}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => setOpen(true)}
        >
          Report it
        </button>
      </p>
    );
  }
  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <label htmlFor="share-report" className="text-foreground">
        What's wrong with it?
      </label>
      <textarea
        id="share-report"
        value={reason}
        maxLength={2000}
        rows={3}
        onChange={(event) => setReason(event.target.value)}
        className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground outline-none focus-visible:border-ring"
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={status === "sending" || reason.trim() === ""}>
          Send report
        </Button>
        {status === "failed" ? <span>It couldn't be sent. Try again.</span> : null}
      </div>
    </form>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

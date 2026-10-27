import { XIcon } from "lucide-react";
import { useState } from "react";
import type {
  AccountApproval,
  AccountHandoff,
  AccountApprovalDecision,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveBrowserProfiles } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { useClientSettings } from "~/hooks/useSettings";
import { accountsState } from "./accountsState";
import { useAccountCommand, useAccounts } from "./useAccounts";

import { HandoffBrowser } from "./HandoffBrowser";
import { handoffInstruction } from "./handoffInstruction";

const revealed = new Set<string>();

/** Scrolls a new hand-off above the composer once; after that the user scrolls freely. */
function revealOnce(element: HTMLElement | null, handoffId: string) {
  if (!element || revealed.has(handoffId)) return;
  revealed.add(handoffId);
  requestAnimationFrame(() => {
    let scroller = element.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))
      scroller = scroller.parentElement;
    if (!scroller) return;
    const composer = document.querySelector('[data-chat-composer-stack="true"]');
    const limit = Math.min(
      scroller.getBoundingClientRect().bottom,
      composer ? composer.getBoundingClientRect().top : Number.POSITIVE_INFINITY,
    );
    const overflow = element.getBoundingClientRect().bottom + 12 - limit;
    if (overflow > 0) scroller.scrollBy({ top: overflow, behavior: "smooth" });
  });
}

export function AccountHandoffs({
  environmentId,
  handoffs,
  canWrite,
}: {
  environmentId: EnvironmentId;
  handoffs: ReadonlyArray<AccountHandoff>;
  canWrite: boolean;
}) {
  const show = useAccountCommand(accountsState.showHandoff, environmentId);
  const cancel = useAccountCommand(accountsState.cancelHandoff, environmentId);
  return (
    <div className="grid gap-2">
      {handoffs.map((handoff) => (
        <div
          key={handoff.handoffId}
          ref={(element) => revealOnce(element, handoff.handoffId)}
          className="mx-auto w-full max-w-2xl overflow-hidden rounded-xl border bg-card shadow-sm"
        >
          <div className="flex items-center gap-2 py-1.5 ps-3 pe-1.5 text-xs">
            <span
              aria-hidden
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground motion-reduce:animate-none"
            />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              <span className="font-medium text-foreground">{handoff.accountName}</span>
              {" · "}
              {handoffInstruction(handoff)}
            </span>
            {handoff.kind === "push" && handoff.number ? (
              <span className="shrink-0 rounded bg-muted px-1.5 text-sm font-semibold tabular-nums text-foreground">
                Tap {handoff.number}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Cancel sign-in"
              disabled={!canWrite}
              onClick={() => void cancel({ handoffId: handoff.handoffId })}
            >
              <XIcon />
            </Button>
          </div>
          {handoff.tabId ? (
            <HandoffBrowser
              environmentId={environmentId}
              threadId={handoff.threadId}
              tabId={handoff.tabId}
              className="aspect-[16/10] border-t"
              fallback={
                <div className="border-t px-3 py-1.5">
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={!canWrite}
                    onClick={() => void show({ handoffId: handoff.handoffId })}
                  >
                    Open browser
                  </Button>
                </div>
              }
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

const ACTION_LABELS: Readonly<Record<AccountApproval["action"], string>> = {
  "sign-in": "Sign in",
  credentials: "Read its credentials",
  request: "Make a request",
  "browser-session": "Use its sign-in in a script",
  "open-profile": "Open a browser tab",
};

export function AccountApprovals({
  environmentId,
  approvals,
  canWrite,
}: {
  environmentId: EnvironmentId;
  approvals: ReadonlyArray<AccountApproval>;
  canWrite: boolean;
}) {
  const respond = useAccountCommand(accountsState.respondApproval, environmentId);
  const profiles = resolveBrowserProfiles(
    useClientSettings((settings) => settings.browserProfiles),
  );
  const targetName = ({ target, targetName: fallback }: AccountApproval) =>
    target.type === "profile"
      ? (profiles.find((profile) => profile.id === target.profileId)?.name ?? fallback)
      : fallback;
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const run = async (approvalId: string, decision: AccountApprovalDecision) => {
    if (!canWrite || busy.has(approvalId)) return;
    setBusy((current) => new Set([...current, approvalId]));
    await respond({ approvalId, decision });
    setBusy((current) => {
      const next = new Set(current);
      next.delete(approvalId);
      return next;
    });
  };
  return (
    <div className="grid gap-2">
      {approvals.map((approval) => (
        <div key={approval.approvalId} className="rounded-lg border bg-card p-3">
          <div className="mb-2 text-sm">
            <span className="font-medium">{targetName(approval)}</span>
            <span className="text-muted-foreground"> · {ACTION_LABELS[approval.action]}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["once", "Allow in this conversation"],
                ["project", "Always in this project"],
                ["always", "Always"],
                ["deny", "Deny"],
              ] as const
            )
              .filter(([decision]) => decision !== "project" || approval.projectId)
              .map(([decision, label]) => (
                <Button
                  key={decision}
                  size="xs"
                  variant={decision === "once" ? "default" : "outline"}
                  disabled={!canWrite || busy.has(approval.approvalId)}
                  onClick={() => void run(approval.approvalId, decision)}
                >
                  {label}
                </Button>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ThreadAccountApprovals({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const { data, canWrite } = useAccounts(environmentId);
  if (!data) return null;
  const approvals = data.approvals.filter((approval) => approval.threadId === threadId);
  return approvals.length ? (
    <div className="mb-2">
      <AccountApprovals environmentId={environmentId} approvals={approvals} canWrite={canWrite} />
    </div>
  ) : null;
}

/** A thread's sign-ins waiting for the user; they sit in the conversation and scroll with it. */
export function useThreadAccountHandoffs(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const { data, canWrite } = useAccounts(environmentId);
  const handoffs =
    threadId === null
      ? []
      : (data?.handoffs ?? []).filter((handoff) => handoff.threadId === threadId);
  return { handoffs, canWrite };
}

export function ThreadAccountHandoffs({
  environmentId,
  handoffs,
  canWrite,
}: {
  environmentId: EnvironmentId;
  handoffs: ReadonlyArray<AccountHandoff>;
  canWrite: boolean;
}) {
  return handoffs.length ? (
    <div className="chat-content-lane py-3">
      <AccountHandoffs environmentId={environmentId} handoffs={handoffs} canWrite={canWrite} />
    </div>
  ) : null;
}

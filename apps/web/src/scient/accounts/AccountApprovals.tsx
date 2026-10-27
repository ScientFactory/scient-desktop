import { useState } from "react";
import type {
  AccountApproval,
  AccountApprovalDecision,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveBrowserProfiles } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { useClientSettings } from "~/hooks/useSettings";
import { accountsState } from "./accountsState";
import { useAccountCommand, useAccounts } from "./useAccounts";

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

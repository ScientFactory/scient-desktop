import { useState } from "react";
import type {
  AccountApproval,
  AccountApprovalDecision,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { accountsState } from "./accountsState";
import { useAccountCommand, useAccounts } from "./useAccounts";

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
            {approval.targetName}: {approval.action.replaceAll("-", " ")}
          </div>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["once", "Allow once"],
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

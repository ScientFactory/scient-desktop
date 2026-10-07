interface ActivityIssuePolicy {
  readonly owner:
    | "workspace"
    | "file-history"
    | "changes"
    | "restore"
    | "approval"
    | "question"
    | "turn"
    | "session";
  readonly summary: string;
  readonly severe: boolean;
}

/** Domain ownership, not spelling or exception text, determines presentation.
 * Also applies to persisted activities from older servers without rewriting history. */
const policies: Readonly<Record<string, ActivityIssuePolicy>> = {
  "setup-script.failed": {
    owner: "workspace",
    summary: "Workspace setup script failed",
    severe: false,
  },
  "checkpoint.capture.failed": {
    owner: "file-history",
    summary: "File history unavailable",
    severe: false,
  },
  "checkpoint.diff.failed": {
    owner: "changes",
    summary: "Changes could not be compared",
    severe: false,
  },
  "checkpoint.revert.failed": {
    owner: "restore",
    summary: "Rewind could not be completed",
    severe: false,
  },
  "provider.approval.respond.failed": {
    owner: "approval",
    summary: "Approval response was not accepted",
    severe: false,
  },
  "provider.user-input.respond.failed": {
    owner: "question",
    summary: "Question response was not accepted",
    severe: false,
  },
  "provider.turn.start.failed": {
    owner: "turn",
    summary: "Message could not be sent",
    severe: true,
  },
  "provider.turn.interrupt.failed": {
    owner: "turn",
    summary: "Stop was not confirmed. The agent may still be working.",
    severe: true,
  },
  "provider.session.stop.failed": {
    owner: "session",
    summary: "Session could not be stopped",
    severe: true,
  },
  "runtime.error": { owner: "turn", summary: "The agent encountered a problem", severe: true },
};

export function activityIssuePolicy(kind: string | undefined): ActivityIssuePolicy | undefined {
  return kind !== undefined && Object.hasOwn(policies, kind) ? policies[kind] : undefined;
}

import type { PendingApproval } from "../../session-logic";

/** `responseError` is client-local: the response could not be sent, so the request stays for a retry. */
export type ScientPendingApproval = PendingApproval & { readonly responseError?: string };

export function ApprovalResponseError({ approval }: { readonly approval: ScientPendingApproval }) {
  return approval.responseError ? (
    <span role="alert" className="text-xs text-destructive">
      {approval.responseError}
    </span>
  ) : null;
}

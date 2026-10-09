import type {
  OrchestrationV2ProviderTurn,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { ProviderAdapterTurnStartError } from "@t3tools/provider-core/server/ProviderAdapter";

type TurnStartIdentity = {
  readonly threadId: ThreadId;
  readonly providerThread: { readonly id: ProviderThreadId };
  readonly runId: RunId;
};

const isNativeStartReceiptError = Schema.is(ProviderAdapterTurnStartError);

/** A start failure that already carries its native delivery observation keeps it. */
export const turnStartErrorKeepingReceipt =
  (driver: ProviderDriverKind, turnInput: TurnStartIdentity) => (cause: unknown) =>
    isNativeStartReceiptError(cause)
      ? cause
      : new ProviderAdapterTurnStartError({
          driver,
          threadId: turnInput.threadId,
          providerThreadId: turnInput.providerThread.id,
          runId: turnInput.runId,
          cause,
        });

/** The prompt's native delivery: accepted when observed, unknown once offered, else pending. */
export const nativeTurnAcceptance = (turn: {
  readonly acceptedAt: DateTime.Utc | null;
  readonly promptOffered: boolean;
}): Pick<OrchestrationV2ProviderTurn, "nativeAcceptance" | "acceptedAt"> => ({
  nativeAcceptance:
    turn.acceptedAt === null ? (turn.promptOffered ? "unknown" : "pending") : "accepted",
  ...(turn.acceptedAt === null ? {} : { acceptedAt: turn.acceptedAt }),
});

/** JSON-RPC invalid request, unknown method and invalid params: the provider never accepted it. */
export const isPreAcceptanceRejectionCode = (code: number): boolean =>
  code === -32600 || code === -32601 || code === -32602;

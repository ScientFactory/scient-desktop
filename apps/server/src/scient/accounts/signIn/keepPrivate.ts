// @effect-diagnostics nodeBuiltinImport:off -- Opaque hand-off ids use the operating system CSPRNG.
import type { AccountId, PreviewTabId, ThreadId } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { AccountsService } from "../AccountsService.ts";

const RETRY_MS = 2_000;

/**
 * A tab that still holds something only the person may see stays private and theirs until
 * `settle` works: tried at once, then in the background every 2 s, with a hand-off asking them to
 * `reason`. When their wait is up it tries `close`; a close that fails changes nothing and the
 * wait starts again. Returns whether it settled at once.
 */
export const keepPrivateUntil = Effect.fn("AccountsAgent.keepPrivateUntil")(function* (input: {
  readonly tabId: PreviewTabId;
  readonly threadId: ThreadId;
  readonly accountId: AccountId;
  readonly accountName: string;
  readonly site: string;
  readonly reason: string;
  readonly waitMs: number;
  readonly settle: Effect.Effect<boolean>;
  readonly close: Effect.Effect<boolean>;
  /** Shows the tab to the person when the hand-off appears. */
  readonly show: Effect.Effect<void>;
}) {
  if (yield* input.settle) return true;
  const accounts = yield* AccountsService;
  const attemptId = `held:${NodeCrypto.randomUUID()}`;
  yield* accounts.setAttempt({
    attemptId,
    threadId: input.threadId,
    tabId: input.tabId,
    accountId: input.accountId,
    state: "person",
  });
  const handoffId = NodeCrypto.randomUUID();
  const publish = Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    yield* accounts.setHandoff(
      {
        handoffId,
        threadId: input.threadId,
        accountId: input.accountId,
        accountName: input.accountName,
        site: input.site,
        tabId: input.tabId,
        kind: "other",
        reason: input.reason,
        startedAt: DateTime.formatIso(DateTime.makeUnsafe(startedAt)),
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(startedAt + input.waitMs)),
      },
      input.show,
    );
  });
  yield* publish;
  const hold = Effect.gen(function* () {
    for (;;) {
      for (let poll = 0; poll < input.waitMs / RETRY_MS; poll++) {
        yield* Effect.sleep(RETRY_MS);
        if (yield* accounts.handoffCancelled(handoffId)) break;
        if (yield* input.settle) return;
      }
      if (yield* input.close) return;
      yield* publish;
    }
  }).pipe(
    Effect.ensuring(
      Effect.all([accounts.removeHandoff(handoffId), accounts.removeAttempt(attemptId)]),
    ),
  );
  yield* Effect.forkDetach(hold);
  return false;
});

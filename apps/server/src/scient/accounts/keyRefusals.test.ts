import { AccountId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeHarness } from "./Accounts.testkit.ts";
import { typedDigest } from "./AccountsService.ts";
import { withKeyUse } from "./keyRefusals.ts";

const accountId = AccountId.make("acc_synthetic1");
const at = "2026-11-26T00:00:00.000Z";
const report = (kind: "connector" | "voice", outcome: "refused" | "ok", version = "v1") => ({
  accountId,
  use: { kind, id: kind + "-1" },
  version,
  at,
  outcome,
});

describe("withKeyUse", () => {
  it("marks the key refused only when two uses refuse the same version, and a success clears it", () => {
    const first = withKeyUse([], report("connector", "refused"));
    expect(first.key).toBe("unchanged");
    expect(first.refusals).toHaveLength(1);
    // The same use refusing again is still one use.
    expect(withKeyUse(first.refusals, report("connector", "refused")).key).toBe("unchanged");
    // A new value starts clean: the old version's refusal doesn't count.
    expect(withKeyUse(first.refusals, report("voice", "refused", "v2")).key).toBe("unchanged");
    const second = withKeyUse(first.refusals, report("voice", "refused"));
    expect(second.key).toBe("refused");
    const works = withKeyUse(second.refusals, report("voice", "ok"));
    expect(works.key).toBe("works");
    expect(works.refusals.map(({ use }) => use.kind)).toEqual(["connector"]);
  });
});

it.effect("shows refusals on their uses and marks the key only after a second use refuses", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    const save = (value: string, id?: AccountId) =>
      service.save({
        ...(id ? { accountId: id } : {}),
        name: "OpenRouter",
        details: { kind: "api-key", sites: ["openrouter.ai"], auth: { type: "bearer" } },
        secrets: { token: { type: "scient", value } },
      });
    const { accountId: id } = yield* save("first-value");
    const first = typedDigest("first-value");
    yield* service.reportKeyUse!(id, { kind: "connector", id: "con_a" }, "refused", first);
    const once = yield* service.snapshot;
    expect(once.keyRefusals?.map(({ use }) => use.kind)).toEqual(["connector"]);
    expect(once.accounts[0]?.signIn?.state).not.toBe("failed");
    yield* service.reportKeyUse!(id, { kind: "voice", id: "engine-1" }, "refused", first);
    expect((yield* service.snapshot).accounts[0]?.signIn?.state).toBe("failed");
    // A new value starts clean.
    yield* save("second-value", id);
    expect((yield* service.snapshot).keyRefusals).toEqual([]);
    // Late answers about the value it replaced count for nothing.
    yield* service.reportKeyUse!(id, { kind: "connector", id: "con_a" }, "refused", first);
    yield* service.reportKeyUse!(id, { kind: "voice", id: "engine-1" }, "refused", first);
    const later = yield* service.snapshot;
    expect(later.keyRefusals).toEqual([]);
    expect(later.accounts[0]?.signIn?.state).not.toBe("failed");
  }),
);

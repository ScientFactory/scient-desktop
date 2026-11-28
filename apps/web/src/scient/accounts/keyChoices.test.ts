import { describe, expect, it } from "vite-plus/test";
import { AccountId, defaultAccountControls, type AccountSummary } from "@t3tools/contracts";

import { keyChoices } from "./keyChoices";

const key = (id: string, sites: ReadonlyArray<string>, extra: Partial<AccountSummary> = {}) =>
  ({
    accountId: AccountId.make(`acc_${id}`),
    name: id,
    details: { kind: "api-key", sites, auth: { type: "bearer" } },
    secrets: { token: { source: { type: "scient" } } },
    controls: defaultAccountControls("api-key"),
    ...extra,
  }) as AccountSummary;

describe("keyChoices", () => {
  it("filters by the use first, then shows rows with the same value as one entry", () => {
    const personal = key("personal1", ["openrouter.ai"]);
    const copy = key("copy00001", ["openrouter.ai"]);
    const work = key("work00001", ["openrouter.ai"]);
    // Same value, but kept for one connector: it never joins or stands for the group.
    const kept = key("kept00001", ["openrouter.ai"], {
      details: {
        kind: "api-key",
        sites: ["openrouter.ai"],
        auth: { type: "bearer" },
        privateTo: { kind: "connector", id: "con_x", name: "X" },
      },
    });
    const other = key("other0001", ["api.openai.com"]);
    const snapshot = {
      accounts: [personal, copy, work, kept, other],
      sameKeys: [[personal.accountId, copy.accountId, kept.accountId]],
    };
    const fits = (account: AccountSummary) =>
      account.details.kind === "api-key" && account.details.sites.includes("openrouter.ai");

    expect(
      keyChoices(snapshot, { kind: "connector", id: "con_y" }, fits).map(({ account, copies }) => [
        account.name,
        copies,
      ]),
    ).toEqual([
      ["personal1", 1],
      ["work00001", 0],
    ]);
    // The chosen copy stands for its group.
    expect(
      keyChoices(snapshot, { kind: "connector", id: "con_y" }, fits, copy.accountId)[0]?.account
        .name,
    ).toBe("copy00001");
  });
});

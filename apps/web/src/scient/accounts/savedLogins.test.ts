import { AccountId, defaultAccountControls, type AccountSummary } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { orderSavedLogins, possibleDuplicates, savedLogins, signInKeyChoices } from "./savedLogins";

const login = (accountId: string, username: string, profileId: string) =>
  ({
    accountId: AccountId.make(accountId),
    name: "example.com",
    details: { kind: "website", sites: ["example.com"], username, profileId },
    secrets: { password: { source: { type: "scient" } } },
    controls: defaultAccountControls("website"),
    status: "ready",
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
  }) as AccountSummary;

it("offers one choice per login, from the copy filled, else the tab's profile", () => {
  const work = login("acc_synthetic_work", "CC\\corcosy", "work");
  const main = login("acc_synthetic_main", "cc\\corcosy", "main");
  const bare = login("acc_synthetic_bare", "corcosy", "work");
  const ids = (filledId?: string) =>
    signInKeyChoices([work, main, bare], "main", filledId).map(({ account, copies }) => [
      account.accountId,
      copies.length,
    ]);
  expect(ids()).toEqual([
    ["acc_synthetic_main", 2],
    ["acc_synthetic_bare", 1],
  ]);
  expect(ids("acc_synthetic_work")[0]).toEqual(["acc_synthetic_work", 2]);
});

it("marks possible duplicates on any site they share, and keeps them side by side", () => {
  const at = (accountId: string, name: string, username: string, sites: string[]) =>
    ({
      ...login(accountId, username, "main"),
      name,
      details: { kind: "website", sites, username, profileId: "main" },
    }) as AccountSummary;
  const logins = savedLogins([
    // regression: they share only a second site, and their names sort apart.
    at("acc_synthetic_alpha", "Alpha portal", "CC\\yaacovc", [
      "a.example.com",
      "shared.example.com",
    ]),
    at("acc_synthetic_middle", "Middle", "someone", ["shared.example.com"]),
    at("acc_synthetic_zeta", "Zeta", "yaacovc", ["shared.example.com"]),
  ]);
  expect([...possibleDuplicates(logins)].toSorted()).toEqual([
    "acc_synthetic_alpha",
    "acc_synthetic_zeta",
  ]);
  expect(orderSavedLogins(logins).map(({ account }) => account.accountId)).toEqual([
    "acc_synthetic_alpha",
    "acc_synthetic_zeta",
    "acc_synthetic_middle",
  ]);
});

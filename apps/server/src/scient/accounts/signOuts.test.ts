import { AccountId, BrowserProfileId, type AccountSummary } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { signedOutOfSite, withoutSignOuts, withSignOut } from "./signOuts.ts";

const main = BrowserProfileId.make("default");
const work = BrowserProfileId.make("work");
const row = (profileId: BrowserProfileId | undefined) =>
  ({
    accountId: AccountId.make(`acc_${profileId ?? "none"}_fixture`),
    name: "row",
    details: {
      kind: "website",
      sites: ["mail.example.com"],
      username: "someone",
      ...(profileId === undefined ? {} : { profileId }),
    },
    secrets: { password: { source: { type: "scient" } } },
  }) as unknown as AccountSummary;

it("leaves a site the person signed out of on purpose, in that profile only", () => {
  const signedOut = withSignOut(undefined, work, "example.com");
  expect(signedOutOfSite(row(work), signedOut)).toBe(true);
  expect(signedOutOfSite(row(main), signedOut)).toBe(false);
  // A row with no profile lives in Main, where its look and its sign-in run.
  expect(signedOutOfSite(row(undefined), withSignOut(undefined, main, "example.com"))).toBe(true);
  expect(signedOutOfSite(row(work), withSignOut(undefined, work, "other.example"))).toBe(false);
});

it("ends only for the sites and profile the person signed in to again", () => {
  const signedOut = [
    ...withSignOut(undefined, work, "example.com"),
    ...withSignOut(undefined, work, "other.example"),
  ];
  expect(withoutSignOuts(signedOut, work, ["mail.example.com"])).toEqual([
    { profileId: work, site: "other.example" },
  ]);
  expect(withoutSignOuts(signedOut, main, ["mail.example.com"])).toBe(signedOut);
});

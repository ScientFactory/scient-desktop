import {
  AccountId,
  BrowserProfileId,
  defaultAccountControls,
  type AccountSummary,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";
import { foldStoredAccounts, withStoredAccountsFolded } from "./AccountPersistence.ts";
import { isSignInTab, isUniversitySignInService, withSignInService } from "./universitySignIn.ts";

const ID = AccountId.make("acc_university1");
const SIGN_IN = "https://login.microsoftonline.com";
const university = (sites: ReadonlyArray<string> = ["uni.example.edu"]): AccountSummary => ({
  accountId: ID,
  name: "Example University",
  details: {
    kind: "website",
    sites: [...sites],
    profileId: BrowserProfileId.make("default"),
    institution: {
      name: "Example University",
      entityId: "https://idp.example.edu/shibboleth",
      domain: "example.edu",
    },
  },
  secrets: {},
  controls: defaultAccountControls("website"),
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

it("keeps each exact sign-in address, even under a covered domain, within the limit", () => {
  expect(withSignInService(["example.edu"], new Set(["https://idp.example.edu"]))).toEqual([
    "example.edu",
    "https://idp.example.edu",
  ]);
  expect(
    withSignInService(
      ["example.edu", "https://idp.example.edu"],
      new Set(["https://idp.example.edu"]),
    ),
  ).toEqual(["example.edu", "https://idp.example.edu"]);
  expect(withSignInService(["example.edu"], new Set([SIGN_IN]))).toEqual(["example.edu", SIGN_IN]);
  const full = Array.from({ length: 16 }, (_, index) => `s${index}.example.edu`);
  const kept = withSignInService(full, new Set([SIGN_IN]));
  expect(kept).toHaveLength(16);
  // A full list makes room: the sign-in address and the university's own domain always stay.
  expect(kept).toContain(SIGN_IN);
  expect(kept[0]).toBe("s0.example.edu");
});

it("keeps a university's sign-in service, and nothing else of it, out of scripts", () => {
  const accounts = [university(["example.edu", SIGN_IN])];
  expect(isUniversitySignInService(accounts, `${SIGN_IN}/common/saml2`)).toBe(true);
  // Learned under a domain the sites already cover, it is still kept out.
  const covered = [university(["example.edu", "https://idp.example.edu"])];
  expect(isUniversitySignInService(covered, "https://idp.example.edu/login")).toBe(true);
  expect(isUniversitySignInService(covered, "https://moodle.example.edu/my")).toBe(false);
  expect(isUniversitySignInService(accounts, "https://moodle.example.edu/my")).toBe(false);
  expect(isUniversitySignInService([], `${SIGN_IN}/common`)).toBe(false);
});

it("reads saved library accounts as website accounts carrying their library link", () => {
  const library = {
    summary: {
      details: {
        kind: "library",
        sites: ["huji.ac.il"],
        proxyUrl: "https://go.example.org/r?url={url}",
      },
    },
  };
  const website = { summary: { details: { kind: "website", sites: ["a.org"] } } };
  expect(foldStoredAccounts({ format: 1, accounts: [library, website] })).toEqual({
    format: 1,
    accounts: [
      {
        summary: {
          details: {
            kind: "website",
            sites: ["huji.ac.il"],
            proxyUrl: "https://go.example.org/r?url={url}",
          },
        },
      },
      website,
    ],
  });
});

it("leaves unreadable saved data for the decoder to report", () => {
  const bytes = Redacted.make(new TextEncoder().encode("not json"));
  expect(withStoredAccountsFolded(bytes)).toBe(bytes);
});

it("knows a tab left on the university's sign-in, and never a course page or another profile", () => {
  const details = { sites: ["huji.ac.il", "https://idp.cc.huji.ac.il"], profileId: "default" };
  const at = (url: string | null, profileId = "default") =>
    isSignInTab({ details }, { url, profileId }, []);
  expect(at("https://idp.cc.huji.ac.il/simplesaml/login")).toBe(true);
  expect(at("https://login.openathens.net/saml/2/sso")).toBe(true);
  expect(at("https://my.openathens.net/auth?targetURL=%2Fapp")).toBe(true);
  expect(at("https://my.openathens.net/app/research")).toBe(false);
  expect(at("https://moodle.huji.ac.il/my/")).toBe(false);
  // A learned address serves other pages too; only its sign-in pages count.
  const portal = { sites: ["example.edu", "https://portal.example.edu"], profileId: "default" };
  expect(
    isSignInTab(
      { details: portal },
      { url: "https://portal.example.edu/login", profileId: "default" },
      [],
    ),
  ).toBe(true);
  expect(
    isSignInTab(
      { details: portal },
      { url: "https://portal.example.edu/courses/42", profileId: "default" },
      [],
    ),
  ).toBe(false);
  expect(at("https://idp.cc.huji.ac.il/simplesaml/login", "work")).toBe(false);
  expect(at(null)).toBe(false);
  // A tab in a sign-in under way belongs to that attempt's account, whatever it shows.
  const tab = { tabId: "tab-1", url: "https://moodle.huji.ac.il/my/", profileId: "default" };
  const attempt = (accountId: string) => [{ tabId: "tab-1", accountId: AccountId.make(accountId) }];
  expect(isSignInTab({ accountId: ID, details }, tab, attempt(ID))).toBe(true);
  expect(
    isSignInTab(
      { accountId: ID, details },
      { ...tab, url: "https://idp.cc.huji.ac.il/simplesaml/login" },
      attempt("acc_other_university"),
    ),
  ).toBe(false);
});

it("keeps OpenAthens out of scripts for a university that signs in there", () => {
  const openAthens: AccountSummary = {
    ...university(),
    details: {
      ...university().details,
      institution: {
        name: "Hebrew University",
        entityId: "https://idp.huji.ac.il/openathens",
        domain: "huji.ac.il",
      },
    } as AccountSummary["details"],
  };
  expect(isUniversitySignInService([openAthens], "https://my.openathens.net/app")).toBe(true);
  // Any sign-in page stays in the browser while a university is connected, learned or not.
  expect(isUniversitySignInService([university()], "https://idp.example.edu/profile/SAML2")).toBe(
    true,
  );
  expect(isUniversitySignInService([university()], "https://login.example.org/")).toBe(true);
  expect(isUniversitySignInService([university()], "https://moodle.example.edu/my")).toBe(false);
  expect(isUniversitySignInService([], "https://login.example.org/")).toBe(false);
});

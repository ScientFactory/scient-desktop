import type { AccountSummary } from "@t3tools/contracts";
import { institutionLink, openAthensLink } from "@t3tools/shared/scientPaperLinks";
import { expect, it } from "@effect/vitest";
import { attemptKeys } from "@t3tools/shared/scientAccountSignIn";
import * as Effect from "effect/Effect";
import { fakeAccounts } from "../accounts/Accounts.testkit.ts";
import { AccountsService } from "../accounts/AccountsService.ts";
import {
  buttonSteps,
  routeLogin,
  routeSteps,
  routeUniversities,
  takeFallback,
  withButtonSteps,
} from "./paperRoutes.ts";

const ENTITY = "https://idp.huji.ac.il/openathens";
const university = (
  accountId: string,
  details: Record<string, unknown>,
  signIn?: AccountSummary["signIn"],
) =>
  ({
    accountId,
    name: accountId,
    details: { kind: "website", sites: ["huji.ac.il"], ...details },
    ...(signIn ? { signIn } : {}),
  }) as unknown as AccountSummary;
const paper = { landingUrl: "https://doi.org/10.1/x", articleUrl: "https://www.nature.com/a" };

it("carries the university and the way back on each publisher's sign-in link", () => {
  expect(institutionLink("https://www.sciencedirect.com/science/article/pii/S1", ENTITY)).toBe(
    `https://auth.elsevier.com/ShibAuth/institutionLogin?entityID=${encodeURIComponent(ENTITY)}&appReturnURL=${encodeURIComponent("https://www.sciencedirect.com/science/article/pii/S1")}`,
  );
  expect(institutionLink("https://www.nejm.org/doi/full/10.1056/x", ENTITY)).toBe(
    `https://www.nejm.org/action/ssostart?idp=${encodeURIComponent(ENTITY)}&redirectUri=${encodeURIComponent("/doi/full/10.1056/x")}`,
  );
  expect(institutionLink("https://pubs.acs.org/doi/10.1/x", ENTITY)).toContain(
    `https://pubs.acs.org/Shibboleth.sso/Login?entityID=${encodeURIComponent(ENTITY)}`,
  );
  expect(institutionLink("https://example.org/a", ENTITY)).toBeUndefined();
});

it("starts at the publisher, which works on a university network with no setup", () => {
  expect(routeSteps(paper, [])).toEqual([{ route: "publisher", url: paper.articleUrl }]);
});

it("offers every way in: OpenAthens, the library, then the journal; the one that last worked first", () => {
  const account = university("acc_a", {
    institution: { name: "HUJI", entityId: ENTITY, domain: "huji.ac.il" },
    proxyUrl: "https://go.example/r?url={url}",
  });
  expect(routeSteps(paper, [account]).map((step) => step.url)).toEqual([
    paper.articleUrl,
    openAthensLink("huji.ac.il", paper.articleUrl),
    `https://go.example/r?url=${encodeURIComponent(paper.articleUrl)}`,
    institutionLink(paper.articleUrl, ENTITY),
  ]);
  const worked = { route: "library", accountId: account.accountId } as const;
  expect(routeSteps(paper, [account], worked).map((step) => step.route)).toEqual([
    "library",
    "publisher",
    "university",
    "university",
  ]);
});

it("goes through each of someone's universities", () => {
  const first = university("acc_a", {
    institution: { name: "HUJI", entityId: ENTITY, domain: "huji.ac.il" },
  });
  const second = university("acc_b", {
    institution: { name: "Oxford", entityId: "https://idp.ox.ac.uk", domain: "ox.ac.uk" },
  });
  const worked = { route: "university", accountId: second.accountId } as const;
  expect(routeSteps(paper, [first, second], worked).map((step) => step.account)).toEqual([
    second,
    undefined,
    first,
    first,
  ]);
});

it("reads a way in off the button of a journal no rule knows", () => {
  const account = university("acc_a", {
    institution: { name: "HUJI", entityId: ENTITY, domain: "huji.ac.il" },
  });
  const article = "https://journals.example.org/doi/10.1/x";
  const [step] = buttonSteps(
    "https://journals.example.org/action/ssostart?redirectUri=%2Fdoi%2F10.1%2Fx",
    article,
    [account],
    [],
  );
  expect(step).toMatchObject({ route: "university", account });
  expect(step?.url).toBe(
    `https://journals.example.org/action/ssostart?idp=${encodeURIComponent(ENTITY)}&redirectUri=${encodeURIComponent("/doi/10.1/x")}`,
  );
  // Already tried is not tried again, in that profile; another profile's copy still gets its own.
  expect(buttonSteps(step!.url, article, [account], [step!])).toEqual([]);
  const work = { ...account, details: { ...account.details, profileId: "work" } } as AccountSummary;
  expect(buttonSteps(step!.url, article, [work], [step!])).toHaveLength(1);
});

it("tries the university that delivered here, else the latest signed in, and one other at most", () => {
  const signedIn = (at: string) => ({ state: "signed-in" as const, at });
  const huji = university(
    "acc_huji",
    { institution: { name: "HUJI", entityId: ENTITY, domain: "huji.ac.il" } },
    signedIn("2026-11-01T00:00:00.000Z"),
  );
  // The same university's library row: one university, its working row first.
  const hujiLibrary = university("acc_huji_library", {
    proxyUrl: "https://go.openathens.net/redirector/huji.ac.il?url={url}",
  });
  const ox = university(
    "acc_ox",
    { institution: { name: "Oxford", entityId: "https://idp.ox.ac.uk", domain: "ox.ac.uk" } },
    signedIn("2026-11-20T00:00:00.000Z"),
  );
  const tau = university("acc_tau", {
    institution: { name: "TAU", entityId: "https://idp.tau.ac.il", domain: "tau.ac.il" },
  });
  const ids = (rows: ReadonlyArray<AccountSummary>) => rows.map(({ accountId }) => accountId);
  expect(ids(routeUniversities([hujiLibrary, huji, tau, ox]))).toEqual([
    "acc_ox",
    "acc_huji",
    "acc_huji_library",
  ]);
  const worked = { route: "library", accountId: hujiLibrary.accountId } as const;
  expect(ids(routeUniversities([hujiLibrary, huji, tau, ox], worked))).toEqual([
    "acc_huji",
    "acc_huji_library",
    "acc_ox",
  ]);
  // Its OpenAthens link and the library row's redirector are the same address, tried once.
  const urls = routeSteps(paper, [huji, hujiLibrary]).map((step) => step.url);
  expect(urls.filter((url) => url === openAthensLink("huji.ac.il", paper.articleUrl))).toHaveLength(
    1,
  );
});

it("leaves out a university the person signed out of", () => {
  const out = university(
    "acc_out",
    { institution: { name: "HUJI", entityId: ENTITY, domain: "huji.ac.il" } },
    { state: "signed-out", at: "2026-11-20T00:00:00.000Z", by: "action" },
  );
  expect(routeUniversities([out])).toEqual([]);
});

it("counts routes reaching one login page as one try, and keeps a university's own ways first", () => {
  const huji = university("acc_huji", {
    institution: { name: "HUJI", entityId: ENTITY, domain: "huji.ac.il" },
  });
  const library = university("acc_huji_library", {
    proxyUrl: "https://go.openathens.net/redirector/huji.ac.il?url={url}",
  });
  const [, openAthens, own] = routeSteps(paper, [huji]);
  const [, redirector] = routeSteps(paper, [library]);
  // OpenAthens' link and the old library row's redirector reach OpenAthens' one login page.
  expect(routeLogin(openAthens!, "default")).toBe(
    routeLogin({ ...redirector!, route: "library" }, "default"),
  );
  expect(routeLogin(own!, "default")).not.toBe(routeLogin(openAthens!, "default"));
  // The same login page in another profile is another session.
  expect(routeLogin(openAthens!, "work")).not.toBe(routeLogin(openAthens!, "default"));
  // Two proxies on one host, on different ports or tenants, are two logins.
  const proxyAt = (proxyUrl: string) => {
    const [, step] = routeSteps(paper, [university(`acc_${proxyUrl.length}`, { proxyUrl })]);
    return routeLogin(step!, "default");
  };
  expect(proxyAt("https://proxy.example.edu/login?url={url}")).not.toBe(
    proxyAt("https://proxy.example.edu:8443/login?url={url}"),
  );
  expect(proxyAt("https://proxy.example.edu/a/login?url={url}")).not.toBe(
    proxyAt("https://proxy.example.edu/b/login?url={url}"),
  );
  const ox = university("acc_ox", {
    institution: { name: "Oxford", entityId: "https://idp.ox.ac.uk", domain: "ox.ac.uk" },
  });
  const steps = routeSteps(paper, [huji, ox]);
  const found = { route: "university" as const, url: "https://journal.example/sso", account: huji };
  const merged = withButtonSteps(steps, 1, [found]);
  // HUJI's button route goes right after HUJI's own, before Oxford's.
  expect(merged.map((step) => step.account?.accountId)).toEqual([
    undefined,
    "acc_huji",
    "acc_huji",
    "acc_huji",
    "acc_ox",
  ]);
});

it.effect(
  "a paper's other route spends its login's one fallback, which a password then can't",
  () =>
    Effect.gen(function* () {
      const account = {
        ...university("acc_a", {
          institution: { name: "HUJI", entityId: ENTITY, domain: "huji.ac.il" },
        }),
        secrets: {},
      };
      const fake = fakeAccounts({ accounts: [account] });
      const [first] = routeSteps(paper, [account]).slice(1);
      const route = takeFallback(first!).pipe(Effect.provideService(AccountsService, fake.service));
      expect(yield* route).toBe(true);
      expect(yield* fake.service.takeFallback(attemptKeys([account])(account))).toBe(false);
      expect(yield* route).toBe(false);
    }),
);

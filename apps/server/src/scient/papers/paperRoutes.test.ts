import type { AccountSummary } from "@t3tools/contracts";
import { institutionLink, openAthensLink } from "@t3tools/shared/scientPaperLinks";
import { expect, it } from "@effect/vitest";
import { buttonSteps, routeSteps } from "./paperRoutes.ts";

const ENTITY = "https://idp.huji.ac.il/openathens";
const university = (accountId: string, details: Record<string, unknown>) =>
  ({
    accountId,
    details: { kind: "website", sites: ["huji.ac.il"], ...details },
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
  // Already tried is not tried again.
  expect(buttonSteps(step!.url, article, [account], [step!])).toEqual([]);
});

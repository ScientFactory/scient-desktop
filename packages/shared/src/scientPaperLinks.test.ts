import type { AccountDetails } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  institutionLinkFromButton,
  openAthensLink,
  signInReturn,
  universityLinks,
  universitySignInLink,
  usesOpenAthens,
} from "./scientPaperLinks.ts";

const OPEN_ATHENS = "https://idp.huji.ac.il/openathens";
const SHIBBOLETH = "https://idp.example.edu/idp/shibboleth";
const ARTICLE = "https://www.nejm.org/doi/full/10.1056/NEJMra2506114";
const website = (details: Partial<Extract<AccountDetails, { kind: "website" }>>) =>
  ({ kind: "website", sites: ["huji.ac.il"], ...details }) as Extract<
    AccountDetails,
    { kind: "website" }
  >;

describe("university links", () => {
  it("knows an OpenAthens university by its sign-in service", () => {
    expect(usesOpenAthens({ entityId: OPEN_ATHENS })).toBe(true);
    expect(usesOpenAthens({ entityId: SHIBBOLETH })).toBe(false);
  });

  it("signs an OpenAthens university in on the person's own OpenAthens page", () => {
    const link = universitySignInLink(
      website({ institution: { name: "HUJI", entityId: OPEN_ATHENS, domain: "huji.ac.il" } }),
    );
    expect(link).toBe(
      `https://my.openathens.net/auth?targetURL=%2Fapp%2Fresearch&entityID=${encodeURIComponent(OPEN_ATHENS)}`,
    );
    // The start of that sign-in is not its end; the person's page is.
    expect(signInReturn(link!)).toBeUndefined();
    expect(signInReturn("https://my.openathens.net/app/research")).toBe("openathens");
  });

  it("goes in through OpenAthens first, for any journal", () => {
    const links = universityLinks(
      website({ institution: { name: "HUJI", entityId: OPEN_ATHENS, domain: "huji.ac.il" } }),
      ARTICLE,
    );
    expect(links[0]).toEqual({
      route: "university",
      url: `https://go.openathens.net/redirector/huji.ac.il?url=${encodeURIComponent(ARTICLE)}`,
    });
    expect(links[0]?.url).toBe(openAthensLink("huji.ac.il", ARTICLE));
    // The journal's own sign-in comes after it.
    expect(links[1]?.url).toContain("https://www.nejm.org/action/ssostart?idp=");
  });

  it("uses only the journal's own sign-in for a university outside OpenAthens", () => {
    const links = universityLinks(
      website({ institution: { name: "Example", entityId: SHIBBOLETH, domain: "example.edu" } }),
      "https://example.org/unknown-journal",
    );
    expect(links).toEqual([]);
  });

  it("reads the university's way in off a journal's own button", () => {
    const article = "https://www.cambridge.org/core/journals/x/article/y";
    expect(
      institutionLinkFromButton(
        `https://shibboleth.cambridge.org/Shibboleth.sso/discovery?target=${encodeURIComponent(article)}`,
        article,
        SHIBBOLETH,
      ),
    ).toBe(
      `https://shibboleth.cambridge.org/Shibboleth.sso/Login?entityID=${encodeURIComponent(SHIBBOLETH)}&target=${encodeURIComponent(article)}`,
    );
    expect(
      institutionLinkFromButton(
        "https://wayf.example.org/ds?return=https%3A%2F%2Fsp.example.org%2FLogin%3Fx%3D1",
        article,
        SHIBBOLETH,
      ),
    ).toBe(`https://sp.example.org/Login?x=1&entityID=${encodeURIComponent(SHIBBOLETH)}`);
    expect(
      institutionLinkFromButton("https://example.org/help/access", article, SHIBBOLETH),
    ).toBeUndefined();
    expect(
      institutionLinkFromButton("http://example.org/action/ssostart", article, SHIBBOLETH),
    ).toBeUndefined();
  });
});

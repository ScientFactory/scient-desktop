import { describe, expect, it } from "@effect/vitest";

import { isLogin, loginCandidates, loginGroups, type LoginRow } from "./scientLoginIdentity.ts";

const row = (
  accountId: string,
  sites: string[],
  username?: string,
  extra: Partial<LoginRow["details"]> = {},
): LoginRow => ({
  accountId,
  details: { kind: "website", sites, ...(username === undefined ? {} : { username }), ...extra },
  secrets: { password: {} },
});

const ids = (groups: LoginRow[][]) =>
  groups.map((group) => group.map((row) => row.accountId).toSorted()).toSorted();

describe("login identity", () => {
  it("reads DOMAIN\\user names without case, as Windows does", () => {
    // The owner's HUJI logins: two copies of one login, and a login with no domain beside it.
    expect(
      ids(
        loginGroups([
          row("a", ["tss2.ada.huji.ac.il"], "cc\\corcosy"),
          row("b", ["tss2.ada.huji.ac.il"], "CC\\corcosy"),
          row("c", ["tss2.ada.huji.ac.il"], "cc\\yaacovc"),
          row("d", ["tss2.ada.huji.ac.il"], "yaacovc"),
          // A plain username still compares exactly.
          row("e", ["tss2.ada.huji.ac.il"], "Yaacovc"),
        ]),
      ),
    ).toEqual([["a", "b"], ["c"], ["d"], ["e"]]);
    expect(
      isLogin(
        row("a", ["tss2.ada.huji.ac.il"], "cc\\corcosy"),
        row("x", ["tss2.ada.huji.ac.il"], "CC\\CORCOSY").details,
      ),
    ).toBe(true);
  });

  it("groups the copies of one login and keeps different logins apart", () => {
    expect(
      ids(
        loginGroups([
          // One login: a bare host, its https origin with a default port, an email in another case.
          row("a", ["example.com"], "Ada@Lab.org"),
          row("b", ["https://EXAMPLE.com:443"], "ada@lab.org"),
          // A chain through a shared site joins too.
          row("c", ["https://example.com", "https://login.example.com"], "ada@lab.org"),
          row("d", ["https://login.example.com"], "ada@lab.org"),
          // Not the same login: another port, a subdomain, a non-email in another case.
          row("e", ["https://example.com:8443"], "ada@lab.org"),
          row("f", ["https://sub.example.com"], "ada@lab.org"),
          row("g", ["example.com"], "Ada"),
          row("h", ["example.com"], "ada"),
          // Another tenant on the same host.
          row("i", ["example.com"], "ada@lab.org", { loginUrl: "https://example.com/t/other/" }),
        ]),
      ),
    ).toEqual([["a", "b", "c", "d"], ["e"], ["f"], ["g"], ["h"], ["i"]]);
  });

  it("never treats a university, a session row or a row without a password as a login", () => {
    const rows: LoginRow[] = [
      row("a", ["example.com"], "ada"),
      row("b", ["example.com"], "ada", {
        institution: { name: "U", entityId: "x", domain: "example.com" },
      }),
      row("c", ["example.com"], "ada", { origin: "browser-session" }),
      { ...row("d", ["example.com"], "ada"), secrets: {} },
    ];
    expect(ids(loginGroups(rows))).toEqual([["a"]]);
    const named = (username: string, loginUrl?: string) => ({
      kind: "website",
      sites: ["https://example.com"],
      username,
      ...(loginUrl ? { loginUrl } : {}),
    });
    expect(isLogin(rows[1]!, named("ada"))).toBe(false);
    expect(isLogin(rows[0]!, named("ada"))).toBe(true);
    expect(isLogin(rows[0]!, named("Ada"))).toBe(false);
    // The saved sign-in path is the tenant, exactly: no wildcard, no folding of pages.
    expect(isLogin(rows[0]!, named("ada", "https://example.com/t/acme/login"))).toBe(false);
    const tenant = row("t", ["example.com"], "ada", {
      loginUrl: "https://example.com/login/acme/",
    });
    expect(isLogin(tenant, named("ada", "https://example.com/login/acme"))).toBe(true);
    expect(isLogin(tenant, named("ada", "https://example.com/login/other"))).toBe(false);
    // Every path at the site is still a candidate for the person or agent to choose from.
    expect(loginCandidates([tenant, rows[0]!], named("ada", "https://example.com/x"))).toHaveLength(
      2,
    );
  });
});

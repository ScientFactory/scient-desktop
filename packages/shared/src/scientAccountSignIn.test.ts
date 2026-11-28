import { AccountId, type AccountSummary } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { attemptKeys, signInChoiceLabels, signInsForTab } from "./scientAccountSignIn.ts";

const id = (name: string) => AccountId.make(`acc_${name.padEnd(8, "_")}`);

const row = (
  accountId: string,
  details: Partial<Extract<AccountSummary["details"], { kind: "website" }>>,
  password = true,
) =>
  ({
    accountId: id(accountId),
    details: { kind: "website", sites: ["https://example.com"], username: "ada", ...details },
    secrets: password ? { password: {} } : {},
  }) as unknown as AccountSummary;

describe("sign-in choices on a tab", () => {
  it("offers a tab only its profile's sign-ins, and labels choices that share a username", () => {
    const rows = [
      row("main", { profileId: "default" }),
      row("work", { profileId: "work" }),
      row("work-tenant", { profileId: "work", loginUrl: "https://example.com/t/acme/login" }),
      row("session", { profileId: "work", origin: "browser-session", username: undefined }, false),
    ];
    const ids = (profileId: string) =>
      signInsForTab(rows, "https://example.com/x", profileId).map((row) =>
        row.accountId.slice(4).replace(/_+$/, ""),
      );
    // Main's password is never offered in a Work tab, nor Work's in Main.
    expect(ids("work").toSorted()).toEqual(["work", "work-tenant"]);
    expect(ids("default")).toEqual(["main"]);
    // A profile with none of its own gets another profile's only when there is one.
    expect(ids("other")).toEqual([]);
    expect(signInsForTab(rows.slice(0, 1), "https://example.com/x", "other")).toHaveLength(1);
    const labels = signInChoiceLabels(signInsForTab(rows, "https://example.com/x", "work"));
    expect(new Set(labels.values()).size).toBe(2);
    expect(labels.get(id("work-tenant"))).toBe("ada · example.com/t/acme/login");
    expect(signInChoiceLabels([rows[0]!]).get(id("main"))).toBe("ada");
  });

  it("keys attempts by the login identity: one key per login, tenants and other users apart", () => {
    const rows = [
      row("bare", { sites: ["example.com"], username: "Ada@Lab.org" }),
      row("chain", {
        sites: ["https://example.com", "https://login.example.com"],
        loginUrl: "https://login.example.com/",
        username: "ada@lab.org",
      }),
      row("acme", { loginUrl: "https://example.com/t/acme" }),
      row("other", { loginUrl: "https://example.com/t/other" }),
      row("caps", { loginUrl: "https://example.com/t/acme", username: "Ada" }),
    ];
    const keyOf = attemptKeys(rows);
    const key = (name: string) => keyOf(rows.find((row) => row.accountId === id(name))!);
    // Copies of one login share one attempt and one fallback, whichever site each names first.
    expect(key("bare")).toBe(key("chain"));
    expect(new Set(["acme", "other", "caps", "bare"].map(key)).size).toBe(4);
  });

  it("keys a university's routes by its membership: one lock and one fallback", () => {
    const huji = {
      name: "Hebrew University",
      entityId: "https://idp.huji.ac.il/oa",
      domain: "huji.ac.il",
    };
    const rows = [
      row("directory", {
        sites: ["https://idp.cc.huji.ac.il"],
        institution: huji,
        username: undefined,
      }),
      row("library", {
        sites: ["huji.ac.il"],
        proxyUrl: "https://go.openathens.net/redirector/huji.ac.il?url={url}",
        username: "Corcos.Yaacov",
      }),
      row("proxy", {
        sites: ["huji.ac.il"],
        proxyUrl: "https://ezproxy.huji.ac.il/login?url={url}",
        username: "Corcos.Yaacov",
      }),
    ];
    const keyOf = attemptKeys(rows);
    const key = (name: string) => keyOf(rows.find((row) => row.accountId === id(name))!);
    expect(key("library")).toBe(key("directory"));
    expect(key("proxy")).toBe(key("directory"));
    // A username's case doesn't make another membership, as the Library menu shows it, while
    // another username at the same university does.
    const caps = row("caps", {
      sites: ["huji.ac.il"],
      institution: huji,
      username: "corcos.yaacov",
    });
    expect(attemptKeys([...rows, caps])(caps)).toBe(attemptKeys([...rows, caps])(rows[1]!));
    const staff = row("staff", {
      sites: ["huji.ac.il"],
      institution: huji,
      username: "staff.member",
    });
    expect(attemptKeys([...rows, staff])(staff)).not.toBe(key("library"));
    // Rows a directory entity ties to one university share its key, whatever their domains name.
    const vendor = row("vendor", {
      sites: ["https://login.vendor-idp.com"],
      institution: { ...huji, domain: "vendor-idp.com" },
      username: "Corcos.Yaacov",
    });
    const all = [...rows, vendor];
    expect(attemptKeys(all)(vendor)).toBe(attemptKeys(all)(rows[1]!));
  });
});

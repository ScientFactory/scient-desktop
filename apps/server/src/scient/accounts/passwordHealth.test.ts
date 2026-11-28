import { AccountId, type AccountSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { healthFindings, passwordFacts, pwnedSuffixes } from "./passwordHealth.ts";

const login = (id: string, sites: string[], username: string) =>
  ({
    accountId: AccountId.make(id),
    name: id,
    details: { kind: "website", sites, username },
    secrets: { password: { source: { type: "scient" } } },
  }) as unknown as AccountSummary;

describe("password health", () => {
  it("calls short, plain and common passwords weak, and a long varied one not", () => {
    for (const weak of ["Sh0rt!x", "correcthorse", "Password2026!!", "aaaaaaaaaaaaaaaa"])
      expect(passwordFacts(weak).weak).toBe(true);
    expect(passwordFacts("q7#Lm2-vR9xT!pZ4wK8e").weak).toBe(false);
    expect(passwordFacts("abc").sha1).toBe("A9993E364706816ABA3E25717850C26C9CD0D89D");
  });

  it("finds a leak first, then reuse on another login; copies of one login aren't reuse", () => {
    const strong = passwordFacts("q7#Lm2-vR9xT!pZ4wK8e");
    const rows = [
      // One login in two profiles: the same password by design.
      { summary: login("acc_lab_aaaa", ["example.com"], "ada"), ...strong },
      { summary: login("acc_lab_bbbb", ["example.com"], "ada"), ...strong },
      {
        summary: login("acc_shop_one", ["shop.test"], "ada"),
        ...passwordFacts("u3$Wq9!rT6yP2#mK7vL1"),
      },
      {
        summary: login("acc_bank_one", ["bank.test"], "ada"),
        ...passwordFacts("u3$Wq9!rT6yP2#mK7vL1"),
      },
      { summary: login("acc_old_site", ["old.test"], "ada"), ...passwordFacts("letmein") },
    ];
    const leaked = rows[4]!.sha1;
    expect(healthFindings(rows, (sha1) => sha1 === leaked)).toEqual([
      { accountId: "acc_shop_one", finding: "reused" },
      { accountId: "acc_bank_one", finding: "reused" },
      { accountId: "acc_old_site", finding: "leaked" },
    ]);
  });

  it("reads only the suffixes a range answer lists as breached, never its padding", () => {
    expect([
      ...pwnedSuffixes(
        "0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0\n",
      )!,
    ]).toEqual(["0018A45C4D1DEF81644B54AB7F969B88D65"]);
    // A page in its place (a captive portal's) is no answer, not "listed nowhere".
    expect(pwnedSuffixes("<html><body>Sign in to the network</body></html>")).toBeUndefined();
  });
});

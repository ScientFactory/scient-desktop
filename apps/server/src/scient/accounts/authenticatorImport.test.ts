import { AccountId, BrowserProfileId, type AccountSummary } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { URI } from "otpauth";
import { describe, expect, it } from "vite-plus/test";

import {
  authenticatorTargets,
  isAuthenticatorExport,
  parseAuthenticatorExport,
} from "./authenticatorImport.ts";

/** Google Authenticator's protobuf, written by hand: a varint or bytes per field. */
const varint = (value: number) => {
  const out: number[] = [];
  do {
    out.push((value & 0x7f) | (value > 0x7f ? 0x80 : 0));
    value >>>= 7;
  } while (value > 0);
  return out;
};
const bytes = (field: number, value: Uint8Array | string) => {
  const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...varint(field * 8 + 2), ...varint(data.length), ...data];
};
const number = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
const entry = (parts: {
  secret: number[];
  name: string;
  issuer?: string;
  type?: number;
  digits?: number;
}) =>
  bytes(
    1,
    Uint8Array.from([
      ...bytes(1, Uint8Array.from(parts.secret)),
      ...bytes(2, parts.name),
      ...(parts.issuer ? bytes(3, parts.issuer) : []),
      ...number(4, 1),
      ...number(5, parts.digits ?? 1),
      ...number(6, parts.type ?? 2),
    ]),
  );
const exportOf = (...entries: number[][]) =>
  `otpauth-migration://offline?data=${encodeURIComponent(Buffer.from(Uint8Array.from([...entries.flat(), ...number(2, 1)])).toString("base64"))}`;

// "Hello!\xde\xad\xbe\xef" is JBSWY3DPEHPK3PXP in base32.
const SECRET = [0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef];

describe("Google Authenticator import", () => {
  it("reads each TOTP key with its issuer and account, leaving HOTP keys out", () => {
    const content = exportOf(
      entry({ secret: SECRET, name: "ada@example.com", issuer: "GitHub", digits: 2 }),
      entry({ secret: SECRET, name: "Dropbox:ada" }),
      entry({ secret: SECRET, name: "counter", issuer: "Bank", type: 1 }),
    );
    expect(isAuthenticatorExport(` ${content}`)).toBe(true);
    const keys = parseAuthenticatorExport(content);
    expect(keys.map(({ issuer, account }) => [issuer, account])).toEqual([
      ["GitHub", "ada@example.com"],
      ["Dropbox", "ada"],
    ]);
    const github = URI.parse(keys[0]!.uri);
    expect(github.secret.base32).toBe("JBSWY3DPEHPK3PXP");
    expect(github.digits).toBe(8);
  });

  it("puts each key only on the login it identifies, and names the rest", () => {
    const row = (
      id: string,
      name: string,
      sites: string[],
      username?: string,
      profileId?: string,
    ) =>
      ({
        accountId: AccountId.make(id),
        name,
        details: {
          kind: "website",
          sites,
          ...(username ? { username } : {}),
          ...(profileId ? { profileId } : {}),
        },
        secrets: {},
        updatedAt: "2026-11-26T10:00:00.000Z",
      }) as unknown as AccountSummary;
    const accounts = [
      row("acc_gh_ada0001", "Work GitHub", ["github.com"], "ada@example.com"),
      row("acc_gh_bob0001", "GitHub", ["github.com"], "bob"),
      row("acc_dropbox001", "Dropbox", ["https://www.dropbox.com"], "ada"),
      row("acc_alex_box01", "Box", ["box.com"], "alex"),
      row("acc_lab_home01", "Lab", ["lab.example.org"], "ada", "home"),
      row("acc_lab_work01", "Lab", ["lab.example.org"], "ada", "work"),
      row("acc_slack_0001", "Slack", ["slack.com"]),
    ];
    const key = (issuer: string, account: string) => ({
      issuer,
      account,
      uri: `${issuer}:${account}`,
    });
    const { found, unmatched } = authenticatorTargets(
      accounts,
      [
        key("GitHub", "ADA@example.com"),
        key("Dropbox", "ada"),
        key("gitlab.com", "ada"),
        // Bea's key never goes on Alex's login, the only one saved for the issuer.
        key("Box", "bea"),
        // A login whose username is unknown can't be told to be the account's.
        key("Slack", "ada"),
        key("Bank of Somewhere", "ada"),
      ],
      undefined,
    );
    // Each key goes on the row as matched: saved only while that row is unchanged.
    expect(
      found.map((item) => [
        item.accountId ?? item.login?.details.sites,
        Redacted.value(item.value),
        item.updatedAt,
      ]),
    ).toEqual([
      ["acc_gh_ada0001", "GitHub:ADA@example.com", "2026-11-26T10:00:00.000Z"],
      ["acc_dropbox001", "Dropbox:ada", "2026-11-26T10:00:00.000Z"],
      [["gitlab.com"], "gitlab.com:ada", undefined],
    ]);
    expect(unmatched).toEqual(["Box", "Slack", "Bank of Somewhere"]);
    // Copies of one login in two profiles: the import's profile says which copy takes the key.
    const lab = [key("lab.example.org", "ada")];
    expect(authenticatorTargets(accounts, lab, undefined).unmatched).toEqual(["lab.example.org"]);
    expect(
      authenticatorTargets(accounts, lab, BrowserProfileId.make("work")).found.map(
        (item) => item.accountId,
      ),
    ).toEqual(["acc_lab_work01"]);
    // A domain issuer names that host only: `www.` or another port is another site.
    const hosts = [
      row("acc_portal_801", "Portal", ["https://portal.example.org:8443"], "ada"),
      row("acc_www_pt001", "Portal", ["https://www.portal.example.org"], "ada"),
    ];
    expect(
      authenticatorTargets(hosts, [key("portal.example.org", "ada")], undefined).found.map(
        (item) => item.accountId ?? item.login?.details.sites,
      ),
    ).toEqual([["portal.example.org"]]);
  });

  it("never replaces a login's key, never matches by display name, never puts two keys on one", () => {
    const row = (id: string, name: string, site: string, totp: boolean) =>
      ({
        accountId: AccountId.make(id),
        name,
        details: { kind: "website", sites: [site], username: "ada" },
        secrets: totp ? { totp: { source: { type: "scient" } } } : {},
      }) as unknown as AccountSummary;
    const accounts = [
      // Named like the issuer, on another site: the name says nothing about whose key it is.
      row("acc_lab_name01", "Lab", "notes.example.org", false),
      row("acc_vault_0001", "Vault", "vault.example.com", true),
      row("acc_mail_0001", "Mail", "mail.example.net", false),
    ];
    const key = (issuer: string, uri: string) => ({ issuer, account: "ada", uri });
    const { found, unmatched } = authenticatorTargets(
      accounts,
      [
        key("Lab", "lab"),
        key("vault.example.com", "vault"),
        key("mail.example.net", "mail-1"),
        key("mail.example.net", "mail-2"),
      ],
      undefined,
    );
    expect(found).toEqual([]);
    expect(unmatched).toEqual(["Lab", "vault.example.com", "mail.example.net", "mail.example.net"]);
  });
});

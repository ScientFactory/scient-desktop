/**
 * Google Authenticator's export: `otpauth-migration://offline?data=…`, a protobuf list of keys
 * (about ten per QR). Each TOTP key goes on the saved login it belongs to, by issuer and account
 * name, or on a new login when the issuer names a site.
 */
import { AccountSite, type AccountSummary, type BrowserProfileId } from "@t3tools/contracts";
import { loginCopies, loginUserKey } from "@t3tools/shared/scientLoginIdentity";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Secret, TOTP } from "otpauth";
import { getDomain } from "tldts";

import type { FoundValue } from "./AccountsService.ts";

const isAccountSite = Schema.is(AccountSite);

/** Whether an import's text is one or more Google Authenticator export addresses. */
export const isAuthenticatorExport = (content: string) =>
  content.trimStart().toLowerCase().startsWith("otpauth-migration://");

export interface AuthenticatorKey {
  readonly issuer: string;
  readonly account: string;
  /** The key as an `otpauth://totp/` address. */
  readonly uri: string;
}

/** Protobuf fields of one message: varints as numbers, length-delimited ones as bytes. */
function fieldsOf(bytes: Uint8Array) {
  const fields: Array<{ field: number; value: number | Uint8Array }> = [];
  let at = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = bytes[at++];
      if (byte === undefined || shift > 63) throw new Error("Truncated export.");
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
  };
  while (at < bytes.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) fields.push({ field, value: varint() });
    else if (wire === 2) {
      const length = varint();
      if (at + length > bytes.length) throw new Error("Truncated export.");
      fields.push({ field, value: bytes.subarray(at, at + length) });
      at += length;
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else throw new Error("Unknown field.");
  }
  return fields;
}

const ALGORITHMS: Record<number, string> = { 0: "SHA1", 1: "SHA1", 2: "SHA256", 3: "SHA512" };

/**
 * The TOTP keys in an export's addresses, one per line. HOTP keys and MD5 ones (which Google
 * Authenticator never makes) are left out; a malformed address throws.
 */
export function parseAuthenticatorExport(content: string): ReadonlyArray<AuthenticatorKey> {
  const keys: AuthenticatorKey[] = [];
  const text = new TextDecoder();
  for (const line of content.split(/\s+/).filter(Boolean)) {
    const data = new URL(line).searchParams.get("data");
    if (!data) throw new Error("No data in the export.");
    for (const { field, value } of fieldsOf(Buffer.from(data, "base64"))) {
      if (field !== 1 || typeof value === "number") continue;
      const parameters = new Map(fieldsOf(value).map((entry) => [entry.field, entry.value]));
      const secret = parameters.get(1);
      const name = parameters.get(2);
      const issuer = parameters.get(3);
      const algorithm = ALGORITHMS[Number(parameters.get(4) ?? 0)];
      const digits = parameters.get(5) === 2 ? 8 : 6;
      // Type 1 is HOTP; 0 (unspecified) is read as TOTP, as Google Authenticator does.
      if (!(secret instanceof Uint8Array) || secret.length === 0 || parameters.get(6) === 1)
        continue;
      if (!algorithm) continue;
      const label = name instanceof Uint8Array ? text.decode(name) : "";
      const named = issuer instanceof Uint8Array ? text.decode(issuer) : "";
      // An older export keeps "Issuer:account" in the name only.
      const colon = label.indexOf(":");
      const issuerName = named || (colon > 0 ? label.slice(0, colon) : "");
      const account =
        colon > 0 && (!named || label.startsWith(`${named}:`)) ? label.slice(colon + 1) : label;
      const totp = new TOTP({
        issuer: issuerName.trim(),
        label: account.trim() || issuerName.trim() || "Key",
        secret: new Secret({ buffer: Uint8Array.from(secret).buffer }),
        algorithm,
        digits,
      });
      keys.push({ issuer: issuerName.trim(), account: account.trim(), uri: totp.toString() });
    }
  }
  return keys;
}

/** Letters and digits only, lower case: "GitHub" and "github.com"'s "github" compare equal. */
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Where each key goes: the one login it identifies (a domain issuer by that exact site, another by
 * a site's own name, never a display name; the export's account must be its username), or a new
 * login for a site issuer with none. Never over a login's key, never two on one: else unmatched.
 */
export function authenticatorTargets(
  accounts: ReadonlyArray<AccountSummary>,
  keys: ReadonlyArray<AuthenticatorKey>,
  profileId: BrowserProfileId | undefined,
) {
  const placed: Array<{ readonly name: string; readonly found: FoundValue }> = [];
  const unmatched: string[] = [];
  const logins = accounts.filter(
    (row) =>
      row.details.kind === "website" &&
      row.details.origin !== "browser-session" &&
      row.details.institution === undefined &&
      (profileId === undefined ||
        row.details.profileId === undefined ||
        row.details.profileId === profileId),
  );
  // A site's own host, port included: `www.` and another port are other sites to a domain issuer.
  const hostOf = (site: string) => site.replace(/^https:\/\//, "");
  for (const key of keys) {
    const name = key.issuer || key.account || "Key";
    const issuer = key.issuer.trim().toLowerCase();
    const domain = isAccountSite(issuer) ? hostOf(issuer) : null;
    const candidates = logins.filter(
      ({ details }) =>
        details.kind === "website" &&
        details.sites.some((site) => {
          if (domain) return hostOf(site) === domain;
          const host = hostOf(site).replace(/:\d+$/, "");
          return (
            slug(issuer) !== "" &&
            slug((getDomain(host) ?? host).split(".")[0] ?? "") === slug(issuer)
          );
        }),
    );
    const named = key.account
      ? candidates.filter(
          ({ details }) =>
            details.kind === "website" &&
            details.username !== undefined &&
            loginUserKey(details.username) === loginUserKey(key.account),
        )
      : candidates;
    const [first] = named;
    const copies = first
      ? new Set([
          first.accountId,
          ...loginCopies(accounts, first.accountId).map((row) => row.accountId),
        ])
      : new Set<string>();
    const value = Redacted.make(key.uri);
    const row =
      first && named.every((row) => copies.has(row.accountId))
        ? (named.find(
            ({ details }) => details.kind === "website" && details.profileId === profileId,
          ) ?? (named.length === 1 ? first : undefined))
        : undefined;
    if (row && row.secrets["totp"] === undefined) {
      placed.push({
        name,
        // The row as matched: changed before the import saves (a key added meanwhile), it isn't.
        found: {
          field: "totp",
          value,
          accountId: row.accountId,
          updatedAt: row.updatedAt,
          onlyIfEmpty: true,
        },
      });
      continue;
    }
    if (!row && candidates.length === 0 && domain) {
      placed.push({
        name,
        found: {
          field: "totp",
          value,
          login: {
            name: key.issuer.trim().slice(0, 80),
            details: {
              kind: "website",
              sites: [issuer],
              ...(key.account ? { username: key.account } : {}),
              ...(profileId === undefined ? {} : { profileId }),
            },
          },
        },
      });
      continue;
    }
    unmatched.push(name);
  }
  const target = ({ found }: (typeof placed)[number]) =>
    found.accountId ?? `new:${found.login?.details.sites[0]}:${found.login?.details.username}`;
  const taken = placed.map(target);
  const found = placed.flatMap((entry) => {
    if (taken.filter((id) => id === target(entry)).length === 1) return [entry.found];
    unmatched.push(entry.name);
    return [];
  });
  return { found, unmatched };
}

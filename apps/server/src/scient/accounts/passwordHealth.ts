// @effect-diagnostics nodeBuiltinImport:off -- SHA-1 digests for the leak check's hash prefix.
import * as NodeCrypto from "node:crypto";
import type { AccountId, AccountSummary } from "@t3tools/contracts";
import { loginCopies } from "@t3tools/shared/scientLoginIdentity";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { fail } from "./AccountsService.ts";

/** What a saved password's row shows, worst first: leaked, used on another login, or weak. */
export type PasswordFinding = "leaked" | "reused" | "weak";

/** Words and runs every guessing list tries first. */
const COMMON =
  /password|passw0rd|qwerty|letmein|welcome|iloveyou|admin|abc123|111111|123123|monkey|dragon|football|baseball|sunshine|princess/i;

/** What the computer can tell from a password alone, never sent whole. */
export interface PasswordFacts {
  /** Upper-case hex: its first 5 are all the leak check sends; the whole is matched for reuse. */
  readonly sha1: string;
  /** By length, variety and common words. */
  readonly weak: boolean;
}

export function passwordFacts(value: string): PasswordFacts {
  const pool =
    (/[a-z]/.test(value) ? 26 : 0) +
    (/[A-Z]/.test(value) ? 26 : 0) +
    (/[0-9]/.test(value) ? 10 : 0) +
    (/[^a-zA-Z0-9]/.test(value) ? 33 : 0);
  const bits = value.length * Math.log2(Math.max(pool, 2));
  return {
    sha1: NodeCrypto.createHash("sha1").update(value).digest("hex").toUpperCase(),
    weak: value.length < 10 || bits < 60 || COMMON.test(value) || /^(.)\1+$/.test(value),
  };
}

/**
 * Each login's finding. Copies of one login share their password by design, so only another
 * login holding the same one makes it reused.
 */
export function healthFindings(
  rows: ReadonlyArray<{
    readonly summary: AccountSummary;
    readonly sha1: string;
    readonly weak: boolean;
  }>,
  leaked: (sha1: string) => boolean,
) {
  const summaries = rows.map((row) => row.summary);
  return rows.flatMap((row): Array<{ accountId: AccountId; finding: PasswordFinding }> => {
    const copies = new Set(
      loginCopies(summaries, row.summary.accountId).map((copy) => copy.accountId),
    );
    const reused = rows.some(
      (other) => other !== row && other.sha1 === row.sha1 && !copies.has(other.summary.accountId),
    );
    const finding = leaked(row.sha1) ? "leaked" : reused ? "reused" : row.weak ? "weak" : undefined;
    return finding ? [{ accountId: row.summary.accountId, finding }] : [];
  });
}

/**
 * The suffixes a range answer lists as seen in breaches; padding lines count 0 and are left out.
 * An answer with any other line (a captive portal's page, a cut-off body) is no answer.
 */
export function pwnedSuffixes(answer: string) {
  const lines = answer.split(/\r?\n/).flatMap((line) => (line.trim() ? [line.trim()] : []));
  if (lines.length === 0 || lines.some((line) => !/^[0-9A-F]{35}:\d+$/i.test(line)))
    return undefined;
  return new Set(
    lines.flatMap((line) => {
      const [suffix, count] = line.split(":");
      return Number(count) > 0 ? [suffix!.toUpperCase()] : [];
    }),
  );
}

/**
 * Have I Been Pwned's k-anonymity range: the 5-hex prefix only, with its padding header. Untraced
 * and unpropagated, so the prefix is in no span or outgoing trace header.
 */
export const pwnedRange = Effect.fn("Accounts.pwnedRange")(
  function* (prefix: string) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(
      HttpClientRequest.get(`https://api.pwnedpasswords.com/range/${prefix}`).pipe(
        HttpClientRequest.setHeader("Add-Padding", "true"),
      ),
    );
    if (response.status !== 200) return yield* fail("unavailable", "Leak check unavailable.");
    return yield* response.text;
  },
  Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
  Effect.provideService(HttpClient.TracerPropagationEnabled, false),
  Effect.provide(FetchHttpClient.layer),
  Effect.timeout("10 seconds"),
  Effect.mapError(() => fail("unavailable", "Leak check unavailable.")),
);

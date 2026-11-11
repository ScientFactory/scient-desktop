import type { ScientSourceIdentifier } from "@scientfactory/scient-sources";
import { AccountId, defaultAccountControls, type AccountSummary } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { AccountsService } from "../accounts/AccountsService.ts";
import { fakeAccounts, syntheticValue } from "../accounts/Accounts.testkit.ts";
import { keyedIdentifierLookup, readResearchKeys } from "./researchKeys.ts";
import type { MetadataRequest } from "./metadataHttp.ts";
import {
  resolveSourceIdentifier,
  SourceIdentifierLookup,
  type ResearchKeys,
} from "./SourceIdentifierResolver.ts";

const keyRow = (
  id: string,
  site: string,
  access: AccountSummary["controls"]["access"] = "allowed",
): AccountSummary => ({
  accountId: AccountId.make(`acc_${id}fixture`),
  name: site,
  details: { kind: "api-key", sites: [site], auth: { type: "query", name: "api_key" } },
  secrets: { token: { source: { type: "scient" } } },
  controls: { ...defaultAccountControls("api-key"), access },
  status: "ready",
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z",
});

it.effect("reads saved research keys by site, leaving out a key the user turned off", () =>
  Effect.gen(function* () {
    const value = syntheticValue();
    const accounts = fakeAccounts({
      accounts: [
        keyRow("openalex", "openalex.org"),
        keyRow("ncbi", "ncbi.nlm.nih.gov", "off"),
        keyRow("other", "example.com"),
      ],
      values: { token: value },
    });
    const keys = yield* readResearchKeys().pipe(
      Effect.provideService(AccountsService, accounts.service),
    );
    expect(Object.keys(keys)).toEqual(["openAlex"]);
    expect(keys.openAlex && Redacted.value(keys.openAlex)).toBe(value);
    // Redacted, so a log or tool result never shows it.
    expect(JSON.stringify(keys)).not.toContain(value);
  }),
);

it.effect("hands the keys to whichever resolver the tools use", () =>
  Effect.gen(function* () {
    const seen: Array<ResearchKeys | undefined> = [];
    const resolve = yield* keyedIdentifierLookup().pipe(
      Effect.provideService(
        AccountsService,
        fakeAccounts({ accounts: [keyRow("s2", "semanticscholar.org")], values: { token: "k" } })
          .service,
      ),
      Effect.provideService(SourceIdentifierLookup, async (_identifiers, keys) => {
        seen.push(keys);
        return null;
      }),
    );
    const identifiers: ReadonlyArray<ScientSourceIdentifier> = [{ scheme: "doi", value: "10.1/x" }];
    yield* Effect.promise(() => resolve(identifiers));
    expect(Object.keys(seen[0] ?? {})).toEqual(["semanticScholar"]);
  }),
);

it.effect("sends the Google Books key from Accounts, and none once the row is turned off", () =>
  Effect.gen(function* () {
    const value = syntheticValue();
    const sent: Array<string | null> = [];
    const request: MetadataRequest = async (url) => {
      if (url.host === "www.googleapis.com") sent.push(url.searchParams.get("key"));
      const body = url.host === "openlibrary.org" ? {} : { totalItems: 0 };
      return { status: 200, body: JSON.stringify(body), url };
    };
    for (const access of ["allowed", "off"] as const) {
      const accounts = fakeAccounts({
        accounts: [keyRow("books", "www.googleapis.com", access)],
        values: { token: value },
      });
      const keys = yield* readResearchKeys().pipe(
        Effect.provideService(AccountsService, accounts.service),
      );
      yield* Effect.promise(() =>
        resolveSourceIdentifier([{ scheme: "isbn", value: "9780300102864" }], {
          request,
          pace: (run) => run(),
          keys,
        }),
      );
    }
    expect(sent).toEqual([value, null]);
  }),
);

it.effect("works without Accounts, with no keys", () =>
  Effect.gen(function* () {
    expect(yield* readResearchKeys()).toEqual({});
  }),
);

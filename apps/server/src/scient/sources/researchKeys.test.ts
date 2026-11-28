import type { ScientSourceIdentifier } from "@scientfactory/scient-sources";
import {
  AccountId,
  AccountsError,
  defaultAccountControls,
  type AccountSummary,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ServerSettingsService } from "../../serverSettings.ts";
import { lookUpPaper } from "../papers/paperLookup.ts";
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

it.effect("uses the key the Library chose, even Off for the person, never for an agent", () =>
  Effect.gen(function* () {
    const chosen = keyRow("ncbi", "ncbi.nlm.nih.gov", "off");
    const accounts = fakeAccounts({
      accounts: [keyRow("ncbi2", "ncbi.nlm.nih.gov"), chosen],
      values: { token: syntheticValue() },
    });
    const read = (caller: "person" | "agent") =>
      readResearchKeys(caller).pipe(
        Effect.provideService(AccountsService, accounts.service),
        Effect.provide(
          ServerSettingsService.layerTest({
            scientSources: { registryContactEmail: "", keys: { ncbi: chosen.accountId } },
          }),
        ),
      );
    expect(Object.keys(yield* read("person"))).toEqual(["ncbi"]);
    expect(Object.keys(yield* read("agent"))).toEqual([]);
  }),
);

it.effect("never gives an agent's lookup a key kept to some projects", () =>
  Effect.gen(function* () {
    const scoped = {
      ...keyRow("openalex", "openalex.org"),
      controls: {
        ...defaultAccountControls("api-key"),
        scope: { type: "projects" as const, projectIds: [] },
      },
    };
    const accounts = fakeAccounts({ accounts: [scoped], values: { token: syntheticValue() } });
    const keys = yield* readResearchKeys().pipe(
      Effect.provideService(AccountsService, accounts.service),
    );
    expect(Object.keys(keys)).toEqual([]);
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

it.effect("checks an agent's keys at each lookup, not once when the lookup was made", () =>
  Effect.gen(function* () {
    const seen: Array<ResearchKeys | undefined> = [];
    const fake = fakeAccounts({
      accounts: [keyRow("s2", "semanticscholar.org")],
      values: { token: "k" },
    });
    const uses = { allowed: true };
    const resolve = yield* keyedIdentifierLookup().pipe(
      Effect.provideService(
        AccountsService,
        AccountsService.of({
          ...fake.service,
          authorizeUse: () =>
            uses.allowed
              ? Effect.void
              : Effect.fail(new AccountsError({ reason: "denied", message: "Access changed." })),
        }),
      ),
      Effect.provideService(SourceIdentifierLookup, async (_identifiers, keys) => {
        seen.push(keys);
        return null;
      }),
    );
    const identifiers: ReadonlyArray<ScientSourceIdentifier> = [{ scheme: "doi", value: "10.1/x" }];
    yield* Effect.promise(() => resolve(identifiers));
    uses.allowed = false;
    yield* Effect.promise(() => resolve(identifiers));
    expect(seen.map((keys) => Object.keys(keys ?? {}))).toEqual([["semanticScholar"], []]);
  }),
);

it.effect("gives an agent's lookup no key replaced while it was read", () =>
  Effect.gen(function* () {
    const row = keyRow("s2", "semanticscholar.org");
    const fake = fakeAccounts({ accounts: [row], values: { token: "k" } });
    let version = row.updatedAt;
    const keys = yield* readResearchKeys().pipe(
      Effect.provideService(
        AccountsService,
        AccountsService.of({
          ...fake.service,
          // A new key is saved as the old one is read.
          resolveSecrets: (accountId, fields) =>
            fake.service
              .resolveSecrets(accountId, fields)
              .pipe(Effect.tap(() => Effect.sync(() => (version = "2026-11-02T00:00:00.000Z")))),
          authorizeUse: (_scope, _target, use) =>
            use?.since !== undefined && use.since.updatedAt !== version
              ? Effect.fail(new AccountsError({ reason: "denied", message: "Access changed." }))
              : Effect.void,
        }),
      ),
    );
    expect(keys).toEqual({});
  }),
);

it.effect("gives an agent's lookup no key replaced while a later key was read", () =>
  Effect.gen(function* () {
    const first = keyRow("alex", "openalex.org");
    const second = keyRow("s2", "semanticscholar.org");
    const fake = fakeAccounts({ accounts: [first, second], values: { token: "k" } });
    const versions = new Map<string, string>([
      [first.accountId, first.updatedAt],
      [second.accountId, second.updatedAt],
    ]);
    const keys = yield* readResearchKeys().pipe(
      Effect.provideService(
        AccountsService,
        AccountsService.of({
          ...fake.service,
          // The OpenAlex key is replaced while the Semantic Scholar key is read.
          resolveSecrets: (accountId, fields) =>
            fake.service.resolveSecrets(accountId, fields).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (accountId === second.accountId)
                    versions.set(first.accountId, "2026-11-12T00:00:00.000Z");
                }),
              ),
            ),
          authorizeUse: (_scope, target, use) =>
            target.type === "account" &&
            use?.since !== undefined &&
            use.since.updatedAt !== versions.get(target.accountId)
              ? Effect.fail(new AccountsError({ reason: "denied", message: "Access changed." }))
              : Effect.void,
        }),
      ),
    );
    expect(Object.keys(keys)).toEqual(["semanticScholar"]);
  }),
);

/** Keys read for an agent whose rows change version as `bump` says, gated as the service does. */
const versioned = (rows: ReadonlyArray<AccountSummary>) => {
  const fake = fakeAccounts({ accounts: [...rows], values: { token: "synthetic-token" } });
  const versions = new Map(rows.map((row) => [row.accountId as string, row.updatedAt]));
  const service = AccountsService.of({
    ...fake.service,
    authorizeUse: (_scope, target, use) =>
      target.type === "account" &&
      use?.since !== undefined &&
      use.since.updatedAt !== versions.get(target.accountId)
        ? Effect.fail(new AccountsError({ reason: "denied", message: "Access changed." }))
        : Effect.void,
  });
  return {
    service,
    bump: (row: AccountSummary) => versions.set(row.accountId, "2026-11-20T00:00:00.000Z"),
  };
};

it.effect("sends no Google Books key replaced while Open Library answered", () =>
  Effect.gen(function* () {
    const books = keyRow("books", "www.googleapis.com");
    const { service, bump } = versioned([books]);
    const keys = yield* readResearchKeys().pipe(Effect.provideService(AccountsService, service));
    const sent: Array<string> = [];
    const request: MetadataRequest = async (url) => {
      sent.push(url.host);
      // The key is replaced while Open Library answers.
      if (url.host === "openlibrary.org") bump(books);
      const body = url.host === "openlibrary.org" ? {} : { totalItems: 0 };
      return { status: 200, body: JSON.stringify(body), url };
    };
    yield* Effect.promise(() =>
      resolveSourceIdentifier([{ scheme: "isbn", value: "9780300102864" }], {
        request,
        pace: (run) => run(),
        keys,
      }),
    );
    // regression: the gate ran once per lookup, so the old key still went to Google Books.
    expect(sent).toEqual(["openlibrary.org"]);
  }),
);

it.effect("sends no Unpaywall email changed while OpenAlex answered", () =>
  Effect.gen(function* () {
    const alex = keyRow("alex", "api.openalex.org");
    const email = {
      ...keyRow("unpaywall", "api.unpaywall.org"),
      accountId: AccountId.make("acc_mailfixture"),
    };
    const { service, bump } = versioned([alex, email]);
    const keys = yield* readResearchKeys().pipe(Effect.provideService(AccountsService, service));
    const asked: Array<string> = [];
    const layer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        asked.push(new URL(request.url).host);
        if (request.url.startsWith("https://api.openalex.org/")) bump(email);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }) as never),
        );
      }),
    );
    yield* lookUpPaper({ doi: "10.1000/synthetic" }, keys).pipe(Effect.provide(layer));
    expect(asked).toEqual(["api.openalex.org"]);
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

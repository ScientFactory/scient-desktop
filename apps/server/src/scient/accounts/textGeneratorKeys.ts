import {
  referencedAccountId,
  type AccountId,
  type ProviderInstanceId,
  type TextGeneratorConfig,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../../serverSettings.ts";
import { SECRET_REDACTED } from "../../settingsSecrets.ts";
import {
  AccountsService,
  privateKeyId,
  typedDigest,
  type AccountsServiceShape,
} from "./AccountsService.ts";

export const ACCOUNTS_UNAVAILABLE = "Accounts & secrets isn't available here.";

/** The generator asking: its settings id, endpoint and API style. */
export type TextGeneratorUse = Pick<TextGeneratorConfig, "baseUrl" | "kind"> & {
  readonly id: ProviderInstanceId;
};

type Read = (accountId: AccountId, generator: TextGeneratorUse) => Effect.Effect<string, string>;
/** The API's answer to a request sent with `sent`, for the generator's Accounts key, if any. */
type Report = (
  generator: TextGeneratorUse & Pick<TextGeneratorConfig, "apiKey">,
  sent: string,
  outcome: "refused" | "ok",
) => Effect.Effect<void>;
/** A typed key's value now: its Accounts row once kept, failing if that row is gone. */
type Kept = (
  generator: TextGeneratorUse,
  typed: string,
) => Effect.Effect<{ readonly key: string; readonly accountId?: AccountId }, string>;
interface Handlers {
  readonly read: Read;
  readonly report: Report;
  readonly kept: Kept;
}

/**
 * Text generators are built below Accounts, so Accounts hands them its reader once it starts.
 * Both sides get one instance because Effect shares a layer value across the server's build.
 */
export class TextGeneratorKeys extends Context.Service<
  TextGeneratorKeys,
  {
    readonly read: Read;
    /** A provider's answer to a request sent with an Accounts key. */
    readonly report: Report;
    readonly kept: Kept;
    readonly serve: (handlers: Handlers) => Effect.Effect<void>;
  }
>()("t3/scient/accounts/textGeneratorKeys") {}

export const layer = Layer.sync(TextGeneratorKeys, () => {
  let served: Handlers | undefined;
  return TextGeneratorKeys.of({
    read: Effect.fn("TextGeneratorKeys.read")(function* (accountId, config) {
      if (!served) return yield* Effect.fail(ACCOUNTS_UNAVAILABLE);
      return yield* served.read(accountId, config);
    }),
    report: Effect.fn("TextGeneratorKeys.report")((generator, sent, outcome) =>
      served ? served.report(generator, sent, outcome) : Effect.void,
    ),
    kept: Effect.fn("TextGeneratorKeys.kept")((generator, typed) =>
      served ? served.kept(generator, typed) : Effect.succeed({ key: typed }),
    ),
    serve: Effect.fn("TextGeneratorKeys.serve")((handlers) =>
      Effect.sync(() => {
        served = handlers;
      }),
    ),
  });
});

// Titles and commit messages call often; Activity shows one use per stretch of work.
const USE_RECORD_INTERVAL_MS = 10 * 60_000;
const lastRecordedUse = new Map<AccountId, number>();

/** The person chose this use, so agent Off doesn't apply; the row must still fit the endpoint. */
export const readTextGeneratorKey = Effect.fn("TextGeneratorKeys.readAccount")(function* (
  accounts: Pick<AccountsServiceShape, "resolveTextGeneratorKey" | "recordUse">,
  accountId: AccountId,
  config: TextGeneratorUse,
) {
  const token = yield* accounts
    .resolveTextGeneratorKey(accountId, config)
    .pipe(
      Effect.mapError(
        () => "The key chosen in Accounts & secrets is unavailable for this endpoint.",
      ),
    );
  const now = yield* Clock.currentTimeMillis;
  if (now - (lastRecordedUse.get(accountId) ?? -Infinity) >= USE_RECORD_INTERVAL_MS) {
    lastRecordedUse.set(accountId, now);
    yield* accounts.recordUse({
      target: { type: "account", accountId },
      action: "request",
      detail: new URL(config.baseUrl).origin,
      outcome: "ok",
    });
  }
  return Redacted.value(token).trim();
});

/** A typed generator key Accounts can keep: an `https` endpoint's literal value. */
const typedKey = (generator: Pick<TextGeneratorConfig, "apiKey" | "baseUrl">) => {
  const typed = generator.apiKey;
  if (typeof typed !== "string" || !typed.trim() || typed === SECRET_REDACTED) return undefined;
  return URL.canParse(generator.baseUrl) && new URL(generator.baseUrl).protocol === "https:"
    ? typed.trim()
    : undefined;
};

/**
 * Keeps each typed generator key in a row for that generator only too. Settings keep the typed
 * value, which an older build reads; this build reads the row while that value is unchanged, and
 * keeps a changed one again. A removed row is never kept again: its typed value is cleared, on
 * each start until that write lands. Keyless, named-reference and plain-`http` generators stay.
 */
export const keepTypedGeneratorKeys = Effect.fn("TextGeneratorKeys.keepTyped")(function* (
  accounts: Pick<AccountsServiceShape, "keepPrivateKey" | "keptKeyState">,
  settings: Pick<ServerSettingsService["Service"], "getSettings" | "updateSettings">,
) {
  const { keepPrivateKey: keep, keptKeyState } = accounts;
  if (!keep || !keptKeyState) return;
  for (const [id, generator] of Object.entries((yield* settings.getSettings).textGenerators)) {
    yield* Effect.exit(
      Effect.gen(function* () {
        const typed = typedKey(generator);
        if (typed === undefined) return;
        const use = { kind: "text-generator" as const, id };
        const url = new URL(generator.baseUrl);
        const kept = yield* keptKeyState(use, Redacted.make(typed), url.origin);
        if (kept === "removed") return yield* clearTyped(settings, id, typed);
        if (kept === "kept") return;
        yield* keep({
          use: { ...use, name: generator.label ?? url.host },
          sites: [url.origin],
          auth:
            generator.kind === "anthropic"
              ? { type: "header", name: "x-api-key" }
              : { type: "bearer" },
          value: Redacted.make(typed),
        });
      }),
    );
  }
});

/** Clears a generator's typed value while it is still the one given. */
const clearTyped = Effect.fn("TextGeneratorKeys.clearTyped")(function* (
  settings: Pick<ServerSettingsService["Service"], "getSettings" | "updateSettings">,
  id: string,
  typed: string,
) {
  const generator = (yield* settings.getSettings).textGenerators[id as ProviderInstanceId];
  if (generator && typedKey(generator) === typed)
    yield* settings.updateSettings({ textGenerators: { [id]: { ...generator, apiKey: "" } } });
});

/**
 * The key a generator sends for its typed value: that value until Accounts keeps it, then its
 * row. A kept key that is removed or can't be read is never replaced by the typed copy.
 */
export const keptGeneratorKey = Effect.fn("TextGeneratorKeys.keptKey")(function* (
  accounts: Pick<AccountsServiceShape, "keptKeyState" | "resolveTextGeneratorKey" | "recordUse">,
  generator: TextGeneratorUse,
  typed: string,
) {
  const value = typedKey({ ...generator, apiKey: typed });
  if (value === undefined || !accounts.keptKeyState) return { key: typed };
  const state = yield* accounts
    .keptKeyState(
      { kind: "text-generator", id: generator.id },
      Redacted.make(value),
      new URL(generator.baseUrl).origin,
    )
    .pipe(Effect.mapError(() => ACCOUNTS_UNAVAILABLE));
  if (state === "removed")
    return yield* Effect.fail("This generator's key was removed in Accounts & secrets.");
  if (state === "kept") {
    const accountId = privateKeyId({ kind: "text-generator", id: generator.id });
    const key = yield* readTextGeneratorKey(accounts, accountId, generator);
    return { key, accountId };
  }
  // Too short to scrub from a provider's error text, as for an Accounts key.
  if (value.length < 8) return yield* Effect.fail("This generator's key is too short to send.");
  return { key: typed };
});

/** Removing a generator's kept row stops it: the typed value it was kept from goes too. */
const followRemovals = Effect.fn("TextGeneratorKeys.followRemovals")(function* (
  accounts: Pick<AccountsServiceShape, "changes" | "keptKeyState">,
  settings: Pick<ServerSettingsService["Service"], "getSettings" | "updateSettings">,
) {
  const keptKeyState = accounts.keptKeyState;
  if (!keptKeyState) return;
  yield* Stream.runForEach(accounts.changes, () =>
    Effect.gen(function* () {
      for (const [id, generator] of Object.entries((yield* settings.getSettings).textGenerators)) {
        const typed = typedKey(generator);
        if (typed === undefined) continue;
        const kept = yield* keptKeyState({ kind: "text-generator", id }, Redacted.make(typed));
        if (kept === "removed") yield* clearTyped(settings, id, typed);
      }
    }).pipe(Effect.ignore),
  );
});

/** Accounts' side: serves text generators' Accounts keys and keeps typed ones too. */
export const serveLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const accounts = yield* AccountsService;
    const keys = yield* TextGeneratorKeys;
    yield* keys.serve({
      read: (accountId, config) => readTextGeneratorKey(accounts, accountId, config),
      // A reference names its row; a typed key may be kept in its generator's own row. Accounts
      // drops an answer about any other value, so a typed key never counts against the row.
      report: (generator, sent, outcome) =>
        accounts.reportKeyUse
          ? accounts.reportKeyUse(
              referencedAccountId(generator.apiKey) ??
                privateKeyId({ kind: "text-generator", id: generator.id }),
              { kind: "text-generator", id: generator.id },
              outcome,
              typedDigest(sent),
            )
          : Effect.void,
      kept: (generator, typed) => keptGeneratorKey(accounts, generator, typed),
    });
    const settings = yield* ServerSettingsService;
    yield* followRemovals(accounts, settings).pipe(Effect.forkScoped);
    yield* keepTypedGeneratorKeys(accounts, settings).pipe(Effect.ignore, Effect.forkScoped);
  }),
).pipe(Layer.provide(layer));

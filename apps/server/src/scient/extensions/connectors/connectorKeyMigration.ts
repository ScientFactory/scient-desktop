import { type ApiKeyAuth } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { accountTokenRef } from "../../accounts/AccountBoundRef.ts";
import { privateKeyId, type AccountsServiceShape } from "../../accounts/AccountsService.ts";
import type { ConnectorCredentialStoreShape } from "./ConnectorCredentialStore.ts";
import type { ConnectorAuthRecord, ConnectorStateStore } from "./ConnectorStateStore.ts";

type Owned = Extract<ConnectorAuthRecord, { type: "credential" }>;

/** How Accounts names a connector credential's header style. */
export const connectorKeyAuth = (auth: Pick<Owned, "strategy" | "headerName">): ApiKeyAuth =>
  auth.strategy === "header"
    ? { type: "header", name: auth.headerName ?? "Authorization" }
    : auth.strategy === "basic"
      ? { type: "basic", username: "" }
      : { type: "bearer" };

/**
 * Keeps each typed connector key in a row for that connector only too, beside its typed copy,
 * which an older build goes on using (`accountRef` is all the record gains). A typed copy changed
 * since is kept again; a row the person removed is not, and its typed copy is never read again.
 * Plain-`http` connectors stay typed.
 */
export const keepTypedConnectorKeys = Effect.fn("ConnectorKeys.keepTyped")(function* (deps: {
  readonly store: ConnectorStateStore;
  readonly credentials: ConnectorCredentialStoreShape;
  readonly accounts: Pick<AccountsServiceShape, "keepPrivateKey" | "keptKeyState">;
}) {
  const { keepPrivateKey: keep, keptKeyState } = deps.accounts;
  if (!keep || !keptKeyState) return;
  for (const record of (yield* deps.store.read).connectors) {
    yield* Effect.exit(
      Effect.gen(function* () {
        const auth = record.auth;
        if (auth.type !== "credential" || auth.storage !== "owned") return;
        const origin = URL.canParse(record.url) ? new URL(record.url) : undefined;
        if (origin?.protocol !== "https:") return;
        const typed = yield* deps.credentials.readOwned(auth.credentialRef, {
          type: "connector",
          connectorId: record.connectorId,
        });
        if (Option.isNone(typed)) return;
        const value = new TextDecoder().decode(typed.value.material);
        const use = { kind: "connector" as const, id: record.connectorId };
        const kept = yield* keptKeyState(use, Redacted.make(value));
        const settled = kept === "kept" || kept === "removed";
        if (settled && auth.accountRef !== undefined) return;
        // A removed row stays removed: the record's `accountRef` then finds no key.
        const accountId = settled
          ? privateKeyId(use)
          : yield* keep({
              use: { ...use, name: record.displayName },
              sites: [origin.origin],
              auth: connectorKeyAuth(auth),
              value: Redacted.make(value),
            });
        if (auth.accountRef !== undefined) return;
        yield* deps.store.update((current) => {
          const latest = current.connectors.find(
            ({ connectorId }) => connectorId === record.connectorId,
          );
          if (
            latest?.auth.type !== "credential" ||
            latest.auth.storage !== "owned" ||
            latest.auth.credentialRef !== auth.credentialRef
          )
            return Effect.succeed([undefined, current] as const);
          const next = {
            ...latest,
            auth: { ...latest.auth, accountRef: accountTokenRef(accountId) },
          };
          return Effect.succeed([
            undefined,
            {
              ...current,
              connectors: current.connectors.map((entry) => (entry === latest ? next : entry)),
            },
          ] as const);
        });
      }),
    );
  }
});

import { expect, it } from "@effect/vitest";
import { ConnectorId, ThreadId, VaultSecretRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { accountTokenRef } from "../../accounts/AccountBoundRef.ts";
import { makeHarness, secretEquals } from "../../accounts/Accounts.testkit.ts";
import type { ConnectorCredentialStoreShape } from "./ConnectorCredentialStore.ts";
import { keepTypedConnectorKeys } from "./connectorKeyMigration.ts";
import type {
  ConnectorRecord,
  ConnectorStateData,
  ConnectorStateStore,
} from "./ConnectorStateStore.ts";

const connectorId = ConnectorId.make("con_synthetic01");
const typedRef = VaultSecretRef.make("connector-00000000-0000-4000-8000-000000000001");
const record = {
  connectorId,
  serverName: "Example",
  displayName: "Example",
  url: "https://mcp.example.com/mcp",
  source: { type: "url" },
  auth: { type: "credential", strategy: "bearer", storage: "owned", credentialRef: typedRef },
  status: "connected",
  enabled: true,
  authRevision: 0,
  availability: { type: "all-projects" },
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
} as ConnectorRecord;

it.effect(
  "keeps a typed connector key in Accounts for that connector, and the typed copy for older builds",
  () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      let data: ConnectorStateData = {
        connectors: [record],
        githubFromSourceControlDeclined: false,
      };
      const store = {
        read: Effect.sync(() => data),
        update: (transform) =>
          transform(data).pipe(
            Effect.map(([result, next]) => {
              data = next;
              return result;
            }),
          ),
      } as ConnectorStateStore;
      const removed: string[] = [];
      let typed = { text: "synthetic-typed-connector-key", version: 1 };
      const credentials = {
        readOwned: (ref: VaultSecretRef) =>
          Effect.succeed(
            ref === typedRef
              ? Option.some({
                  material: new TextEncoder().encode(typed.text),
                  version: typed.version,
                })
              : Option.none(),
          ),
        remove: (ref: VaultSecretRef) => Effect.sync(() => void removed.push(ref)),
      } as unknown as ConnectorCredentialStoreShape;
      const migrate = keepTypedConnectorKeys({ store, credentials, accounts: service });
      const own = {
        kind: "connector" as const,
        connectorId,
        origin: "https://mcp.example.com",
        auth: { type: "bearer" as const },
      };
      const accountRef = () => {
        const auth = data.connectors[0]!.auth;
        return auth.type === "credential" ? auth.accountRef : undefined;
      };

      yield* migrate;
      // An older build still finds its typed copy, and the record still names it.
      expect(data.connectors[0]!.auth).toMatchObject({ storage: "owned", credentialRef: typedRef });
      expect(removed).toEqual([]);
      expect(secretEquals(yield* service.resolveBound(accountRef()!, own), typed.text)).toBe(true);
      const scope = { threadId: ThreadId.make("t"), projectId: undefined, unattended: false };
      expect((yield* service.forSession(scope)).accounts).toEqual([]);

      // An older build changed the typed key meanwhile: this build keeps the new one.
      typed = { text: "synthetic-replaced-by-older-build", version: 2 };
      yield* migrate;
      expect(secretEquals(yield* service.resolveBound(accountRef()!, own), typed.text)).toBe(true);

      // A row the person removed stays removed.
      const accountId = (yield* service.snapshot).accounts[0]!.accountId;
      yield* service.remove(accountId);
      yield* migrate;
      expect((yield* service.snapshot).accounts).toEqual([]);
      // Even if the record never gained its `accountRef`, a restart points it at the removed row
      // rather than keeping its typed copy again.
      const [current] = data.connectors;
      if (current?.auth.type === "credential") {
        const { accountRef: _, ...auth } = current.auth;
        data = { ...data, connectors: [{ ...current, auth }] };
      }
      yield* migrate;
      expect((yield* service.snapshot).accounts).toEqual([]);
      expect(accountRef()).toBe(accountTokenRef(accountId));
    }),
);

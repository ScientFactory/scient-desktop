import { expect, it } from "@effect/vitest";
import {
  AccountId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  WS_METHODS,
  WsAccountsRpcGroup,
  RpcScopeAuthorization,
} from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { makeAccountsRpcHandlers } from "../scient/accounts/AccountsRpcHandlers.ts";
import { makeHarness, syntheticValue, website } from "../scient/accounts/Accounts.testkit.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

it.effect(
  "permits account observation but blocks every account change and autofill before execution",
  () =>
    Effect.gen(function* () {
      const { service, blobs } = yield* makeHarness();
      const handlers = makeAccountsRpcHandlers({
        accounts: service,
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStream: (_method, stream) => stream,
        check: () => Effect.succeed({ checked: 0 }),
        linkKey: () => Effect.void,
        paperForSource: () => Effect.die("not reached"),
        papers: {
          request: () => Effect.die("not reached"),
          continue: () => Effect.die("not reached"),
          list: () => Effect.die("not reached"),
          signInAsPerson: () => Effect.die("not reached"),
          universityBrowse: () => Effect.die("not reached"),
          universities: () => Effect.die("not reached"),
        },
        plainKeys: { find: () => Effect.succeed([]), keep: () => Effect.void },
        restoreKeptKeys: () => Effect.void,
      });
      const group = WsAccountsRpcGroup.middleware(RpcScopeAuthorization);
      const layer = group.toLayer(handlers);
      const reader = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(layer, RpcAuthorization.layer([AuthOrchestrationReadScope]))),
      );
      yield* reader[WS_METHODS.accountsSnapshot]({});
      expect(yield* reader[WS_METHODS.accountsActivity]({})).toEqual([]);
      expect(
        (yield* Stream.runCollect(
          reader[WS_METHODS.accountsSubscribeChanges]({}).pipe(Stream.take(1)),
        )).length,
      ).toBe(1);
      const accountId = AccountId.make("acc_synthetic123");
      const before = blobs.size;
      const writes = [
        reader[WS_METHODS.accountsKeychainCandidates]({}),
        reader[WS_METHODS.accountsSave](website()),
        reader[WS_METHODS.accountsRemove]({ accountId }),
        reader[WS_METHODS.accountsTest]({ accountId }),
        reader[WS_METHODS.accountsSetControls]({
          target: { type: "account", accountId },
          access: "off",
        }),
        reader[WS_METHODS.accountsSetAgentAccess]({ enabled: false }),
        reader[WS_METHODS.accountsProfileUpdate]({ profileId: "synthetic", color: "#aabbcc" }),
        reader[WS_METHODS.accountsProfileRemove]({ profileId: "synthetic" }),
        reader[WS_METHODS.accountsHandoffCancel]({ handoffId: "synthetic-wait" }),
        reader[WS_METHODS.accountsHandoffShow]({ handoffId: "synthetic-wait" }),
        reader[WS_METHODS.accountsApprovalRespond]({
          approvalId: "apr_synthetic123",
          decision: "once",
        }),
        reader[WS_METHODS.accountsOnePasswordConnect]({
          mode: "service-account",
          token: syntheticValue(),
        }),
        reader[WS_METHODS.accountsOnePasswordDisconnect]({}),
        reader[WS_METHODS.accountsPasswordStore]({
          store: "bitwarden",
          action: "connect",
          password: "synthetic",
        }),
        reader[WS_METHODS.accountsImportPasswords]({
          format: "auto",
          content: "name,url,username,password",
        }),
        reader[WS_METHODS.accountsFillValues]({ accountId, origin: "https://example.com" }),
        reader[WS_METHODS.accountsMatchSignIn]({
          origin: "https://example.com",
          username: "synthetic",
          password: syntheticValue(),
        }),
      ];
      for (const write of writes)
        expect(yield* write.pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthSettingsWriteScope,
        });
      expect(blobs.size).toBe(before);
      const writer = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(layer, RpcAuthorization.layer([AuthSettingsWriteScope]))),
      );
      const saved = yield* writer[WS_METHODS.accountsSave](website());
      expect((yield* service.snapshot).accounts[0]?.accountId).toBe(saved.accountId);
      expect(yield* writer[WS_METHODS.accountsSnapshot]({}).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthOrchestrationReadScope,
      });
    }).pipe(Effect.scoped),
);

const paperClient = (scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    const reached: Array<string> = [];
    const handlers = makeAccountsRpcHandlers({
      accounts: service,
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStream: (_method, stream) => stream,
      check: () => Effect.succeed({ checked: 0 }),
      linkKey: () => Effect.void,
      paperForSource: () =>
        Effect.sync(() => {
          reached.push("paperForSource");
          return { status: "waiting", message: "synthetic" } as const;
        }),
      papers: {
        request: (input) =>
          Effect.as(
            Effect.sync(() => reached.push(`request:${input.papers.length}`)),
            {},
          ),
        continue: () => Effect.die("not reached"),
        list: () => Effect.die("not reached"),
        signInAsPerson: () => Effect.die("not reached"),
        universityBrowse: () => Effect.die("not reached"),
        universities: () => Effect.die("not reached"),
      },
      plainKeys: { find: () => Effect.succeed([]), keep: () => Effect.void },
      restoreKeptKeys: () => Effect.void,
    });
    const group = WsAccountsRpcGroup.middleware(RpcScopeAuthorization);
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(group.toLayer(handlers), RpcAuthorization.layer(scopes))),
    );
    return { client, reached };
  });

const source = { sourceId: "src_synthetic", expectedRevision: 1 };
const attachingRequests = [
  { root: "/synthetic", papers: [{ doi: "10.1000/plain" }, { doi: "10.1000/x", source }] },
  { root: "/synthetic", papers: [{ doi: "10.1000/y", library: true }] },
];

it.effect("refuses a settings-only connection that would file papers into the Library", () =>
  Effect.gen(function* () {
    const { client, reached } = yield* paperClient([AuthSettingsWriteScope]);
    const refused = [
      client[WS_METHODS.accountsPaperForSource]({
        root: "/synthetic",
        ...source,
        doi: "10.1000/x",
      }),
      ...attachingRequests.map((input) => client[WS_METHODS.accountsPapersRequest](input)),
    ];
    for (const call of refused)
      expect(yield* call.pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthOrchestrationOperateScope,
      });
    yield* client[WS_METHODS.accountsPapersRequest]({
      root: "/synthetic",
      papers: [{ doi: "10.1000/plain" }],
    });
    expect(reached).toEqual(["request:1"]);
  }).pipe(Effect.scoped),
);

it.effect("lets a connection with the Library grant file papers into the Library", () =>
  Effect.gen(function* () {
    const { client, reached } = yield* paperClient([
      AuthSettingsWriteScope,
      AuthOrchestrationOperateScope,
    ]);
    yield* client[WS_METHODS.accountsPaperForSource]({ root: "/synthetic", ...source });
    for (const input of attachingRequests) yield* client[WS_METHODS.accountsPapersRequest](input);
    expect(reached).toEqual(["paperForSource", "request:2", "request:1"]);
  }).pipe(Effect.scoped),
);

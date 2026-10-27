import { expect, it } from "@effect/vitest";
import {
  AccountId,
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

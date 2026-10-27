// @effect-diagnostics nodeBuiltinImport:off -- Synthetic private state and Accounts integration fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ProjectId, ProviderInstanceId, VaultSecretRef } from "@t3tools/contracts";
import { makeHarness, syntheticValue } from "../accounts/Accounts.testkit.ts";
import { accountTokenRef } from "../accounts/AccountBoundRef.ts";
import { makePluginKeyBindings, pluginKeyAccountsEligibilityKey } from "./PluginKeyBindings.ts";
import { PLUGIN_KEY_STATE_FILE } from "./PluginKeyStateStore.ts";
const directory = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-plugin-bindings-"))),
  (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);
const target = {
  agent: ProviderInstanceId.make("synthetic-agent"),
  pluginId: "sample@synthetic",
  projectId: ProjectId.make("synthetic-project"),
};

it.effect(
  "persists only account references and rechecks removal, Off, global access and project scope",
  () =>
    Effect.gen(function* () {
      const root = yield* directory;
      const { service } = yield* makeHarness();
      const value = syntheticValue();
      const { accountId } = yield* service.save({
        name: "Synthetic key",
        details: { kind: "api-key", sites: [], auth: { type: "bearer" } },
        secrets: { token: { type: "scient", value } },
      });
      const bindings = yield* makePluginKeyBindings(root, service);
      expect((yield* bindings.list(target, ["TOKEN"])).status).toBe("needs-key");
      yield* bindings.bind({ ...target, envName: "TOKEN", accountRef: accountTokenRef(accountId) });
      const eligibilityBeforeUse = pluginKeyAccountsEligibilityKey(yield* service.snapshot);
      expect((yield* bindings.list(target, ["TOKEN"])).status).toBe("ready");
      expect(pluginKeyAccountsEligibilityKey(yield* service.snapshot)).toBe(eligibilityBeforeUse);
      expect(
        (yield* bindings.list({ ...target, agent: ProviderInstanceId.make("other-agent") }, [
          "TOKEN",
        ])).status,
      ).toBe("needs-key");
      expect((yield* bindings.list(target, undefined)).status).toBe("needs-key");
      const text = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, PLUGIN_KEY_STATE_FILE), "utf8"),
      );
      expect(text.includes(value)).toBe(false);
      const reopened = yield* makePluginKeyBindings(root, service);
      expect((yield* reopened.list(target, ["TOKEN"])).status).toBe("ready");
      yield* service.setAgentAccess(false);
      expect((yield* reopened.list(target, ["TOKEN"])).status).toBe("needs-key");
      yield* service.setAgentAccess(true);
      yield* service.setControls({ target: { type: "account", accountId }, access: "off" });
      expect((yield* reopened.list(target, ["TOKEN"])).status).toBe("needs-key");
      yield* service.setControls({
        target: { type: "account", accountId },
        access: "ask",
        scope: { type: "projects", projectIds: [target.projectId] },
      });
      expect((yield* reopened.list(target, ["TOKEN"])).status).toBe("ready");
      expect(
        (yield* reopened.list({ ...target, projectId: ProjectId.make("other-project") }, ["TOKEN"]))
          .status,
      ).toBe("needs-key");
      yield* service.save({
        accountId,
        name: "Synthetic key",
        details: { kind: "api-key", sites: [], auth: { type: "bearer" } },
        secrets: { token: { type: "clear" } },
      });
      expect((yield* reopened.list(target, ["TOKEN"])).status).toBe("needs-key");
      yield* service.remove(accountId);
      expect((yield* reopened.list(target, ["TOKEN"])).status).toBe("needs-key");
      yield* reopened.unbind({ ...target, envName: "TOKEN" });
      expect((yield* reopened.list(target, ["TOKEN"])).keys[0]?.accountRef).toBeUndefined();
    }),
);

it.effect("refuses overwriting corrupt or newer state, and rejects non-account references", () =>
  Effect.gen(function* () {
    const root = yield* directory;
    const { service } = yield* makeHarness();
    const original = '{"formatVersion":99,"bindings":[]}';
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(root, PLUGIN_KEY_STATE_FILE), original),
    );
    const bindings = yield* makePluginKeyBindings(root, service);
    expect((yield* bindings.list(target, [])).status).toBe("needs-key");
    expect((yield* bindings.unbind({ ...target, envName: "TOKEN" }).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect(
      (yield* bindings
        .bind({ ...target, envName: "TOKEN", accountRef: VaultSecretRef.make("not-an-account") })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(
      yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(root, PLUGIN_KEY_STATE_FILE), "utf8"),
      ),
    ).toBe(original);
  }),
);

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OmpSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import { checkOmpProviderStatus } from "../Layers/OmpProvider.ts";

describe("real OMP qualification", () => {
  it.effect("discovers a pinned executable when explicitly requested", () =>
    Effect.gen(function* () {
      const binary = process.env.OMP_QUALIFY_BINARY;
      if (!binary) return;
      const home = NodePath.join(NodeOS.tmpdir(), `scient-omp-real-${process.pid}`);
      NodeFS.rmSync(home, { recursive: true, force: true });
      NodeFS.mkdirSync(home, { recursive: true });
      const settings = OmpSettings.make({
        enabled: true,
        binaryPath: binary,
        homePath: "",
        profile: "",
      });
      const result = yield* checkOmpProviderStatus(
        settings,
        { ...process.env, HOME: home, PI_CODING_AGENT_DIR: NodePath.join(home, "agent") },
        undefined,
        home,
      );
      expect(result.status).toBe("ready");
      expect(result.models.length).toBeGreaterThan(0);
      NodeFS.rmSync(home, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("starts and stops a real isolated OMP session", () =>
    Effect.gen(function* () {
      const binary = process.env.OMP_QUALIFY_BINARY;
      if (!binary) return;
      const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-adapter-real-${process.pid}`);
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.mkdirSync(root, { recursive: true });
      const environment = {
        ...process.env,
        HOME: NodePath.join(root, "home"),
        PI_CODING_AGENT_DIR: NodePath.join(root, "home", "agent"),
      };
      NodeFS.mkdirSync(environment.HOME, { recursive: true });
      const adapter = yield* makeOmpAdapter({
        binaryPath: binary,
        providerInstanceId: ProviderInstanceId.make("omp-real-smoke"),
        stateDir: NodePath.join(root, "state"),
        attachmentsDir: NodePath.join(root, "attachments"),
        environment,
      });
      const threadId = ThreadId.make("real-omp-thread");
      const session = yield* adapter.startSession({
        threadId,
        cwd: root,
        runtimeMode: "full-access",
      });
      expect(session.status).toBe("ready");
      yield* adapter.stopAll();
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { DroidSettings } from "@t3tools/contracts";

import {
  buildInitialDroidProviderSnapshot,
  checkDroidProviderStatus,
  isDroidAuthenticationRequiredError,
} from "./DroidProvider.ts";

const decodeDroidSettings = Schema.decodeSync(DroidSettings);
describe("buildInitialDroidProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDroidProviderSnapshot(
        decodeDroidSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a disabled snapshot by default — Droid is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDroidProviderSnapshot(decodeDroidSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDroidProviderSnapshot(
        decodeDroidSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Droid");
    }),
  );

  it.effect("keeps configured but unobserved custom-model capabilities unknown", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDroidProviderSnapshot(
        decodeDroidSettings({ enabled: true, customModels: ["custom:model"] }),
      );
      expect(snapshot.models[0]?.slug).toBe("custom:model");
      expect(snapshot.models[0]?.capabilities).toBeNull();
    }),
  );
});

it.layer(NodeServices.layer)("checkDroidProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDroidProviderStatus(
        decodeDroidSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/droid-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken droid install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-droid-version-" });
          const droidPath = path.join(dir, "droid");
          yield* fs.writeFileString(
            droidPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(droidPath, 0o755);

          return yield* checkDroidProviderStatus(
            decodeDroidSettings({ enabled: true, binaryPath: droidPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Droid CLI is installed but failed to run.");
      // CLI stderr must never leak into the user-facing snapshot message.
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports an error status when ACP startup fails without an auth signal", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-droid-acp-fail-" });
          const droidPath = path.join(dir, "droid");
          // A version-healthy binary that is not a real ACP agent: the probe
          // fails at startup with no "authentication required" anywhere.
          yield* fs.writeFileString(
            droidPath,
            ["#!/bin/sh", 'printf "droid-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(droidPath, 0o755);

          return yield* checkDroidProviderStatus(
            decodeDroidSettings({ enabled: true, binaryPath: droidPath }),
          );
        }),
      );

      // The fake binary prints a version but is not a real ACP agent, so the
      // probe fails at startup: error status, honest message — and crucially
      // NOT an unauthenticated verdict.
      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.0.99");
      expect(snapshot.message).toContain("ACP startup");
      expect(snapshot.auth.status).not.toBe("unauthenticated");
    }),
  );
});

describe("isDroidAuthenticationRequiredError", () => {
  it("matches the scoped authentication-required signal", () => {
    // The exact wire failure observed from `@factory/cli` on session/new.
    assert.isTrue(
      isDroidAuthenticationRequiredError({
        code: -32000,
        errorMessage: "Authentication required. Please log in.",
      }),
    );
    assert.isTrue(isDroidAuthenticationRequiredError(new Error("authentication required")));
  });

  it("rejects generic -32000 server errors and unrelated failures", () => {
    // -32000 is a generic server-error range: code alone is not an auth
    // signal (regression guard for the original over-broad classifier).
    assert.isFalse(
      isDroidAuthenticationRequiredError({ code: -32000, errorMessage: "internal error" }),
    );
    assert.isFalse(isDroidAuthenticationRequiredError({ code: -32602 }));
    assert.isFalse(isDroidAuthenticationRequiredError(new Error("spawn ENOENT")));
    assert.isFalse(isDroidAuthenticationRequiredError(undefined));
  });
});

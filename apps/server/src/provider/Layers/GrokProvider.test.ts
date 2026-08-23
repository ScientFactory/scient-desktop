// @effect-diagnostics nodeBuiltinImport:off -- Import-meta fixture resolution is test-only; provider runtime paths use Effect Path.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@t3tools/contracts";

import { buildInitialGrokProviderSnapshot, checkGrokProviderStatus } from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

const makeMockGrok = Effect.fn("GrokProvider.test.makeMockGrok")(function* (
  authState:
    | "account"
    | "account-no-metadata"
    | "account-stale-subscription"
    | "api_key"
    | "unauthenticated",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-grok-probe-" });
  const executable = path.join(dir, "grok");
  const requestLog = path.join(dir, "requests.jsonl");
  yield* fs.writeFileString(
    executable,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  printf "grok 1.0.5\\n"',
      "  exit 0",
      "fi",
      `exec "${process.execPath}" "${mockAgentPath}" "$@"`,
      "",
    ].join("\n"),
  );
  yield* fs.chmod(executable, 0o755);
  return {
    executable,
    requestLog,
    environment: {
      T3_ACP_GROK_PROBE_AUTH_STATE: authState,
      T3_ACP_REQUEST_LOG_PATH: requestLog,
      ...(authState === "api_key" ? { XAI_API_KEY: "synthetic-test-key" } : {}),
    },
  };
});

describe("buildInitialGrokProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a disabled snapshot by default — Grok is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(decodeGrokSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Grok");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
    }),
  );
});

it.layer(NodeServices.layer)("checkGrokProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/grok-binary",
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
      const secretStderr = "broken grok install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-version-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Grok CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-success-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", 'printf "grok-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build"]);
      expect(snapshot.message).toContain("local agent did not start");
    }),
  );

  it.effect(
    "discovers models and subscription metadata without authenticating or creating a session",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const mock = yield* makeMockGrok("account");
          const snapshot = yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: mock.executable }),
            mock.environment,
          );

          expect(snapshot.status).toBe("ready");
          expect(snapshot.version).toBe("1.0.5");
          expect(snapshot.auth).toEqual({
            status: "authenticated",
            required: true,
            type: "grok_account",
            label: "SuperGrok",
            email: "scientist@example.com",
          });
          expect(snapshot.models.map((model) => model.slug)).toEqual([
            "grok-build",
            "grok-mock-alt",
          ]);

          const methods = (yield* fs.readFileString(mock.requestLog))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { readonly method?: string })
            .flatMap((entry) => (entry.method ? [entry.method] : []));
          expect(methods).toContain("initialize");
          expect(methods).toContain("_x.ai/auth/info");
          expect(methods).toContain("_x.ai/auth/check_subscription");
          expect(methods).not.toContain("authenticate");
          expect(methods).not.toContain("session/new");
        }),
      ),
  );

  it.effect("reports an installed account flow as unauthenticated without opening it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = yield* makeMockGrok("unauthenticated");
        const snapshot = yield* checkGrokProviderStatus(
          decodeGrokSettings({ enabled: true, binaryPath: mock.executable }),
          mock.environment,
        );

        expect(snapshot.status).toBe("warning");
        expect(snapshot.auth).toEqual({
          status: "unauthenticated",
          required: true,
          type: "grok_account",
        });
        expect(snapshot.message).toContain("Sign in to Grok");
      }),
    ),
  );

  it.effect(
    "keeps a confirmed account ready when optional subscription metadata is unavailable",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const mock = yield* makeMockGrok("account-no-metadata");
          const snapshot = yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: mock.executable }),
            mock.environment,
          );

          expect(snapshot.status).toBe("ready");
          expect(snapshot.auth).toEqual({
            status: "authenticated",
            required: true,
            type: "grok_account",
            label: "Grok subscription",
          });
        }),
      ),
  );

  it.effect("keeps API-key readiness distinct from a connected subscription", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = yield* makeMockGrok("api_key");
        const snapshot = yield* checkGrokProviderStatus(
          decodeGrokSettings({ enabled: true, binaryPath: mock.executable }),
          mock.environment,
        );

        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth).toEqual({
          status: "authenticated",
          required: true,
          type: "api_key",
          label: "xAI API key",
        });
      }),
    ),
  );

  it.effect("ignores stale subscription metadata when Grok reports it as unauthenticated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = yield* makeMockGrok("account-stale-subscription");
        const snapshot = yield* checkGrokProviderStatus(
          decodeGrokSettings({ enabled: true, binaryPath: mock.executable }),
          mock.environment,
        );

        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth).toEqual({
          status: "authenticated",
          required: true,
          type: "grok_account",
          label: "Grok subscription",
          email: "current@example.com",
        });
      }),
    ),
  );

  it.effect("handles concurrent safe readiness probes without starting any session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = yield* makeMockGrok("account");
        const snapshots = yield* Effect.forEach(
          Array.from({ length: 6 }),
          () =>
            checkGrokProviderStatus(
              decodeGrokSettings({ enabled: true, binaryPath: mock.executable }),
              mock.environment,
            ),
          { concurrency: "unbounded" },
        );

        expect(snapshots).toHaveLength(6);
        expect(snapshots.every((snapshot) => snapshot.status === "ready")).toBe(true);
        expect(snapshots.every((snapshot) => snapshot.auth.email === "scientist@example.com")).toBe(
          true,
        );
      }),
    ),
  );
});

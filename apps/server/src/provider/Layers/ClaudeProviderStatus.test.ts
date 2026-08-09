import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it.layer(NodeServices.layer)("Claude provider account status", (it) => {
  it.effect("does not treat SDK model discovery as authentication when Claude is logged out", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-claude-auth-status-" });
      const executablePath = path.join(tempDir, "fake-claude.mjs");

      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          "const args = process.argv.slice(2);",
          'if (args.length === 1 && args[0] === "--version") {',
          '  process.stdout.write("2.1.170\\n");',
          "  process.exit(0);",
          "}",
          'if (args.join(" ") === "auth status --json") {',
          "  process.stdout.write(JSON.stringify({ loggedIn: false }));",
          "  process.exit(1);",
          "}",
          "process.exit(2);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      let capabilityProbeCalled = false;
      const snapshot = yield* checkClaudeProviderStatus(
        decodeClaudeSettings({ binaryPath: executablePath }),
        () => {
          capabilityProbeCalled = true;
          return Effect.succeed({
            email: "wrong@example.com",
            subscriptionType: "pro",
            tokenSource: "oauth",
            apiProvider: "firstParty",
            slashCommands: [],
          });
        },
        process.env,
        tempDir,
      );

      assert.equal(capabilityProbeCalled, false);
      assert.equal(snapshot.installed, true);
      assert.equal(snapshot.status, "warning");
      assert.deepEqual(snapshot.auth, {
        status: "unauthenticated",
        required: true,
      });
      assert.deepEqual(snapshot.models, []);
      assert.equal(snapshot.message, "Claude is installed but not signed in.");
    }).pipe(Effect.scoped),
  );

  it.effect("preserves T3's SDK-derived readiness for an explicit API configuration", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-claude-api-status-" });
      const executablePath = path.join(tempDir, "fake-claude.mjs");

      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          "const args = process.argv.slice(2);",
          'if (args.length === 1 && args[0] === "--version") {',
          '  process.stdout.write("2.1.170\\n");',
          "  process.exit(0);",
          "}",
          // An explicit API configuration must not invoke first-party auth status.
          "process.exit(2);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      let capabilityProbeCalled = false;
      const snapshot = yield* checkClaudeProviderStatus(
        decodeClaudeSettings({ binaryPath: executablePath }),
        () => {
          capabilityProbeCalled = true;
          return Effect.succeed({
            email: undefined,
            subscriptionType: undefined,
            tokenSource: undefined,
            apiProvider: "firstParty",
            slashCommands: [],
          });
        },
        { ...process.env, ANTHROPIC_API_KEY: "configured-for-test" },
        tempDir,
      );

      assert.equal(capabilityProbeCalled, true);
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "authenticated");
      assert.equal(snapshot.models.length > 0, true);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a confirmed account distinct from a failed readiness probe", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-claude-model-status-" });
      const executablePath = path.join(tempDir, "fake-claude.mjs");

      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          "const args = process.argv.slice(2);",
          'if (args.length === 1 && args[0] === "--version") {',
          '  process.stdout.write("2.1.170\\n");',
          "  process.exit(0);",
          "}",
          'if (args.join(" ") === "auth status --json") {',
          "  process.stdout.write(JSON.stringify({ loggedIn: true }));",
          "  process.exit(0);",
          "}",
          "process.exit(2);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      const snapshot = yield* checkClaudeProviderStatus(
        decodeClaudeSettings({ binaryPath: executablePath }),
        () => Effect.succeed(undefined),
        process.env,
        tempDir,
      );

      assert.equal(snapshot.status, "warning");
      assert.deepEqual(snapshot.auth, { status: "authenticated", required: true });
      assert.equal(
        snapshot.models.some((model) => model.slug === "claude-fable-5"),
        true,
      );
      assert.equal(
        snapshot.models.some((model) => model.slug === "default"),
        false,
      );
      assert.equal(
        snapshot.message,
        "Claude is signed in, but Scient could not complete its readiness check.",
      );
    }).pipe(Effect.scoped),
  );
});

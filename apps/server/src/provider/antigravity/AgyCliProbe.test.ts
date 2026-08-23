/**
 * Optional, no-prompt integration check against an installed Antigravity CLI.
 * Enable with `T3_ANTIGRAVITY_CLI_PROBE=1`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AntigravitySettings } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import { checkAntigravityProviderStatus } from "../Layers/AntigravityProvider.ts";
import { ANTIGRAVITY_WORKSPACE_TOOL_INSTRUCTIONS } from "../Layers/AntigravityAdapter.ts";
import { officialAntigravityAccountEnvironment } from "../../scient/providerLifecycle/AntigravityConnectionActions.ts";
import { makeAgySession, type AgySessionEvent } from "./AgySession.ts";

const decodeSettings = Schema.decodeSync(AntigravitySettings);

describe.runIf(process.env.T3_ANTIGRAVITY_CLI_PROBE === "1")("Antigravity CLI probe", () => {
  it.effect("discovers the installed version, account, and models without sending a prompt", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAntigravityProviderStatus(
        decodeSettings({ enabled: true, binaryPath: "agy" }),
        officialAntigravityAccountEnvironment(process.env),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toMatch(/\d+\.\d+\.\d+/);
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const LiveStructuredAnswer = Schema.Struct({ answer: Schema.String });
const decodeLiveStructuredAnswer = Schema.decodeUnknownSync(LiveStructuredAnswer);

describe.runIf(process.env.T3_ANTIGRAVITY_LIVE_TURN_PROBE === "1")(
  "Antigravity live turn probe",
  () => {
    it.effect("keeps an account-backed structured conversation warm across turns", () =>
      Effect.gen(function* () {
        const session = yield* makeAgySession({
          binaryPath: "agy",
          cwd: process.cwd(),
          environment: officialAntigravityAccountEnvironment(process.env),
          model: "gemini-3.7-flash",
          effort: "low",
          runtimeMode: "approval-required",
          printTimeout: "2m",
          jsonSchema:
            '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}',
        });
        const first = yield* session.prompt({
          text: 'Return exactly the value "alpha" in the answer field.',
        });
        const second = yield* session.prompt({
          text: "Return the answer value from the previous turn in the answer field.",
        });

        expect(first.status).toBe("success");
        expect(second.status).toBe("success");
        expect(first.conversationId).toBe(second.conversationId);
        expect(decodeLiveStructuredAnswer(first.structuredOutput).answer).toBe("alpha");
        expect(decodeLiveStructuredAnswer(second.structuredOutput).answer).toBe("alpha");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect.each([1, 2, 3])("executes and reports a harmless tool call (attempt $0)", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "scient-antigravity-live-tool-",
        });
        const session = yield* makeAgySession({
          binaryPath: "agy",
          cwd,
          environment: officialAntigravityAccountEnvironment(process.env),
          model: "gemini-3.7-flash",
          effort: "low",
          runtimeMode: "full-access",
          printTimeout: "2m",
        });
        const events: AgySessionEvent[] = [];
        const result = yield* session.prompt({
          text: `${ANTIGRAVITY_WORKSPACE_TOOL_INSTRUCTIONS.trim()}\n\nCreate a file named "agy-tool-probe.txt" in the current directory containing exactly "scient-tool-ok". Use the run_command shell tool to create it, then reply briefly.`,
          onEvent: (event) => Effect.sync(() => events.push(event)),
        });

        expect(result.status, result.error).toBe("success");
        expect(
          (yield* fileSystem.readFileString(path.join(cwd, "agy-tool-probe.txt"))).trim(),
        ).toBe("scient-tool-ok");
        expect(events.some((event) => event._tag === "ToolCall")).toBe(true);
        expect(events.some((event) => event._tag === "ToolCallUpdate")).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);

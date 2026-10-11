import { assert, it } from "@effect/vitest";
import {
  NodeId,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { ProviderAdapterTurnStartError } from "@t3tools/provider-core/server/ProviderAdapter";
import { OpenCodeSettings } from "@t3tools/provider-opencode/settings";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import {
  buildOpenCodeRuntimeGuidance,
  mapOpenCodeTurnStartError,
  OpenCodeDriver,
} from "./OpenCodeDriverComposition.ts";
import { SCIENT_CORE_AWARENESS } from "./ScientAwareness.ts";

it("registers the app-composed OpenCode driver and keeps its provider settings", () => {
  const registered = BUILT_IN_DRIVERS.find(
    (driver) => driver.driverKind === ProviderDriverKind.make("opencode"),
  );
  assert.strictEqual(registered, OpenCodeDriver);
  assert.strictEqual(OpenCodeDriver.configSchema, OpenCodeSettings);
  assert.deepStrictEqual(OpenCodeDriver.defaultConfig(), {
    enabled: false,
    binaryPath: "opencode",
    serverUrl: "",
    serverPassword: "",
    customModels: [],
  });
});

it("builds per-session OpenCode prompt guidance from granted capabilities", () => {
  assert.strictEqual(buildOpenCodeRuntimeGuidance(), SCIENT_CORE_AWARENESS);
  const noTools = buildOpenCodeRuntimeGuidance(new Set());
  assert.notInclude(noTools, "## Scient browser");
  assert.notInclude(noTools, "## Scient skills");
  const granted = buildOpenCodeRuntimeGuidance(new Set(["preview", "skills:read"]));
  assert.include(granted, "## Scient browser");
  assert.include(granted, "## Scient skills");
});

it("preserves an OpenCode native turn receipt through app start-error mapping", () => {
  const driver = ProviderDriverKind.make("opencode");
  const threadId = ThreadId.make("thread:opencode-receipt");
  const providerThreadId = ProviderThreadId.make("provider-thread:opencode-receipt");
  const runId = RunId.make("run:opencode-receipt");
  const providerThread = Schema.decodeUnknownSync(OrchestrationV2ProviderThread)({
    id: providerThreadId,
    driver,
    providerInstanceId: ProviderInstanceId.make("opencode"),
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: DateTime.makeUnsafe("2026-10-09T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-09T00:00:00.000Z"),
  });
  const receipt = Schema.decodeUnknownSync(OrchestrationV2ProviderTurn)({
    id: ProviderTurnId.make("provider-turn:opencode-receipt"),
    providerThreadId,
    nodeId: NodeId.make("node:opencode-receipt"),
    runAttemptId: RunAttemptId.make("attempt:opencode-receipt"),
    nativeTurnRef: null,
    ordinal: 1,
    status: "running",
    nativeAcceptance: "accepted",
    startedAt: null,
    completedAt: null,
  });
  const nativeError = new ProviderAdapterTurnStartError({
    driver,
    threadId,
    providerThreadId,
    runId,
    providerTurn: receipt,
  });

  const mapped = mapOpenCodeTurnStartError({ threadId, providerThread, runId }, nativeError);
  assert.strictEqual(mapped, nativeError);
  assert.deepStrictEqual(mapped.providerTurn, receipt);
});

import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  EnvironmentId,
  ExtensionsError,
  PreviewAutomationExecutionError,
  PreviewAutomationTimeoutError,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { McpSchema } from "effect/ai";
import * as Effect from "effect/Effect";
import type { CDPSession } from "playwright-core";

import * as ServerBrowserPage from "../preview/ServerBrowserPage.ts";

import { toAccountsError } from "../scient/accounts/agent/connectorAuthoring.ts";

import {
  BrowserToolCallLedger,
  closedErrorCode,
  noteToolFailure,
  refusedDelegateTarget,
  scientMcpAnalyticsInput,
  scientToolOutcome,
  type ToolFailureFacts,
  ToolFailureNote,
} from "./ScientMcpAnalytics.ts";
import { toolOutcome } from "./ProviderDimensions.ts";

describe("Scient MCP analytics input", () => {
  it("retains metric identifiers and decodes the declared JSON-text result", () => {
    const input = scientMcpAnalyticsInput(
      "scient_thread_transfer",
      new McpSchema.CallToolResult({
        content: [{ type: "text", text: '{"targetThreadId":"synthetic-child"}' }],
      }),
    );
    expect(input.tool).toBe("t3_thread_transfer");
    expect(input.result?.structuredContent).toEqual({ targetThreadId: "synthetic-child" });
  });

  it("preserves failure codes without treating declared failures as successful handoffs", () => {
    const input = scientMcpAnalyticsInput(
      "scient_queue",
      new McpSchema.CallToolResult({
        isError: true,
        content: [
          { type: "text", text: '{"_tag":"OrchestratorMcpFailure","code":"capability_denied"}' },
        ],
      }),
    );
    expect(toolOutcome(input.result)).toEqual({
      outcome: "error",
      errorCode: "capability_denied",
    });
  });

  it("leaves structured results, plain text, multi-part content, and exceptions unchanged", () => {
    for (const result of [
      undefined,
      new McpSchema.CallToolResult({
        structuredContent: { sequence: 1 },
        content: [{ type: "text", text: '{"sequence":2}' }],
      }),
      new McpSchema.CallToolResult({ content: [{ type: "text", text: "not json" }] }),
      new McpSchema.CallToolResult({
        content: [
          { type: "text", text: "{}" },
          { type: "text", text: "{}" },
        ],
      }),
    ]) {
      expect(scientMcpAnalyticsInput("delegate_task", result)).toEqual({
        tool: "delegate_task",
        result,
      });
    }
  });

  it.each([
    ["PreviewAutomationTimeoutError", "timeout"],
    ["PreviewAutomationNoAvailableHostError", "no_host"],
    ["McpCapabilityUnavailableError", "mcp_capability_unavailable"],
    ["capability_denied", "capability_denied"],
    ["build-failed", "build_failed"],
    [`${"Very".repeat(20)}LongError`, "very_".repeat(9) + "ver"],
  ])("closes the failure name %s as %s", (name, code) => {
    expect(closedErrorCode(name)).toBe(code);
  });

  it("names a failure from its top-level tag or the call's failure note, never its message", () => {
    const tagged = scientMcpAnalyticsInput(
      "preview_act",
      new McpSchema.CallToolResult({
        isError: true,
        content: [
          { type: "text", text: '{"_tag":"PreviewAutomationInvalidSelectorError","selector":"x"}' },
        ],
      }),
    );
    expect(scientToolOutcome(tagged.result)).toEqual({
      outcome: "error",
      errorCode: "invalid_selector",
      failureOwner: "input",
    });
    const messageOnly = new McpSchema.CallToolResult({
      isError: true,
      content: [{ type: "text", text: "Preview automation timed out after 5000ms." }],
    });
    expect(scientToolOutcome(messageOnly)).toEqual({
      outcome: "error",
      errorCode: "unknown",
      failureOwner: "unknown",
    });
    expect(
      scientToolOutcome(messageOnly, {
        tag: "PreviewAutomationTimeoutError",
        failureClass: "timeout",
      }),
    ).toEqual({
      outcome: "error",
      errorCode: "timeout",
      failureClass: "timeout",
      failureOwner: "unknown",
    });
    expect(scientToolOutcome(undefined, { tag: "Ignored" })).toEqual({
      outcome: "error",
      errorCode: "exception",
      failureOwner: "scient",
    });
    expect(
      scientToolOutcome(
        new McpSchema.CallToolResult({ structuredContent: { _tag: "Ready" }, content: [] }),
      ),
    ).toEqual({ outcome: "ok" });
  });

  effectIt.effect(
    "tells a page that never got ready from a host that never answered, and leaves evaluate failures unowned",
    () =>
      Effect.gen(function* () {
        const request = {
          environmentId: EnvironmentId.make("analytics-environment"),
          threadId: ThreadId.make("analytics-thread"),
          clientId: "server-browser",
          connectionId: "analytics-connection",
          requestId: "preview-1",
          timeoutMs: 15_000,
        };
        const answered = {
          remoteTag: "PreviewAutomationTimeoutError",
          remoteMessageLength: 0,
          cause: null,
        };
        const messageOnly = new McpSchema.CallToolResult({
          isError: true,
          content: [{ type: "text", text: "A browser failure written for the agent." }],
        });
        const recorded = Effect.fn(function* (error: unknown) {
          const facts: ToolFailureFacts = {};
          yield* noteToolFailure(error).pipe(Effect.provideService(ToolFailureNote, facts));
          return scientToolOutcome(messageOnly, facts);
        });
        expect(
          yield* recorded(
            new PreviewAutomationTimeoutError({ ...request, ...answered, operation: "click" }),
          ),
        ).toEqual({
          outcome: "error",
          errorCode: "timeout",
          failureClass: "page_not_ready",
          failureOwner: "external",
        });
        expect(
          yield* recorded(new PreviewAutomationTimeoutError({ ...request, operation: "click" })),
        ).toEqual({
          outcome: "error",
          errorCode: "timeout",
          failureClass: "host_overrun",
          failureOwner: "scient",
        });
        // A script that threw and a browser call that failed reach analytics with the same tag.
        const evaluated = (send: () => Promise<unknown>) =>
          Effect.promise(() =>
            ServerBrowserPage.evaluate(
              { send } as unknown as CDPSession,
              { expression: "1 + 1" },
              1_000,
            ).then(
              () => undefined,
              (cause: unknown) => ServerBrowserPage.toOperationError(cause),
            ),
          );
        for (const failure of [
          yield* evaluated(async () => ({
            result: { type: "object" },
            exceptionDetails: { text: "Uncaught", exception: { description: "Error: thrown" } },
          })),
          yield* evaluated(async () => {
            throw new Error("Protocol error (Runtime.evaluate): Session closed.");
          }),
        ]) {
          expect(
            yield* recorded(
              new PreviewAutomationExecutionError({
                ...request,
                remoteTag: failure!.tag,
                remoteMessageLength: failure!.message.length,
                cause: failure,
                operation: "evaluate",
              }),
            ),
          ).toEqual({ outcome: "error", errorCode: "execution", failureOwner: "unknown" });
        }
      }),
  );

  effectIt.effect(
    "keeps a connector tool's own reason through the Accounts failure it travels in",
    () =>
      Effect.gen(function* () {
        const facts: ToolFailureFacts = {};
        const unreachable = toAccountsError(
          new ExtensionsError({ reason: "unreachable", message: "The service did not answer." }),
        );
        yield* noteToolFailure(unreachable).pipe(Effect.provideService(ToolFailureNote, facts));
        const result = new McpSchema.CallToolResult({
          isError: true,
          content: [{ type: "text", text: unreachable.message }],
        });
        // regression: every connector failure read as `accounts`, owner unknown.
        expect(scientToolOutcome(result, facts)).toEqual({
          outcome: "error",
          errorCode: "accounts",
          failureClass: "unreachable",
          failureOwner: "external",
        });
      }),
  );

  it("counts a thread's browser calls up to its turn's end and keeps later ones for the next", () => {
    const ledger = new BrowserToolCallLedger();
    ledger.record("thread-a", 10, false);
    ledger.record("thread-a", 20, true);
    ledger.record("thread-b", 15, true);
    ledger.record("thread-a", 40, false);
    expect(ledger.take("thread-a", 30)).toEqual({ calls: 2, failures: 1 });
    expect(ledger.take("thread-a", 50)).toEqual({ calls: 1, failures: 0 });
    expect(ledger.take("thread-a", 50)).toEqual({ calls: 0, failures: 0 });
    expect(ledger.take("thread-b", 50)).toEqual({ calls: 1, failures: 1 });
  });

  it("reports a refused delegation's target as a driver and a reviewed model name only", () => {
    const providers = [
      {
        instanceId: ProviderInstanceId.make("scient-work"),
        driver: ProviderDriverKind.make("scient"),
        models: [],
      } as unknown as ServerProvider,
    ];
    const failed = { outcome: "error" };
    const target = (value: object) =>
      refusedDelegateTarget(
        "delegate_task",
        { task: "Private task", target: value },
        failed,
        providers,
      );
    expect(target({ providerInstanceId: "scient-work", model: "openai-codex/gpt-6-luna" })).toEqual(
      {
        targetProvider: "scient",
        targetModel: "gpt-6-luna",
      },
    );
    // A user's own model name never leaves the computer.
    expect(target({ providerInstanceId: "scient-work", model: "acme-private-7b" })).toEqual({
      targetProvider: "scient",
      targetModel: "other",
    });
    expect(target({ providerInstanceId: "missing" })).toEqual({ targetProvider: "unknown" });
    expect(
      refusedDelegateTarget(
        "delegate_task",
        { target: { model: "gpt-6-luna" } },
        { outcome: "ok" },
        providers,
      ),
    ).toEqual({});
  });
});

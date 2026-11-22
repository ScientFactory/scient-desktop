import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  AccountsError,
  EnvironmentId,
  ExtensionsError,
  OrchestratorMcpFailure,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
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
  browserTurnSummary,
  closedErrorCode,
  noteToolFailure,
  recordBrowserCall,
  refusedDelegateTarget,
  scientMcpAnalyticsInput,
  scientToolOutcome,
  type ToolFailureFacts,
  ToolFailureNote,
  withFailureClass,
  withRemoteFailureClass,
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

  // SCIENT-FORK:START — exact owners for failures whose cause the code alone proves.
  it("gives exact owners to merged or hostless pull requests, oversized results and a browser still installing", () => {
    const failed = new McpSchema.CallToolResult({
      isError: true,
      content: [{ type: "text", text: "refused" }],
    });
    const owner = (tag: string, failureClass?: string) =>
      scientToolOutcome(failed, { tag, ...(failureClass === undefined ? {} : { failureClass }) })
        .failureOwner;
    expect(owner("PullRequestNotOpenError")).toBe("input");
    expect(owner("PullRequestHostRequiredError")).toBe("input");
    expect(owner("PreviewAutomationResultTooLargeError")).toBe("input");
    expect(owner("orchestration_error", "preview_browser_installing")).toBe("scient");
    // A class's owner still wins over a code's, and other codes keep their pattern owner.
    expect(owner("PreviewAutomationTimeoutError", "page_not_ready")).toBe("external");
    expect(owner("orchestration_error")).toBe("unknown");
  });
  // SCIENT-FORK:END

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
        expect(
          yield* recorded(
            new PreviewAutomationTimeoutError({
              ...request,
              operation: "snapshot",
              pendingStages: ["page state"],
            }),
          ),
        ).toMatchObject({ failureClass: "host_overrun", pendingStage: "page_state" });
        // A tab a person took over is not the agent's fault; a stale element ref is its input.
        expect(
          yield* recorded(
            new PreviewAutomationControlInterruptedError({
              ...request,
              ...answered,
              operation: "click",
              reason: "humanControl",
            }),
          ),
        ).toMatchObject({ failureClass: "control_human_control", failureOwner: "external" });
        expect(
          yield* recorded(
            new PreviewAutomationInvalidSelectorError({
              ...request,
              ...answered,
              operation: "click",
              staleRef: true,
            }),
          ),
        ).toMatchObject({
          errorCode: "invalid_selector",
          failureClass: "stale_ref",
          failureOwner: "input",
        });
        // A script that threw and a browser call that failed share a tag; only the page's own
        // exception report, carried as a fixed detail, makes the failure the caller's code.
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
        const throwing = yield* evaluated(async () => ({
          result: { type: "object" },
          exceptionDetails: { text: "Uncaught", exception: { description: "Error: thrown" } },
        }));
        const broken = yield* evaluated(async () => {
          throw new Error("Protocol error (Runtime.evaluate): Session closed.");
        });
        const asBrokerSees = (failure: NonNullable<typeof throwing>) =>
          withRemoteFailureClass(
            new PreviewAutomationExecutionError({
              ...request,
              remoteTag: failure.tag,
              remoteMessageLength: failure.message.length,
              cause: failure,
              operation: "evaluate",
            }),
            { _tag: failure.tag, detail: failure.detail },
          );
        expect(yield* recorded(asBrokerSees(throwing!))).toEqual({
          outcome: "error",
          errorCode: "execution",
          failureClass: "script_exception",
          failureOwner: "code",
        });
        expect(yield* recorded(asBrokerSees(broken!))).toEqual({
          outcome: "error",
          errorCode: "execution",
          failureOwner: "unknown",
        });
        // A look-alike detail from any other failure is ignored.
        expect(
          yield* recorded(
            withRemoteFailureClass(
              new PreviewAutomationExecutionError({ ...request, ...answered, operation: "click" }),
              {
                _tag: "PreviewAutomationTimeoutError",
                detail: { failureClass: "script_exception" },
              },
            ),
          ),
        ).toMatchObject({ failureOwner: "unknown" });
        const execution = (detail: unknown) =>
          recorded(
            withRemoteFailureClass(
              new PreviewAutomationExecutionError({
                ...request,
                ...answered,
                operation: "navigate",
              }),
              { _tag: "PreviewAutomationExecutionError", detail },
            ),
          );
        expect(yield* execution({ failureClass: "navigation_network", url: "x" })).toMatchObject({
          failureClass: "navigation_network",
          failureOwner: "external",
        });
        // A frameless screenshot keeps its reason but no owner; an unlisted reason is dropped.
        expect(yield* execution({ failureClass: "screenshot_no_frames" })).toMatchObject({
          failureClass: "screenshot_no_frames",
          failureOwner: "unknown",
        });
        expect(yield* execution({ failureClass: "page text" })).not.toHaveProperty("failureClass");
      }),
  );

  // SCIENT-FORK:START — broad failures that keep a specific cause, and Accounts' own reasons.
  effectIt.effect("attributes a broad failure by the specific cause it was built from", () =>
    Effect.gen(function* () {
      const failed = new McpSchema.CallToolResult({
        isError: true,
        content: [{ type: "text", text: "refused" }],
      });
      const recorded = Effect.fn(function* (error: unknown) {
        const facts: ToolFailureFacts = {};
        yield* noteToolFailure(error).pipe(Effect.provideService(ToolFailureNote, facts));
        return scientToolOutcome(failed, facts);
      });
      const orchestrator = (
        code: "thread_not_sendable" | "orchestration_error" | "model_unavailable",
      ) => new OrchestratorMcpFailure({ code, message: "refused" });
      const owner = function* (error: unknown) {
        const outcome = yield* recorded(error);
        return [outcome.errorCode, outcome.failureClass, outcome.failureOwner];
      };
      expect(
        yield* owner(withFailureClass(orchestrator("thread_not_sendable"), "thread_archived")),
      ).toEqual(["thread_not_sendable", "thread_archived", "input"]);
      expect(
        yield* owner(withFailureClass(orchestrator("thread_not_sendable"), "no_steerable_run")),
      ).toEqual(["thread_not_sendable", "no_steerable_run", "input"]);
      expect(
        yield* owner(
          withFailureClass(orchestrator("orchestration_error"), "task_projection_missing"),
        ),
      ).toEqual(["orchestration_error", "task_projection_missing", "scient"]);
      expect(
        yield* owner(
          withFailureClass(orchestrator("orchestration_error"), "projection_load_failed"),
        ),
      ).toEqual(["orchestration_error", "projection_load_failed", "scient"]);
      expect(
        yield* owner(
          withFailureClass(orchestrator("model_unavailable"), "delegate_model_not_offered"),
        ),
      ).toEqual(["model_unavailable", "delegate_model_not_offered", "input"]);
      expect(
        yield* owner(
          withFailureClass(orchestrator("model_unavailable"), "delegate_model_needs_update"),
        ),
      ).toEqual(["model_unavailable", "delegate_model_needs_update", "environment"]);
      // Unmarked, the same broad failures stay unowned.
      expect(yield* owner(orchestrator("orchestration_error"))).toEqual([
        "orchestration_error",
        undefined,
        "unknown",
      ]);
      // Accounts: a connector's own class wins; otherwise its broad reason, and "unavailable"
      // (the browser or the Accounts store) stays unowned.
      const accounts = (reason: AccountsError["reason"]) =>
        new AccountsError({ reason, message: "refused" });
      expect(yield* owner(accounts("invalid-input"))).toEqual([
        "accounts",
        "accounts_invalid_input",
        "input",
      ]);
      expect(yield* owner(accounts("denied"))).toEqual([
        "accounts",
        "accounts_denied",
        "environment",
      ]);
      expect(yield* owner(accounts("unavailable"))).toEqual([
        "accounts",
        "accounts_unavailable",
        "unknown",
      ]);
      expect(
        (yield* recorded(
          new AccountsError({ reason: "unavailable", message: "x", failureClass: "unreachable" }),
        )).failureClass,
      ).toBe("unreachable");
    }),
  );
  // SCIENT-FORK:END

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
    const call = (at: number, failed: boolean) => ({
      at,
      tool: "preview_act",
      durationMs: 1,
      failed,
    });
    ledger.record("thread-a", call(10, false));
    ledger.record("thread-a", call(20, true));
    ledger.record("thread-b", call(15, true));
    ledger.record("thread-a", call(40, false));
    expect(ledger.take("thread-a", 30)).toMatchObject({ calls: 2, failures: 1 });
    expect(ledger.take("thread-a", 50)).toMatchObject({ calls: 1, failures: 0 });
    expect(ledger.take("thread-a", 50)).toMatchObject({ calls: 0, failures: 0 });
    expect(ledger.take("thread-b", 50)).toMatchObject({ calls: 1, failures: 1 });
  });

  it("summarizes a turn's browser work: tools, times, recovered failures and sites, hosts only", () => {
    const ledger = new BrowserToolCallLedger();
    const call = (
      tool: string,
      at: number,
      args: object,
      result: McpSchema.CallToolResult | undefined,
      failure: ToolFailureFacts = {},
    ) => {
      recordBrowserCall(ledger, "thread", {
        tool,
        args,
        result,
        failure,
        startedAt: at - 100 * (at / 10),
        endedAt: at,
      });
      return failure;
    };
    const ok = (structuredContent: object) =>
      new McpSchema.CallToolResult({ structuredContent, content: [] });
    const timedOut = new McpSchema.CallToolResult({
      isError: true,
      content: [{ type: "text", text: "timed out" }],
    });
    call(
      "preview_open",
      10,
      { url: "https://Example.org/private/path?q=1" },
      ok({
        url: "https://example.org/private/path?q=1",
      }),
    );
    const failed = call("preview_act", 20, { action: "click" }, timedOut, {
      tag: "PreviewAutomationTimeoutError",
    });
    call(
      "preview_act",
      30,
      { action: "click" },
      ok({ toolIcon: { pageUrl: "https://example.org/a" } }),
    );
    call(
      "preview_navigate",
      40,
      { url: "http://localhost:5173/" },
      ok({
        url: "http://localhost:5173/",
        loadError: { url: "http://localhost:5173/", code: -102, description: "refused" },
        accountsNote: "Sign in to continue.",
      }),
    );
    // The failure is reported with the site and action it worked on.
    expect(scientToolOutcome(timedOut, failed)).toMatchObject({
      errorCode: "timeout",
      site: "example.org",
      action: "click",
    });
    const summary = browserTurnSummary(ledger.take("thread", 50).entries);
    expect(summary).toMatchObject({
      calls: 4,
      failures: 1,
      recoveredFailures: 1,
      longestFailureStreak: 1,
      endedOnFailure: false,
      openCalls: 1,
      actCalls: 2,
      actFailures: 1,
      navigateCalls: 1,
      sites: ["example.org", "local"],
      failedSites: ["example.org"],
      errorCodes: ["timeout"],
      loadErrors: 1,
      loadErrorCodes: [-102],
      accountNotes: 1,
      maxMs: 400,
    });
    expect(JSON.stringify(summary)).not.toContain("private");
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

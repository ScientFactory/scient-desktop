import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import { assert, describe, it } from "@effect/vitest";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import {
  CLAUDE_TEST_MODEL_SELECTION,
  DEFAULT_CLAUDE_SETTINGS,
  AUTO_COMPACT_CLAUDE_SETTINGS,
} from "./ClaudeAdapterV2.fixture.ts";

describe("ClaudeAdapterV2 runtime query policy", () => {
  it.each([false, true])("requests thinking summaries with resume=%s", (resume) => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "thinking-thread",
      resume,
      cwd: "/workspace",
    });
    assert.deepEqual(options.thinking, { type: "adaptive", display: "summarized" });
    assert.equal(options.extraArgs?.["thinking-display"], "summarized");
    assert.include(options.settings, { showThinkingSummaries: true });
  });

  it("preserves an explicit omitted thinking display", () => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "thinking-thread",
      resume: false,
      cwd: "/workspace",
      settings: { ...DEFAULT_CLAUDE_SETTINGS, launchArgs: "--thinking-display omitted" },
    });
    assert.isUndefined(options.thinking);
    assert.equal(options.extraArgs?.["thinking-display"], "omitted");
    assert.notInclude(options.settings ?? {}, { showThinkingSummaries: true });
  });

  it("does not enable thinking when the model option disables it", () => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: {
        ...CLAUDE_TEST_MODEL_SELECTION,
        model: "claude-haiku-4-5",
        options: [{ id: "thinking", value: false }],
      },
      nativeThreadId: "thinking-thread",
      resume: false,
      cwd: "/workspace",
    });
    assert.isUndefined(options.thinking);
    assert.isUndefined(options.extraArgs?.["thinking-display"]);
    assert.include(options.settings, { alwaysThinkingEnabled: false });
  });

  it.each([
    ["--permission-mode acceptEdits", "acceptEdits"],
    ["--dangerously-skip-permissions", "bypassPermissions"],
    ["--dangerously-skip-permissions --permission-mode plan", "plan"],
  ])("folds %s into the SDK permission mode", (launchArgs, expected) => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "native-permission-override",
      resume: false,
      cwd: "/workspace",
      permissionMode: "default",
      settings: { ...AUTO_COMPACT_CLAUDE_SETTINGS, launchArgs },
    });
    assert.equal(options.permissionMode, expected);
    assert.isUndefined(options.extraArgs?.["permission-mode"]);
    assert.isUndefined(options.extraArgs?.["dangerously-skip-permissions"]);
  });

  it("passes automatic compaction and resume-dialog controls to the SDK", () => {
    const onUserDialog = async () => ({
      behavior: "completed" as const,
      result: "continue" as const,
    });
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "native-thread-auto-compact",
      resume: true,
      cwd: "/workspace",
      settings: AUTO_COMPACT_CLAUDE_SETTINGS,
      onUserDialog,
      supportedDialogKinds: ["resume_return"],
    });

    assert.equal((options.settings as { autoCompactWindow?: number }).autoCompactWindow, 300_000);
    assert.equal(options.onUserDialog, onUserDialog);
    assert.deepEqual(options.supportedDialogKinds, ["resume_return"]);
  });

  it("projects AskUserQuestion input with question text as the answer key", () => {
    assert.deepEqual(
      ClaudeAdapterV2.claudeUserInputQuestions({
        questions: [
          {
            header: "Approach",
            question: "Which approach?",
            options: [{ label: "Simple", description: "Use fewer moving parts" }],
            multiSelect: true,
          },
        ],
      }),
      [
        {
          id: "Which approach?",
          header: "Approach",
          question: "Which approach?",
          options: [{ label: "Simple", description: "Use fewer moving parts" }],
          multiSelect: true,
        },
      ],
    );
    const sdkAnswers: NonNullable<AskUserQuestionInput["answers"]> =
      ClaudeAdapterV2.claudeSdkUserInputAnswers({
        "Which approach?": ["Simple", "Safe"],
        "Deploy now?": "Yes",
      });
    assert.deepEqual(sdkAnswers, {
      "Which approach?": "Simple, Safe",
      "Deploy now?": "Yes",
    });
    assert.isTrue(
      ClaudeAdapterV2.ClaudeProviderCapabilitiesV2.planning.supportsStructuredQuestions,
    );
  });

  it("normalizes Claude todo and proposed-plan tool input", () => {
    assert.deepEqual(
      ClaudeAdapterV2.claudeTodoSteps({
        todos: [
          { content: "Inspect", status: "completed" },
          { content: "Implement", status: "in_progress" },
        ],
      }),
      [
        { id: "todo-0", text: "Inspect", status: "completed" },
        { id: "todo-1", text: "Implement", status: "running" },
      ],
    );
    assert.equal(
      ClaudeAdapterV2.claudeProposedPlan({ plan: "  # Plan\nShip it  " }),
      "# Plan\nShip it",
    );
    assert.isTrue(ClaudeAdapterV2.ClaudeProviderCapabilitiesV2.planning.emitsTodoList);
    assert.isTrue(ClaudeAdapterV2.ClaudeProviderCapabilitiesV2.planning.emitsProposedPlan);
  });

  it("maps canonical read-only never policy to Claude dontAsk with read-only tools", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "dontAsk",
      tools: ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      allowedTools: ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      installPermissionCallback: false,
    });
  });

  it("maps canonical read-only on-request policy to Claude default with callbacks", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "default",
      tools: ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      allowedTools: ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      installPermissionCallback: true,
    });
  });

  it("does not auto-allow reads for canonical restricted read-only never policy", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: {
            type: "restricted",
            includePlatformDefaults: false,
            readableRoots: [],
          },
          networkAccess: false,
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "dontAsk",
      tools: ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      installPermissionCallback: false,
    });
  });

  it("maps default full-access policy to Claude bypass permissions", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      installPermissionCallback: false,
    });
  });

  it("maps Auto runtime mode to Claude's AI-reviewed permission mode", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "auto",
        interactionMode: "default",
        cwd: "/workspace",
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "auto",
      installPermissionCallback: false,
    });
  });

  it("keeps approval-required mode interactive with danger-full-access sandboxing", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
        sandboxPolicy: {
          type: "dangerFullAccess",
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "default",
      installPermissionCallback: true,
    });
  });

  it("installs the permission callback for approval-required plan mode", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "plan",
        cwd: "/workspace",
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "plan",
      installPermissionCallback: true,
    });
  });

  it("honors never approvals for approval-required workspace-write policy", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "dontAsk",
      installPermissionCallback: false,
    });
  });

  it("honors never approvals for externally sandboxed policy", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "externalSandbox",
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      installPermissionCallback: false,
    });
  });
});

describe("ClaudeAdapterV2 context usage", () => {
  it("projects assistant usage against the selected context window", () => {
    const usage = ClaudeAdapterV2.claudeProviderTurnTokenUsage(
      {
        input_tokens: 42_000,
        cache_creation_input_tokens: 2_000,
        cache_read_input_tokens: 5_000,
        output_tokens: 1_000,
      },
      CLAUDE_TEST_MODEL_SELECTION,
      "2026-08-29T00:00:00.000Z",
    );

    assert.deepEqual(usage, {
      usedTokens: 50_000,
      maxTokens: 200_000,
      inputTokens: 49_000,
      cachedInputTokens: 5_000,
      outputTokens: 1_000,
      reasoningOutputTokens: 0,
      updatedAt: "2026-08-29T00:00:00.000Z",
    });
  });
});

describe("ClaudeAdapterV2 session permissions", () => {
  it("forces suggested permission updates to session scope", () => {
    const result = ClaudeAdapterV2.permissionResultFromDecision({
      toolName: "Bash",
      decision: "acceptForSession",
      toolInput: { command: "git status" },
      toolUseID: "tool-1",
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "git status" }],
          behavior: "allow",
          destination: "localSettings",
        },
      ],
    });

    assert.equal(result.behavior, "allow");
    if (result.behavior !== "allow") {
      return;
    }
    assert.deepEqual(result.updatedPermissions, [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "git status" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
  });

  it("adds a whole-tool session rule when Claude offers no suggestion", () => {
    const result = ClaudeAdapterV2.permissionResultFromDecision({
      toolName: "mcp__t3__custom_tool",
      decision: "acceptForSession",
      toolInput: {},
      toolUseID: "tool-2",
    });

    assert.equal(result.behavior, "allow");
    if (result.behavior !== "allow") {
      return;
    }
    assert.deepEqual(result.updatedPermissions, [
      {
        type: "addRules",
        rules: [{ toolName: "mcp__t3__custom_tool" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
  });
});

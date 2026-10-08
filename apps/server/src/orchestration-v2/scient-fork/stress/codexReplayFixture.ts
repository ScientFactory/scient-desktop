import type * as CodexReplay from "effect-codex-app-server/replay";
import packageJson from "../../../../package.json" with { type: "json" };
import * as CodexAdapterV2 from "../../Adapters/CodexAdapterV2.ts";
import { buildRuntimeInstructions } from "../../../provider/RuntimeInstructions.ts";
import { buildScientAwareness } from "../../../provider/ScientAwareness.ts";
export function makeCodexReplayTurn(input: {
  readonly id: string;
  readonly status: "inProgress" | "completed" | "interrupted" | "failed";
}): Record<string, unknown> {
  const terminal =
    input.status === "completed" || input.status === "interrupted" || input.status === "failed";
  return {
    id: input.id,
    items: [],
    itemsView: "notLoaded",
    status: input.status,
    error: null,
    startedAt: 1782622440,
    completedAt: terminal ? 1782622450 : null,
    durationMs: null,
  };
}
export function codexReplayPreamble(input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
  /** Text the adapter should send, when it differs from what the user typed. */
  readonly sentPrompt?: string;
  readonly startRequestId?: number;
  readonly turnRequestId?: number;
  readonly cwd?: string;
}): Array<CodexReplay.CodexAppServerReplayEntry> {
  return [
    {
      type: "expect_outbound",
      label: "initialize",
      // Synthetic request expectation uses Scient's shared client identity;
      // native response/event frames retain their recorded protocol shapes.
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "t3code_desktop",
            title: "Scient Desktop",
            version: packageJson.version,
          },
          capabilities: {
            experimentalApi: true,
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
            optOutNotificationMethods: ["turn/diff/updated"],
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "initialize",
      frame: {
        id: 1,
        result: {
          userAgent: "T3 Code/0.156.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
    { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      label: "thread/start",
      frame: {
        id: input.startRequestId ?? 2,
        method: "thread/start",
        params: {
          config: CodexAdapterV2.CODEX_THREAD_CONFIG,
          model: "gpt-5.4",
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/start",
      frame: {
        id: input.startRequestId ?? 2,
        result: {
          thread: {
            id: input.nativeThreadId,
            sessionId: input.nativeThreadId,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${input.nativeThreadId}.jsonl`,
            cwd: input.cwd ?? "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: input.cwd ?? "/workspace",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: {
        id: input.turnRequestId ?? 3,
        method: "turn/start",
        params: {
          threadId: input.nativeThreadId,
          input: [{ type: "text", text: input.sentPrompt ?? input.prompt }],
          cwd: input.cwd ?? "/workspace",
          model: "gpt-5.4",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          summary: "detailed",
          additionalContext: {
            t3_code_runtime: {
              kind: "application",
              value: buildRuntimeInstructions({
                harness: "Codex",
                model: "gpt-5.4",
                reasoningEffort: "medium",
              }),
            },
            scient_awareness: { kind: "application", value: buildScientAwareness() },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start",
      frame: {
        id: input.turnRequestId ?? 3,
        result: { turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }) },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started",
      frame: {
        method: "turn/started",
        params: {
          threadId: input.nativeThreadId,
          turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }),
        },
      },
    },
  ];
}

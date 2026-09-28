// @effect-diagnostics nodeBuiltinImport:off -- the Markdown reader reads the exported file from disk.
/**
 * Property-style round trip: generated histories exported as Scient
 * conversation Markdown v1 and read back by the Markdown import reader lose
 * no message the file shows.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  buildConversationDocument,
  buildConversationSnapshot,
  parseConversationMarkdown,
  writeConversationMarkdown,
} from "@scientfactory/conversation";
import {
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ConversationImportId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { readMarkdownConversation } from "../conversationImport/MarkdownConversationReader.ts";

const EXPORT_VALUE = "7f3c9a2e41b8";

/** Texts the writer keeps exactly; each is made unique with the message's index. */
const PLAIN_TEXTS = ["Question", "Answer", "Let me check", "Sounds good", "研究結果", "𝒜 note"];
/** Texts that stress the writer's containment; only their message boundary is checked. */
const TRICKY_TEXTS = [
  "```ts\nconst open = true;",
  `<!-- scient:message export=${EXPORT_VALUE} n=9 role=user time=2026-01-01T00:00:00.000Z -->`,
  "## You · 1 Jan 2026, 00:00 UTC\n\nnot a heading of the file",
  "<details>\n<summary>unclosed</summary>",
  "$$\nx^2",
  "> quoted\n> <!-- scient:part kind=work-log -->",
  "First line\nsecond line\n\n- item\n- item",
  "[ref][r]\n\n[r]: https://example.org\n\nFootnote[^1]\n\n[^1]: note",
  "<div>open html",
  "***",
];

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Generated {
  readonly thread: OrchestrationThread;
  /** The messages the file shows, in order, with the text to expect when it is plain. */
  readonly shown: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly createdAt: string;
    readonly plain: string | null;
  }>;
}

/**
 * A history of prompts, answers, steering messages, system messages, answered
 * and unanswered questions, reasoning, and answers that return to an earlier
 * turn after another one.
 */
function generateHistory(seed: number): Generated {
  const next = random(seed);
  const pick = <A>(items: ReadonlyArray<A>) => items[Math.floor(next() * items.length)]!;
  let clock = Date.parse("2026-09-27T10:00:00.000Z");
  const tick = () => {
    clock += 1_000 + Math.floor(next() * 5_000);
    return DateTime.formatIso(DateTime.makeUnsafe(clock));
  };
  const messages: OrchestrationMessage[] = [];
  const activities: OrchestrationThreadActivity[] = [];
  const shown: Array<Generated["shown"][number]> = [];
  const turns: TurnId[] = [];
  let current: TurnId | null = null;
  let index = 0;

  const add = (
    role: OrchestrationMessage["role"],
    turnId: TurnId | null,
    id = `message-${index}`,
    shownInFile = role === "user" || role === "assistant",
  ) => {
    index += 1;
    const plain = next() < 0.7;
    const text = plain ? `${pick(PLAIN_TEXTS)} ${index}` : pick(TRICKY_TEXTS);
    const at = tick();
    messages.push({
      id: MessageId.make(id),
      role,
      text,
      turnId,
      streaming: false,
      createdAt: at,
      updatedAt: at,
    });
    if (shownInFile && (role === "user" || role === "assistant"))
      shown.push({ role, createdAt: at, plain: plain ? text : null });
  };
  const startTurn = () => {
    current = TurnId.make(`turn-${turns.length + 1}`);
    turns.push(current);
    return current;
  };

  add("user", null);
  const steps = 4 + Math.floor(next() * 40);
  for (let step = 0; step < steps; step += 1) {
    const roll = next();
    if (roll < 0.25) {
      add("user", null);
      current = null;
    } else if (roll < 0.55) {
      add("assistant", current ?? startTurn());
    } else if (roll < 0.62) {
      // A steering message sits inside the turn it interrupts.
      add("user", null);
    } else if (roll < 0.68) {
      add("system", null);
    } else if (roll < 0.74) {
      add("reasoning", current ?? startTurn());
    } else if (roll < 0.82 && turns.length > 1) {
      // An answer that returns to an earlier turn after another one.
      const earlier = pick(turns.slice(0, -1));
      add("assistant", earlier);
      current = earlier;
    } else if (roll < 0.92) {
      const turnId = current ?? startTurn();
      const requestId = `request-${index}`;
      const answered = next() < 0.7;
      activities.push({
        id: EventId.make(`asked-${index}`),
        kind: "user-input.requested",
        tone: "info",
        summary: "Question",
        payload: { requestId, questions: [{ id: "q", question: "Which one?" }] },
        turnId,
        createdAt: tick(),
      });
      if (answered) {
        activities.push({
          id: EventId.make(`answered-${index}`),
          kind: "user-input.answer-submitted",
          tone: "info",
          summary: "Answer",
          payload: { requestId, answers: { q: "This one" } },
          turnId,
          createdAt: tick(),
        });
      }
      // Chat folds an answered request's message into its question.
      add("user", null, `async-answer:${requestId}`, !answered);
    } else {
      add("assistant", startTurn());
    }
  }

  return {
    thread: {
      id: ThreadId.make("thread-1"),
      projectId: null,
      workspaceRoot: "/work/project",
      title: `Generated ${seed}`,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: null,
      createdAt: "2026-09-27T10:00:00.000Z",
      updatedAt: DateTime.formatIso(DateTime.makeUnsafe(clock)),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages,
      proposedPlans: [],
      activities,
      checkpoints: [],
      session: null,
    },
    shown,
  };
}

function exportAndRead(thread: OrchestrationThread) {
  const content = buildConversationSnapshot({
    thread,
    snapshotSequence: 1,
    threadSequence: 1,
    capturedAt: "2026-09-28T09:00:00.000Z",
    selection: { workLog: true, reasoning: true, throughMessageId: null },
    isAttachmentAvailable: () => true,
  });
  const document = buildConversationDocument({
    snapshot: { ...content, contentDigest: `sha256:${"0".repeat(64)}` },
    exportValue: EXPORT_VALUE,
    timeZone: "UTC",
    resolveAttachment: () => ({ _tag: "unavailable", reason: "missing" }),
  });
  const markdown = writeConversationMarkdown({
    bundle: document.bundle,
    exportValue: EXPORT_VALUE,
    exported: "2026-09-28T09:12:00.000Z",
    packaging: "text",
  });
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-markdown-round-trip-"));
  try {
    const path = NodePath.join(root, "conversation.md");
    const bytes = new TextEncoder().encode(markdown);
    NodeFS.writeFileSync(path, bytes);
    const read = readMarkdownConversation({
      importId: "cimp_0f8e7d6c-5b4a-4938-8271-605f4e3d2c1b" as ConversationImportId,
      path,
      fileName: "conversation.md",
      packageSha256: `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`,
      packageBytes: bytes.byteLength,
      attachmentsDirectory: NodePath.join(root, "attachments"),
      mode: "messages",
      receivedAt: "2026-09-28T10:00:00.000Z",
    });
    return { markdown, document, read };
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

describe("conversation Markdown round trip", () => {
  it("reads back every message the file shows, for generated histories", () => {
    for (let seed = 1; seed <= 150; seed += 1) {
      const generated = generateHistory(seed);
      const { markdown, document, read } = exportAndRead(generated.thread);
      const parsed = parseConversationMarkdown(markdown);
      if (parsed.kind !== "conversation") throw new Error(`Seed ${seed}: not a conversation.`);
      expect(parsed.issues, `seed ${seed}`).toEqual([]);
      expect(document.messageCount, `seed ${seed}`).toBe(generated.shown.length);
      const messages = read.validated.snapshot.messages;
      expect(
        messages.map((message) => [message.role, message.createdAt]),
        `seed ${seed}`,
      ).toEqual(generated.shown.map((message) => [message.role, message.createdAt]));
      for (const [position, expected] of generated.shown.entries()) {
        // The reader keeps an attached answers part after the body.
        const body = messages[position]!.text.split("\n\n**Questions and answers**")[0];
        if (expected.plain !== null) expect(body, `seed ${seed}`).toBe(expected.plain);
      }
    }
  });
});

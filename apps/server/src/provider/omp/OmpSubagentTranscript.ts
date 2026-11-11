import { isRecord } from "effect-omp-rpc/schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * A native subagent's steps, read from the conversation OMP saves for it. The
 * file is OMP's session JSONL, the same records `get_subagent_messages` returns;
 * reading it here keeps each read bounded and works after an OMP restart.
 */

/** One step of a subagent's conversation; `id` is stable across re-reads. */
export type OmpSubagentStep =
  | {
      readonly kind: "text";
      readonly id: string;
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly reasoning?: true;
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly name: string;
      readonly status: "running" | "completed" | "failed";
      readonly input?: unknown;
      readonly output?: string;
    }
  | { readonly kind: "omitted"; readonly id: string; readonly bytes: number };

/** What earlier records say about later ones. */
export interface OmpSubagentConversation {
  /** The first user message is the assignment, which Scient shows from the subagent's update. */
  readonly assignmentSeen: boolean;
  /** Calls whose results may still come, so a result can carry its call's name and input. */
  readonly calls: ReadonlyMap<string, { readonly name: string; readonly input: unknown }>;
}

export interface OmpSubagentTranscriptCursor extends OmpSubagentConversation {
  readonly offset: number;
}

export const OMP_SUBAGENT_TRANSCRIPT_START: OmpSubagentTranscriptCursor = {
  offset: 0,
  assignmentSeen: false,
  calls: new Map(),
};

const CHUNK_BYTES = 256 * 1024;
/** A larger record is shown as omitted rather than parsed. */
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
/** Steps returned by one read; the caller reads again while `more` is set. */
const MAX_STEPS_PER_READ = 100;
const NEWLINE = 0x0a;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const utf8 = new TextDecoder("utf-8", { fatal: false });

const contentText = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) =>
    isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
  );
  return parts.length > 0 ? parts.join("") : undefined;
};

/** The steps one saved record adds; records that are not conversation messages add none. */
function ompSubagentRecordSteps(
  record: unknown,
  cursor: OmpSubagentConversation,
): {
  readonly steps: ReadonlyArray<OmpSubagentStep>;
  readonly cursor: OmpSubagentConversation;
} {
  if (!isRecord(record) || record.type !== "message" || typeof record.id !== "string")
    return { steps: [], cursor };
  const message = record.message;
  if (!isRecord(message)) return { steps: [], cursor };
  const entryId = record.id;
  if (message.role === "user") {
    if (!cursor.assignmentSeen) return { steps: [], cursor: { ...cursor, assignmentSeen: true } };
    const text = contentText(message.content);
    return {
      steps: text ? [{ kind: "text", id: entryId, role: "user", text }] : [],
      cursor,
    };
  }
  if (message.role === "assistant" && Array.isArray(message.content)) {
    const steps: OmpSubagentStep[] = [];
    let calls = cursor.calls;
    message.content.forEach((block, index) => {
      if (!isRecord(block)) return;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        steps.push({
          kind: "text",
          id: `${entryId}:${index}`,
          role: "assistant",
          text: block.text,
        });
      } else if (
        block.type === "thinking" &&
        typeof block.thinking === "string" &&
        block.thinking.trim()
      ) {
        steps.push({
          kind: "text",
          id: `${entryId}:${index}`,
          role: "assistant",
          text: block.thinking,
          reasoning: true,
        });
      } else if (
        block.type === "toolCall" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        const input = block.arguments ?? {};
        calls = new Map(calls).set(block.id, { name: block.name, input });
        steps.push({ kind: "tool", id: block.id, name: block.name, status: "running", input });
      }
    });
    return { steps, cursor: calls === cursor.calls ? cursor : { ...cursor, calls } };
  }
  if (message.role === "toolResult" && typeof message.toolCallId === "string") {
    const call = cursor.calls.get(message.toolCallId);
    const name =
      call?.name ?? (typeof message.toolName === "string" ? message.toolName : undefined);
    if (name === undefined) return { steps: [], cursor };
    const calls = new Map(cursor.calls);
    calls.delete(message.toolCallId);
    const output = contentText(message.content);
    return {
      steps: [
        {
          kind: "tool",
          id: message.toolCallId,
          name,
          status: message.isError === true ? "failed" : "completed",
          ...(call === undefined ? {} : { input: call.input }),
          ...(output === undefined ? {} : { output }),
        },
      ],
      cursor: { ...cursor, calls },
    };
  }
  return { steps: [], cursor };
}

/**
 * Reads complete records after `cursor`, a bounded amount at a time. A partial
 * last line waits for the next read; a file that shrank is read again from the
 * start, whose steps keep their ids.
 */
export const readOmpSubagentTranscript = Effect.fn("OmpSubagentTranscript.read")(function* (
  file: string,
  start: OmpSubagentTranscriptCursor,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const size = Number((yield* fileSystem.stat(file)).size);
  const from = size < start.offset ? OMP_SUBAGENT_TRANSCRIPT_START : start;
  let offset = from.offset;
  let conversation: OmpSubagentConversation = from;
  const steps: OmpSubagentStep[] = [];
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fileSystem.open(file, { flag: "r" });
      const readAt = (offset: number, length: number) =>
        handle
          .seek(BigInt(offset), "start")
          .pipe(
            Effect.andThen(handle.readAlloc(length)),
            Effect.map(Option.getOrElse(() => new Uint8Array())),
          );
      while (offset < size && steps.length < MAX_STEPS_PER_READ) {
        const base = offset;
        let bytes = yield* readAt(base, Math.min(CHUNK_BYTES, size - base));
        let end = bytes.indexOf(NEWLINE);
        if (end === -1 && base + bytes.length < size) {
          // One long record: read it whole up to the limit.
          bytes = yield* readAt(base, Math.min(MAX_RECORD_BYTES + 1, size - base));
          end = bytes.indexOf(NEWLINE);
        }
        if (end === -1 && bytes.length > MAX_RECORD_BYTES) {
          // Too long to parse: skip to its end and say a step was left out.
          let skipped = bytes.length;
          let newline = -1;
          while (newline === -1 && base + skipped < size) {
            const next = yield* readAt(
              base + skipped,
              Math.min(CHUNK_BYTES, size - base - skipped),
            );
            newline = next.indexOf(NEWLINE);
            skipped += newline === -1 ? next.length : newline;
          }
          if (newline === -1) break;
          steps.push({ kind: "omitted", id: `offset:${base}`, bytes: skipped });
          offset = base + skipped + 1;
          continue;
        }
        // A partial last record waits for the next read.
        if (end === -1) break;
        let lineStart = 0;
        while (end !== -1 && steps.length < MAX_STEPS_PER_READ) {
          const line = bytes.subarray(lineStart, end);
          const record = line.length > 0 ? decodeJson(utf8.decode(line)) : Option.none();
          const next = Option.isSome(record)
            ? ompSubagentRecordSteps(record.value, conversation)
            : { steps: [], cursor: conversation };
          for (const step of next.steps) steps.push(step);
          conversation = next.cursor;
          offset = base + end + 1;
          lineStart = end + 1;
          end = bytes.indexOf(NEWLINE, lineStart);
        }
      }
      const cursor: OmpSubagentTranscriptCursor = {
        offset,
        assignmentSeen: conversation.assignmentSeen,
        calls: conversation.calls,
      };
      return { steps, cursor, more: steps.length >= MAX_STEPS_PER_READ && offset < size };
    }),
  );
});

import { isRecord } from "effect-omp-rpc/schema";

type ContentKind = "text" | "reasoning";
type ContentStatus = "completed" | "failed";

export type OmpAssistantContentUpdate =
  | {
      readonly type: "assistant-delta" | "reasoning-delta";
      readonly messageId: string;
      readonly delta: string;
    }
  | {
      readonly type: "content-snapshot";
      readonly messageId: string;
      readonly text: string;
      readonly reasoning: boolean;
      readonly status: ContentStatus;
    }
  | {
      readonly type: "assistant-completed";
      readonly messageId: string;
      readonly status?: ContentStatus;
    };

interface ContentBlock {
  readonly id: string;
  readonly kind: ContentKind;
  text: string;
  status: ContentStatus | undefined;
}

const messageBlocks = (message: unknown) => {
  if (!isRecord(message)) return [];
  if (typeof message.content === "string")
    return [{ index: 0, kind: "text" as const, text: message.content }];
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((part, index) => {
    if (!isRecord(part)) return [];
    if (part.type === "text" && typeof part.text === "string")
      return [{ index, kind: "text" as ContentKind, text: part.text }];
    if (part.type === "thinking" && typeof part.thinking === "string")
      return [{ index, kind: "reasoning" as ContentKind, text: part.thinking }];
    return [];
  });
};

/** One native envelope owns independent text and visible reasoning blocks. */
export function makeOmpAssistantContent(messageId: string, initialMessage?: unknown) {
  const blocks = new Map<string, ContentBlock>();
  const blockFor = (index: number, kind: ContentKind) => {
    const key = `${index}:${kind}`;
    let block = blocks.get(key);
    if (!block) {
      block = {
        id: `${messageId}:content-${index}:${kind}`,
        kind,
        text: "",
        status: undefined,
      };
      blocks.set(key, block);
    }
    return block;
  };
  const complete = (
    block: ContentBlock,
    status: ContentStatus,
    snapshot?: string,
  ): OmpAssistantContentUpdate[] => {
    const updates: OmpAssistantContentUpdate[] = [];
    const newlyPublished = block.text.length === 0 && snapshot !== undefined && snapshot.length > 0;
    if (snapshot !== undefined && snapshot.length > 0 && snapshot !== block.text) {
      if (block.text.length === 0) {
        updates.push({
          type: block.kind === "text" ? "assistant-delta" : "reasoning-delta",
          messageId: block.id,
          delta: snapshot,
        });
      } else {
        updates.push({
          type: "content-snapshot",
          messageId: block.id,
          text: snapshot,
          reasoning: block.kind === "reasoning",
          status,
        });
      }
      block.text = snapshot;
    }
    if (block.text.length > 0 && (newlyPublished || block.status !== status)) {
      updates.push({
        type: "assistant-completed",
        messageId: block.id,
        ...(status === "failed" ? { status } : {}),
      });
    }
    block.status = status;
    return updates;
  };
  return {
    delta(index: number, kind: ContentKind, delta: string): OmpAssistantContentUpdate[] {
      if (delta.length === 0) return [];
      const block = blockFor(index, kind);
      if (block.status !== undefined) return [];
      block.text += delta;
      return [
        {
          type: kind === "text" ? "assistant-delta" : "reasoning-delta",
          messageId: block.id,
          delta,
        },
      ];
    },
    end(index: number, kind: ContentKind, snapshot?: string): OmpAssistantContentUpdate[] {
      const block = blockFor(index, kind);
      if (block.status !== undefined) return [];
      return complete(block, "completed", snapshot);
    },
    finish(status: ContentStatus, finalMessage?: unknown): OmpAssistantContentUpdate[] {
      const updates: OmpAssistantContentUpdate[] = [];
      for (const part of messageBlocks(finalMessage ?? initialMessage)) {
        // The start snapshot may fill an unstreamed block, but cannot replace later deltas.
        if (finalMessage === undefined && blocks.has(`${part.index}:${part.kind}`)) continue;
        updates.push(...complete(blockFor(part.index, part.kind), status, part.text));
      }
      for (const block of blocks.values()) updates.push(...complete(block, status));
      return updates;
    },
  };
}

import { describe, expect, it } from "@effect/vitest";
import { makeOmpAssistantContent } from "./OmpAssistantContent.ts";

const message = (content: unknown) => ({ role: "assistant", content });
const text = (value: string) => ({ type: "text", text: value });
const thinking = (value: string) => ({ type: "thinking", thinking: value });

describe("OMP assistant content", () => {
  it("does not publish tool-only, empty, or opaque reasoning envelopes", () => {
    for (const content of [
      [],
      "",
      [text("")],
      [{ type: "toolCall", id: "read" }],
      [{ type: "thinking", signature: "opaque" }],
    ]) {
      const blocks = makeOmpAssistantContent("native", message(content));
      expect(blocks.finish("completed", message(content))).toEqual([]);
      expect(blocks.finish("failed", message(content))).toEqual([]);
    }
  });

  it("keeps text and visible reasoning separate across tool gaps", () => {
    const blocks = makeOmpAssistantContent("native");
    const first = blocks.delta(0, "reasoning", "Reason");
    const second = blocks.delta(2, "text", "Answer");
    const updates = blocks.finish(
      "completed",
      message([thinking("Reason"), { type: "toolCall", id: "read" }, text("Answer"), text("Tail")]),
    );
    expect(first[0]?.messageId).not.toBe(second[0]?.messageId);
    expect(updates.filter((update) => update.type === "assistant-completed")).toHaveLength(3);
    expect(updates.filter((update) => update.type === "assistant-delta")).toMatchObject([
      { delta: "Tail" },
    ]);
    expect(blocks.finish("completed")).toEqual([]);
  });

  it("repairs streamed content with replacement snapshots, without replaying them", () => {
    const blocks = makeOmpAssistantContent("native");
    const [delta] = blocks.delta(0, "text", "Draft with a missing suffix");
    expect(blocks.end(0, "text", "Correct answer")).toContainEqual({
      type: "content-snapshot",
      messageId: delta!.messageId,
      text: "Correct answer",
      reasoning: false,
      status: "completed",
    });
    expect(blocks.delta(0, "text", "late")).toEqual([]);
    expect(blocks.end(0, "text", "Correct answer")).toEqual([]);
    expect(blocks.finish("completed", message([text("Correct answer")]))).toEqual([]);
    expect(blocks.finish("failed", message([text("Final partial")]))).toContainEqual({
      type: "content-snapshot",
      messageId: delta!.messageId,
      text: "Final partial",
      reasoning: false,
      status: "failed",
    });
  });

  it("uses end snapshots when deltas were absent and settles reasoning immediately", () => {
    const blocks = makeOmpAssistantContent("native");
    expect(blocks.end(1, "reasoning", "Visible reasoning")).toMatchObject([
      { type: "reasoning-delta", delta: "Visible reasoning" },
      { type: "assistant-completed" },
    ]);
    expect(
      blocks.finish("completed", message([{ type: "toolCall" }, thinking("Visible reasoning")])),
    ).toEqual([]);
  });

  it("settles a final snapshot even after an empty block end", () => {
    const blocks = makeOmpAssistantContent("native");
    expect(blocks.end(0, "text", "")).toEqual([]);
    expect(blocks.finish("completed", message([text("Recovered snapshot")]))).toMatchObject([
      { type: "assistant-delta", delta: "Recovered snapshot" },
      { type: "assistant-completed" },
    ]);
  });

  it("retains a partial stream when only an older start snapshot is available", () => {
    const blocks = makeOmpAssistantContent("native", message([text("Old snapshot")]));
    blocks.delta(0, "text", "Partial stream");
    expect(blocks.finish("failed")).toMatchObject([
      { type: "assistant-completed", status: "failed" },
    ]);
  });
});

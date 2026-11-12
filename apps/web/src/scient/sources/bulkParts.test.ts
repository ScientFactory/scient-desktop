import {
  ScientSourcesBulkChange,
  type ScientSourcesBulkChange as BulkChange,
} from "@scientfactory/scient-sources";
import type { ScientSourcesBulkResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  bulkChangeParts,
  bulkPartsAnnouncement,
  partsNotSent,
  runParts,
  sumBulkResults,
  undoBulkParts,
  undoPartsAnnouncement,
} from "./bulkParts";

const ids = Array.from({ length: 1_200 }, (_, index) => `src_${index}`);
const change: BulkChange = { sourceIds: ids, addTags: ["RCT"] };
const lost = Object.assign(new Error("timed out"), { _tag: "RemoteEnvironmentAuthTimeoutError" });
const isLost = (error: unknown) => error === lost;
const decodeBulkChange = Schema.decodeUnknownSync(ScientSourcesBulkChange);
const message = (error: unknown) => (error instanceof Error ? error.message : "?");

/** A server that answers each part as the bulk route would, and fails where it is told to. */
function server(input: { readonly failAt?: number; readonly error?: unknown } = {}) {
  const sent: BulkChange[] = [];
  const send = async (sourceIds: ReadonlyArray<string>): Promise<ScientSourcesBulkResult> => {
    const part = decodeBulkChange({ ...change, sourceIds });
    sent.push(part);
    if (sent.length === input.failAt) throw input.error;
    return {
      sources: part.sourceIds.map((sourceId, index) => ({
        sourceId,
        outcome: index === 0 ? "unchanged" : "updated",
        revision: 2,
      })),
      collections: [],
      undo: { batchId: `bulk_${sent.length}`, sourceCount: part.sourceIds.length - 1 },
    };
  };
  return { sent, send };
}

const run = (
  send: ReturnType<typeof server>["send"],
  options: { readonly stopAfter?: number } = {},
) => {
  const progress: number[] = [];
  return runParts({
    parts: bulkChangeParts(change).map((part) => part.sourceIds),
    send,
    isLost,
    onProgress: (answered) => progress.push(answered),
    stopRequested: () => options.stopAfter !== undefined && progress.length >= options.stopAfter,
  }).then((outcome) => ({ outcome, progress }));
};

describe("bulk edits in parts", () => {
  it("sends 1,200 sources as consecutive parts and sums what they changed", async () => {
    const { sent, send } = server();
    const { outcome, progress } = await run(send);

    expect(sent.map((part) => part.sourceIds)).toEqual(
      Array.from({ length: 12 }, (_, index) => ids.slice(index * 100, index * 100 + 100)),
    );
    expect(sent.every((part) => part.addTags?.[0] === "RCT")).toBe(true);
    expect(progress).toEqual(Array.from({ length: 12 }, (_, index) => (index + 1) * 100));
    const sum = sumBulkResults(outcome.results);
    expect(sum.result.sources).toHaveLength(1_200);
    expect(sum.undo.map((part) => part.batchId)).toEqual(
      sent.map((_, index) => `bulk_${index + 1}`),
    );
    expect(sum.changed).toBe(1_188);
    expect(
      bulkPartsAnnouncement({ outcome, changed: sum.changed, failureTitle: "x", message }),
    ).toEqual({ type: "success", title: "Changed 1,188 sources" });
  });

  it.each([
    ["a part that fails", { failAt: 2, error: new Error("Disk full") }, "failed"],
    ["Stop after the first part", {}, "stopped"],
  ] as const)("ends at %s, keeping the first part's count and Undo", async (_, failure, kind) => {
    const { sent, send } = server(failure);
    const { outcome } = await run(send, kind === "stopped" ? { stopAfter: 1 } : {});

    expect(sent).toHaveLength(kind === "stopped" ? 1 : 2);
    expect(outcome.end.kind).toBe(kind);
    expect(outcome.answered).toBe(100);
    expect(partsNotSent(outcome)).toBe(1_100);
    const sum = sumBulkResults(outcome.results);
    expect(sum.undo).toEqual([{ batchId: "bulk_1", sourceCount: 99 }]);
    expect(
      bulkPartsAnnouncement({ outcome, changed: sum.changed, failureTitle: "x", message }),
    ).toEqual(
      kind === "stopped"
        ? {
            type: "success",
            title: "Changed 99 sources",
            description: "Stopped. 1,100 other sources were not changed.",
          }
        : {
            type: "warning",
            title: "Changed 99 sources",
            description: "1,100 other sources were not changed. Disk full",
          },
    );
  });

  it("counts a part with no answer as neither changed nor unchanged", async () => {
    const { send } = server({ failAt: 3, error: lost });
    const { outcome } = await run(send);

    expect(outcome.end).toMatchObject({ kind: "lost", unknown: 100 });
    expect(outcome.answered).toBe(200);
    expect(partsNotSent(outcome)).toBe(900);
    const sum = sumBulkResults(outcome.results);
    expect(sum.undo.map((part) => part.batchId)).toEqual(["bulk_1", "bulk_2"]);
    expect(
      bulkPartsAnnouncement({ outcome, changed: sum.changed, failureTitle: "x", message }),
    ).toEqual({
      type: "warning",
      title: "Changed 198 sources",
      description:
        "No answer came back for 100 sources, so whether they were changed is unknown. 900 other sources were not changed.",
    });
  });

  it("undoes newest first and tries again only the parts that did not finish", async () => {
    const parts = [1, 2, 3, 4].map((index) => ({ batchId: `bulk_${index}`, sourceCount: 10 }));
    const order: string[] = [];
    const undone = (sourceId: string, failed = false): ScientSourcesBulkResult => ({
      sources: [{ sourceId, outcome: failed ? "failed" : "updated", revision: 3 }],
      collections: [],
      conflicts: [{ sourceId, message: "A later tag was kept." }],
    });
    const first = await undoBulkParts({
      parts,
      isLost,
      send: async (batchId) => {
        order.push(batchId);
        if (batchId === "bulk_2") throw lost;
        return undone(batchId, batchId === "bulk_3");
      },
    });

    expect(order).toEqual(["bulk_4", "bulk_3", "bulk_2"]);
    expect(first.retry.map((part) => part.batchId)).toEqual(["bulk_1", "bulk_2", "bulk_3"]);
    expect(first.unanswered).toBe(20);
    expect(undoPartsAnnouncement(first, message)).toEqual({
      type: "warning",
      title: "Undo did not finish",
      description:
        "1 change could not be undone. No answer came back for 20 changes, so whether they were undone is unknown.",
    });

    order.length = 0;
    const again = await undoBulkParts({
      parts: first.retry,
      isLost,
      send: async (batchId) => {
        order.push(batchId);
        return undone(batchId);
      },
    });
    expect(order).toEqual(["bulk_3", "bulk_2", "bulk_1"]);
    expect(again.retry).toEqual([]);
    expect(undoPartsAnnouncement(again, message)).toEqual({
      type: "warning",
      title: "Some later changes were kept",
      description: "A later tag was kept. 2 more were kept as well.",
    });
  });
});

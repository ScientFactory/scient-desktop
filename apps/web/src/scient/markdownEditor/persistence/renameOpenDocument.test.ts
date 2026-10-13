import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type {
  MarkdownPersistenceLease,
  MarkdownPersistenceMoveTransaction,
} from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";

import { registerRenameParticipant, renameOpenDocument } from "./renameOpenDocument";

const from = { environmentId: EnvironmentId.make("env"), cwd: "/w", relativePath: "a.md" };
const destination = { ...from, relativePath: "b.md" };

function fixture(
  overrides: {
    move?: Partial<MarkdownPersistenceMoveTransaction> | null;
    revision?: string;
  } = {},
) {
  const order: string[] = [];
  const move: MarkdownPersistenceMoveTransaction = {
    documentId: "doc-1",
    preflight: vi.fn(async () => "empty" as const),
    commit: vi.fn(() => {
      order.push("commit");
      return true;
    }),
    finish: vi.fn(() => order.push("finish")),
    ...overrides.move,
  };
  const lease = {
    documentId: "doc-1",
    getSnapshot: () => ({ baselineRevision: "r1" }),
    beginMove: vi.fn(() => (overrides.move === null ? null : move)),
  } as unknown as MarkdownPersistenceLease;
  const rename = vi.fn(async () => {
    order.push("rename");
    return {
      ok: true as const,
      destinationRelativePath: "b.md",
      revision: overrides.revision ?? "r1",
    };
  });
  const reopen = vi.fn(() => order.push("reopen"));
  const follow = vi.fn(() => order.push("follow"));
  const followed = vi.fn(async () => true);
  let free = true;
  const destinationFree = vi.fn(() => free);
  const run = () =>
    renameOpenDocument({ lease, destination, rename, reopen, follow, followed, destinationFree });
  return {
    lease,
    move,
    rename,
    reopen,
    follow,
    followed,
    order,
    run,
    setFree: (value: boolean) => (free = value),
  };
}

describe("renameOpenDocument", () => {
  it("renames the ordinary way when another tab shows the destination", async () => {
    const h = fixture();
    h.setFree(false);
    expect(await h.run()).toEqual({ kind: "legacy-required", reason: "destination" });
    expect(h.rename).not.toHaveBeenCalled();
  });

  it("reopens instead of moving when the destination is opened during the rename", async () => {
    const h = fixture();
    h.rename.mockImplementationOnce(async () => {
      h.setFree(false);
      return { ok: true as const, destinationRelativePath: "b.md", revision: "r1" };
    });
    expect((await h.run()).kind).toBe("renamed");
    expect(h.move.commit).not.toHaveBeenCalled();
    expect(h.reopen).toHaveBeenCalledOnce();
  });

  it("refuses to rename at all while the old name's recovery copy cannot be cleared", async () => {
    const h = fixture();
    (h.lease as unknown as { settleRecoveryCopy: () => Promise<boolean> }).settleRecoveryCopy =
      vi.fn(async () => false);
    const outcome = await h.run();
    expect(outcome.kind).toBe("failed");
    expect(h.lease.beginMove).not.toHaveBeenCalled();
    expect(h.rename).not.toHaveBeenCalled();
  });

  it("leaves a lease from older code to the ordinary rename", async () => {
    const h = fixture();
    const older = { ...h.lease, beginMove: undefined, documentId: undefined };
    expect(
      await renameOpenDocument({
        lease: older as unknown as typeof h.lease,
        destination,
        rename: h.rename,
        reopen: h.reopen,
        follow: h.follow,
        followed: h.followed,
      }),
    ).toEqual({ kind: "legacy-required" });
    expect(h.rename).not.toHaveBeenCalled();
  });

  it("moves in place: rename, commit, follow, then release", async () => {
    const h = fixture();
    expect(await h.run()).toEqual({
      kind: "moved",
      destinationRelativePath: "b.md",
      revision: "r1",
    });
    expect(h.order).toEqual(["rename", "commit", "follow", "finish"]);
    expect(h.reopen).not.toHaveBeenCalled();
  });

  it("asks nothing of the server when the document cannot move", async () => {
    const h = fixture({ move: null });
    expect(await h.run()).toEqual({ kind: "legacy-required" });
    expect(h.rename).not.toHaveBeenCalled();
  });

  it("asks nothing of the server when the destination holds a recovery copy", async () => {
    for (const state of ["occupied", "unknown"] as const) {
      const h = fixture({ move: { preflight: vi.fn(async () => state) } });
      expect(await h.run()).toEqual(
        state === "occupied"
          ? { kind: "legacy-required", reason: "destination" }
          : { kind: "legacy-required" },
      );
      expect(h.rename).not.toHaveBeenCalled();
      expect(h.move.finish).toHaveBeenCalledOnce();
    }
  });

  it("waits for an editor that is composing text", async () => {
    const h = fixture();
    const remove = registerRenameParticipant("doc-1", { readyToMove: () => false });
    expect(await h.run()).toEqual({ kind: "legacy-required" });
    expect(h.lease.beginMove).not.toHaveBeenCalled();
    remove();
    expect((await h.run()).kind).toBe("moved");
  });

  it("reports a refused server rename and changes nothing", async () => {
    const h = fixture();
    h.rename.mockResolvedValueOnce({ ok: false, cause: "path_exists" } as never);
    expect(await h.run()).toEqual({ kind: "failed", cause: "path_exists" });
    expect(h.move.commit).not.toHaveBeenCalled();
    expect(h.move.finish).toHaveBeenCalledOnce();
  });

  it("reopens the ordinary way, still held, when the session could not move", async () => {
    const h = fixture({ move: { commit: vi.fn(() => false) } });
    expect((await h.run()).kind).toBe("renamed");
    expect(h.order).toEqual(["rename", "reopen", "finish"]);
    expect(h.follow).not.toHaveBeenCalled();
  });

  it("does not move a file whose content changed under the rename", async () => {
    const h = fixture({ revision: "other" });
    expect((await h.run()).kind).toBe("renamed");
    expect(h.move.commit).not.toHaveBeenCalled();
  });

  it("asks for a repair when the views did not follow", async () => {
    const h = fixture();
    h.followed.mockResolvedValueOnce(false);
    expect((await h.run()).kind).toBe("repair");
    const g = fixture();
    g.follow.mockImplementationOnce(() => {
      throw new Error("tab store unavailable");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await g.run()).kind).toBe("repair");
    logged.mockRestore();
    expect(g.move.finish).toHaveBeenCalledOnce();
  });
});

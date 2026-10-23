import { describe, expect, it, vi } from "vite-plus/test";
import {
  checkpointVisualDraft,
  clearVisualDraft,
  confirmVisualDraft,
  discardVisualDraft,
  flushVisualDraft,
  readPersistedVisualDraft,
  readVisualDraftForSource,
} from "./visualDrafts";

const keys = [
  "versioned",
  "legacy",
  "v1",
  "v2",
  "invalid",
  "pending",
  "failed",
  "confirmed",
  "newer",
  "nonexact",
  "reloaded",
  "unchanged",
  "multiple",
  "discarded",
  "wrong-discard",
];
const before = [
  "\\documentclass{article}",
  "\\begin{document}",
  "A deliberately long surrounding paragraph contains old visual prose for recovery.",
  "",
  "A second editable paragraph remains unchanged.",
  "\\end{document}",
].join("\n");
const after = before.replace("old visual prose", "new visual prose");
const afterBoth = after.replace("remains unchanged", "is now edited too");

function retain(key: string, source: string) {
  checkpointVisualDraft(key, source, "disk-one");
}

// The copy that would be found on reopening: written out, then read from storage.
function readVisualDraft(key: string) {
  flushVisualDraft(key);
  return readPersistedVisualDraft(key);
}

async function _cleanupFixture0(_fixture: _Fixture) {
  for (const key of keys) clearVisualDraft(key);
}

describe("Visual draft recovery", () => {
  it("finds a queued checkpoint without taking an unrelated view's stored record", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const slot = "scient:latex-visual-draft:source:pending";
    const theirs = JSON.stringify({ source: before, baseRevision: "other-view" });
    localStorage.setItem(slot, theirs);
    retain("pending", after);
    expect(readVisualDraftForSource("pending", after)).toEqual({
      source: after,
      baseRevision: "disk-one",
    });
    expect(readVisualDraftForSource("pending", afterBoth)).toBeNull();
    expect(localStorage.getItem(slot)).toBe(theirs);
    expect(flushVisualDraft("pending")).toBe(false);
    expect(localStorage.getItem(slot)).toBe(theirs);
    expect(readVisualDraftForSource("pending", after)).toEqual({
      source: after,
      baseRevision: "disk-one",
    });
    expect(discardVisualDraft("pending", { source: before, baseRevision: "other-view" })).toBe(
      true,
    );
    expect(flushVisualDraft("pending")).toBe(true);
    expect(readPersistedVisualDraft("pending")).toEqual({
      source: after,
      baseRevision: "disk-one",
    });
  });

  it("finds the persisted buffer until its exact save is acknowledged", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    retain("confirmed", after);
    expect(flushVisualDraft("confirmed")).toBe(true);
    expect(readVisualDraftForSource("confirmed", after)?.source).toBe(after);
    expect(readVisualDraftForSource("confirmed", before)).toBeNull();
    expect(confirmVisualDraft("confirmed", after)).toBe(true);
    expect(readVisualDraftForSource("confirmed", after)).toBeNull();
  });

  it("replaces only its own successfully stored checkpoint with later writing", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    retain("newer", after);
    expect(flushVisualDraft("newer")).toBe(true);
    retain("newer", afterBoth);
    expect(flushVisualDraft("newer")).toBe(true);
    expect(readPersistedVisualDraft("newer")).toEqual({
      source: afterBoth,
      baseRevision: "disk-one",
    });
  });

  it("keeps another window's replacement of its successfully stored checkpoint", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const slot = "scient:latex-visual-draft:source:newer";
    retain("newer", after);
    expect(flushVisualDraft("newer")).toBe(true);
    const theirs = JSON.stringify({ source: before, baseRevision: "other-view" });
    localStorage.setItem(slot, theirs);
    retain("newer", afterBoth);
    expect(flushVisualDraft("newer")).toBe(false);
    expect(localStorage.getItem(slot)).toBe(theirs);
    expect(readVisualDraftForSource("newer", afterBoth)).toEqual({
      source: afterBoth,
      baseRevision: "disk-one",
    });
    expect(discardVisualDraft("newer", { source: before, baseRevision: "other-view" })).toBe(true);
    expect(flushVisualDraft("newer")).toBe(true);
    expect(readPersistedVisualDraft("newer")).toEqual({
      source: afterBoth,
      baseRevision: "disk-one",
    });
  });

  it("retains its pending work when another window replaces the write before acknowledgement", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const slot = "scient:latex-visual-draft:source:pending";
    const theirs = JSON.stringify({ source: before, baseRevision: "other-view" });
    const setItem = Storage.prototype.setItem;
    let replace = true;
    using _replacement = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      setItem.call(this, key, value);
      if (key === slot && replace) {
        replace = false;
        setItem.call(this, key, theirs);
      }
    });

    retain("pending", after);
    expect(flushVisualDraft("pending")).toBe(false);
    expect(localStorage.getItem(slot)).toBe(theirs);
    expect(readVisualDraftForSource("pending", after)).toEqual({
      source: after,
      baseRevision: "disk-one",
    });
    expect(discardVisualDraft("pending", { source: before, baseRevision: "other-view" })).toBe(
      true,
    );
    expect(flushVisualDraft("pending")).toBe(true);
    expect(readPersistedVisualDraft("pending")).toEqual({
      source: after,
      baseRevision: "disk-one",
    });
  });

  it("keeps an optimistic complete-source checkpoint durable until disk confirmation", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    retain("pending", after);
    checkpointVisualDraft("pending", after, "disk-one");

    expect(readVisualDraft("pending")).toEqual({ source: after, baseRevision: "disk-one" });
  });

  it("preserves the complete source when a save fails or confirms different contents", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    checkpointVisualDraft("failed", after, "disk-one");

    expect(confirmVisualDraft("failed", before)).toBe(false);
    expect(readVisualDraft("failed")?.source).toBe(after);
  });

  it("clears only after the exact complete checkpoint reaches a confirmed disk write", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    checkpointVisualDraft("confirmed", after, "disk-one");

    expect(confirmVisualDraft("confirmed", after)).toBe(true);
    expect(readVisualDraft("confirmed")).toBeNull();
  });

  it("does not let an older save confirmation erase newer uncheckpointed source", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    checkpointVisualDraft("newer", after, "disk-one");
    retain("newer", afterBoth);

    expect(confirmVisualDraft("newer", after)).toBe(false);
    expect(readVisualDraft("newer")?.source).toBe(afterBoth);
  });

  it("fails closed instead of using a last-block proof for a nonexact save", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    checkpointVisualDraft("nonexact", after, "disk-one");
    const later = `% unrelated edit\n${after}`;

    expect(confirmVisualDraft("nonexact", later)).toBe(false);
    expect(readVisualDraft("nonexact")?.source).toBe(after);
  });

  it("retains the full latest source across multiple edited blocks", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    checkpointVisualDraft("multiple", after, "disk-one");
    retain("multiple", afterBoth);
    checkpointVisualDraft("multiple", afterBoth, "disk-one");

    expect(readVisualDraft("multiple")?.source).toBe(afterBoth);
    expect(confirmVisualDraft("multiple", afterBoth)).toBe(true);
  });

  it("clears a transaction only for a matching Discard identity while Retry can retain it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    checkpointVisualDraft("discarded", after, "disk-one");
    retain("discarded", afterBoth);

    expect(discardVisualDraft("discarded", { source: after, baseRevision: "wrong-revision" })).toBe(
      false,
    );
    expect(readVisualDraft("discarded")?.source).toBe(afterBoth);
    // Discard must match the latest accepted source.
    expect(discardVisualDraft("discarded", { source: after, baseRevision: "disk-one" })).toBe(
      false,
    );
    expect(discardVisualDraft("discarded", { source: afterBoth, baseRevision: "disk-one" })).toBe(
      true,
    );
    expect(readVisualDraft("discarded")).toBeNull();

    checkpointVisualDraft("wrong-discard", after, "disk-one");
    expect(
      discardVisualDraft("wrong-discard", { source: afterBoth, baseRevision: "disk-one" }),
    ).toBe(false);
    expect(readVisualDraft("wrong-discard")?.source).toBe(after);
  });

  it("judges this window's unwritten checkpoint and the stored record separately", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const stored = "scient:latex-visual-draft:source:shared";
    const other = JSON.stringify({ source: afterBoth, baseRevision: "disk-two" });
    try {
      // Another window stored its own copy; this window holds an unwritten one.
      for (const act of [
        () => confirmVisualDraft("shared", after),
        () => discardVisualDraft("shared", { source: after, baseRevision: "disk-one" }),
      ]) {
        localStorage.setItem(stored, other);
        checkpointVisualDraft("shared", after, "disk-one");
        expect(act()).toBe(true);
        // Ours is gone; the other window's record is not ours to remove.
        expect(localStorage.getItem(stored)).toBe(other);
        expect(flushVisualDraft("shared")).toBe(true);
        expect(localStorage.getItem(stored)).toBe(other);
      }
      // A stored record that matches is removed even when ours does not match.
      localStorage.setItem(stored, other);
      checkpointVisualDraft("shared", after, "disk-one");
      expect(confirmVisualDraft("shared", afterBoth)).toBe(true);
      expect(localStorage.getItem(stored)).toBeNull();
      expect(flushVisualDraft("shared")).toBe(true);
      expect(JSON.parse(localStorage.getItem(stored)!).source).toBe(after);
      // A stored record that matches is removed together with the unwritten one.
      localStorage.setItem(stored, other);
      checkpointVisualDraft("shared", afterBoth, "disk-two");
      expect(confirmVisualDraft("shared", afterBoth)).toBe(true);
      expect(localStorage.getItem(stored)).toBeNull();
    } finally {
      clearVisualDraft("shared");
    }
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;

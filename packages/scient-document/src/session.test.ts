import { describe, expect, it } from "vite-plus/test";

import {
  applyUserDocumentSource,
  beginDocumentSave,
  confirmDocumentSave,
  createDocumentSession,
  receiveExternalDocumentSource,
  rebaseLocalDocumentDraft,
  resolveDocumentConflictWithDisk,
  resolveDocumentConflictWithLocal,
  setDocumentMode,
} from "./session.ts";

describe("Document session", () => {
  it("restores a local draft without mislabeling it as the disk baseline", () => {
    const session = createDocumentSession({
      source: "Disk",
      revision: "r1",
      draftSource: "Local draft",
    });

    expect(session).toMatchObject({
      baselineSource: "Disk",
      baselineRevision: "r1",
      draftSource: "Local draft",
      editVersion: 1,
      confirmedEditVersion: 0,
    });
    expect(beginDocumentSave(session)).toMatchObject({
      source: "Local draft",
      expectedRevision: "r1",
      editVersion: 1,
    });
  });

  it("changes rich-document editability without creating a save intent", () => {
    const source = "- one\n  - two\n";
    let session = createDocumentSession({ source, revision: "sha256:before" });

    for (let index = 0; index < 100; index += 1) {
      session = setDocumentMode(session, "write");
      session = setDocumentMode(session, "read");
    }

    expect(session.draftSource).toBe(source);
    expect(session.editVersion).toBe(0);
    expect(beginDocumentSave(session)).toBeNull();
  });

  it("creates save intent only for an actual source change", () => {
    const initial = createDocumentSession({ source: "before\n", revision: "r1" });
    expect(applyUserDocumentSource(initial, "before\n")).toBe(initial);

    const changed = applyUserDocumentSource(initial, "after\n");
    expect(beginDocumentSave(changed)).toMatchObject({
      source: "after\n",
      expectedRevision: "r1",
      editVersion: 1,
    });
  });

  it("confirms one snapshot while retaining newer typing as dirty", () => {
    const initial = createDocumentSession({ source: "zero", revision: "r0" });
    const one = applyUserDocumentSource(initial, "one");
    const intent = beginDocumentSave(one)!;
    const two = applyUserDocumentSource(one, "two");
    const confirmed = confirmDocumentSave(two, intent, "r1");

    expect(confirmed.baselineSource).toBe("one");
    expect(confirmed.draftSource).toBe("two");
    expect(beginDocumentSave(confirmed)).toMatchObject({
      source: "two",
      expectedRevision: "r1",
      editVersion: 2,
    });
  });

  it("confirms exclusive recreation without manufacturing a new edit and never replays it once present", () => {
    const missing = {
      ...createDocumentSession({ source: "A", revision: "rA" }),
      currentMissing: true,
    };
    const intent = beginDocumentSave(missing)!;
    const newer = applyUserDocumentSource(missing, "B");
    const present = confirmDocumentSave(newer, intent, "rA");
    expect(present).toMatchObject({
      baselineSource: "A",
      baselineRevision: "rA",
      draftSource: "B",
      editVersion: 1,
      confirmedEditVersion: 0,
      currentMissing: false,
    });
    expect(beginDocumentSave(present)).toMatchObject({
      source: "B",
      expectedRevision: "rA",
      editVersion: 1,
    });
    expect(confirmDocumentSave(present, intent, "rA")).toBe(present);
    expect(
      confirmDocumentSave(
        missing,
        {
          mutationId: intent.mutationId,
          source: intent.source,
          expectedRevision: intent.expectedRevision,
          editVersion: intent.editVersion,
        },
        "rA",
      ),
    ).toBe(missing);
  });

  it("adopts external edits when clean and exposes conflicts when dirty", () => {
    const clean = createDocumentSession({ source: "disk one", revision: "r1" });
    const refreshed = receiveExternalDocumentSource(clean, { source: "disk two", revision: "r2" });
    expect(refreshed.draftSource).toBe("disk two");
    expect(refreshed.conflict).toBeNull();

    const dirty = applyUserDocumentSource(refreshed, "local three");
    const conflicted = receiveExternalDocumentSource(dirty, {
      source: "agent three",
      revision: "r3",
    });
    expect(conflicted.draftSource).toBe("local three");
    expect(conflicted.conflict).toEqual({
      externalSource: "agent three",
      externalRevision: "r3",
    });
    expect(beginDocumentSave(conflicted)).toBeNull();

    const keepDisk = resolveDocumentConflictWithDisk(conflicted);
    expect(keepDisk.draftSource).toBe("agent three");
    expect(beginDocumentSave(keepDisk)).toBeNull();

    const keepLocal = resolveDocumentConflictWithLocal(conflicted);
    expect(keepLocal.draftSource).toBe("local three");
    expect(beginDocumentSave(keepLocal)).toMatchObject({
      source: "local three",
      expectedRevision: "r3",
      editVersion: 1,
    });
  });

  it("rebases a local draft onto a complete host snapshot before a session conflict arrives", () => {
    const initial = createDocumentSession({ source: "disk zero", revision: "r0" });
    const dirty = applyUserDocumentSource(initial, "local one");
    const rebased = rebaseLocalDocumentDraft(dirty, {
      source: "agent one",
      revision: "r1",
    });

    expect(rebased.draftSource).toBe("local one");
    expect(rebased.baselineSource).toBe("agent one");
    expect(rebased.baselineRevision).toBe("r1");
    expect(rebased.conflict).toBeNull();
    expect(beginDocumentSave(rebased)).toMatchObject({
      source: "local one",
      expectedRevision: "r1",
      editVersion: 1,
    });
  });
});

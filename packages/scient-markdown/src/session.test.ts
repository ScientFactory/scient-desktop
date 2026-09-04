import { describe, expect, it } from "vite-plus/test";

import {
  applyUserMarkdownSource,
  beginMarkdownSave,
  confirmMarkdownSave,
  createMarkdownDocumentSession,
  receiveExternalMarkdownSource,
  rebaseLocalMarkdownDraft,
  resolveMarkdownConflictWithDisk,
  resolveMarkdownConflictWithLocal,
  setMarkdownDocumentMode,
} from "./session.ts";

describe("Markdown document session", () => {
  it("restores a local draft without mislabeling it as the disk baseline", () => {
    const session = createMarkdownDocumentSession({
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
    expect(beginMarkdownSave(session)).toEqual({
      source: "Local draft",
      expectedRevision: "r1",
      editVersion: 1,
    });
  });

  it("changes rich-document editability without creating a save intent", () => {
    const source = "- one\n  - two\n";
    let session = createMarkdownDocumentSession({ source, revision: "sha256:before" });

    for (let index = 0; index < 100; index += 1) {
      session = setMarkdownDocumentMode(session, "write");
      session = setMarkdownDocumentMode(session, "read");
    }

    expect(session.draftSource).toBe(source);
    expect(session.editVersion).toBe(0);
    expect(beginMarkdownSave(session)).toBeNull();
  });

  it("creates save intent only for an actual source change", () => {
    const initial = createMarkdownDocumentSession({ source: "before\n", revision: "r1" });
    expect(applyUserMarkdownSource(initial, "before\n")).toBe(initial);

    const changed = applyUserMarkdownSource(initial, "after\n");
    expect(beginMarkdownSave(changed)).toEqual({
      source: "after\n",
      expectedRevision: "r1",
      editVersion: 1,
    });
  });

  it("confirms one snapshot while retaining newer typing as dirty", () => {
    const initial = createMarkdownDocumentSession({ source: "zero", revision: "r0" });
    const one = applyUserMarkdownSource(initial, "one");
    const intent = beginMarkdownSave(one)!;
    const two = applyUserMarkdownSource(one, "two");
    const confirmed = confirmMarkdownSave(two, intent, "r1");

    expect(confirmed.baselineSource).toBe("one");
    expect(confirmed.draftSource).toBe("two");
    expect(beginMarkdownSave(confirmed)).toEqual({
      source: "two",
      expectedRevision: "r1",
      editVersion: 2,
    });
  });

  it("adopts external edits when clean and exposes conflicts when dirty", () => {
    const clean = createMarkdownDocumentSession({ source: "disk one", revision: "r1" });
    const refreshed = receiveExternalMarkdownSource(clean, { source: "disk two", revision: "r2" });
    expect(refreshed.draftSource).toBe("disk two");
    expect(refreshed.conflict).toBeNull();

    const dirty = applyUserMarkdownSource(refreshed, "local three");
    const conflicted = receiveExternalMarkdownSource(dirty, {
      source: "agent three",
      revision: "r3",
    });
    expect(conflicted.draftSource).toBe("local three");
    expect(conflicted.conflict).toEqual({
      externalSource: "agent three",
      externalRevision: "r3",
    });
    expect(beginMarkdownSave(conflicted)).toBeNull();

    const keepDisk = resolveMarkdownConflictWithDisk(conflicted);
    expect(keepDisk.draftSource).toBe("agent three");
    expect(beginMarkdownSave(keepDisk)).toBeNull();

    const keepLocal = resolveMarkdownConflictWithLocal(conflicted);
    expect(keepLocal.draftSource).toBe("local three");
    expect(beginMarkdownSave(keepLocal)).toEqual({
      source: "local three",
      expectedRevision: "r3",
      editVersion: 1,
    });
  });

  it("rebases a local draft onto a complete host snapshot before a session conflict arrives", () => {
    const initial = createMarkdownDocumentSession({ source: "disk zero", revision: "r0" });
    const dirty = applyUserMarkdownSource(initial, "local one");
    const rebased = rebaseLocalMarkdownDraft(dirty, {
      source: "agent one",
      revision: "r1",
    });

    expect(rebased.draftSource).toBe("local one");
    expect(rebased.baselineSource).toBe("agent one");
    expect(rebased.baselineRevision).toBe("r1");
    expect(rebased.conflict).toBeNull();
    expect(beginMarkdownSave(rebased)).toEqual({
      source: "local one",
      expectedRevision: "r1",
      editVersion: 1,
    });
  });
});

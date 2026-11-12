// @effect-diagnostics nodeBuiltinImport:off -- These tests exercise the project filesystem boundary directly.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { SCIENT_SOURCE_FULL_TEXT_PROFILE, type ScientSourceFullText } from "./fullText.ts";
import {
  listScientSourceFullTextHashes,
  readScientSourceFullText,
  removeScientSourceFullText,
  scientSourceFullTextByteLength,
  SCIENT_SOURCE_TEXT_DIRECTORY,
  writeScientSourceFullText,
} from "./fullTextStore.ts";

const sha256 = "ab".repeat(32);

const extracted: ScientSourceFullText = {
  formatVersion: 1,
  outcome: "extracted",
  sha256,
  byteLength: 1_024,
  profile: SCIENT_SOURCE_FULL_TEXT_PROFILE,
  extractor: { name: "pdfjs", version: "6.2.108" },
  extractedAt: "2026-11-10T00:00:00.000Z",
  pageCount: 1,
  complete: true,
  pages: [{ page: 1, text: "Hello\nworld", viewBox: [0, 0, 612, 792], rotation: 0, userUnit: 1 }],
};

async function temporaryRoot(): Promise<AsyncDisposable & { readonly root: string }> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-full-text-"));
  return {
    root,
    [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

describe("full-text store", () => {
  it("stores text by PDF hash and lists and removes it", async () => {
    await using project = await temporaryRoot();
    expect(await readScientSourceFullText(project.root, sha256)).toBeNull();
    expect(await scientSourceFullTextByteLength(project.root, sha256)).toBeNull();
    await writeScientSourceFullText(project.root, extracted);
    expect(await readScientSourceFullText(project.root, sha256)).toEqual(extracted);
    expect(await scientSourceFullTextByteLength(project.root, sha256)).toBeGreaterThan(0);
    expect(await listScientSourceFullTextHashes(project.root)).toEqual([sha256]);
    await removeScientSourceFullText(project.root, sha256);
    expect(await listScientSourceFullTextHashes(project.root)).toEqual([]);
  });

  it("treats a damaged or mislabelled text file as missing so it is extracted again", async () => {
    await using project = await temporaryRoot();
    await writeScientSourceFullText(project.root, extracted);
    const filePath = NodePath.join(
      project.root,
      SCIENT_SOURCE_TEXT_DIRECTORY,
      "ab",
      `${sha256}.json`,
    );
    await NodeFSP.writeFile(filePath, "{not json", "utf8");
    expect(await readScientSourceFullText(project.root, sha256)).toBeNull();
    await NodeFSP.writeFile(filePath, JSON.stringify({ ...extracted, sha256: "cd".repeat(32) }));
    expect(await readScientSourceFullText(project.root, sha256)).toBeNull();
  });

  it("refuses a symlinked text directory and a key that is not a digest", async () => {
    await using project = await temporaryRoot();
    await using outside = await temporaryRoot();
    await NodeFSP.mkdir(NodePath.join(project.root, ".scient", "sources"), { recursive: true });
    await NodeFSP.symlink(outside.root, NodePath.join(project.root, ".scient", "sources", "text"));
    await expect(writeScientSourceFullText(project.root, extracted)).rejects.toThrow(
      "not a safe directory",
    );
    expect(await NodeFSP.readdir(outside.root)).toEqual([]);
    await expect(readScientSourceFullText(project.root, "../escape")).rejects.toThrow("SHA-256");
  });
});

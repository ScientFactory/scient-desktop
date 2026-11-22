// @effect-diagnostics nodeBuiltinImport:off -- Managed bibliography tests exercise real project files.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import type { ScientSourceCandidate } from "@scientfactory/scient-sources";
import { importScientSource } from "@scientfactory/scient-sources/store";

export function sourceCandidate(sourceKey: string, title: string): ScientSourceCandidate {
  return {
    sourceKey,
    type: "article",
    customType: null,
    title,
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
    ],
    issuedRaw: "1843",
    issuedYear: 1843,
    identifiers: [],
    abstract: null,
    containerTitle: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: null,
    tags: [],
    externalReferences: [],
    fieldProvenance: [],
    pdfAvailable: false,
    pdfFileName: null,
    pdfAttachmentCount: 0,
  };
}

export async function addSource(root: string, sourceKey: string, title: string) {
  await importScientSource({
    root,
    operationId: NodeCrypto.randomUUID(),
    candidate: sourceCandidate(sourceKey, title),
  });
}

export const readProjectFile = (root: string, name: string) =>
  NodeFSP.readFile(NodePath.join(root, name), "utf8");

type FileSystemOverrides = {
  link?: typeof NodeFSP.link;
  open?: typeof NodeFSP.open;
  lstat?: typeof NodeFSP.lstat;
};

/** Replaces `node:fs/promises` functions for code that imports the namespace, until disposed. */
export function overrideFileSystem(
  overrides: (original: Required<FileSystemOverrides>) => FileSystemOverrides,
): Disposable {
  // The mutable module object behind the namespace, so the helper sees the injected functions.
  const fsPromises: Required<FileSystemOverrides> = NodeModule.createRequire(import.meta.url)(
    "node:fs/promises",
  );
  const original = { link: fsPromises.link, open: fsPromises.open, lstat: fsPromises.lstat };
  Object.assign(fsPromises, overrides(original));
  NodeModule.syncBuiltinESMExports();
  return {
    [Symbol.dispose]() {
      Object.assign(fsPromises, original);
      NodeModule.syncBuiltinESMExports();
    },
  };
}

export const nodeError = (code: string) => Object.assign(new Error(`synthetic ${code}`), { code });

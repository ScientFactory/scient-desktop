// @effect-diagnostics nodeBuiltinImport:off -- Test support: reads a project's displaced-copy file.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  scientDisplacedCopyInternals,
  type ScientDisplacedCopy,
  type ScientDisplacedHolder,
} from "../projectDisplacedCopies.ts";

const { displacedPath, verifiedDirectory, readVerifiedFile, decodeDisplacedFile } =
  scientDisplacedCopyInternals;

/** One holder's kept copies; throws on a file a reader would refuse. */
export async function readScientDisplacedCopies(
  root: string,
  holder: ScientDisplacedHolder,
): Promise<ReadonlyArray<ScientDisplacedCopy>> {
  const canonicalRoot = await NodeFSP.realpath(root);
  const filePath = displacedPath(canonicalRoot, holder);
  const dirId = await verifiedDirectory(canonicalRoot, NodePath.dirname(filePath));
  if (!dirId) return [];
  const read = await readVerifiedFile(canonicalRoot, filePath, dirId);
  if (read.kind === "missing") return [];
  return decodeDisplacedFile(JSON.parse(read.text)).copies;
}

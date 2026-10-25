import type { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import { EnvironmentId } from "@t3tools/contracts";
import { saveEnvironmentPdfEdit } from "@t3tools/client-runtime/state/scient-pdf-edits";
import { runtime } from "~/lib/runtime";
import { readPreparedConnection } from "~/state/session";

export async function savePdfEdits(input: {
  source: PdfSourceDescriptor;
  expectedRevision: string;
  operationId: string;
  bytes: Uint8Array;
}) {
  const prepared = readPreparedConnection(EnvironmentId.make(input.source.authority));
  if (!prepared) throw new Error("The PDF's environment is not connected.");
  return runtime.runPromise(saveEnvironmentPdfEdit({ ...input, prepared }));
}

import { createScientDocumentPdfEnvironmentAtoms } from "@t3tools/client-runtime/state/scientDocumentPdf";

import { connectionAtomRuntime } from "../connection/runtime";

export const scientDocumentPdfEnvironment =
  createScientDocumentPdfEnvironmentAtoms(connectionAtomRuntime);

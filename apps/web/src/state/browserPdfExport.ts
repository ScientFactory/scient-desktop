import { createBrowserPdfExportEnvironmentAtoms } from "@t3tools/client-runtime/state/browserPdfExport";

import { connectionAtomRuntime } from "../connection/runtime";

export const browserPdfExportEnvironment =
  createBrowserPdfExportEnvironmentAtoms(connectionAtomRuntime);

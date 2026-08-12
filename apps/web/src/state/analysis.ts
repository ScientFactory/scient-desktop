import { createAnalysisEnvironmentAtoms } from "@t3tools/client-runtime/state/analysis";

import { connectionAtomRuntime } from "../connection/runtime";

export const analysisEnvironment = createAnalysisEnvironmentAtoms(connectionAtomRuntime);

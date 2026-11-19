/** Reuse the native import fixtures. */
import * as Layer from "effect/Layer";
import { layer as OrchestrationCommandReceiptRepositoryLive } from "../../persistence/OrchestrationCommandReceipts.ts";

import {
  createNativeProjects,
  nativeImportTestLayer,
  type NativeImportTestControls,
} from "./conversationImport.native-test-harness.ts";

export type ImportTestControls = NativeImportTestControls;

export const importTestLayer = (controls: ImportTestControls = {}) =>
  OrchestrationCommandReceiptRepositoryLive.pipe(
    Layer.provideMerge(nativeImportTestLayer(controls)),
  );

export const createProjects = createNativeProjects;

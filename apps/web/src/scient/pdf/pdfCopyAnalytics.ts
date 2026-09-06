import type { AssetCopyResult } from "@scientfactory/document-artifacts";
import type { EnvironmentId } from "@t3tools/contracts";
import { beginScientUiOperation } from "../analytics/client";

/** Observe the host's save receipt without reading its path or changing the result. */
export async function observePdfCopy(
  environmentId: EnvironmentId,
  task: () => Promise<AssetCopyResult>,
): Promise<AssetCopyResult> {
  const finish = beginScientUiOperation(environmentId, "document-export");
  try {
    const result = await task();
    switch (result._tag) {
      case "saved":
        finish("completed");
        break;
      case "cancelled":
        finish("cancelled");
        break;
      case "failed":
        finish("failed");
        break;
      // The browser has no durable-save receipt. Do not invent success or failure.
      case "download-started":
        finish(null);
        break;
    }
    return result;
  } catch (error) {
    finish("failed");
    throw error;
  }
}

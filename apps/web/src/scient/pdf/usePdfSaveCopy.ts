import type { AssetCopyResult, PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { assetEnvironment } from "~/state/assets";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { pdfSourceAssetResource, saveResolvedPdfCopy } from "./pdfSource";

export function usePdfSaveCopy(environmentId: EnvironmentId) {
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });

  return useCallback(
    async (source: PdfSourceDescriptor): Promise<AssetCopyResult> => {
      if (String(source.authority) !== String(environmentId)) {
        throw new Error("The PDF belongs to a different environment.");
      }
      if (httpBaseUrl === null) {
        throw new Error("The environment connection is unavailable.");
      }

      const issued = await createAssetUrl({
        environmentId,
        input: { resource: pdfSourceAssetResource(source) },
      });
      if (issued._tag === "Failure") throw squashAtomCommandFailure(issued);

      const url = resolveAssetUrl(httpBaseUrl, issued.value.relativeUrl);
      if (url === null) throw new Error("The environment returned an invalid PDF URL.");

      return saveResolvedPdfCopy(source, {
        url,
        expiresAt: issued.value.expiresAt,
        refresh: () => undefined,
      });
    },
    [createAssetUrl, environmentId, httpBaseUrl],
  );
}

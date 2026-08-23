import { type AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentFilePath,
  type AssetCreateUrlResult,
  type AssetResource,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { resolveAssetUrl } from "~/assets/assetUrls";
import {
  BrowserPreviewUnavailableError,
  openUrlInPreview,
  type OpenPreviewMutation,
} from "~/browser/openFileInPreview";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useHtmlPdfSourceStore } from "../documentExport/htmlPdfSourceStore";

export function environmentFileAssetResource(input: {
  readonly path: string;
  readonly access?: "exact" | "html-document";
}): AssetResource {
  return {
    _tag: "environment-file",
    path: EnvironmentFilePath.make(input.path),
    access: input.access ?? "exact",
  };
}

export async function openEnvironmentFileInPreview<AssetError, PreviewError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly path: string;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, AssetError>>;
  readonly openPreview: OpenPreviewMutation<PreviewError>;
}): Promise<AtomCommandResult<void, AssetError | PreviewError | BrowserPreviewUnavailableError>> {
  if (!isPreviewSupportedInRuntime()) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message: "The integrated browser is unavailable in this runtime.",
        }),
      ),
    );
  }
  const assetResult = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: environmentFileAssetResource({
        path: input.path,
        access: "html-document",
      }),
    },
  });
  if (assetResult._tag === "Failure") return AsyncResult.failure(assetResult.cause);
  const assetUrl = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
  if (assetUrl === null) {
    return AsyncResult.failure(
      Cause.die(new Error("The environment returned an invalid asset URL.")),
    );
  }
  return openUrlInPreview({
    threadRef: input.threadRef,
    url: assetUrl,
    openPreview: input.openPreview,
    onOpened: (snapshot) => {
      useHtmlPdfSourceStore.getState().bind({
        threadRef: input.threadRef,
        tabId: snapshot.tabId,
        authorizedUrl: assetUrl,
        source: {
          _tag: "environment-html",
          environmentId: input.threadRef.environmentId,
          canonicalPath: EnvironmentFilePath.make(assetResult.value.sourcePath ?? input.path),
        },
      });
    },
  });
}

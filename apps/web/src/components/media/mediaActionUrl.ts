import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";

export interface MediaActionLocation {
  readonly src: string | null;
  readonly asset?: { readonly environmentId: EnvironmentId; readonly resource: AssetResource };
}

/** Resolve authorization for a byte action without changing the displayed image. */
export async function resolveMediaActionUrl(
  source: MediaActionLocation,
  resolveAsset: (asset: NonNullable<MediaActionLocation["asset"]>) => Promise<{
    readonly httpBaseUrl: string;
    readonly relativeUrl: string;
  }>,
): Promise<string> {
  if (!source.asset) {
    if (!source.src) throw new Error("This media is unavailable. Try reopening the preview.");
    return source.src;
  }
  const result = await resolveAsset(source.asset);
  const url = resolveAssetUrl(result.httpBaseUrl, result.relativeUrl);
  if (!url) throw new Error("The environment returned an invalid media URL.");
  return url;
}

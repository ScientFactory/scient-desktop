"use client";

import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import {
  previewStaticImageRevisionKey,
  type PreviewStaticImageSurfaceDescriptor,
} from "~/previewStaticImageSurface";

import { PreviewImageSurface } from "./PreviewImageSurface";

export function StaticAssetImageSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly image: PreviewStaticImageSurfaceDescriptor;
  readonly className?: string;
  readonly refreshToken?: number;
}) {
  const asset = useAssetUrlState(props.environmentId, props.image.resource);
  const autoRetriedRevisionRef = useRef<string | null>(null);
  const refreshedExpiredUrlRef = useRef<string | null>(null);
  const previousRefreshTokenRef = useRef(props.refreshToken);
  const revisionKey = previewStaticImageRevisionKey(props.image);
  const refreshAsset = asset.refresh;
  const assetUrl = asset._tag === "Success" ? asset.url : null;
  const assetExpiresAt = asset._tag === "Success" ? asset.expiresAt : null;

  useEffect(() => {
    if (previousRefreshTokenRef.current === props.refreshToken) return;
    previousRefreshTokenRef.current = props.refreshToken;
    autoRetriedRevisionRef.current = null;
    refreshAsset();
  }, [props.refreshToken, refreshAsset]);

  useEffect(() => {
    if (!assetUrl || assetExpiresAt === null || assetExpiresAt > Date.now() + 5_000) return;
    if (refreshedExpiredUrlRef.current === assetUrl) return;
    refreshedExpiredUrlRef.current = assetUrl;
    refreshAsset();
  }, [assetExpiresAt, assetUrl, refreshAsset]);

  if (asset._tag !== "Success") {
    return (
      <div
        className={cn(
          "flex min-h-0 items-center justify-center bg-background text-xs text-muted-foreground",
          props.className,
        )}
      >
        {asset._tag === "Loading" ? (
          "Loading figure…"
        ) : (
          <div className="flex items-center gap-2">
            <span>Unable to load figure</span>
            <Button size="xs" variant="outline" onClick={refreshAsset}>
              Try again
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <PreviewImageSurface
      source={{ url: asset.url, alt: props.image.label }}
      {...(props.className === undefined ? {} : { className: props.className })}
      onLoadError={() => {
        if (autoRetriedRevisionRef.current === revisionKey) return;
        autoRetriedRevisionRef.current = revisionKey;
        refreshAsset();
      }}
    />
  );
}

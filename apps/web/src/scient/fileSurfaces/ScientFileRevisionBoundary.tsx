import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { Fragment, useState, type ReactNode } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { FileSurfaceLoading } from "~/components/files/fileSurfaceChrome";
import { DocumentIdentityContext } from "../documentCache/documentIdentity";

/**
 * Keeps a preview mounted while its file is unchanged: each move of `refreshToken` checks the
 * file's revision, and only a new one remounts it (without revisions, every move does). The
 * preview opens once the revision is known, named in DocumentIdentityContext for documentCache.
 */
export function ScientFileRevisionBoundary(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: AssetResource;
  readonly refreshToken: string;
  readonly children: ReactNode;
}) {
  const asset = useAssetUrlState(props.environmentId, props.resource, props.refreshToken);
  // While a check runs, or when it fails, the preview stays as it is.
  const known = asset._tag === "Success" ? asset.fileRevision : undefined;
  const revision = asset._tag === "Success" ? (known ?? `unknown:${props.refreshToken}`) : null;
  const [shown, setShown] = useState<{
    revision: string | null;
    known: boolean;
    generation: number;
    failed: boolean;
  }>({ revision: null, known: false, generation: 0, failed: false });
  // A preview opened while its file could not be read failed too: it retries once the file can be.
  if (asset._tag === "Failure" && shown.revision === null && !shown.failed)
    setShown({ ...shown, failed: true });
  if (revision !== null && revision !== shown.revision)
    setShown({
      revision,
      known: known !== undefined,
      failed: false,
      // The first revision read is the one the preview opened with.
      generation:
        shown.revision === null && !shown.failed ? shown.generation : shown.generation + 1,
    });
  if (shown.revision === null && !shown.failed && asset._tag !== "Failure")
    return <FileSurfaceLoading />;
  const identity = shown.known
    ? JSON.stringify([props.environmentId, props.resource, shown.revision])
    : null;
  return (
    <DocumentIdentityContext value={identity}>
      <Fragment key={shown.generation}>{props.children}</Fragment>
    </DocumentIdentityContext>
  );
}

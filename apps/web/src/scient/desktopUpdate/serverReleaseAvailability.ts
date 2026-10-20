import { useAtomValue } from "@effect/atom-react";
import {
  isExactScientReleaseVersion,
  scientReleaseRepository,
  scientServerAssetName,
  scientServerPackageSpec,
} from "@t3tools/shared/scientRelease";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  assets: Schema.Array(Schema.Struct({ name: Schema.String, browser_download_url: Schema.String })),
});

/** Availability only: the server still owns artifact installation, preflight and update authority. */
export function hasScientServerReleaseArtifact(
  version: string,
  release: typeof Release.Type,
): boolean {
  return (
    isExactScientReleaseVersion(version) &&
    !release.draft &&
    release.tag_name === `v${version}` &&
    release.assets.some(
      (asset) =>
        asset.name === scientServerAssetName(version) &&
        asset.browser_download_url === scientServerPackageSpec(version),
    )
  );
}

const releasePublishedAtom = Atom.family((version: string) =>
  Atom.make(
    Effect.gen(function* () {
      const response = yield* HttpClient.get(
        `https://api.github.com/repos/${scientReleaseRepository(version)}/releases/tags/v${encodeURIComponent(version)}`,
      );
      if (response.status === 404) return false;
      const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.json),
        Effect.flatMap(Schema.decodeUnknownEffect(Release)),
      );
      return hasScientServerReleaseArtifact(version, body);
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`scient-server-release:${version}`),
  ),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(false));

/** Previous success inside a failed or refreshing response is not current availability proof. */
export function isCurrentScientServerReleasePublished<E>(
  result: AsyncResult.AsyncResult<boolean, E>,
): boolean {
  return AsyncResult.isSuccess(result) && !result.waiting && result.value;
}

/** Unknown, private, unpublished or failed responses never admit a bulk service update. */
export function useScientServerReleasePublished(version: string | null): boolean {
  const result = useAtomValue(
    version && isExactScientReleaseVersion(version)
      ? releasePublishedAtom(version)
      : NO_VERSION_ATOM,
  );
  return isCurrentScientServerReleasePublished(result);
}

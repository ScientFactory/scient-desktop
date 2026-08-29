import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  EnvironmentFilePath,
  type EnvironmentFileChangeEvent,
  type EnvironmentFilePrepareResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatEnvironmentQueryError } from "~/state/query";

import { environmentFileChanges } from "./environmentFileChanges";
import { environmentFilePreparation } from "./environmentFileState";

export interface EnvironmentFileChangeCursor {
  readonly watchedPath: string;
  readonly event: EnvironmentFileChangeEvent | null;
}

export function advanceEnvironmentFileChangeCursor(
  cursor: EnvironmentFileChangeCursor,
  watchedPath: string,
  event: EnvironmentFileChangeEvent | null,
): { readonly cursor: EnvironmentFileChangeCursor; readonly shouldRefresh: boolean } {
  const previousEvent = cursor.watchedPath === watchedPath ? cursor.event : null;
  if (event === null || event === previousEvent) {
    return {
      cursor: { watchedPath, event: previousEvent },
      shouldRefresh: false,
    };
  }
  return {
    cursor: { watchedPath, event },
    shouldRefresh: true,
  };
}

export function resolveEnvironmentFileWatchPath(
  requestedPath: string,
  preparedFile: Pick<EnvironmentFilePrepareResult, "canonicalPath"> | null,
): string {
  return preparedFile?.canonicalPath ?? requestedPath;
}

export interface EnvironmentFileRefreshView {
  readonly automaticRefreshUnavailable: boolean;
  readonly error: string | null;
  readonly file: EnvironmentFilePrepareResult | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
  readonly refreshToken: number;
}

/**
 * Keeps a read-only host-file preview current. Watch events are invalidation
 * hints only: every readiness or change event repeats the authoritative
 * inspection and renews the mounted viewer's asset revision.
 */
export function useEnvironmentFileRefresh(input: {
  readonly environmentId: EnvironmentId;
  readonly path: string;
}): EnvironmentFileRefreshView {
  const preparationAtom = environmentFilePreparation({
    environmentId: input.environmentId,
    input: { path: EnvironmentFilePath.make(input.path) },
  });
  const preparation = useAtomValue(preparationAtom);
  const refreshPreparation = useAtomRefresh(preparationAtom);
  const file = Option.getOrNull(AsyncResult.value(preparation));
  const watchedPath = resolveEnvironmentFileWatchPath(input.path, file);
  const fileChangeAtom = environmentFileChanges({
    environmentId: input.environmentId,
    input: { path: EnvironmentFilePath.make(watchedPath) },
  });
  const fileChangeResult = useAtomValue(fileChangeAtom);
  const refreshFileChanges = useAtomRefresh(fileChangeAtom);
  const fileChange = Option.getOrNull(AsyncResult.value(fileChangeResult));
  const [refreshToken, setRefreshToken] = useState(0);
  const cursorRef = useRef<EnvironmentFileChangeCursor>({
    watchedPath,
    event: null,
  });

  const refreshPreview = useCallback(() => {
    refreshPreparation();
    setRefreshToken((current) => current + 1);
  }, [refreshPreparation]);

  useEffect(() => {
    const observation = advanceEnvironmentFileChangeCursor(
      cursorRef.current,
      watchedPath,
      fileChange,
    );
    cursorRef.current = observation.cursor;
    if (observation.shouldRefresh) refreshPreview();
  }, [fileChange, refreshPreview, watchedPath]);

  const automaticRefreshUnavailable = fileChangeResult._tag === "Failure";
  const refresh = useCallback(() => {
    refreshPreview();
    refreshFileChanges();
  }, [refreshFileChanges, refreshPreview]);

  return {
    automaticRefreshUnavailable,
    error: preparation._tag === "Failure" ? formatEnvironmentQueryError(preparation.cause) : null,
    file,
    isPending: preparation.waiting,
    refresh,
    refreshToken,
  };
}

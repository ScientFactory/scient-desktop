import { useState } from "react";

import { isScientSavedViewFile } from "./dataFiles";

export function useSavedDataViewPreview(
  path: string | null,
  contents: string | undefined,
  runAfterPendingSave: (paths: ReadonlyArray<string>, apply: () => void) => void,
) {
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  if (path === null || !isScientSavedViewFile(path, contents)) return null;

  return {
    path,
    rendered: sourcePath !== path,
    setRendered(pressed: boolean, onApplied: () => void) {
      runAfterPendingSave([path], () => {
        setSourcePath(pressed ? null : path);
        onApplied();
      });
    },
  };
}

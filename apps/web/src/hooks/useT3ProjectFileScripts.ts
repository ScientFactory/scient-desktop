import {
  SCIENT_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectFileName,
  type T3ProjectFile,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

export interface T3ProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  file: T3ProjectFile | null;
  scripts: ReadonlyArray<T3ProjectFileScript>;
  refresh: () => void;
  // SCIENT-FORK: the file the project has, or scient.json when it has neither.
  fileName: ProjectFileName;
}

export function useT3ProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): T3ProjectFileState {
  // SCIENT-FORK:START — scient.json first; t3.json only when the project has no scient.json.
  const scientQuery = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    SCIENT_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const scientMissing = cwd !== null && !scientQuery.isPending && scientQuery.data === null;
  const t3Query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    T3_PROJECT_FILE_NAME,
    scientMissing,
  );
  const usesT3 = scientMissing && t3Query.data !== null;
  const query = usesT3 ? t3Query : scientQuery;
  const fileName = usesT3 ? T3_PROJECT_FILE_NAME : SCIENT_PROJECT_FILE_NAME;
  const isPending = scientQuery.isPending || (scientMissing && t3Query.isPending);
  const refresh = () => {
    scientQuery.refresh();
    if (scientMissing) t3Query.refresh();
  };
  // SCIENT-FORK:END
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  if (contents === null) {
    return {
      status: isPending ? "loading" : "missing",
      file: null,
      scripts: NO_SCRIPTS,
      refresh,
      fileName,
    } as const;
  }
  const file = parseT3ProjectFile(contents);
  if (file === null) {
    return { status: "invalid", file: null, scripts: NO_SCRIPTS, refresh, fileName } as const;
  }
  return {
    status: "valid",
    file,
    scripts: file.scripts ?? NO_SCRIPTS,
    refresh,
    fileName,
  } as const;
}

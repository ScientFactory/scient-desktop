import {
  SCIENT_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectFileName,
  type T3ProjectFile,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";

import { useState } from "react";

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
  // The last settled choice holds while a refresh reads scient.json again, so a t3.json project
  // keeps its scripts on screen; a scient.json that fails to read never hands over to t3.json.
  const scientQuery = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    SCIENT_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const key = `${environmentId}\0${cwd ?? ""}`;
  const settled = scientQuery.isPending
    ? null
    : scientQuery.data !== null
      ? "scient"
      : scientQuery.isMissing
        ? "t3"
        : "none";
  const [lastChoice, setLastChoice] = useState<{
    readonly key: string;
    readonly choice: "scient" | "t3" | "none";
  } | null>(null);
  if (settled !== null && (lastChoice?.key !== key || lastChoice.choice !== settled)) {
    setLastChoice({ key, choice: settled });
  }
  const choice = settled ?? (lastChoice?.key === key ? lastChoice.choice : null);
  const t3Query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    T3_PROJECT_FILE_NAME,
    cwd !== null && choice === "t3",
  );
  const usesT3 = choice === "t3";
  const query = usesT3 ? t3Query : scientQuery;
  const fileName = usesT3 ? T3_PROJECT_FILE_NAME : SCIENT_PROJECT_FILE_NAME;
  const isPending = cwd !== null && (choice === null || query.isPending);
  const refresh = () => {
    scientQuery.refresh();
    if (usesT3) t3Query.refresh();
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

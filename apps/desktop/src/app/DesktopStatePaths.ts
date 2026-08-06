import * as Option from "effect/Option";
import { SCIENT_NEXT_IDENTITY } from "@t3tools/shared/scientNextIdentity";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(scientNextHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(scientNextHome)) {
    return Option.none();
  }
  const trimmed = scientNextHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly scientNextHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.scientNextHome), () =>
    input.joinPath(input.homeDirectory, SCIENT_NEXT_IDENTITY.baseDirName),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
}): string {
  // Development must remain separate from production even when the launcher
  // supplies an explicit candidate home. A shared base is safe; a shared
  // userdata database is not.
  const useDevSubdir = input.isDevelopment;
  return input.joinPath(
    input.baseDir,
    useDevSubdir ? SCIENT_NEXT_IDENTITY.developmentUserDataDirName : "userdata",
  );
}

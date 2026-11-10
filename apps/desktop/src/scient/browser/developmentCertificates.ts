/**
 * Development builds only (`VITE_DEV_SERVER_URL` set): the app's browser trusts the certificates
 * whose SPKI hashes are listed in `server-browser/dev-trusted-spki.txt` of the candidate's own
 * state folder, so sign-ins can be tested against a local HTTPS fixture. Installed apps never
 * read the file.
 */
import * as Option from "effect/Option";

import {
  type JoinPath,
  resolveDesktopBaseDir,
  resolveDesktopStateDir,
} from "../../app/DesktopStatePaths.ts";

const SPKI = /^[A-Za-z0-9+/]{43}=$/u;

export function developmentTrustedCertificates(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly readFileString: (path: string) => string;
}): string | null {
  if ((input.env.VITE_DEV_SERVER_URL ?? "").trim() === "") return null;
  const stateDir = resolveDesktopStateDir({
    baseDir: resolveDesktopBaseDir({
      homeDirectory: input.homeDirectory,
      joinPath: input.joinPath,
      scientNextHome: Option.fromUndefinedOr(input.env.SCIENT_NEXT_HOME),
    }),
    isDevelopment: true,
    joinPath: input.joinPath,
  });
  let text = "";
  try {
    text = input.readFileString(input.joinPath(stateDir, "server-browser", "dev-trusted-spki.txt"));
  } catch {
    return null;
  }
  const hashes = text
    .split(/\s+/u)
    .map((line) => line.trim())
    .filter((line) => SPKI.test(line));
  return hashes.length === 0 ? null : hashes.join(",");
}

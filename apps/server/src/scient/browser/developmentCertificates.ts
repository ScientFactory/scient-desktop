// @effect-diagnostics nodeBuiltinImport:off -- Read once at browser launch, outside any Effect.
/**
 * Development candidates only: the server browser trusts the certificates whose SPKI hashes are
 * listed in `server-browser/dev-trusted-spki.txt` of the candidate's own state folder, so a local
 * HTTPS test site (a sign-in fixture) can be used. Installed apps never read the file.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const SPKI = /^[A-Za-z0-9+/]{43}=$/u;

export async function developmentTrustedCertificateArgs(
  env: NodeJS.ProcessEnv,
  profilesDir: string,
): Promise<ReadonlyArray<string>> {
  if (env.SCIENT_NEXT_DEVELOPMENT_STATE !== "true") return [];
  const file = NodePath.join(profilesDir, "..", "dev-trusted-spki.txt");
  const text = await NodeFSP.readFile(file, "utf8").catch(() => "");
  const hashes = text
    .split(/\s+/u)
    .map((line) => line.trim())
    .filter((line) => SPKI.test(line));
  return hashes.length === 0 ? [] : [`--ignore-certificate-errors-spki-list=${hashes.join(",")}`];
}

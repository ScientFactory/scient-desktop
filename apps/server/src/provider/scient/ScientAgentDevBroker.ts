// @effect-diagnostics nodeBuiltinImport:off - Checks permissions and links without opening the broker credential.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const BROKER_URL = "http://127.0.0.1:8765";
const TOKEN_FILE = "auth-broker.token";

/** Gives a managed macOS dev agent a reference to the owner-enabled local broker. */
export async function prepareScientAgentDevBroker(input: {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly home: string;
  readonly root: string;
  readonly userId: number | undefined;
}): Promise<string | undefined> {
  const { environment } = input;
  if (
    input.platform !== "darwin" ||
    environment.SCIENT_LOCAL_DEV_APP_MANAGED !== "1" ||
    environment.SCIENT_NEXT_DEVELOPMENT_STATE !== "true" ||
    environment.SCIENT_DEV_IDENTITY === "off" ||
    input.userId === undefined
  ) {
    return undefined;
  }

  const brokerRoot = NodePath.join(input.home, ".local", "share", "scient-dev-chatgpt");
  const source = NodePath.join(brokerRoot, TOKEN_FILE);
  const [directory, consent, token] = await Promise.all(
    [brokerRoot, NodePath.join(brokerRoot, "share-with-dev-apps"), source].map((path) =>
      NodeFSP.lstat(path).catch(() => undefined),
    ),
  );
  const isPrivate = (entry: typeof token) =>
    entry !== undefined && entry.uid === input.userId && (entry.mode & 0o077) === 0;
  if (
    !directory?.isDirectory() ||
    !consent?.isFile() ||
    !token?.isFile() ||
    !isPrivate(directory) ||
    !isPrivate(consent) ||
    !isPrivate(token)
  ) {
    return undefined;
  }

  const target = NodePath.join(input.root, TOKEN_FILE);
  try {
    await NodeFSP.symlink(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A candidate with its own broker keeps it. Only links this setup owns are reused.
    const existing = await NodeFSP.readlink(target).catch(() => undefined);
    if (existing !== source) return undefined;
  }
  return BROKER_URL;
}

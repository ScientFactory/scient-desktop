// @effect-diagnostics nodeBuiltinImport:off - Checks filesystem ownership and permissions without opening credentials.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const BROKER_SOCKET = "broker.sock";
const TOKEN_FILE = "auth-broker.token";

/** Finds an owner-enabled socket without writing anything into the dev agent's state. */
export async function prepareScientAgentDevBroker(input: {
  readonly platform: NodeJS.Platform;
  readonly desktop: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly home: string;
  readonly userId: number | undefined;
}): Promise<string | undefined> {
  const { environment } = input;
  if (
    input.platform !== "darwin" ||
    !input.desktop ||
    environment.SCIENT_LOCAL_DEV_APP_MANAGED !== "1" ||
    environment.SCIENT_NEXT_DEVELOPMENT_STATE !== "true" ||
    environment.SCIENT_DEV_IDENTITY === "off" ||
    input.userId === undefined
  ) {
    return undefined;
  }

  const brokerRoot = NodePath.join(input.home, ".local", "share", "scient-dev-chatgpt");
  const source = NodePath.join(brokerRoot, TOKEN_FILE);
  const socketPath = NodePath.join(brokerRoot, BROKER_SOCKET);
  const [directory, consent, token, socket] = await Promise.all(
    [brokerRoot, NodePath.join(brokerRoot, "share-with-dev-apps"), source, socketPath].map((path) =>
      NodeFSP.lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }),
    ),
  );
  const isPrivate = (entry: typeof token) =>
    entry !== undefined && entry.uid === input.userId && (entry.mode & 0o077) === 0;
  if (
    !directory?.isDirectory() ||
    !consent?.isFile() ||
    !token?.isFile() ||
    !socket?.isSocket() ||
    socket.uid !== input.userId ||
    !isPrivate(directory) ||
    !isPrivate(consent) ||
    !isPrivate(token)
  ) {
    return undefined;
  }

  return `unix:${socketPath}`;
}

import fs from "node:fs";
import path from "node:path";

import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_EXECUTABLE_FILE_MODE,
  PRIVATE_FILE_MODE,
  PrivatePathPermissionError,
  supportsPosixPermissions,
  withPrivatePathContext,
} from "@synara/shared/privatePathPermissions";

export {
  ensurePrivateDirectorySync,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_EXECUTABLE_FILE_MODE,
  PRIVATE_FILE_MODE,
  PrivatePathPermissionError,
  supportsPosixPermissions,
} from "@synara/shared/privatePathPermissions";

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(["EINVAL", "ENOTSUP", "EBADF"]);

const withPathContext = withPrivatePathContext;

/** Flushes directory-entry changes where the platform exposes durable directory fsync. */
export async function syncDirectoryEntry(
  directoryPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!supportsPosixPermissions(platform)) return;

  const handle = await fs.promises.open(
    directoryPath,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    await handle.sync().catch((cause) => {
      const code = (cause as NodeJS.ErrnoException).code;
      if (!code || !UNSUPPORTED_DIRECTORY_SYNC_CODES.has(code)) throw cause;
    });
  } finally {
    await handle.close();
  }
}

export function repairPrivateFileSync(
  filePath: string,
  options: {
    readonly executable?: boolean;
    readonly platform?: NodeJS.Platform;
  } = {},
): void {
  if (!supportsPosixPermissions(options.platform)) return;
  const targetMode = options.executable ? PRIVATE_EXECUTABLE_FILE_MODE : PRIVATE_FILE_MODE;
  const descriptor = withPathContext("open without following symlinks", filePath, () =>
    fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
  );
  try {
    withPathContext("set mode on", filePath, () => {
      if (!fs.fstatSync(descriptor).isFile()) {
        throw new Error("Path is not a regular file");
      }
      fs.fchmodSync(descriptor, targetMode);
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

export function ensurePrivateFileSync(
  filePath: string,
  options: {
    readonly executable?: boolean;
    readonly platform?: NodeJS.Platform;
  } = {},
): void {
  if (!supportsPosixPermissions(options.platform)) {
    withPathContext("create", filePath, () => {
      const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o600);
      fs.closeSync(descriptor);
    });
    return;
  }

  const targetMode = options.executable ? PRIVATE_EXECUTABLE_FILE_MODE : PRIVATE_FILE_MODE;
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW;
  const descriptor = withPathContext("open without following symlinks", filePath, () =>
    fs.openSync(filePath, flags, targetMode),
  );
  try {
    withPathContext("set mode on", filePath, () => {
      if (!fs.fstatSync(descriptor).isFile()) {
        throw new Error("Path is not a regular file");
      }
      fs.fchmodSync(descriptor, targetMode);
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function repairPrivateFile(
  filePath: string,
  options: {
    readonly executable?: boolean;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<void> {
  if (!supportsPosixPermissions(options.platform)) return;
  const targetMode = options.executable ? PRIVATE_EXECUTABLE_FILE_MODE : PRIVATE_FILE_MODE;
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (cause) {
    throw new PrivatePathPermissionError("open without following symlinks", filePath, cause);
  }
  try {
    try {
      if (!(await handle.stat()).isFile()) {
        throw new Error("Path is not a regular file");
      }
      await handle.chmod(targetMode);
    } catch (cause) {
      throw new PrivatePathPermissionError("set mode on", filePath, cause);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Repairs a private tree without following symlinks. Owner-executable files
 * keep that capability, while all group/other access is removed.
 */
export function repairPrivateTreeSync(
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!supportsPosixPermissions(platform)) return;

  const visit = (entryPath: string, isRoot = false): void => {
    const stat = withPathContext("inspect", entryPath, () => fs.lstatSync(entryPath));
    if (stat.isSymbolicLink()) {
      if (isRoot) {
        throw new PrivatePathPermissionError(
          "repair",
          entryPath,
          new Error("Refusing to follow a symlinked private-tree root"),
        );
      }
      return;
    }
    if (stat.isDirectory()) {
      withPathContext("set mode on", entryPath, () =>
        fs.chmodSync(entryPath, PRIVATE_DIRECTORY_MODE),
      );
      const entries = withPathContext("read", entryPath, () => fs.readdirSync(entryPath));
      for (const entry of entries) {
        visit(path.join(entryPath, entry));
      }
      return;
    }
    if (stat.isFile()) {
      repairPrivateFileSync(entryPath, {
        executable: (stat.mode & 0o100) !== 0,
        platform,
      });
    }
  };

  visit(rootPath, true);
}

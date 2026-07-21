import fs from "node:fs";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_EXECUTABLE_FILE_MODE = 0o700;

export class PrivatePathPermissionError extends Error {
  readonly path: string;
  readonly operation: string;

  constructor(operation: string, targetPath: string, cause: unknown) {
    super(`Failed to ${operation} private path ${targetPath}`, { cause });
    this.name = "PrivatePathPermissionError";
    this.path = targetPath;
    this.operation = operation;
  }
}

export function withPrivatePathContext<T>(
  operation: string,
  targetPath: string,
  action: () => T,
): T {
  try {
    return action();
  } catch (cause) {
    if (cause instanceof PrivatePathPermissionError) throw cause;
    throw new PrivatePathPermissionError(operation, targetPath, cause);
  }
}

export function supportsPosixPermissions(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

export function ensurePrivateDirectorySync(
  directoryPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  withPrivatePathContext("create", directoryPath, () => {
    fs.mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  });
  if (!supportsPosixPermissions(platform)) return;

  const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const descriptor = withPrivatePathContext("open without following symlinks", directoryPath, () =>
    fs.openSync(directoryPath, directoryFlags),
  );
  try {
    withPrivatePathContext("set mode on", directoryPath, () => {
      if (!fs.fstatSync(descriptor).isDirectory()) {
        throw new Error("Path is not a directory");
      }
      fs.fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE);
    });
  } finally {
    fs.closeSync(descriptor);
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

  const descriptor = withPrivatePathContext("open without following symlinks", filePath, () =>
    fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    ),
  );
  try {
    withPrivatePathContext("set mode on", filePath, () => {
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
    const descriptor = withPrivatePathContext("create", filePath, () =>
      fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT, PRIVATE_FILE_MODE),
    );
    fs.closeSync(descriptor);
    return;
  }

  const targetMode = options.executable ? PRIVATE_EXECUTABLE_FILE_MODE : PRIVATE_FILE_MODE;
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_APPEND |
    fs.constants.O_NOFOLLOW |
    fs.constants.O_NONBLOCK;
  const descriptor = withPrivatePathContext("create without following symlinks", filePath, () =>
    fs.openSync(filePath, flags, targetMode),
  );
  try {
    withPrivatePathContext("set mode on", filePath, () => {
      if (!fs.fstatSync(descriptor).isFile()) {
        throw new Error("Path is not a regular file");
      }
      fs.fchmodSync(descriptor, targetMode);
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

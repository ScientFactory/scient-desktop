// @effect-diagnostics nodeBuiltinImport:off -- Effect FileSystem cannot create a file with O_EXCL.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";

const lockHeld = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

/** One live writer for a conversation directory. A dead holder's lock is reclaimed. */
export const acquireOmpSessionLock = (lockPath: string): Effect.Effect<void, string> =>
  Effect.try({
    try: () => {
      // The holder record carries a per-acquisition token so a takeover can
      // prove it is deleting the stale record it inspected, and not a lock that
      // another process re-created between the check and the delete.
      const token = `${process.pid}:${NodeCrypto.randomUUID()}`;
      const writeToken = () => NodeFS.writeFileSync(lockPath, `${token}\n`, { flag: "wx" });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          writeToken();
          return "acquired" as const;
        } catch (error) {
          const code = errorCode(error);
          if (code !== "EEXIST") throw error;
        }
        let observed: string;
        try {
          observed = NodeFS.readFileSync(lockPath, "utf8").trim();
        } catch (error) {
          // The holder released the lock between our write attempt and the read.
          if (errorCode(error) === "ENOENT") continue;
          throw error;
        }
        if (lockHeld(Number(observed.split(":")[0]))) return "busy" as const;
        try {
          // Only unlink the exact stale record we inspected.
          if (NodeFS.readFileSync(lockPath, "utf8").trim() !== observed) continue;
          NodeFS.unlinkSync(lockPath);
        } catch (error) {
          if (errorCode(error) === "ENOENT") continue;
          throw error;
        }
      }
      return "busy" as const;
    },
    catch: () => "Oh My Pi could not lock this conversation.",
  }).pipe(
    Effect.flatMap((result) =>
      result === "busy" ? Effect.fail("This Oh My Pi conversation is already open.") : Effect.void,
    ),
  );

export const releaseOmpSessionLock = (lockPath: string): Effect.Effect<void> =>
  Effect.sync(() => {
    NodeFS.rmSync(lockPath, { force: true });
  });

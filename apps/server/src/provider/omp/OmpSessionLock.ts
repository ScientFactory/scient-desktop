// @effect-diagnostics nodeBuiltinImport:off -- Effect FileSystem cannot create a file with O_EXCL.
import * as NodeFS from "node:fs";

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
      const write = () => NodeFS.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
      try {
        write();
        return "acquired" as const;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const existing = Number(NodeFS.readFileSync(lockPath, "utf8").trim());
        if (lockHeld(existing)) return "busy" as const;
        NodeFS.rmSync(lockPath, { force: true });
        write();
        return "acquired" as const;
      }
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

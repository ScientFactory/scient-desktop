// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { windowsNativeFile } from "../workspace/WindowsNativeFile.ts";
import {
  ensureNativePrivateRetentionDirectory,
  resolveNativeFilePublicationHelperPath,
  observedDirectoryBinding,
  removeNativeRetainedEntry,
  withNativeFilePublicationLease,
} from "../workspace/NativeFilePublication.ts";
import {
  bytesRevision,
  fileIdentity,
  mutateRetainedFile,
  publicationLeaseBindings,
} from "../workspace/RetainedFileMutation.ts";

export async function windowsPrivateRetention(directory: string, create: boolean) {
  const helper = await resolveNativeFilePublicationHelperPath(
    process.env.SCIENT_FILE_PUBLICATION_HELPER,
  );
  if (!helper) throw new Error("Windows retention requires the publication helper.");
  if (create) await ensureNativePrivateRetentionDirectory(helper, directory);
  const info = await windowsNativeFile(directory, "private", helper);
  if (info.code || info.syncManaged)
    throw new Error(info.syncManaged ? "sync-managed-folder" : "unsafe-directory");
}

/** Exercise capture and no-replace installation on the actual retention volume. */
export async function probeWindowsRetention(directory: string, helper: string | null) {
  if (!helper) throw new Error("Windows retention requires the publication helper.");
  const scratch = await ensureNativePrivateRetentionDirectory(
    helper,
    NodePath.join(directory, `.probe-${NodeCrypto.randomUUID()}`),
  );
  const target = NodePath.join(scratch, "target");
  const records = await ensureNativePrivateRetentionDirectory(
    helper,
    NodePath.join(scratch, "records"),
  );
  const original = Buffer.from("original");
  await NodeFSP.writeFile(target, original, { flag: "wx" });
  const identity = await fileIdentity(target);
  try {
    const result = await mutateRetainedFile(
      {
        cwd: scratch,
        relativePath: "target",
        retentionDirectory: records,
        id: "probe",
        bytes: Buffer.from("installed"),
        expectedRevision: bytesRevision(original),
        nativePublicationHelper: helper,
      },
      target,
    );
    if (
      result.outcome !== "done" ||
      JSON.stringify(result.retainedIdentity) !== JSON.stringify(identity) ||
      (await NodeFSP.readFile(target, "utf8")) !== "installed" ||
      (await NodeFSP.readFile(result.retainedPath!, "utf8")) !== "original"
    )
      throw new Error("Windows retention volume failed capture/install qualification.");
  } finally {
    const folders = [NodePath.join(records, "probe"), records, scratch, directory];
    const bindings = await Promise.all(
      folders.map((folder) => observedDirectoryBinding(helper, folder)),
    );
    await withNativeFilePublicationLease(
      helper,
      await publicationLeaseBindings(helper, bindings),
      async (lease) => {
        for (const folder of folders.slice(0, -1)) {
          for (const name of await NodeFSP.readdir(folder))
            await removeNativeRetainedEntry(lease, folder, name);
        }
        await removeNativeRetainedEntry(lease, directory, NodePath.basename(scratch));
      },
      { mode: "exclusive" },
    );
  }
}

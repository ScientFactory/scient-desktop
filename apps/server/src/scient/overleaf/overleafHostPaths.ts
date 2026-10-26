// @effect-diagnostics nodeBuiltinImport:off -- Budgets apply to server-host paths.
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  overleafFilesystemRefusalText,
  ScientOverleafFilesystemRefusalReason,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  platformFileIdentity,
  type VolumeIdentityResolver,
} from "../workspace/PlatformFileIdentity.ts";
import { WindowsNativeFileError } from "../workspace/WindowsNativeFile.ts";

export class OverleafFilesystemError extends Schema.TaggedError<OverleafFilesystemError>()(
  "OverleafFilesystemError",
  { reason: ScientOverleafFilesystemRefusalReason, path: Schema.String },
) {
  override get message(): string {
    return overleafFilesystemRefusalText(this.reason)!;
  }
}

/** Native admission failures remain actionable at the shared connection boundary. */
export function overleafDirectoryIdentity(path: string, volume?: VolumeIdentityResolver) {
  return Effect.tryPromise({
    try: () => platformFileIdentity.directory(path, volume),
    catch: (error) =>
      new OverleafFilesystemError({
        path,
        reason: error instanceof WindowsNativeFileError ? error.reason : "identity-unavailable",
      }),
  });
}

/** Leave room for the terminating NUL and Windows' extended UNC prefix. */
export function overleafHostPathProblem(
  path: string,
  platform: string = HostProcess.Platform.defaultValue(),
): "path-too-long" | "component-too-long" | null {
  const bytes = new TextEncoder().encode(path).length;
  if (
    platform === "win32"
      ? path.length + 8 >= 32_767
      : bytes >= (platform === "darwin" ? 1_024 : 4_096)
  )
    return "path-too-long";
  for (const component of path.split(platform === "win32" ? /[/\\]/u : /\//u))
    if (component.length > 255 || new TextEncoder().encode(component).length > 255)
      return "component-too-long";
  return null;
}

export function assertOverleafHostPath(path: string): string {
  const reason = overleafHostPathProblem(path);
  if (reason !== null) throw new OverleafFilesystemError({ reason, path });
  return path;
}

/** Reserve the maximum accepted IDs, retries, journal leaves and sibling stage name. */
export function assertOverleafApplyPaths(
  cwd: string,
  applicationDirectory: string,
  paths: Iterable<string>,
  id = "a".repeat(100),
): void {
  const directory = NodePath.join(applicationDirectory, id);
  assertOverleafHostPath(NodePath.join(directory, "apply.json.tmp"));
  assertOverleafHostPath(NodePath.join(directory, "plan.json.tmp"));
  const step = NodePath.join(directory, "files", "a".repeat(100));
  assertOverleafHostPath(NodePath.join(step, "record.json.tmp"));
  assertOverleafHostPath(NodePath.join(step, "view-provisional.abcdefghijklmnop"));
  for (const path of paths) {
    const target = assertOverleafHostPath(NodePath.join(cwd, path));
    assertOverleafHostPath(
      NodePath.join(NodePath.dirname(target), `.scient-overleaf-apply-${id}-${"a".repeat(36)}`),
    );
  }
}

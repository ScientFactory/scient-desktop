import { LogicalDocumentKey } from "@scientfactory/document-artifacts";
import {
  EnvironmentFilePath,
  EnvironmentId,
  type AssetResource,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";
import * as Schema from "effect/Schema";

const TrackedPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
  // eslint-disable-next-line no-control-regex -- Persisted source paths must reject NUL.
  Schema.isPattern(/^[^\0]+$/u),
);

export const TrackedHtmlSourceSchema = Schema.Union([
  Schema.TaggedStruct("workspace-html", {
    environmentId: EnvironmentId,
    workspaceRoot: TrackedPath,
    relativePath: TrackedPath,
    absolutePath: TrackedPath,
  }),
  Schema.TaggedStruct("environment-html", {
    environmentId: EnvironmentId,
    canonicalPath: EnvironmentFilePath,
  }),
]);
export type TrackedHtmlSource = typeof TrackedHtmlSourceSchema.Type;

function sha256Hex(value: string): string {
  return [...sha256(new TextEncoder().encode(value))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

function normalizedPath(value: string): string {
  const slashNormalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return isWindowsAbsolutePath(value) ? slashNormalized.toLowerCase() : slashNormalized;
}

function sourceIdentity(source: TrackedHtmlSource): string {
  return source._tag === "workspace-html"
    ? JSON.stringify([source._tag, source.environmentId, normalizedPath(source.absolutePath)])
    : JSON.stringify([source._tag, source.environmentId, normalizedPath(source.canonicalPath)]);
}

export function trackedHtmlLogicalDocumentKey(source: TrackedHtmlSource): LogicalDocumentKey {
  return LogicalDocumentKey.make(`browser-export:${sha256Hex(sourceIdentity(source))}`);
}

export function trackedHtmlAssetResource(
  source: TrackedHtmlSource,
  threadRef: ScopedThreadRef,
): AssetResource {
  return source._tag === "workspace-html"
    ? {
        _tag: "workspace-file",
        cwd: source.workspaceRoot,
        relativePath: source.relativePath,
        threadId: threadRef.threadId,
        path: source.absolutePath,
      }
    : {
        _tag: "environment-file",
        path: source.canonicalPath,
        access: "html-document",
      };
}

export function sameTrackedHtmlSource(left: TrackedHtmlSource, right: TrackedHtmlSource): boolean {
  return sourceIdentity(left) === sourceIdentity(right);
}

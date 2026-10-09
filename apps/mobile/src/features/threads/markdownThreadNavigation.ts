import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  parseEnvironmentQualifiedThreadLinkHref,
  parseThreadLinkHref,
  percentDecodedThreadLinkId,
} from "@t3tools/shared/threadLinks";

/** Resolves a native Markdown press with the same literal-first identity rule as web. */
export function resolveMarkdownThreadNavigation(
  href: string,
  environmentId: EnvironmentId,
  hasThread: (ref: ScopedThreadRef) => boolean,
): ScopedThreadRef | null {
  const qualified = parseEnvironmentQualifiedThreadLinkHref(href);
  // The old reader decoded its two segments once; never reinterpret the ID again.
  if (qualified) return scopeThreadRef(qualified.environmentId, qualified.threadId);
  const written = parseThreadLinkHref(href);
  if (written === null) return null;
  const writtenRef = scopeThreadRef(environmentId, written);
  if (hasThread(writtenRef)) return writtenRef;
  const decoded = percentDecodedThreadLinkId(written);
  if (decoded !== null) {
    const decodedRef = scopeThreadRef(environmentId, decoded);
    if (hasThread(decodedRef)) return decodedRef;
  }
  // Missing or archived targets keep their written identity instead of guessing.
  return writtenRef;
}

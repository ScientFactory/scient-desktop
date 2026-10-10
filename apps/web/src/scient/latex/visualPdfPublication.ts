import { useEffect, useState } from "react";

export interface LatexSourceIdentity {
  readonly source: string;
  readonly revision: string;
}

/**
 * Hash the exact editor buffer without blocking input. The source travels with
 * the digest so an asynchronous result can never authorize newer text.
 */
export function useLatexSourceIdentity(source: string, enabled = true): LatexSourceIdentity | null {
  const [identity, setIdentity] = useState<LatexSourceIdentity | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!globalThis.crypto?.subtle) return;
    let current = true;
    void crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(source))
      .then((bytes) => {
        if (!current) return;
        setIdentity({
          source,
          revision: `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
        });
      })
      .catch(() => {
        if (current) setIdentity(null);
      });
    return () => {
      current = false;
    };
  }, [enabled, source]);

  return enabled && identity?.source === source ? identity : null;
}

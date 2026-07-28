// FILE: ProviderSignOutActionButton.tsx
// Purpose: Provide a truthful, single-flight provider CLI sign-out action.
// Layer: Settings component

import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";

import { Loader2Icon } from "../../lib/icons";
import { Button } from "../ui/button";

export function ProviderSignOutActionButton({
  provider,
  disabled = false,
  onRequestSignOut,
  onUnexpectedError,
}: {
  readonly provider: ProviderKind;
  readonly disabled?: boolean;
  readonly onRequestSignOut: () => Promise<void>;
  readonly onUnexpectedError?: (error: unknown) => void;
}) {
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const [active, setActive] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const providerName = PROVIDER_DISPLAY_NAMES[provider];
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={disabled || active}
      aria-label={active ? `Signing out of ${providerName}` : `Sign out of ${providerName}`}
      onClick={(event) => {
        event.stopPropagation();
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        setActive(true);
        void onRequestSignOut()
          .catch((error: unknown) => onUnexpectedError?.(error))
          .finally(() => {
            inFlightRef.current = false;
            if (mountedRef.current) setActive(false);
          });
      }}
    >
      {active ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
      {active ? "Signing out" : "Sign out"}
    </Button>
  );
}

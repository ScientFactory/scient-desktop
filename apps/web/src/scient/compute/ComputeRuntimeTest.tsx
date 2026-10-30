import { useEffect, useRef, useState } from "react";
import { CheckIcon, LoaderCircleIcon } from "lucide-react";
import type { ComputeLanguageId, EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "~/state/use-atom-command";
import { computeEnvironment } from "~/state/compute";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

const PASSED_MS = 4_000;

/** Starts and closes the runtime once. Testing never selects or changes it. */
export function ComputeRuntimeTest({
  executable,
  environmentId,
  languageId,
  label,
  disabled = false,
  onVersion,
}: {
  executable: string;
  environmentId: EnvironmentId | null;
  languageId: ComputeLanguageId;
  /** Which runtime this tests, when a page shows several. */
  label: string;
  disabled?: boolean;
  onVersion?: ((version: string) => void) | undefined;
}) {
  const verifyRuntime = useAtomCommand(computeEnvironment.verifyRuntime, { reportFailure: false });
  const lock = useRef(false);
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks component liveness in a ref so late verification replies do not set state after unmount
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [testing, setTesting] = useState(false);
  const [passed, setPassed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the timer that hides the passed indicator, cleared on unmount or re-test
  useEffect(() => {
    if (!passed) return;
    const timeout = setTimeout(() => setPassed(false), PASSED_MS);
    return () => clearTimeout(timeout);
  }, [passed]);
  const run = async () => {
    if (lock.current || disabled || !environmentId) return;
    lock.current = true;
    setTesting(true);
    setPassed(false);
    setError(null);
    const failure = await verifyRuntime({
      environmentId,
      input: { cwd: null, languageId, executable },
    })
      .then((verification) => {
        if (verification._tag === "Failure") throw squashAtomCommandFailure(verification);
        const { profile, readiness, connection, message } = verification.value;
        if (
          profile?.executable === executable &&
          profile.languageVersion &&
          profile.languageVersion !== "unknown"
        ) {
          onVersion?.(profile.languageVersion);
        }
        return readiness === "ready" && connection === "verified"
          ? null
          : (message ?? "The connection could not be verified.");
      })
      .catch((cause: unknown) =>
        cause instanceof Error ? cause.message : "The connection could not be verified.",
      );
    lock.current = false;
    if (!mounted.current) return;
    setTesting(false);
    setPassed(failure === null);
    setError(failure);
  };
  if (testing || passed) {
    return (
      <span
        role="status"
        className={`inline-flex items-center gap-1 text-xs ${testing ? "text-muted-foreground" : "text-success"}`}
      >
        {testing ? (
          <LoaderCircleIcon
            aria-hidden
            className="size-3 animate-spin motion-reduce:animate-none"
          />
        ) : (
          <CheckIcon aria-hidden className="size-3" />
        )}
        {testing ? "Testing…" : "Test passed"}
      </span>
    );
  }
  if (error !== null) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={disabled}
              aria-label={`Test failed: ${error.slice(0, 200)}`}
              onClick={() => void run()}
            />
          }
        >
          Test failed
        </TooltipTrigger>
        <TooltipPopup className="max-w-80">{error}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      disabled={disabled}
      aria-label={`Test ${label}`}
      onClick={() => void run()}
    >
      Test
    </Button>
  );
}

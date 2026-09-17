import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, LoaderCircleIcon, MoreHorizontalIcon } from "lucide-react";
import type {
  ComputeLanguageId,
  ComputeRuntimeVerification,
  EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useAtomCommand } from "~/state/use-atom-command";
import { computeEnvironment } from "~/state/compute";
import { SettingsRow } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { ComputeSettingsInstallation } from "./computeInstallationSettingsModel";

/** Installation-local diagnostics; testing never selects or mutates this runtime. */
export function ComputeInstallationRow({
  id,
  title,
  installation,
  environmentId,
  languageId,
  isDefault = false,
  disabled = false,
  description,
  status,
  action,
  renderMenu,
  onForget,
  forgetDisabled = false,
  onVersion,
}: {
  id: string;
  title: string;
  installation?: ComputeSettingsInstallation | undefined;
  environmentId: EnvironmentId | null;
  languageId: ComputeLanguageId;
  isDefault?: boolean;
  disabled?: boolean;
  description?: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
  renderMenu?: (items: ReactNode) => ReactNode;
  onForget?: (() => void) | undefined;
  forgetDisabled?: boolean;
  onVersion?: (version: string) => void;
}) {
  const verifyRuntime = useAtomCommand(computeEnvironment.verifyRuntime, { reportFailure: false });
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ComputeRuntimeVerification | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "runtime path",
    onCopy: () => setCopyError(null),
    onError: () => setCopyError("The path could not be copied. Try again."),
  });
  const passed = result?.readiness === "ready" && result.connection === "verified";
  useEffect(() => {
    if (result?.readiness !== "ready" || result.connection !== "verified") return;
    const timeout = setTimeout(() => setShowSuccess(false), 4_000);
    return () => clearTimeout(timeout);
  }, [result]);
  const runTest = async () => {
    if (lock.current || disabled || !installation || !environmentId) return;
    lock.current = true;
    setTesting(true);
    setResult(null);
    setShowSuccess(false);
    setError(null);
    try {
      const verification = await verifyRuntime({
        environmentId,
        input: {
          cwd: null,
          languageId,
          executable: installation.executable,
        },
      });
      if (!mounted.current) return;
      if (verification._tag === "Failure") throw squashAtomCommandFailure(verification);
      setResult(verification.value);
      setShowSuccess(
        verification.value.readiness === "ready" && verification.value.connection === "verified",
      );
      const profile = verification.value.profile;
      if (profile?.executable === installation.executable && profile.languageVersion) {
        onVersion?.(profile.languageVersion);
      }
      if (
        verification.value.readiness !== "ready" ||
        verification.value.connection !== "verified"
      ) {
        setError(
          verification.value.message ??
            "The connection could not be verified. Scient did not start a test session.",
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The connection could not be verified.");
    } finally {
      lock.current = false;
      setTesting(false);
    }
  };
  const items = installation ? (
    <>
      <MenuItem disabled={disabled || testing} onClick={() => void runTest()}>
        Test
      </MenuItem>
      <MenuItem onClick={() => copyToClipboard(installation.executable, undefined)}>
        {isCopied ? "Copied" : "Copy path"}
      </MenuItem>
      {onForget ? (
        <MenuItem disabled={disabled || forgetDisabled || testing} onClick={onForget}>
          Forget path
        </MenuItem>
      ) : null}
    </>
  ) : null;
  return (
    <SettingsRow
      id={id}
      title={title}
      description={
        description !== undefined
          ? description
          : (result?.profile?.languageVersion ?? installation?.version ?? "Version not checked")
      }
      status={
        installation?.problem || copyError || status ? (
          <>
            {installation?.problem ? (
              <p className="text-xs text-destructive" role="alert">
                {installation.problem}
              </p>
            ) : null}
            {copyError ? (
              <p className="text-xs text-destructive" role="alert">
                {copyError}
              </p>
            ) : null}
            {status}
          </>
        ) : undefined
      }
      control={
        <div
          className="flex flex-wrap items-center justify-end gap-1.5"
          data-compute-installation={installation?.executable}
        >
          {isDefault ? (
            <Tooltip>
              <TooltipTrigger
                render={<span tabIndex={0} className="text-xs text-muted-foreground" />}
              >
                Default
              </TooltipTrigger>
              <TooltipPopup>Default for new sessions</TooltipPopup>
            </Tooltip>
          ) : null}
          {testing || (passed && showSuccess) ? (
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
          ) : null}
          {error ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={disabled || testing}
                    aria-label={`Test failed: ${error.slice(0, 200)}`}
                    onClick={() => void runTest()}
                  />
                }
              >
                Test failed
              </TooltipTrigger>
              <TooltipPopup>{error}</TooltipPopup>
            </Tooltip>
          ) : null}
          {action}
          {renderMenu ? (
            renderMenu(items)
          ) : items ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Actions for ${title}`}
                  />
                }
              >
                <MoreHorizontalIcon />
              </MenuTrigger>
              <MenuPopup align="end">{items}</MenuPopup>
            </Menu>
          ) : null}
        </div>
      }
    />
  );
}

import { useState, type ReactNode } from "react";
import { MoreHorizontalIcon } from "lucide-react";
import type { ComputeLanguageId, EnvironmentId } from "@t3tools/contracts";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { SettingsRow } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { ComputeRuntimeTest } from "./ComputeRuntimeTest";
import type { ComputeSettingsInstallation } from "./computeInstallationSettingsModel";

/** One runtime on this computer, with its own test and path actions. */
export function ComputeInstallationRow({
  id,
  title,
  installation,
  environmentId,
  languageId,
  inUse = false,
  testable = true,
  disabled = false,
  description,
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
  inUse?: boolean;
  testable?: boolean;
  disabled?: boolean;
  description?: ReactNode;
  renderMenu?: (items: ReactNode) => ReactNode;
  onForget?: (() => void) | undefined;
  forgetDisabled?: boolean;
  onVersion?: (version: string) => void;
}) {
  const [copyError, setCopyError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "runtime path",
    onCopy: () => setCopyError(null),
    onError: () => setCopyError("The path could not be copied. Try again."),
  });
  const items = installation ? (
    <>
      <MenuItem onClick={() => copyToClipboard(installation.executable, undefined)}>
        {isCopied ? "Copied" : "Copy path"}
      </MenuItem>
      {onForget ? (
        <MenuItem disabled={disabled || forgetDisabled} onClick={onForget}>
          Forget path
        </MenuItem>
      ) : null}
    </>
  ) : null;
  const problem = installation?.problem ?? copyError;
  return (
    <SettingsRow
      id={id}
      title={title}
      description={description ?? installation?.executable}
      status={
        problem ? (
          <p className="text-xs text-destructive" role="alert">
            {problem}
          </p>
        ) : undefined
      }
      control={
        <div
          className="flex flex-wrap items-center justify-end gap-1.5"
          data-compute-installation={installation?.executable}
        >
          {inUse ? <span className="text-xs text-muted-foreground">In use</span> : null}
          {testable && installation && !installation.problem ? (
            <ComputeRuntimeTest
              executable={installation.executable}
              environmentId={environmentId}
              languageId={languageId}
              label={title}
              disabled={disabled}
              {...(onVersion ? { onVersion } : {})}
            />
          ) : null}
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

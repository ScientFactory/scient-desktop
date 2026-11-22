import type { EnvironmentId, RuntimeMode } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT, useMessages } from "gt-react";
// SCIENT-FORK:START — composer.mode focuses the checked permission, like the footer chip.
import { useRef, useState } from "react";
// SCIENT-FORK:END

import { shortcutLabelForCommand } from "../keybindings";
import { useManagedPolicy } from "../state/managedPolicy";
import { primaryServerKeybindingsAtom } from "../state/server";
import { ComposerControl } from "./chat/ComposerControl";
import { ComposerPermissionsSection } from "./chat/ComposerFooterControls";
import { focusRequestedPermission, useComposerMenuProps } from "./chat/composerEventScope";
import {
  resolveCompatibleRuntimeMode,
  resolveRuntimeModeOptions,
  runtimeModeConfig,
} from "./chat/runtimeModeConfig";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Menu, MenuPopup, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ComposerContextPermissions(props: {
  environmentId: EnvironmentId | null;
  runtimeMode: RuntimeMode;
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.mode",
  );
  const { mode, modes } = resolveCompatibleRuntimeMode(
    props.runtimeMode,
    props.supportedRuntimeModes,
  );
  const options = resolveRuntimeModeOptions(modes, useManagedPolicy(props.environmentId), messages);
  const composerMenuProps = useComposerMenuProps();
  // SCIENT-FORK:START — composer.mode focuses the checked permission, like the footer chip.
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // SCIENT-FORK:END
  const { icon: Icon } = runtimeModeConfig[mode];
  const label = messages(runtimeModeConfig[mode].label);
  return (
    <Menu
      // SCIENT-FORK:START — composer.mode focuses the checked permission, like the footer chip.
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => focusRequestedPermission(isOpen, triggerRef.current)}
      // SCIENT-FORK:END
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  // SCIENT-FORK:START — composer.mode focuses the checked permission, like the footer chip.
                  ref={triggerRef}
                  data-composer-shortcut="composer.mode"
                  // SCIENT-FORK:END
                  size="xs"
                  className="ms-auto min-w-0 shrink-0"
                  aria-label={gt("Permissions: {label}", { label })}
                  data-composer-context-control
                />
              }
            />
          }
        >
          <Icon aria-hidden="true" className="size-3" />
          <ComposerContextLabel>{label}</ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          <T>Permissions</T>
          {shortcutLabel ? ` · ${shortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup side="top" align="end" {...composerMenuProps}>
        <ComposerPermissionsSection
          runtimeMode={mode}
          runtimeModeOptions={options}
          onRuntimeModeChange={props.onRuntimeModeChange}
        />
      </MenuPopup>
    </Menu>
  );
}

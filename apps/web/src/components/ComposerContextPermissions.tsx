import type { RuntimeMode } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
// SCIENT-FORK:START — the strip button opens its own Permissions card.
import { useRef, useState } from "react";
// SCIENT-FORK:END

import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { ComposerControl } from "./chat/ComposerControl";
// SCIENT-FORK:START — the strip button opens its own Permissions card.
import { focusRequestedPermission, useComposerMenuProps } from "./chat/composerEventScope";
import { ComposerPermissionsSection } from "./chat/ComposerFooterControls";
import { resolveCompatibleRuntimeMode, runtimeModeConfig } from "./chat/runtimeModeConfig";
import { Menu, MenuPopup, MenuTrigger } from "./ui/menu";
// SCIENT-FORK:END
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** The new-thread strip names the permissions the first send will use; clicking opens them. */
export function ComposerContextPermissions(props: {
  runtimeMode: RuntimeMode;
  // SCIENT-FORK:START — the strip button opens its own Permissions card.
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  // SCIENT-FORK:END
}) {
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.mode",
  );
  // SCIENT-FORK:START — the strip button opens its own Permissions card.
  const composerMenuProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { modes, mode } = resolveCompatibleRuntimeMode(
    props.runtimeMode,
    props.supportedRuntimeModes,
  );
  const options = modes.map((option) => ({ mode: option, ...runtimeModeConfig[option] }));
  const { icon: Icon, label } = runtimeModeConfig[mode];
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => focusRequestedPermission(isOpen, triggerRef.current)}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  ref={triggerRef}
                  size="xs"
                  className="ms-auto min-w-0 shrink-0"
                  aria-label={`Permissions: ${label}`}
                  data-composer-context-control
                  data-composer-shortcut="composer.mode"
                />
              }
            />
          }
        >
          <Icon aria-hidden="true" className="size-3" />
          <ComposerContextLabel>{label}</ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>Permissions{shortcutLabel ? ` · ${shortcutLabel}` : null}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" {...composerMenuProps}>
        <ComposerPermissionsSection
          runtimeMode={mode}
          runtimeModeOptions={options}
          onRuntimeModeChange={props.onRuntimeModeChange}
        />
      </MenuPopup>
    </Menu>
  );
  // SCIENT-FORK:END
}

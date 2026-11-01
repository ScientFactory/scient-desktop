import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useImperativeHandle, useRef } from "react";

import { Command, CommandFooter, CommandInput, CommandPanel } from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";

/**
 * A view replacing another inside an open dialog mounts with focus on the body,
 * left there by the removed input. Claim it so typing cannot reach the composer
 * behind the modal. On first open the dialog's own initial focus handles it.
 */
function claimFocusInOpenDialog(input: HTMLInputElement | null) {
  if (!input) return;
  const active = input.ownerDocument.activeElement;
  if (
    active === null ||
    active === input.ownerDocument.body ||
    input.closest('[role="dialog"]')?.contains(active)
  ) {
    input.focus();
  }
}

type CommandPaletteContentProps = Omit<ComponentProps<typeof Command>, "children"> & {
  readonly children: ReactNode;
  readonly containerProps?: Omit<ComponentProps<"div">, "className">;
  readonly escapeLabel?: ReactNode;
  readonly footerActionLabel?: ReactNode;
  readonly footerTrailing?: ReactNode;
  readonly inputAccessory?: ReactNode;
  readonly inputProps: ComponentProps<typeof CommandInput>;
  readonly panelSize?: "list" | "tall-list" | "fill" | "project-picker";
  readonly showBackHint?: boolean;
  readonly testId?: string;
};

export function CommandPaletteContent({
  children,
  containerProps,
  escapeLabel = "Close",
  footerActionLabel,
  footerTrailing,
  inputAccessory,
  inputProps,
  panelSize = "list",
  showBackHint,
  testId,
  ...commandProps
}: CommandPaletteContentProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Share the mounted input with caller keyboard/focus handlers without
  // replacing the local ref used by upstream's autofocus behavior.
  useImperativeHandle(inputProps.ref, () => inputRef.current!, []);

  return (
    <div {...containerProps} className="contents" data-testid={testId}>
      <Command {...commandProps}>
        <div className="relative">
          <CommandInput
            autoFocus={false}
            {...inputProps}
            ref={(input) => {
              inputRef.current = input;
              claimFocusInOpenDialog(input);
            }}
          />
          {inputAccessory}
        </div>
        <CommandPanel
          className={
            panelSize === "fill"
              ? "flex min-h-0 flex-1 flex-col"
              : panelSize === "tall-list"
                ? "max-h-[min(34rem,76vh)]"
                : "flex max-h-[min(28rem,70vh)] min-h-0 flex-col"
          }
        >
          {children}
        </CommandPanel>
        <CommandFooter className="max-sm:flex-col max-sm:items-start">
          <div className="flex items-center gap-3">
            <KbdGroup>
              <Kbd>
                <ArrowUpIcon />
              </Kbd>
              <Kbd>
                <ArrowDownIcon />
              </Kbd>
              <span>Navigate</span>
            </KbdGroup>
            {footerActionLabel !== undefined ? (
              <KbdGroup>
                <Kbd>Enter</Kbd>
                <span>{footerActionLabel}</span>
              </KbdGroup>
            ) : null}
            {showBackHint ? (
              <KbdGroup>
                <Kbd>Backspace</Kbd>
                <span>Back</span>
              </KbdGroup>
            ) : null}
            <KbdGroup>
              <Kbd>Esc</Kbd>
              <span>{escapeLabel}</span>
            </KbdGroup>
          </div>
          {footerTrailing}
        </CommandFooter>
      </Command>
    </div>
  );
}

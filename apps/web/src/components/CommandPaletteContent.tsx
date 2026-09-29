import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";

import { Command, CommandFooter, CommandInput, CommandPanel } from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";

type CommandPaletteContentProps = Omit<ComponentProps<typeof Command>, "children"> & {
  readonly children: ReactNode;
  readonly containerProps?: Omit<ComponentProps<"div">, "className">;
  readonly escapeLabel?: ReactNode;
  readonly footerActionLabel?: ReactNode;
  readonly footerTrailing?: ReactNode;
  readonly inputAccessory?: ReactNode;
  readonly inputProps: ComponentProps<typeof CommandInput>;
  /**
   * How tall the results panel may grow: the palette's list, a taller file list, or the whole
   * dialog body (for modes that lay out their own status and empty states).
   */
  readonly panelSize?: "list" | "tall-list" | "fill" | "project-picker";
  readonly showBackHint?: boolean;
  readonly testId?: string;
};

/**
 * Shared command palette chrome. Palette modes provide their query behavior,
 * results, and optional input accessory while retaining one input, panel, and
 * keyboard-hint gutter.
 */
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

  // Direct-open flows replace the initial palette view after the dialog has
  // already moved focus. Reclaim it when the replacement input mounts so
  // typing cannot continue in the composer behind the modal.
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div {...containerProps} className="contents" data-testid={testId}>
      <Command {...commandProps}>
        <div className="relative">
          <CommandInput {...inputProps} ref={inputRef} />
          {inputAccessory}
        </div>
        <CommandPanel
          className={
            panelSize === "fill"
              ? "flex min-h-0 flex-1 flex-col"
              : panelSize === "tall-list"
                ? "max-h-[min(34rem,76vh)]"
                : panelSize === "project-picker"
                  ? "flex max-h-[min(28rem,70vh)] flex-col"
                  : "max-h-[min(28rem,70vh)]"
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

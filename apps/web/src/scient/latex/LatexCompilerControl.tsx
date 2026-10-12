import type { ScientLatexToolchainReport } from "@t3tools/contracts";
import { Cog } from "lucide-react";
import {
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "~/components/ui/menu";
import { DockCommandItem, DockCommandRadioItem } from "../writing/dockChrome";
import {
  LATEX_COMPILER_CHOICES,
  declaredLatexCompiler,
  latexCompilerDeclaration,
  latexCompilerAvailabilityLabel,
  isLatexCompilerUnavailable,
  type LatexCompilerChoice,
} from "./latexCompiler";

export interface LatexCompilerControlProps {
  source: string | null;
  report: ScientLatexToolchainReport | null;
  offline: boolean;
  blockedReason: string | null;
  busy: boolean;
  onChange: (compiler: LatexCompilerChoice) => void;
  rootPath: string | null;
  onOpenRoot: (() => void) | null;
  capabilityError: string | null;
}

export function LatexCompilerMenuItems(props: LatexCompilerControlProps) {
  const compiler = props.source === null ? null : declaredLatexCompiler(props.source);
  const declaration = props.source === null ? null : latexCompilerDeclaration(props.source);
  const selected =
    props.source === null
      ? "unread"
      : (compiler ?? (declaration === null ? "automatic" : "source-declaration"));
  return (
    <DropdownMenuGroup>
      {props.blockedReason ? <DropdownMenuLabel>{props.blockedReason}</DropdownMenuLabel> : null}
      {selected === "source-declaration" ? (
        <DropdownMenuLabel>Source declaration: {declaration}</DropdownMenuLabel>
      ) : null}
      {props.capabilityError && !props.offline ? (
        <DropdownMenuLabel>Availability not checked: {props.capabilityError}</DropdownMenuLabel>
      ) : null}
      <DropdownMenuRadioGroup value={selected}>
        {LATEX_COMPILER_CHOICES.map((choice) => {
          const availability =
            choice.id === "automatic"
              ? props.offline
                ? "Offline"
                : null
              : latexCompilerAvailabilityLabel(props.report, choice.id, props.offline);
          const unavailable =
            choice.id !== "automatic" && isLatexCompilerUnavailable(props.report, choice.id);
          return (
            <DockCommandRadioItem
              key={choice.id}
              value={choice.id}
              disabled={
                props.busy || props.blockedReason !== null || !!unavailable || props.offline
              }
              onClick={() => props.onChange(choice.id)}
            >
              <span>
                {choice.name}
                {availability ? ` — ${availability}` : ""}
              </span>
            </DockCommandRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
      {props.onOpenRoot ? (
        <DockCommandItem onClick={props.onOpenRoot}>Open root: {props.rootPath}</DockCommandItem>
      ) : null}
    </DropdownMenuGroup>
  );
}

export function LatexCompilerMenu(props: LatexCompilerControlProps & { plain?: boolean }) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        {props.plain ? null : <Cog />}
        <span>Compiler</span>
      </MenuSubTrigger>
      <MenuSubPopup className="w-max min-w-48 max-w-80">
        <LatexCompilerMenuItems {...props} />
      </MenuSubPopup>
    </MenuSub>
  );
}

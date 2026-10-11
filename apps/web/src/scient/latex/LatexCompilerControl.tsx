import type { ScientLatexToolchainReport } from "@t3tools/contracts";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuTrigger,
} from "~/components/ui/menu";
import { DockCommandItem, DockCommandRadioItem } from "../writing/dockChrome";
import { ScientTooltip } from "../presentation/ScientTooltip";
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
      : (compiler ?? (declaration === null ? "automatic" : "unsupported"));
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Compiler{props.rootPath ? ` · ${props.rootPath}` : ""}</DropdownMenuLabel>
      {props.blockedReason ? <DropdownMenuLabel>{props.blockedReason}</DropdownMenuLabel> : null}
      {selected === "unsupported" ? (
        <DropdownMenuLabel>Unsupported declaration: {declaration}</DropdownMenuLabel>
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
                : "Uses document requirements"
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

export function LatexCompilerControl(props: LatexCompilerControlProps) {
  const compiler = props.source === null ? null : declaredLatexCompiler(props.source);
  const declaration = props.source === null ? null : latexCompilerDeclaration(props.source);
  const label =
    props.source === null
      ? "Not checked"
      : compiler === "pdflatex"
        ? "pdfLaTeX"
        : compiler === "xelatex"
          ? "XeLaTeX"
          : compiler === "lualatex"
            ? "LuaLaTeX"
            : declaration === null
              ? "Automatic"
              : `Unsupported: ${declaration}`;
  const availability =
    compiler === null
      ? props.offline
        ? "Offline"
        : null
      : latexCompilerAvailabilityLabel(props.report, compiler, props.offline);
  const description =
    props.blockedReason ??
    availability ??
    "Save this document and rebuild using the selected compiler.";
  return (
    <span className="scient-latex-compiler-control">
      <DropdownMenu>
        <ScientTooltip content={description}>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="scient-latex-action"
                aria-label={`Compiler: ${label}${availability ? ` · ${availability}` : ""}`}
                aria-description={description}
              />
            }
          >
            <span>
              Compiler: {props.busy ? "Saving…" : label}
              {availability ? ` · ${availability}` : ""}
            </span>
            <ChevronDown className="size-3" aria-hidden="true" />
          </DropdownMenuTrigger>
        </ScientTooltip>
        <DropdownMenuContent align="end">
          <LatexCompilerMenuItems {...props} />
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

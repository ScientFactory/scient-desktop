import { useAtomValue } from "@effect/atom-react";
import type { CSSProperties } from "react";

import { APP_STAGE_LABEL } from "../branding";
import { resolveServerBackedAppStageLabel } from "../branding.logic";
import { cn } from "../lib/utils";
import { primaryServerConfigAtom } from "../state/server";
import { ScientSymbol } from "./ScientSymbol";

export type SidebarStageBackdropVariant = "nightly" | "dev";
export type EnvironmentIdentificationPillLabel = "Dev" | "Nightly";

export function resolveSidebarStageBackdropVariant(
  stageLabel: string,
  enabled = true,
): SidebarStageBackdropVariant | null {
  if (!enabled) return null;
  const normalized = stageLabel.trim().toLowerCase();
  if (normalized === "nightly") return "nightly";
  if (normalized === "dev") return "dev";
  return null;
}

export function resolveSidebarStageFocusRingOffsetClass(
  variant: SidebarStageBackdropVariant,
): string {
  return variant === "nightly"
    ? "focus-visible:ring-offset-(--stage-night-bottom)"
    : "focus-visible:ring-offset-(--stage-art-bottom)";
}

export function resolveEnvironmentIdentificationPillLabel(
  stageLabel: string,
): EnvironmentIdentificationPillLabel | null {
  const normalized = stageLabel.trim().toLowerCase();
  if (normalized === "dev") return "Dev";
  if (normalized === "nightly") return "Nightly";
  return null;
}

export function useEnvironmentStageLabel(): string {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;

  return resolveServerBackedAppStageLabel({
    primaryServerVersion,
    fallbackStageLabel: APP_STAGE_LABEL,
  });
}

export function useSidebarStageBackdropVariant(enabled = true): SidebarStageBackdropVariant | null {
  return resolveSidebarStageBackdropVariant(useEnvironmentStageLabel(), enabled);
}

/** Minimal Scient stage treatment. Release channels share one brand and differ only in tone. */
export function SidebarStageBackdrop({ variant }: { variant: SidebarStageBackdropVariant }) {
  return (
    <div
      aria-hidden
      className="sidebar-stage-backdrop pointer-events-none absolute inset-x-0 top-0 z-0 h-20 select-none overflow-hidden"
    >
      <StageBackdropArt variant={variant} />
    </div>
  );
}

export function StageBackdropArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  return <ScientStageArt variant={variant} />;
}

export function StageBackdropButtonArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  return <ScientStageArt compact variant={variant} />;
}

type ScientStageStyle = CSSProperties & {
  readonly [key: `--scient-stage-${string}`]: string;
};

const SCIENT_STAGE_STYLES: Readonly<Record<SidebarStageBackdropVariant, ScientStageStyle>> = {
  dev: {
    "--scient-stage-top": "var(--stage-art-top)",
    "--scient-stage-mid": "var(--stage-art-mid)",
    "--scient-stage-bottom": "var(--stage-art-bottom)",
    "--scient-stage-highlight": "var(--stage-art-highlight)",
    "--scient-stage-secondary": "var(--stage-art-secondary)",
  },
  nightly: {
    "--scient-stage-top": "var(--stage-night-top)",
    "--scient-stage-mid": "var(--stage-night-mid)",
    "--scient-stage-bottom": "var(--stage-night-bottom)",
    "--scient-stage-highlight": "var(--stage-night-highlight)",
    "--scient-stage-secondary": "var(--stage-night-secondary)",
  },
};

function ScientStageArt({
  compact = false,
  variant,
}: {
  readonly compact?: boolean;
  readonly variant: SidebarStageBackdropVariant;
}) {
  return (
    <div
      className={cn(
        "scient-stage-art relative h-full w-full overflow-hidden",
        variant === "nightly" ? "scient-stage-art-nightly" : "scient-stage-art-dev",
      )}
      data-scient-stage={variant}
      style={SCIENT_STAGE_STYLES[variant]}
    >
      {compact ? null : (
        <ScientSymbol className="scient-stage-watermark absolute -right-2 -top-6 size-28" />
      )}
    </div>
  );
}

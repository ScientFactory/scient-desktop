import type { ReactNode } from "react";

import { APP_DISPLAY_NAME, APP_STAGE_LABEL } from "../../branding";
import { ScientSymbol } from "../ScientSymbol";
import { resolveSidebarStageBackdropVariant, StageBackdropArt } from "../SidebarStageBackdrop";

/**
 * Full-screen card for standalone auth pages, mirroring the pairing surface's
 * treatment. Used by the CLI-connect authorize and callback surfaces.
 */
export function AuthSurfaceShell({ children }: { readonly children: ReactNode }) {
  const stageVariant = resolveSidebarStageBackdropVariant(APP_STAGE_LABEL);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-72 bg-[radial-gradient(48rem_20rem_at_top,color-mix(in_srgb,var(--scient-slate)_12%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_94%,var(--color-black))_0%,var(--background)_62%)]" />
      </div>

      <section className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-border/80 bg-card/94 shadow-2xl shadow-black/20 backdrop-blur-md">
        <header className="relative h-24 overflow-hidden bg-[var(--scient-warm-white)] text-[var(--scient-burgundy)] dark:bg-[#1b1819] dark:text-[var(--scient-warm-white)]">
          {stageVariant ? (
            <div className="absolute inset-0" aria-hidden>
              <StageBackdropArt variant={stageVariant} />
            </div>
          ) : (
            <div aria-hidden className="scient-stage-art absolute inset-0" />
          )}
          <div className="relative flex h-full items-center gap-3 p-5 sm:p-6">
            <ScientSymbol className="size-8" />
            <p className="text-sm font-semibold tracking-tight">{APP_DISPLAY_NAME}</p>
          </div>
        </header>

        <div className="p-6 sm:p-8">{children}</div>
      </section>
    </div>
  );
}

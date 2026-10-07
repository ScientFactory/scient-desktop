import { lazy, type ReactNode, Suspense } from "react";

import { Spinner } from "~/components/ui/spinner";

/*
 * The Scient surfaces the files panel mounts for PDFs, LaTeX and compute
 * sources. Each loads on first use.
 */
export const ScientPdfReader = lazy(() =>
  import("~/scient/pdf/ScientPdfReader").then((module) => ({
    default: module.ScientPdfReader,
  })),
);
export const ScientLatexSurface = lazy(() =>
  import("~/scient/latex/ScientLatexSurface").then((module) => ({
    default: module.ScientLatexSurface,
  })),
);
export const ScientComputeFileSurface = lazy(() =>
  import("~/scient/compute/ScientComputeFileSurface").then((module) => ({
    default: module.ScientComputeFileSurface,
  })),
);

/** The loading state shared by the lazily loaded file surfaces. */
export function ScientSurfaceSuspense(props: { readonly children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
          <Spinner className="size-5" />
        </div>
      }
    >
      {props.children}
    </Suspense>
  );
}

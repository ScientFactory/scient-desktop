import { lazy, type ReactNode, Suspense } from "react";

import { Spinner } from "~/components/ui/spinner";

/*
 * The Scient surfaces the files panel mounts for PDFs, LaTeX, compute
 * sources and data tables. Each loads on first use.
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

export const ScientDataFileTable = lazy(() =>
  import("~/scient/dataTable/DataFileTable").then((module) => ({
    default: module.DataFileTable,
  })),
);

/** The loading state shared by the lazily loaded file surfaces. */
export function ScientSurfaceSuspense(props: {
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
}) {
  return (
    <Suspense
      fallback={
        props.fallback ?? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
            <Spinner className="size-5" />
          </div>
        )
      }
    >
      {props.children}
    </Suspense>
  );
}

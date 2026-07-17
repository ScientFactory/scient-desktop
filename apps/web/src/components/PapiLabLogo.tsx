// FILE: PapiLabLogo.tsx
// Purpose: Render the current two-color PapiLab mark as an inline SVG.
// Layer: Shared app branding primitive

import type { SVGProps } from "react";
import { PAPILAB_LOGO_PATHS } from "~/assets/papilabLogoPaths";
import { cn } from "~/lib/utils";

export function PapiLabLogo({ className, ...props }: SVGProps<SVGSVGElement>) {
  const ariaLabel = props["aria-label"];

  return (
    <svg
      viewBox="0 0 376 400"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={ariaLabel ? undefined : true}
      {...props}
      className={cn("shrink-0", className)}
    >
      {PAPILAB_LOGO_PATHS.map((path) => (
        <path key={path.d} d={path.d} fill={path.fill} />
      ))}
    </svg>
  );
}

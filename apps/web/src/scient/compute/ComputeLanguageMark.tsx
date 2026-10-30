import { CodeXmlIcon } from "lucide-react";

import bashLogo from "~/assets/compute/bash.svg";
import duckdbLogo from "~/assets/compute/duckdb.svg";
import juliaLogo from "~/assets/compute/julia.svg";
import matlabLogo from "~/assets/compute/matlab.svg";
import octaveLogo from "~/assets/compute/octave.svg";
import pythonLogo from "~/assets/compute/python.svg";
import rLogo from "~/assets/compute/r.svg";
import rustLogo from "~/assets/compute/rust.svg";
import spssLogo from "~/assets/compute/spss.svg";
import stataLogo from "~/assets/compute/stata.svg";
import wolframLogo from "~/assets/compute/wolfram.svg";
import { cn } from "~/lib/utils";

/**
 * Every file is trimmed to its artwork, so `size` is the logo's share of the tile. Each is set by
 * eye: a thin wordmark needs more width than a solid disc to look the same size.
 */
const LANGUAGE_LOGOS: Readonly<Record<string, { readonly src: string; readonly size: string }>> = {
  python: { src: pythonLogo, size: "size-[68%]" },
  r: { src: rLogo, size: "size-[74%]" },
  julia: { src: juliaLogo, size: "size-[66%]" },
  sql: { src: duckdbLogo, size: "size-[66%]" },
  matlab: { src: matlabLogo, size: "size-[74%]" },
  octave: { src: octaveLogo, size: "size-[70%]" },
  rust: { src: rustLogo, size: "size-[70%]" },
  bash: { src: bashLogo, size: "size-[70%]" },
  spss: { src: spssLogo, size: "size-[76%]" },
  stata: { src: stataLogo, size: "size-[84%]" },
  "wolfram-language": { src: wolframLogo, size: "size-[68%]" },
};

/** A language's bare logo, for tabs and small labels. */
export function ComputeLanguageLogo({
  languageId,
  className,
}: {
  languageId: string;
  className?: string;
}) {
  const logo = LANGUAGE_LOGOS[languageId];
  return logo ? (
    <img src={logo.src} alt="" aria-hidden className={cn("object-contain", className)} />
  ) : (
    <CodeXmlIcon aria-hidden className={className} />
  );
}

/** A language's logo in the same framed tile as an extension's. */
export function ComputeLanguageMark({
  languageId,
  large = false,
}: {
  languageId: string;
  large?: boolean;
}) {
  const logo = LANGUAGE_LOGOS[languageId];
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[25%] border border-border bg-white [color-scheme:light]",
        large ? "size-16" : "size-10",
      )}
    >
      {logo ? (
        <img src={logo.src} alt="" className={cn(logo.size, "object-contain")} />
      ) : (
        <CodeXmlIcon data-language-icon={languageId} className="size-[60%] text-foreground/70" />
      )}
    </span>
  );
}

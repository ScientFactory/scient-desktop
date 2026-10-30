import { DatabaseIcon, SigmaIcon, type LucideIcon } from "lucide-react";

import juliaLogo from "~/assets/compute/julia.svg";
import matlabLogo from "~/assets/compute/matlab.svg";
import octaveLogo from "~/assets/compute/octave.svg";
import pythonLogo from "~/assets/compute/python.svg";
import rLogo from "~/assets/compute/r.svg";
import rustLogo from "~/assets/compute/rust.svg";
import spssLogo from "~/assets/compute/spss.svg";
import wolframLogo from "~/assets/compute/wolfram.svg";
import { cn } from "~/lib/utils";

const LANGUAGE_LOGOS: Readonly<Record<string, string>> = {
  python: pythonLogo,
  matlab: matlabLogo,
  julia: juliaLogo,
  r: rLogo,
  octave: octaveLogo,
  rust: rustLogo,
  spss: spssLogo,
  "wolfram-language": wolframLogo,
};
const LANGUAGE_SYMBOLS: Readonly<Record<string, LucideIcon>> = {
  sql: DatabaseIcon,
};

/** A language's logo in the same framed tile as an extension's. */
export function ComputeLanguageMark({
  languageId,
  large = false,
}: {
  languageId: string;
  large?: boolean;
}) {
  const logo = LANGUAGE_LOGOS[languageId];
  const Symbol = LANGUAGE_SYMBOLS[languageId] ?? SigmaIcon;
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[25%] border border-border bg-white [color-scheme:light]",
        large ? "size-16 p-3" : "size-10 p-2",
      )}
    >
      {logo ? (
        <img src={logo} alt="" className="size-full object-contain" />
      ) : (
        <Symbol data-language-icon={languageId} className="size-full text-foreground/75" />
      )}
    </span>
  );
}

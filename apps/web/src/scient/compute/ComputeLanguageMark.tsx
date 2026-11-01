import { CodeXmlIcon } from "lucide-react";

import { cn } from "~/lib/utils";

/** Served as files, not inlined: there are many logos and any one screen shows a few of them. */
const LOGO_FILES = import.meta.glob<string>("../../assets/compute/*.{svg,png}", {
  eager: true,
  import: "default",
  query: "?url&no-inline",
});

/**
 * Every file is trimmed to its artwork, so its size is the logo's share of the tile. Each is set by
 * eye: a thin wordmark needs more width than a solid disc to look the same size.
 */
const LOGO_SIZES: Readonly<Record<string, string>> = {
  python: "size-[68%]",
  r: "size-[74%]",
  julia: "size-[66%]",
  sql: "size-[66%]",
  matlab: "size-[74%]",
  octave: "size-[70%]",
  rust: "size-[70%]",
  bash: "size-[70%]",
  spss: "size-[76%]",
  stata: "size-[84%]",
  "wolfram-language": "size-[68%]",
  agda: "size-[74%]",
  ampl: "size-[70%]",
  apl: "size-[67%]",
  c: "size-[69%]",
  clojure: "size-[67%]",
  "common-lisp": "size-[70%]",
  coq: "size-[88%]",
  cpp: "size-[70%]",
  csharp: "size-[68%]",
  elixir: "size-[73%]",
  erlang: "size-[78%]",
  fortran: "size-[66%]",
  fsharp: "size-[71%]",
  gams: "size-[60%]",
  gap: "size-[72%]",
  gnuplot: "size-[63%]",
  go: "size-[85%]",
  gp: "size-[81%]",
  haskell: "size-[74%]",
  idl: "size-[80%]",
  "imagej-macro": "size-[76%]",
  isabelle: "size-[70%]",
  jags: "size-[88%]",
  java: "size-[84%]",
  javascript: "size-[63%]",
  kotlin: "size-[65%]",
  lean: "size-[68%]",
  lua: "size-[70%]",
  macaulay2: "size-[66%]",
  magma: "size-[88%]",
  maple: "size-[72%]",
  maxima: "size-[88%]",
  minizinc: "size-[70%]",
  modelica: "size-[79%]",
  mplus: "size-[88%]",
  netlogo: "size-[78%]",
  nextflow: "size-[70%]",
  nim: "size-[75%]",
  ocaml: "size-[68%]",
  perl: "size-[68%]",
  powershell: "size-[70%]",
  prolog: "size-[66%]",
  racket: "size-[68%]",
  root: "size-[66%]",
  ruby: "size-[65%]",
  sage: "size-[73%]",
  sas: "size-[67%]",
  scala: "size-[72%]",
  scilab: "size-[66%]",
  singular: "size-[76%]",
  snakemake: "size-[66%]",
  stan: "size-[65%]",
  tcl: "size-[82%]",
  typescript: "size-[65%]",
  verilog: "size-[77%]",
  vhdl: "size-[66%]",
  zig: "size-[70%]",
};

function languageLogo(languageId: string) {
  const size = LOGO_SIZES[languageId];
  const src =
    LOGO_FILES[`../../assets/compute/${languageId}.svg`] ??
    LOGO_FILES[`../../assets/compute/${languageId}.png`];
  return size !== undefined && src !== undefined ? { src, size } : undefined;
}

/** A language's bare logo, for tabs and small labels. */
export function ComputeLanguageLogo({
  languageId,
  className,
}: {
  languageId: string;
  className?: string;
}) {
  const logo = languageLogo(languageId);
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
  const logo = languageLogo(languageId);
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

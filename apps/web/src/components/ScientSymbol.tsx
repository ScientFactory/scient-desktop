import scientSymbolUrl from "../assets/scient-symbol.svg?url";
import scientSymbolStrongUrl from "../assets/scient-symbol-strong.svg?url";
import { cn } from "../lib/utils";

export function ScientSymbol({
  className,
  weight = "regular",
}: {
  readonly className?: string;
  readonly weight?: "regular" | "strong";
}) {
  return (
    <img
      aria-hidden
      className={cn("shrink-0", className)}
      src={weight === "strong" ? scientSymbolStrongUrl : scientSymbolUrl}
      alt=""
    />
  );
}

import scientSymbolUrl from "../assets/scient-symbol.svg?url";
import { cn } from "../lib/utils";

export function ScientSymbol({ className }: { readonly className?: string }) {
  return <img aria-hidden className={cn("shrink-0", className)} src={scientSymbolUrl} alt="" />;
}

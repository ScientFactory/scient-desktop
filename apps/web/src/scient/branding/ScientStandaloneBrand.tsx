import { APP_BASE_NAME } from "../../branding";
import { ScientSymbol } from "../../components/ScientSymbol";

/** Product lockup on standalone pages: pairing, agent and CLI connect, prompt links, route errors. */
export function ScientStandaloneBrand() {
  return (
    <span className="flex items-center gap-1.5" role="img" aria-label={APP_BASE_NAME}>
      <ScientSymbol className="size-4" />
      <span className="text-lg font-medium tracking-tight text-foreground">{APP_BASE_NAME}</span>
    </span>
  );
}

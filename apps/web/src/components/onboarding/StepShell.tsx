import { ChevronLeftIcon } from "lucide-react";
import { Button } from "../ui/button";

export function StepShell({
  title,
  description,
  onBack,
  backDisabled = false,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly onBack?: () => void;
  readonly backDisabled?: boolean;
  readonly children?: React.ReactNode;
}) {
  return (
    <>
      {onBack ? (
        <Button
          className="mb-5 -ml-2"
          disabled={backDisabled}
          onClick={onBack}
          size="xs"
          variant="ghost-muted"
        >
          <ChevronLeftIcon className="size-3.5" />
          Back
        </Button>
      ) : null}
      <h1 className="text-3xl font-semibold text-foreground sm:text-[34px]">{title}</h1>
      {description ? (
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </>
  );
}

import { ChevronDownIcon, ChevronUpIcon, LoaderIcon } from "lucide-react";
import { useId } from "react";

import { Button } from "../../components/ui/button";

export function ProviderAuthorizationCodeForm(props: {
  readonly authorizationCode: string;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly providerName: string;
  readonly submitting?: boolean;
  readonly onAuthorizationCodeChange: (value: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <form
      className="flex w-full items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <input
        aria-label={`${props.providerName} one-time authorization code`}
        autoCapitalize="none"
        autoComplete="off"
        className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors placeholder:text-placeholder focus-visible:border-ring disabled:opacity-64"
        disabled={props.disabled}
        onChange={(event) => props.onAuthorizationCodeChange(event.currentTarget.value)}
        placeholder={props.placeholder ?? "Paste authorization code"}
        spellCheck={false}
        value={props.authorizationCode}
      />
      <Button
        disabled={props.disabled || props.submitting || props.authorizationCode.trim().length === 0}
        size="sm"
        type="submit"
        variant="outline"
      >
        {props.submitting ? <LoaderIcon className="animate-spin" /> : null}
        Submit
      </Button>
    </form>
  );
}

export function ProviderAuthorizationCodeDisclosure(props: {
  readonly authorizationCode: string;
  readonly disabled?: boolean;
  readonly expanded: boolean;
  readonly providerName: string;
  readonly submitting?: boolean;
  readonly onAuthorizationCodeChange: (value: string) => void;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onSubmit: () => void;
}) {
  const formId = useId();

  return (
    <div className="w-full space-y-2 in-[[data-model-picker-content=true]]:max-w-64">
      <Button
        aria-controls={formId}
        aria-expanded={props.expanded}
        className="text-muted-foreground in-[[data-model-picker-content=true]]:mx-auto"
        disabled={props.disabled}
        onClick={() => props.onExpandedChange(!props.expanded)}
        size="sm"
        type="button"
        variant="ghost-muted"
      >
        {props.expanded ? <ChevronUpIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
        Have a sign-in code?
      </Button>
      {props.expanded ? (
        <div id={formId}>
          <ProviderAuthorizationCodeForm
            authorizationCode={props.authorizationCode}
            disabled={props.disabled ?? false}
            onAuthorizationCodeChange={props.onAuthorizationCodeChange}
            onSubmit={props.onSubmit}
            placeholder="Paste sign-in code"
            providerName={props.providerName}
            submitting={props.submitting ?? false}
          />
        </div>
      ) : null}
    </div>
  );
}

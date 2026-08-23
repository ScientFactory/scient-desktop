import { LoaderIcon } from "lucide-react";

import { Button } from "../../components/ui/button";

export function ProviderAuthorizationCodeForm(props: {
  readonly authorizationCode: string;
  readonly disabled?: boolean;
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
        placeholder="Paste authorization code"
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

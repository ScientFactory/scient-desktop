import { T, useGT } from "gt-react";
import { ChevronDownIcon, ChevronUpIcon, LoaderIcon } from "lucide-react";
import { useId } from "react";

import { Button } from "../../components/ui/button";

export function ProviderAuthorizationCodeForm(props: {
  readonly authorizationCode: string;
  readonly disabled?: boolean;
  /** Replaces the default accessible name, for an answer that is not a sign-in code. */
  readonly inputLabel?: string;
  readonly placeholder?: string;
  readonly providerName: string;
  readonly responseKind?: "code" | "callback_url";
  /** The answer is a credential: do not show it as typed. */
  readonly secret?: boolean;
  readonly submitting?: boolean;
  readonly onAuthorizationCodeChange: (value: string) => void;
  readonly onSubmit: () => void;
}) {
  const gt = useGT();
  return (
    <form
      className="flex w-full items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <input
        aria-label={
          props.inputLabel ??
          (props.responseKind === "callback_url"
            ? gt("{provider} sign-in redirect URL", { provider: props.providerName })
            : gt("{provider} one-time authorization code", { provider: props.providerName }))
        }
        autoCapitalize="none"
        autoComplete="off"
        className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors placeholder:text-placeholder focus-visible:border-ring disabled:opacity-64"
        disabled={props.disabled}
        onChange={(event) => props.onAuthorizationCodeChange(event.currentTarget.value)}
        placeholder={
          props.placeholder ??
          (props.responseKind === "callback_url"
            ? gt("Paste the full redirect URL")
            : gt("Paste authorization code"))
        }
        spellCheck={false}
        type={props.secret ? "password" : "text"}
        value={props.authorizationCode}
      />
      <Button
        disabled={props.disabled || props.submitting || props.authorizationCode.trim().length === 0}
        size="sm"
        type="submit"
        variant="outline"
      >
        {props.submitting ? <LoaderIcon className="animate-spin" /> : null}
        <T>Submit</T>
      </Button>
    </form>
  );
}

export function ProviderAuthorizationCodeDisclosure(props: {
  readonly authorizationCode: string;
  readonly disabled?: boolean;
  readonly expanded: boolean;
  readonly providerName: string;
  readonly responseKind?: "code" | "callback_url";
  readonly submitting?: boolean;
  readonly onAuthorizationCodeChange: (value: string) => void;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onSubmit: () => void;
}) {
  const formId = useId();
  const gt = useGT();

  return (
    <div className="w-full space-y-2 in-[[data-model-picker-content=true]]:max-w-64">
      <Button
        aria-controls={formId}
        aria-expanded={props.expanded}
        className="in-[[data-model-picker-content=true]]:mx-auto"
        disabled={props.disabled}
        onClick={() => props.onExpandedChange(!props.expanded)}
        size="sm"
        type="button"
        variant="ghost-muted"
      >
        {props.expanded ? <ChevronUpIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
        {props.responseKind === "callback_url"
          ? gt("Signing in on another computer?")
          : gt("Have a sign-in code?")}
      </Button>
      {props.expanded ? (
        <div className="space-y-2" id={formId}>
          {props.responseKind === "callback_url" ? (
            <p className="text-muted-foreground text-xs">
              <T>If Google redirects to an unreachable localhost page, paste its full URL here.</T>
            </p>
          ) : null}
          <ProviderAuthorizationCodeForm
            authorizationCode={props.authorizationCode}
            disabled={props.disabled ?? false}
            onAuthorizationCodeChange={props.onAuthorizationCodeChange}
            onSubmit={props.onSubmit}
            placeholder={
              props.responseKind === "callback_url"
                ? gt("Paste the full redirect URL")
                : gt("Paste sign-in code")
            }
            providerName={props.providerName}
            responseKind={props.responseKind ?? "code"}
            submitting={props.submitting ?? false}
          />
        </div>
      ) : null}
    </div>
  );
}

import type {
  ConnectorAddInput,
  ConnectorSummary,
  CredentialStrategy,
  DiscoverEntry,
  EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";

import { SecretInput } from "../../components/settings/SecretInput";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { NativeSelect } from "../../components/ui/select";
import { toastManager } from "../../components/ui/toast";
import { useAtomCommand } from "../../state/use-atom-command";
import { addConnector, startConnectorSignIn } from "./extensionsState";
import { ActionError, commandFailureMessage, SignInBlockedNotice } from "./ExtensionsFeedback";
import { validateConnectorUrl, validateHeaderName } from "./extensionsView";
import { openAuthorizationPage } from "./openAuthorizationPage";

type AuthMode = "automatic" | "api-key";

const STRATEGY_LABELS: Readonly<Record<CredentialStrategy, string>> = {
  bearer: "Bearer token",
  header: "Custom header",
  basic: "Basic auth",
};

/** Remotes Scient can reach as a connector without extra user input. */
export function installableRemotes(entry: DiscoverEntry) {
  return entry.remotes.filter(
    (remote) => remote.type === "streamable-http" && !remote.requiresInput,
  );
}

interface AddConnectorErrors {
  url?: string;
  remote?: string;
  clientId?: string;
  headerName?: string;
  value?: string;
}

interface Draft {
  readonly url: string;
  readonly remoteUrl: string;
  readonly displayName: string;
  readonly authMode: AuthMode;
  readonly showAdvanced: boolean;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly strategy: CredentialStrategy;
  readonly headerName: string;
  readonly value: string;
}

function emptyDraft(entry: DiscoverEntry | null): Draft {
  return {
    url: "",
    remoteUrl: entry ? (installableRemotes(entry)[0]?.url ?? "") : "",
    displayName: entry?.title ?? "",
    authMode: "automatic",
    showAdvanced: false,
    clientId: "",
    clientSecret: "",
    strategy: "bearer",
    headerName: "",
    value: "",
  };
}

export function validateAddConnectorDraft(
  draft: Draft,
  entry: DiscoverEntry | null,
): AddConnectorErrors {
  const errors: AddConnectorErrors = {};
  if (entry === null) {
    const url = validateConnectorUrl(draft.url);
    if (url !== null) errors.url = url;
  } else if (!installableRemotes(entry).some((remote) => remote.url === draft.remoteUrl)) {
    errors.remote = "Choose an endpoint.";
  }
  if (draft.authMode === "automatic") {
    if (draft.clientSecret.trim().length > 0 && draft.clientId.trim().length === 0) {
      errors.clientId = "Enter the client ID to use a client secret.";
    }
  } else {
    if (draft.strategy === "header") {
      const headerName = validateHeaderName(draft.headerName);
      if (headerName !== null) errors.headerName = headerName;
    }
    const value = draft.value.trim();
    if (value.length === 0) errors.value = "Enter the key.";
    else if (draft.strategy === "basic" && !value.includes(":")) {
      errors.value = "Use user:password.";
    }
  }
  return errors;
}

function toAddInput(draft: Draft, entry: DiscoverEntry | null): ConnectorAddInput {
  const displayName = draft.displayName.trim();
  const clientId = draft.clientId.trim();
  const clientSecret = draft.clientSecret.trim();
  return {
    target: entry
      ? { type: "registry", name: entry.name, version: entry.version, url: draft.remoteUrl }
      : { type: "url", url: draft.url.trim() },
    ...(displayName ? { displayName } : {}),
    ...(draft.authMode === "automatic" && clientId
      ? { oauthClient: { clientId, ...(clientSecret ? { clientSecret } : {}) } }
      : {}),
    ...(draft.authMode === "api-key"
      ? {
          credential: {
            type: "entered" as const,
            strategy: draft.strategy,
            ...(draft.strategy === "header" ? { headerName: draft.headerName.trim() } : {}),
            value: draft.value.trim(),
          },
        }
      : {}),
  };
}

/** Fields in visual order; the first invalid one takes focus after a failed submit. */
const FIELD_IDS: ReadonlyArray<readonly [keyof AddConnectorErrors, string]> = [
  ["url", "connector-url"],
  ["remote", "connector-remote"],
  ["clientId", "connector-client-id"],
  ["headerName", "connector-header-name"],
  ["value", "connector-key"],
];

function FieldError({
  id,
  message,
}: {
  readonly id: string;
  readonly message: string | undefined;
}) {
  return (
    <p id={id} aria-live="polite" className="text-xs text-destructive-foreground empty:hidden">
      {message}
    </p>
  );
}

/** Wires a control to its error message for assistive technology. */
function invalidProps(fieldId: string, message: string | undefined) {
  return message ? { "aria-invalid": true as const, "aria-describedby": `${fieldId}-error` } : {};
}

/**
 * Adds a connected service by URL or from a Discover entry. Mount it once per
 * add: the draft starts from `entry`. Keys and client secrets are sent once
 * and never read back. Binding a secret from Settings → Secrets is offered
 * only once that vault exists.
 */
export function AddConnectorDialog({
  open,
  onOpenChange,
  environmentId,
  entry,
  callbackOrigin,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  /** Prefills a registry target; null adds by URL. */
  readonly entry: DiscoverEntry | null;
  readonly callbackOrigin: string | null;
}) {
  const add = useAtomCommand(addConnector, { reportFailure: false });
  const startSignIn = useAtomCommand(startConnectorSignIn, { reportFailure: true });
  const [draft, setDraft] = useState(() => emptyDraft(entry));
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState<ConnectorSummary | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [blockedSignInUrl, setBlockedSignInUrl] = useState<string | null>(null);
  const errors = validateAddConnectorDraft(draft, entry);
  const shownErrors = attempted ? errors : {};
  const remotes = entry ? installableRemotes(entry) : [];

  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));
  const close = () => onOpenChange(false);

  const submit = async () => {
    if (submitting) return;
    const invalid = FIELD_IDS.find(([field]) => errors[field] !== undefined);
    if (invalid) {
      setAttempted(true);
      document.getElementById(invalid[1])?.focus();
      return;
    }
    const input = toAddInput(draft, entry);
    const sentSecret = draft.value.length > 0 || draft.clientSecret.length > 0;
    // Secrets leave the form as soon as they are sent, whatever the outcome.
    patch({ value: "", clientSecret: "" });
    setAttempted(false);
    setSubmitting(true);
    setServerError(null);
    const result = await add({ environmentId, input });
    setSubmitting(false);
    if (result._tag === "Failure") {
      const message = commandFailureMessage(result);
      if (message === null) return;
      setServerError(sentSecret ? `${message} Enter the key again to retry.` : message);
      return;
    }
    if (result.value.nextStep === "sign-in-required") {
      setNeedsSignIn(result.value.connector);
      return;
    }
    toastManager.add({ type: "success", title: `${result.value.connector.displayName} connected` });
    close();
  };

  const signIn = async (connector: ConnectorSummary) => {
    if (callbackOrigin === null || signingIn) return;
    setSigningIn(true);
    setSignInError(null);
    setBlockedSignInUrl(null);
    const opening = await openAuthorizationPage(async () => {
      const result = await startSignIn({
        environmentId,
        input: { connectorId: connector.connectorId, callbackOrigin },
      });
      setSignInError(commandFailureMessage(result));
      return result._tag === "Success" ? result.value.authorizationUrl : null;
    }).finally(() => setSigningIn(false));
    if (opening.outcome === "opened") close();
    else if (opening.outcome === "blocked") setBlockedSignInUrl(opening.url);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <DialogPopup className="max-w-md">
        {needsSignIn ? (
          <>
            <DialogHeader>
              <DialogTitle>Sign in to {needsSignIn.displayName}</DialogTitle>
              <DialogDescription>
                Added. Sign in to finish connecting. Agents receive it after you sign in.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="grid gap-2">
                <ActionError message={signInError} />
                <SignInBlockedNotice url={blockedSignInUrl} />
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="outline" onClick={close}>
                Later
              </Button>
              <Button
                disabled={callbackOrigin === null || signingIn}
                onClick={() => void signIn(needsSignIn)}
              >
                Sign in
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {entry ? `Add ${entry.title ?? entry.name}` : "Add a connected service"}
              </DialogTitle>
              <DialogDescription>
                A remote MCP server. Scient keeps its sign-in; agents never receive it.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <form
                className="grid gap-4"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                {entry ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor="connector-remote">Endpoint</Label>
                    <NativeSelect
                      id="connector-remote"
                      value={draft.remoteUrl}
                      {...invalidProps("connector-remote", shownErrors.remote)}
                      onChange={(event) => patch({ remoteUrl: event.target.value })}
                    >
                      {remotes.map((remote) => (
                        <option key={remote.url} value={remote.url}>
                          {remote.url}
                        </option>
                      ))}
                    </NativeSelect>
                    <FieldError id="connector-remote-error" message={shownErrors.remote} />
                  </div>
                ) : (
                  <div className="grid gap-1.5">
                    <Label htmlFor="connector-url">Server URL</Label>
                    <Input
                      id="connector-url"
                      placeholder="https://mcp.example.com/mcp"
                      value={draft.url}
                      autoFocus
                      {...invalidProps("connector-url", shownErrors.url)}
                      onChange={(event) => patch({ url: event.target.value })}
                    />
                    <FieldError id="connector-url-error" message={shownErrors.url} />
                  </div>
                )}
                <div className="grid gap-1.5">
                  <Label htmlFor="connector-name">Name (optional)</Label>
                  <Input
                    id="connector-name"
                    placeholder="Defaults to the server's name"
                    value={draft.displayName}
                    onChange={(event) => patch({ displayName: event.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="connector-auth">Authentication</Label>
                  <NativeSelect
                    id="connector-auth"
                    value={draft.authMode}
                    onChange={(event) =>
                      // A key typed for one mode never rides along with another.
                      patch({
                        authMode: event.target.value as AuthMode,
                        value: "",
                        clientSecret: "",
                      })
                    }
                  >
                    <option value="automatic">Sign in if the server asks</option>
                    <option value="api-key">API key</option>
                  </NativeSelect>
                </div>
                {draft.authMode === "automatic" ? (
                  <div className="grid gap-3">
                    <button
                      type="button"
                      className="justify-self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      aria-expanded={draft.showAdvanced}
                      onClick={() =>
                        patch(
                          draft.showAdvanced
                            ? { showAdvanced: false, clientId: "", clientSecret: "" }
                            : { showAdvanced: true },
                        )
                      }
                    >
                      Advanced
                    </button>
                    {draft.showAdvanced ? (
                      <>
                        <p className="text-xs text-muted-foreground">
                          Use an OAuth client you registered with the service. Leave empty to
                          register automatically.
                        </p>
                        <div className="grid gap-1.5">
                          <Label htmlFor="connector-client-id">Client ID</Label>
                          <Input
                            id="connector-client-id"
                            value={draft.clientId}
                            {...invalidProps("connector-client-id", shownErrors.clientId)}
                            onChange={(event) => patch({ clientId: event.target.value })}
                          />
                          <FieldError
                            id="connector-client-id-error"
                            message={shownErrors.clientId}
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <Label htmlFor="connector-client-secret">Client secret (optional)</Label>
                          <SecretInput
                            id="connector-client-secret"
                            value={draft.clientSecret}
                            onChange={(event) => patch({ clientSecret: event.target.value })}
                          />
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : (
                  <div className="grid gap-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor="connector-strategy">Send as</Label>
                      <NativeSelect
                        id="connector-strategy"
                        value={draft.strategy}
                        onChange={(event) =>
                          patch({ strategy: event.target.value as CredentialStrategy })
                        }
                      >
                        {(Object.keys(STRATEGY_LABELS) as CredentialStrategy[]).map((strategy) => (
                          <option key={strategy} value={strategy}>
                            {STRATEGY_LABELS[strategy]}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                    {draft.strategy === "header" ? (
                      <div className="grid gap-1.5">
                        <Label htmlFor="connector-header-name">Header name</Label>
                        <Input
                          id="connector-header-name"
                          placeholder="X-API-Key"
                          value={draft.headerName}
                          {...invalidProps("connector-header-name", shownErrors.headerName)}
                          onChange={(event) => patch({ headerName: event.target.value })}
                        />
                        <FieldError
                          id="connector-header-name-error"
                          message={shownErrors.headerName}
                        />
                      </div>
                    ) : null}
                    <div className="grid gap-1.5">
                      <Label htmlFor="connector-key">
                        {draft.strategy === "basic" ? "User and password" : "Key"}
                      </Label>
                      <SecretInput
                        id="connector-key"
                        placeholder={draft.strategy === "basic" ? "user:password" : undefined}
                        value={draft.value}
                        {...invalidProps("connector-key", shownErrors.value)}
                        onChange={(event) => patch({ value: event.target.value })}
                      />
                      <FieldError id="connector-key-error" message={shownErrors.value} />
                      <p className="text-xs text-muted-foreground">
                        Sent once and stored on the server. It is never shown again.
                      </p>
                    </div>
                  </div>
                )}
                {serverError ? (
                  <p role="alert" className="text-sm text-destructive-foreground">
                    {serverError}
                  </p>
                ) : null}
                <button type="submit" hidden />
              </form>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button disabled={submitting} onClick={() => void submit()}>
                {submitting ? "Adding…" : "Add"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

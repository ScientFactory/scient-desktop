import type {
  ConnectorAddInput,
  ConnectorSummary,
  ConnectorTestResult,
  DiscoverEntry,
  EnvironmentId,
  LocalBundleField,
  LocalBundleInspection,
  LocalEnvironmentInput,
  LocalImportableServer,
} from "@t3tools/contracts";
import { VaultSecretRef } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { SecretInput } from "../../components/settings/SecretInput";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
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
import { readLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { commandFailureMessage } from "./ExtensionsFeedback";
import {
  addConnector,
  inspectLocalBundle,
  listImportableConnectors,
  testConnector,
} from "./extensionsState";
import { entryName, splitCommandLine } from "./extensionsView";
import {
  initialAnswers,
  LocalSetupFields,
  type SetupAnswer,
  setupInput,
  useKeyAccounts,
} from "./LocalSetupFields";

interface Variable {
  readonly id: number;
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
}

type Step =
  | { readonly name: "choose" }
  | { readonly name: "bundle"; readonly path: string; readonly bundle: LocalBundleInspection }
  | { readonly name: "servers"; readonly servers: ReadonlyArray<LocalImportableServer> }
  | { readonly name: "command" }
  | {
      readonly name: "check";
      readonly connector: ConnectorSummary;
      readonly result: ConnectorTestResult | null;
    };

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

let lastVariableId = 0;
const newVariableId = () => ++lastVariableId;

/** A registry package's declared variables, asked like a bundle's settings. */
const packageFields = (entry: DiscoverEntry): ReadonlyArray<LocalBundleField> =>
  (entry.localPackage?.environment ?? []).map((variable) => ({
    key: variable.name,
    type: "string",
    title: variable.name,
    ...(variable.description === undefined ? {} : { description: variable.description }),
    required: variable.required && variable.default === undefined,
    sensitive: variable.secret,
    multiple: false,
    ...(variable.default === undefined ? {} : { default: variable.default }),
    envName: variable.name,
  }));

function ServerRows({
  servers,
  busy,
  onAdd,
}: {
  readonly servers: ReadonlyArray<LocalImportableServer>;
  readonly busy: string | null;
  readonly onAdd: (server: LocalImportableServer) => void;
}) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {servers.map((server) => {
        const key = `${server.sourceLabel}:${server.name}`;
        return (
          <li key={key} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{server.name}</p>
              <p className="truncate text-xs text-muted-foreground">{server.sourceLabel}</p>
            </div>
            {server.installedConnectorId ? (
              <span className="text-xs text-muted-foreground">Added</span>
            ) : (
              <Button
                size="xs"
                variant="outline"
                aria-label={`Add ${server.name} from ${server.sourceLabel}`}
                disabled={busy !== null}
                onClick={() => onAdd(server)}
              >
                {busy === key ? "Adding…" : "Add"}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function CheckResult({ step }: { readonly step: Extract<Step, { name: "check" }> }) {
  const { connector, result } = step;
  if (result === null) {
    return <p className="text-sm text-muted-foreground">Checking that it starts…</p>;
  }
  if (result.outcome === "ok") {
    const names = result.tools.slice(0, 6).map((tool) => tool.name);
    return (
      <div className="grid gap-1">
        <p className="text-sm font-medium">
          Ready: {result.tools.length} {result.tools.length === 1 ? "tool" : "tools"}
        </p>
        {names.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {names.join(", ")}
            {result.tools.length > names.length ? ", …" : ""}
          </p>
        ) : null}
      </div>
    );
  }
  if (result.outcome === "needs-setup") {
    return (
      <p className="text-sm">
        {connector.displayName} is added and still needs{" "}
        {connector.local?.missing.join(", ") ?? "setup"}. Agents ask for it in the chat when they
        use it, or you can set it up on its page.
      </p>
    );
  }
  return (
    <p role="alert" className="text-sm text-destructive-foreground">
      {connector.displayName} is added but did not start: {result.message ?? "no answer"}. Fix it on
      its page, then choose Restart.
    </p>
  );
}

/**
 * Adds a connector Scient runs on the environment's computer: a bundle file or folder, a server
 * another app already runs, an MCP Registry package (`entry`), or, under Advanced, a command.
 * It checks the connector once added.
 */
export function AddLocalConnectorDialog({
  open,
  onOpenChange,
  environmentId,
  entry,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly entry: DiscoverEntry | null;
}) {
  const formId = useId();
  const pkg = entry?.localPackage;
  const add = useAtomCommand(addConnector, { reportFailure: false });
  const inspect = useAtomCommand(inspectLocalBundle, { reportFailure: false });
  const test = useAtomCommand(testConnector, { reportFailure: false });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const accounts = useKeyAccounts(environmentId);
  const filePicker = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>({ name: "choose" });
  const [path, setPath] = useState("");
  const [reading, setReading] = useState(false);
  const listImportable = useAtomCommand(listImportableConnectors, { reportFailure: false });
  const [importable, setImportable] = useState<ReadonlyArray<LocalImportableServer>>([]);
  const [answers, setAnswers] = useState<Record<string, SetupAnswer>>(() =>
    entry ? initialAnswers(packageFields(entry), accounts) : {},
  );
  const [commandLine, setCommandLine] = useState("");
  const [displayName, setDisplayName] = useState(entry ? entryName(entry) : "");
  const [variables, setVariables] = useState<ReadonlyArray<Variable>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // A picked path names a file on this computer, so only the local environment can use it.
  const local = environmentId === primaryEnvironmentId;
  const getPathForFile = local ? window.desktopBridge?.getPathForFile : undefined;
  const pickFolder = local && window.desktopBridge ? readLocalApi()?.dialogs.pickFolder : undefined;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads other apps' servers from the environment's computer once the dialog opens
  useEffect(() => {
    if (pkg !== undefined) return;
    let live = true;
    void listImportable({ environmentId, input: {} }).then((result) => {
      if (live && result._tag === "Success") setImportable(result.value.servers);
    });
    return () => {
      live = false;
    };
  }, [environmentId, listImportable, pkg]);

  const readPath = async (candidate: string) => {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) return;
    setPath(trimmed);
    setReading(true);
    setError(null);
    const result = await inspect({ environmentId, input: { path: trimmed } });
    setReading(false);
    if (result._tag !== "Success") {
      setError(commandFailureMessage(result));
      return;
    }
    if (result.value.kind === "servers") {
      setStep({ name: "servers", servers: result.value.servers });
      return;
    }
    setStep({ name: "bundle", path: trimmed, bundle: result.value });
    setAnswers(initialAnswers(result.value.fields, accounts));
    if (!displayName.trim()) setDisplayName(result.value.displayName);
  };

  const finish = async (target: ConnectorAddInput["target"], busyKey: string) => {
    setBusy(busyKey);
    setError(null);
    const name = displayName.trim();
    const description = entry?.description?.trim().slice(0, 1000);
    const result = await add({
      environmentId,
      input: {
        target,
        ...(name && target.type !== "local-import" ? { displayName: name } : {}),
        ...(description ? { description } : {}),
      },
    });
    setBusy(null);
    if (result._tag !== "Success") {
      setError(commandFailureMessage(result));
      return;
    }
    const connector = result.value.connector;
    setStep({ name: "check", connector, result: null });
    const checked = await test({ environmentId, input: { connectorId: connector.connectorId } });
    setStep({
      name: "check",
      connector,
      result:
        checked._tag === "Success"
          ? checked.value
          : {
              connectorId: connector.connectorId,
              outcome: "error",
              checkedAt: connector.updatedAt,
              tools: [],
              message: commandFailureMessage(checked) ?? "The check did not finish",
            },
    });
  };

  const environment = (): ReadonlyArray<LocalEnvironmentInput> | string => {
    const entries = variables.filter((variable) => variable.name.trim() || variable.value);
    for (const variable of entries) {
      if (!VARIABLE_NAME.test(variable.name.trim())) {
        return `${variable.name.trim() || "A variable"} is not a valid variable name.`;
      }
    }
    return entries.map((variable) => ({
      name: variable.name.trim(),
      value: variable.value,
      secret: variable.secret,
    }));
  };

  const submit = async () => {
    if (busy !== null) return;
    if (pkg !== undefined && entry !== null) {
      const fields = packageFields(entry);
      const input = setupInput(fields, answers);
      if (typeof input === "string") return setError(input);
      const entries = fields.flatMap((field): LocalEnvironmentInput[] => {
        const key = input.keys[field.key];
        if (key !== undefined) {
          return [
            key.type === "account"
              ? { name: field.key, value: "", secret: true, account: VaultSecretRef.make(key.ref) }
              : { name: field.key, value: key.value, secret: true },
          ];
        }
        const value = input.settings[field.key];
        return value === undefined
          ? []
          : [{ name: field.key, value: String(value), secret: false }];
      });
      return finish(
        {
          type: "local-package",
          name: entry.name,
          version: entry.version,
          package: pkg,
          environment: entries,
        },
        "add",
      );
    }
    if (step.name === "bundle") {
      const input = setupInput(step.bundle.fields, answers);
      if (typeof input === "string") return setError(input);
      return finish({ type: "local-bundle", path: step.path, ...input }, "add");
    }
    if (step.name === "command") {
      const parts = splitCommandLine(commandLine.trim());
      if (parts === null) return setError("A quote in the command is not closed.");
      const [command, ...args] = parts;
      if (command === undefined) return setError("Enter the command that starts the server.");
      const variablesInput = environment();
      if (typeof variablesInput === "string") return setError(variablesInput);
      return finish({ type: "local-command", command, args, environment: variablesInput }, "add");
    }
  };

  const importServer = (server: LocalImportableServer) =>
    void finish(
      { type: "local-import", source: server.source, name: server.name },
      `${server.sourceLabel}:${server.name}`,
    );

  const patchVariable = (id: number, next: Partial<Variable>) =>
    setVariables((current) =>
      current.map((variable) => (variable.id === id ? { ...variable, ...next } : variable)),
    );

  const title =
    step.name === "check"
      ? `${step.connector.displayName} added`
      : entry
        ? `Add ${entryName(entry)}`
        : "Add local connector";
  const showsSetup = pkg !== undefined || step.name === "bundle" || step.name === "command";
  const choosing = step.name === "choose" && pkg === undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {step.name === "check" ? null : (
            <DialogDescription>
              This runs a program on the computer running this environment. Every agent can use its
              tools.
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid gap-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {step.name === "check" ? <CheckResult step={step} /> : null}

            {choosing ? (
              <>
                <div className="grid gap-2">
                  {getPathForFile || pickFolder ? (
                    <div className="flex flex-wrap gap-2">
                      {getPathForFile ? (
                        <>
                          <Button variant="outline" onClick={() => filePicker.current?.click()}>
                            Choose a file…
                          </Button>
                          <input
                            ref={filePicker}
                            type="file"
                            accept=".mcpb,.dxt,.zip"
                            hidden
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              const picked = file ? getPathForFile(file) : null;
                              event.target.value = "";
                              if (picked) void readPath(picked);
                            }}
                          />
                        </>
                      ) : null}
                      {pickFolder ? (
                        <Button
                          variant="outline"
                          onClick={() =>
                            void pickFolder().then((picked) => {
                              if (picked) void readPath(picked);
                            })
                          }
                        >
                          Choose a folder…
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  <Label htmlFor="local-path">
                    {getPathForFile ? "Or type its path" : "Path on that computer"}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="local-path"
                      className="min-w-0 flex-1"
                      placeholder="/path/to/connector.mcpb or a folder"
                      value={path}
                      onChange={(event) => setPath(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void readPath(path);
                        }
                      }}
                    />
                    <Button
                      variant="outline"
                      disabled={reading || !path.trim()}
                      onClick={() => void readPath(path)}
                    >
                      {reading ? "Reading…" : "Open"}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    A connector file (.mcpb or .zip), or a folder with manifest.json or .mcp.json.
                  </p>
                </div>
                {importable.length > 0 ? (
                  <div className="grid gap-2">
                    <Label>From your other apps</Label>
                    <ServerRows servers={importable} busy={busy} onAdd={importServer} />
                  </div>
                ) : null}
                <Button
                  size="xs"
                  variant="ghost-muted"
                  onClick={() => {
                    setError(null);
                    setStep({ name: "command" });
                  }}
                >
                  Advanced: run a command
                </Button>
              </>
            ) : null}

            {step.name === "servers" ? (
              <div className="grid gap-2">
                <Label>Servers in that folder</Label>
                <ServerRows servers={step.servers} busy={busy} onAdd={importServer} />
              </div>
            ) : null}

            {pkg !== undefined && step.name === "choose" ? (
              <p className="text-sm text-muted-foreground">
                Runs <code>{pkg.identifier}</code> {pkg.version} through {pkg.runner}.
              </p>
            ) : null}

            {step.name === "bundle" ? (
              <div className="grid gap-0.5">
                <p className="text-sm font-medium">
                  {step.bundle.displayName}{" "}
                  <span className="font-normal text-muted-foreground">{step.bundle.version}</span>
                </p>
                {step.bundle.author ? (
                  <p className="text-xs text-muted-foreground">by {step.bundle.author}</p>
                ) : null}
                {step.bundle.description ? (
                  <p className="text-sm text-muted-foreground">{step.bundle.description}</p>
                ) : null}
                {step.bundle.unavailableReason ? (
                  <p role="alert" className="text-sm text-destructive-foreground">
                    {step.bundle.unavailableReason}
                  </p>
                ) : null}
              </div>
            ) : null}

            {step.name === "bundle" ||
            (pkg !== undefined && entry !== null && step.name === "choose") ? (
              <LocalSetupFields
                fields={step.name === "bundle" ? step.bundle.fields : packageFields(entry!)}
                answers={answers}
                accounts={accounts}
                onChange={(key, answer) => setAnswers((current) => ({ ...current, [key]: answer }))}
              />
            ) : null}

            {step.name === "command" ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="local-command">Command</Label>
                  <Input
                    id="local-command"
                    placeholder="uvx my-mcp-server --flag"
                    value={commandLine}
                    autoFocus
                    spellCheck={false}
                    onChange={(event) => setCommandLine(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Put keys in variables below, not in the command.
                  </p>
                </div>
                <div className="grid gap-2">
                  <div className="flex items-center justify-between">
                    <Label>Environment variables</Label>
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      onClick={() =>
                        setVariables((current) => [
                          ...current,
                          { id: newVariableId(), name: "", value: "", secret: false },
                        ])
                      }
                    >
                      <PlusIcon aria-hidden />
                      Add variable
                    </Button>
                  </div>
                  {variables.map((variable) => (
                    <div key={variable.id} className="flex items-center gap-2">
                      <Input
                        aria-label="Variable name"
                        className="w-40"
                        placeholder="NAME"
                        value={variable.name}
                        spellCheck={false}
                        onChange={(event) =>
                          patchVariable(variable.id, { name: event.target.value })
                        }
                      />
                      {variable.secret ? (
                        <SecretInput
                          aria-label={`${variable.name || "Variable"} value`}
                          className="min-w-0 flex-1"
                          value={variable.value}
                          onChange={(event) =>
                            patchVariable(variable.id, { value: event.target.value })
                          }
                        />
                      ) : (
                        <Input
                          aria-label={`${variable.name || "Variable"} value`}
                          className="min-w-0 flex-1"
                          value={variable.value}
                          onChange={(event) =>
                            patchVariable(variable.id, { value: event.target.value })
                          }
                        />
                      )}
                      <label className="flex items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={variable.secret}
                          onCheckedChange={(checked) =>
                            patchVariable(variable.id, { secret: checked === true })
                          }
                        />
                        Key
                      </label>
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={`Remove ${variable.name || "variable"}`}
                        onClick={() =>
                          setVariables((current) =>
                            current.filter((item) => item.id !== variable.id),
                          )
                        }
                      >
                        <XIcon aria-hidden />
                      </Button>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    A variable marked Key is saved in Accounts & secrets.
                  </p>
                </div>
              </>
            ) : null}

            {showsSetup ? (
              <div className="grid gap-1.5">
                <Label htmlFor="local-name">Name (optional)</Label>
                <Input
                  id="local-name"
                  placeholder="Defaults to the program's name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            ) : null}
            <button type="submit" hidden />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          {step.name === "check" ? (
            <Button disabled={step.result === null} onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <>
              {step.name !== "choose" && pkg === undefined ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setError(null);
                    setStep({ name: "choose" });
                  }}
                >
                  Back
                </Button>
              ) : (
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
              )}
              {showsSetup ? (
                <Button
                  disabled={
                    busy !== null ||
                    (step.name === "bundle" && step.bundle.unavailableReason !== undefined)
                  }
                  onClick={() => void submit()}
                >
                  {busy === "add" ? "Adding…" : "Add"}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

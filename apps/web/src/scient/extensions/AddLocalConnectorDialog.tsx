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
  ImportableSkill,
  PersonalSkillCandidate,
  PersonalSkillSource,
} from "@t3tools/contracts";
import { VaultSecretRef } from "@t3tools/contracts";
import { ChevronDownIcon, PlusIcon, XIcon } from "lucide-react";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { readLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../../components/ui/toast";
import { Textarea } from "../../components/ui/textarea";
import {
  addPersonalSkills,
  inspectPersonalSkills,
  listImportableSkills,
  undoPersonalSkill,
} from "../skills/scientSkillsState";
import { finishSkillPrompt, useSkillAgentChat } from "../skills/skillAgentChat";
import { canAddCandidate, ImportableSkillRows, SkillCandidateRows } from "./AddSkillsRows";
import { commandFailureMessage, ErrorNote } from "./ExtensionsFeedback";
import {
  addConnector,
  inspectLocalBundle,
  installScientPlugin,
  listImportableConnectors,
  testConnector,
} from "./extensionsState";
import { entryName, type ExtensionKind, splitCommandLine } from "./extensionsView";
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
  | { readonly name: "plugin"; readonly path: string; readonly displayName: string }
  | { readonly name: "command" }
  | {
      readonly name: "skills";
      readonly stagingId: string;
      readonly sourceLabel: string;
      readonly candidates: ReadonlyArray<PersonalSkillCandidate>;
    }
  | {
      readonly name: "check";
      readonly connector: ConnectorSummary;
      readonly result: ConnectorTestResult | null;
    };

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const WEB_ADDRESS = /^https?:\/\//i;
/** A path on that computer: absolute, home-relative, relative, or a Windows drive or share. */
const LOCAL_PATH = /^(?:\/|~|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\)/u;

/** An error as a whole and as one short line. */
interface Failure {
  readonly message: string;
  readonly summary?: string;
}

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
    <div className="grid gap-1">
      <p className="text-sm">
        {connector.displayName} is added but did not start. Fix it on its page, then choose Restart.
      </p>
      <ErrorNote message={result.message ?? "It did not answer."} />
    </div>
  );
}

/**
 * "Add your own": takes a connector file or folder, a Scient plugin folder, a server another app
 * already runs, an MCP Registry package (`entry`), or, under Advanced, a command. A web address
 * goes to `onWebAddress`. A connector is checked once added.
 */
export function AddLocalConnectorDialog({
  open,
  onOpenChange,
  environmentId,
  entry,
  onWebAddress,
  kind,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly entry: DiscoverEntry | null;
  /** A pasted `https://` address: a connector that runs online, added by URL. */
  readonly onWebAddress?: (url: string) => void;
  /** On the Skills tab, other agents' skills are offered instead of their servers. */
  readonly kind?: ExtensionKind | undefined;
}) {
  const formId = useId();
  const pkg = entry?.localPackage;
  const add = useAtomCommand(addConnector, { reportFailure: false });
  const inspect = useAtomCommand(inspectLocalBundle, { reportFailure: false });
  const test = useAtomCommand(testConnector, { reportFailure: false });
  const install = useAtomCommand(installScientPlugin, { reportFailure: false });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const accounts = useKeyAccounts(environmentId);
  const filePicker = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>({ name: "choose" });
  const [path, setPath] = useState("");
  const [reading, setReading] = useState(false);
  const listImportable = useAtomCommand(listImportableConnectors, { reportFailure: false });
  const [importable, setImportable] = useState<ReadonlyArray<LocalImportableServer>>([]);
  const skillsFirst = kind === "skills";
  const inspectSkills = useAtomCommand(inspectPersonalSkills, { reportFailure: false });
  const addSkills = useAtomCommand(addPersonalSkills, { reportFailure: false });
  const undoSkill = useAtomCommand(undoPersonalSkill, { reportFailure: false });
  const listSkills = useAtomCommand(listImportableSkills, { reportFailure: false });
  const [importableSkills, setImportableSkills] = useState<ReadonlyArray<ImportableSkill>>([]);
  const [showImports, setShowImports] = useState(false);
  const [dragging, setDragging] = useState(false);
  const startChat = useSkillAgentChat(environmentId);
  const [answers, setAnswers] = useState<Record<string, SetupAnswer>>(() =>
    entry ? initialAnswers(packageFields(entry), accounts) : {},
  );
  const [commandLine, setCommandLine] = useState("");
  const [displayName, setDisplayName] = useState(entry ? entryName(entry) : "");
  const [variables, setVariables] = useState<ReadonlyArray<Variable>>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const setError = (message: string | null, summary?: string) =>
    setFailure(message === null ? null : { message, ...(summary ? { summary } : {}) });
  const [busy, setBusy] = useState<string | null>(null);
  // A picked path names a file on this computer, so only the local environment can use it.
  const local = environmentId === primaryEnvironmentId;
  const getPathForFile = local ? window.desktopBridge?.getPathForFile : undefined;
  const pickFolder = local && window.desktopBridge ? readLocalApi()?.dialogs.pickFolder : undefined;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads other apps' servers from the environment's computer once the dialog opens
  useEffect(() => {
    if (pkg !== undefined) return;
    let live = true;
    if (skillsFirst) {
      void listSkills({ environmentId, input: {} }).then((result) => {
        if (live && result._tag === "Success") setImportableSkills(result.value.skills);
      });
    } else {
      void listImportable({ environmentId, input: {} }).then((result) => {
        if (live && result._tag === "Success") setImportable(result.value.servers);
      });
    }
    return () => {
      live = false;
    };
  }, [environmentId, listImportable, listSkills, pkg, skillsFirst]);

  /** Skills come first: a source that holds none falls through to connectors and plugins. */
  const readSkills = async (source: PersonalSkillSource) => {
    const result = await inspectSkills({ environmentId, input: { source } });
    if (result._tag !== "Success") {
      setError(commandFailureMessage(result), "Scient could not use that.");
      return "failed" as const;
    }
    if (result.value.kind === "none") return "none" as const;
    setStep({
      name: "skills",
      stagingId: result.value.stagingId,
      sourceLabel: result.value.sourceLabel,
      candidates: result.value.candidates,
    });
    return "skills" as const;
  };

  const addSkillCandidates = async (
    stagingId: string,
    candidates: ReadonlyArray<PersonalSkillCandidate>,
    busyKey: string,
  ) => {
    setBusy(busyKey);
    setError(null);
    const result = await addSkills({
      environmentId,
      input: { stagingId, keys: candidates.map((candidate) => candidate.key) },
    });
    setBusy(null);
    if (result._tag !== "Success") {
      setError(commandFailureMessage(result), "Scient could not add it.");
      return;
    }
    onOpenChange(false);
    const [only] = result.value.added;
    toastManager.add(
      result.value.added.length === 1 && only !== undefined
        ? {
            type: "success",
            title: `Added ${only}`,
            description: "It is on for every agent from your next message.",
            actionProps: {
              children: "Undo",
              onClick: () => void undoSkill({ environmentId, input: { name: only } }),
            },
          }
        : {
            type: "success",
            title: `Added ${result.value.added.length} skills`,
            description: "They are on for every agent from your next message.",
          },
    );
  };

  const finishWithAgent = async (candidate: PersonalSkillCandidate, sourceLabel: string) => {
    if (!startChat) return;
    if (await startChat(finishSkillPrompt(candidate, sourceLabel))) onOpenChange(false);
    else setError("Scient could not open a new chat.");
  };

  const importSkill = async (skill: ImportableSkill) => {
    setBusy(`${skill.app}:${skill.folder}`);
    setError(null);
    const result = await inspectSkills({
      environmentId,
      input: { source: { type: "path", path: skill.folder } },
    });
    setBusy(null);
    if (result._tag !== "Success" || result.value.kind === "none") {
      setError(
        result._tag === "Success" ? "That is no longer a skill." : commandFailureMessage(result),
        "Scient could not use that.",
      );
      return;
    }
    const [candidate, ...others] = result.value.candidates;
    if (candidate && others.length === 0 && canAddCandidate(candidate)) {
      await addSkillCandidates(result.value.stagingId, [candidate], `${skill.app}:${skill.folder}`);
      return;
    }
    setStep({
      name: "skills",
      stagingId: result.value.stagingId,
      sourceLabel: result.value.sourceLabel,
      candidates: result.value.candidates,
    });
  };

  /** One box takes a path, a web address, or a skill's text pasted in. */
  const readPath = async (candidate: string) => {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) return;
    const isWeb = WEB_ADDRESS.test(trimmed) && !/\s/u.test(trimmed);
    const isPath = !isWeb && !trimmed.includes("\n") && LOCAL_PATH.test(trimmed);
    setPath(trimmed);
    setReading(true);
    setError(null);
    if (!isWeb && !isPath) {
      await readSkills({ type: "text", text: trimmed });
      return setReading(false);
    }
    const skills = await readSkills(
      isWeb ? { type: "url", url: trimmed } : { type: "path", path: trimmed },
    );
    if (skills !== "none") return setReading(false);
    if (isWeb) {
      setReading(false);
      if (onWebAddress) return onWebAddress(trimmed);
      return setError("Scient found no skill at that address.");
    }
    const result = await inspect({ environmentId, input: { path: trimmed } });
    setReading(false);
    if (result._tag !== "Success") {
      setError(commandFailureMessage(result), "Scient could not use that.");
      return;
    }
    if (result.value.kind === "plugin") {
      setStep({ name: "plugin", path: trimmed, displayName: result.value.displayName });
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

  const finish = async (target: ConnectorAddInput["target"], busyKey: string, label = "it") => {
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
      setError(commandFailureMessage(result), `Scient could not add ${label}.`);
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
    if (step.name === "plugin") {
      setBusy("add");
      setError(null);
      const result = await install({ environmentId, input: { path: step.path } });
      setBusy(null);
      if (result._tag === "Success") return onOpenChange(false);
      return setError(
        commandFailureMessage(result),
        `Scient could not install ${step.displayName}.`,
      );
    }
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
      server.name,
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
        : step.name === "plugin"
          ? `Install ${step.displayName}`
          : step.name === "skills"
            ? step.candidates.length === 1
              ? "Add a skill"
              : "Add skills"
            : "Add your own";
  const showsSetup = pkg !== undefined || step.name === "bundle" || step.name === "command";
  const description =
    step.name === "plugin"
      ? "A Scient plugin: it adds the skills and connectors it lists. Nothing in it runs."
      : step.name === "skills"
        ? "A skill you add is on for every agent from your next message. You can turn it off or undo the change in Skills."
        : step.name === "choose" && pkg === undefined
          ? "A skill, connector or plugin. Every agent can use it."
          : "This runs a program on the computer running this environment. Every agent can use its tools.";
  const choosing = step.name === "choose" && pkg === undefined;
  const importCount = skillsFirst ? importableSkills.length : importable.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {step.name === "check" ? null : <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid grid-cols-1 gap-4 [overflow-wrap:anywhere]"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {step.name === "check" ? <CheckResult step={step} /> : null}

            {choosing ? (
              <>
                {getPathForFile || pickFolder ? (
                  <div
                    className={`grid justify-items-center gap-2 rounded-lg border border-dashed px-4 py-5 text-center transition-colors ${
                      dragging ? "border-primary bg-primary/5" : "border-border"
                    }`}
                    onDragOver={(event) => {
                      if (!getPathForFile) return;
                      event.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragging(false);
                      const file = event.dataTransfer.files[0];
                      const dropped = file && getPathForFile ? getPathForFile(file) : null;
                      if (dropped) void readPath(dropped);
                    }}
                  >
                    <p className="text-sm text-muted-foreground">
                      {getPathForFile ? "Drop a file or folder here, or" : "Choose a folder"}
                    </p>
                    <Menu>
                      <MenuTrigger render={<Button variant="outline" size="sm" />}>
                        Choose…
                        <ChevronDownIcon aria-hidden className="size-3.5 opacity-70" />
                      </MenuTrigger>
                      <MenuPopup align="center">
                        {getPathForFile ? (
                          <MenuItem onClick={() => filePicker.current?.click()}>A file…</MenuItem>
                        ) : null}
                        {pickFolder ? (
                          <MenuItem
                            onClick={() =>
                              void pickFolder().then((picked) => {
                                if (picked) void readPath(picked);
                              })
                            }
                          >
                            A folder…
                          </MenuItem>
                        ) : null}
                      </MenuPopup>
                    </Menu>
                    {getPathForFile ? (
                      <input
                        ref={filePicker}
                        type="file"
                        accept=".mcpb,.dxt,.zip,.skill,.md,.markdown,.txt"
                        hidden
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          const picked = file ? getPathForFile(file) : null;
                          event.target.value = "";
                          if (picked) void readPath(picked);
                        }}
                      />
                    ) : null}
                  </div>
                ) : null}
                <div className="flex items-start gap-2">
                  <Textarea
                    aria-label="Path, web address or text"
                    className="min-w-0 flex-1 [&_textarea]:max-h-48 [&_textarea]:min-h-0 [&_textarea]:resize-none [&_textarea]:[field-sizing:content]"
                    rows={1}
                    placeholder="Or paste a path, a web address, or a skill's text"
                    value={path}
                    spellCheck={false}
                    onChange={(event) => setPath(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey && !path.includes("\n")) {
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
                {importCount > 0 ? (
                  <div className="grid grid-cols-1 gap-2">
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      className="-ms-2 justify-self-start"
                      aria-expanded={showImports}
                      onClick={() => setShowImports((shown) => !shown)}
                    >
                      {skillsFirst ? "From your other agents" : "From your other apps"} ·{" "}
                      {importCount}
                      <ChevronDownIcon
                        aria-hidden
                        className={`size-3.5 transition-transform ${showImports ? "rotate-180" : ""}`}
                      />
                    </Button>
                    {showImports ? (
                      skillsFirst ? (
                        <ImportableSkillRows
                          skills={importableSkills}
                          busy={busy}
                          onAdd={(skill) => void importSkill(skill)}
                        />
                      ) : (
                        <ServerRows servers={importable} busy={busy} onAdd={importServer} />
                      )
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}

            {step.name === "plugin" ? (
              <p className="text-sm text-muted-foreground">{step.path}</p>
            ) : null}

            {step.name === "skills" ? (
              <div className="grid grid-cols-1 gap-2">
                <Label>Found in {step.sourceLabel}</Label>
                <SkillCandidateRows
                  candidates={step.candidates}
                  busy={busy}
                  onAdd={(candidate) =>
                    void addSkillCandidates(step.stagingId, [candidate], candidate.key)
                  }
                  onFinish={
                    startChat
                      ? (candidate) => void finishWithAgent(candidate, step.sourceLabel)
                      : undefined
                  }
                />
              </div>
            ) : null}

            {step.name === "servers" ? (
              <div className="grid grid-cols-1 gap-2">
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
                <ErrorNote
                  message={step.bundle.unavailableReason ?? null}
                  summary="It cannot run on this computer."
                />
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
                <div className="grid grid-cols-1 gap-2">
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
            <ErrorNote message={failure?.message ?? null} summary={failure?.summary} />
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
              {choosing && !skillsFirst ? (
                <Button
                  variant="ghost-muted"
                  className="me-auto"
                  title="For developers: start a connector from the command that runs it, such as uvx my-server."
                  onClick={() => {
                    setError(null);
                    setStep({ name: "command" });
                  }}
                >
                  Run a command…
                </Button>
              ) : null}
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
              {step.name === "plugin" ? (
                <Button disabled={busy !== null} onClick={() => void submit()}>
                  {busy === "add" ? "Installing…" : "Install"}
                </Button>
              ) : null}
              {step.name === "skills" && step.candidates.filter(canAddCandidate).length > 1 ? (
                <Button
                  disabled={busy !== null}
                  onClick={() =>
                    void addSkillCandidates(
                      step.stagingId,
                      step.candidates.filter(canAddCandidate),
                      "all",
                    )
                  }
                >
                  {busy === "all"
                    ? "Adding…"
                    : `Add all ${step.candidates.filter(canAddCandidate).length}`}
                </Button>
              ) : null}
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

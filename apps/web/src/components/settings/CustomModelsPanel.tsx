import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  CustomModelError,
  customModelAttachmentKey,
  supportsModelConnections,
  ProviderDriverKind,
  ProviderInstanceId,
  type CustomModel,
  type CustomModelConnection,
  type CustomModelSaveInput,
  type CustomModelsSettings,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import {
  BrainCircuitIcon,
  CheckIcon,
  CircleAlertIcon,
  ChevronRightIcon,
  PlusIcon,
  PencilIcon,
  Settings2Icon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import { ClaudeAI, GrokIcon, OpenAI, OpenRouterIcon, type Icon } from "../Icons";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
} from "../ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironments, useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { isElectron } from "~/env";
import { usePrimarySessionState } from "~/environments/primary";
import { useEnvironmentSessionState } from "~/state/session";
import { resolvePrimaryOperateAccess, resolveRemoteOperateAccess } from "~/providerOperateAccess";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { ModelConnectionEditor, Choice, type EditorTarget } from "./ModelConnectionEditor";
import { CustomModelConnectionDialog } from "./CustomModelConnectionDialog";
import { customModelPresetId, modelConnectionStatus } from "./customModels";

const CONNECTION_ICON_BY_PRESET: Partial<Record<string, Icon>> = {
  openrouter: OpenRouterIcon,
  openai: OpenAI,
  anthropic: ClaudeAI,
  spacexai: GrokIcon,
};

function CustomModelConnectionIcon({ connection }: { connection: CustomModelConnection }) {
  const ConnectionIcon = CONNECTION_ICON_BY_PRESET[customModelPresetId(connection)] ?? ServerIcon;
  return (
    <ConnectionIcon
      aria-hidden="true"
      className="size-4 shrink-0 fill-current text-muted-foreground"
    />
  );
}

const isCustomModelError = Schema.is(CustomModelError);
function resultValue<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  const error = squashAtomCommandFailure(result);
  throw new Error(
    isCustomModelError(error) ? error.message : "Could not complete this action. Try again.",
  );
}

type ContentProps = {
  environmentId: EnvironmentId;
  instanceId?: ProviderInstanceId | undefined;
  /**
   * When set, the host renders the "Add model" action itself and bumps this
   * counter to open the editor; otherwise the content shows its own button.
   */
  addRequest?: number | undefined;
};

export function CustomModelsContent(props: ContentProps) {
  const environment = useEnvironment(props.environmentId);
  if (!environment || environment.connection.phase !== "connected")
    return (
      <p className="text-sm text-muted-foreground">
        Connect this execution environment to manage models.
      </p>
    );
  if (environment.entry.target._tag === "PrimaryConnectionTarget")
    return isElectron ? (
      <EditableCustomModelsContent {...props} />
    ) : (
      <PrimaryCustomModelsContent {...props} />
    );
  return <RemoteCustomModelsContent {...props} />;
}

function PrimaryCustomModelsContent(props: ContentProps) {
  const session = usePrimarySessionState();
  const access = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: false,
    session: session.data,
    isPending: session.isPending,
    hasError: session.error !== null,
  });
  return access === "granted" ? (
    <EditableCustomModelsContent {...props} />
  ) : (
    <p className="text-sm text-muted-foreground">
      {access === "pending" ? "Checking access…" : "Model setup requires edit access."}
    </p>
  );
}
function RemoteCustomModelsContent(props: ContentProps) {
  const session = useEnvironmentSessionState(props.environmentId);
  const access = resolveRemoteOperateAccess({
    session: session.data,
    isPending: session.isPending,
    hasError: session.hasError,
  });
  return access === "granted" ? (
    <EditableCustomModelsContent {...props} />
  ) : (
    <p className="text-sm text-muted-foreground">
      {access === "pending" ? "Checking access…" : "Model setup requires edit access."}
    </p>
  );
}

function EditableCustomModelsContent({ environmentId, instanceId, addRequest }: ContentProps) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const [editor, setEditor] = useState<{
    target: EditorTarget;
    settings: CustomModelsSettings;
  } | null>(null);
  const [handledAddRequest, setHandledAddRequest] = useState(addRequest);
  const [managing, setManaging] = useState<{
    connection: CustomModelConnection;
    revision: number;
  } | null>(null);
  const [removing, setRemoving] = useState<{
    connection: CustomModelConnection;
    model?: CustomModel;
    revision: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    key: string;
    revision: number;
    text: string;
    error: boolean;
  } | null>(null);
  const save = useAtomCommand(serverEnvironment.saveCustomModel, {
    reportFailure: false,
    reportDefect: false,
  });
  const remove = useAtomCommand(serverEnvironment.removeCustomModel, { reportFailure: false });
  const test = useAtomCommand(serverEnvironment.testCustomModel, { reportFailure: false });
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  useEffect(() => {
    if (!notice || notice.error) return;
    const timeout = window.setTimeout(() => {
      setNotice((current) => (current === notice ? null : current));
    }, 4000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  if (!settings) return <p className="text-sm text-muted-foreground">Connecting…</p>;
  const catalog = settings.customModels;
  if (addRequest !== handledAddRequest) {
    setHandledAddRequest(addRequest);
    setEditor({ target: {}, settings: catalog });
  }
  const agents = Object.entries(settings.providerInstances)
    .filter(([, value]) => supportsModelConnections(value.driver))
    .map(([id, value]) => ({
      id: ProviderInstanceId.make(id),
      name: value.displayName ?? (value.driver === "droid" ? "Droid" : "Pi"),
      driver: value.driver,
    }));
  if (
    !agents.some((a) => a.id === "pi") &&
    !settings.providerInstances[ProviderInstanceId.make("pi")]
  )
    agents.unshift({
      id: ProviderInstanceId.make("pi"),
      name: "Pi",
      driver: ProviderDriverKind.make("pi"),
    });
  const onSave = async (input: CustomModelSaveInput) => {
    resultValue(await save({ environmentId, input }));
    setNotice(null);
    void refresh({ environmentId, input: {} });
  };
  const checkAgain = async (connection: CustomModelConnection, model: CustomModel) => {
    setBusy(true);
    setNotice(null);
    try {
      await onSave({ revision: catalog.revision, connection, refreshModelId: model.id });
    } catch (error) {
      setNotice({
        key: connection.id + ":" + model.id,
        revision: catalog.revision,
        text: error instanceof Error ? error.message : "Could not check this model.",
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };
  const runTest = async (
    connection: CustomModelConnection,
    model: CustomModel,
    target: ProviderInstanceId,
  ) => {
    const key = connection.id + ":" + model.id;
    setBusy(true);
    setTesting(key);
    setNotice(null);
    try {
      resultValue(
        await test({
          environmentId,
          input: {
            revision: catalog.revision,
            connectionId: connection.id,
            modelId: model.id,
            instanceId: target,
          },
        }),
      );
      const name = agents.find((agent) => agent.id === target)?.name ?? target;
      setNotice({ key, revision: catalog.revision, text: name + " · Test passed", error: false });
    } catch (cause) {
      setNotice({
        key,
        revision: catalog.revision,
        text: cause instanceof Error ? cause.message : "Test failed.",
        error: true,
      });
    } finally {
      setBusy(false);
      setTesting(null);
    }
  };
  const openAdd = () => setEditor({ target: {}, settings: catalog });
  return (
    <div className="space-y-6">
      {addRequest === undefined && catalog.connections.length > 0 ? (
        <div className="flex justify-end">
          <Button size="xs" variant="outline" onClick={openAdd}>
            <PlusIcon />
            Add model
          </Button>
        </div>
      ) : null}
      {catalog.connections.length === 0 ? (
        <Empty className="gap-4 rounded-xl border border-dashed border-border/60 py-10 md:p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BrainCircuitIcon />
            </EmptyMedia>
            <EmptyTitle className="text-base">No custom models yet</EmptyTitle>
            <EmptyDescription>
              Connect a model through an API key or a local endpoint, then choose which agents can
              use it.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" variant="outline" onClick={openAdd}>
              <PlusIcon />
              Add model
            </Button>
          </EmptyContent>
        </Empty>
      ) : null}
      {catalog.connections.map((connection) => (
        <section key={connection.id} className="space-y-1.5">
          <div className="flex min-h-7 items-center justify-between gap-2 px-1">
            <h3 className="flex min-w-0 items-center gap-2 text-sm font-medium tracking-[-0.005em] text-foreground">
              <CustomModelConnectionIcon connection={connection} />
              <span className="truncate">{connection.name}</span>
            </h3>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={"Add model to " + connection.name}
                disabled={busy}
                onClick={() => setEditor({ target: { connection }, settings: catalog })}
              >
                <PlusIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={"Manage " + connection.name}
                disabled={busy}
                onClick={() => setManaging({ connection, revision: catalog.revision })}
              >
                <Settings2Icon />
              </Button>
            </div>
          </div>
          <div className="divide-y divide-border/50 rounded-xl border border-border/60 bg-card/40 shadow-xs/5">
            {connection.models.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">No models yet.</p>
            ) : null}
            {connection.models.map((model) => {
              const testInstance =
                instanceId && model.instanceIds.includes(instanceId)
                  ? instanceId
                  : model.instanceIds[0];
              const agentNames =
                model.instanceIds
                  .map((id) => agents.find((a) => a.id === id)?.name ?? id)
                  .join(", ") || "Not connected";
              const rowKey = connection.id + ":" + model.id;
              const attachments = model.instanceIds.map((id) => {
                const provider = providers?.find((entry) => entry.instanceId === id);
                const assessment = provider?.modelConnections?.find(
                  (entry) =>
                    entry.connectionId === connection.id &&
                    entry.modelId === model.id &&
                    entry.configurationKey === customModelAttachmentKey(connection, model),
                );
                const name = agents.find((agent) => agent.id === id)?.name ?? id;
                const label = modelConnectionStatus(provider, assessment);
                return { id, name, label, assessment };
              });
              const rowNotice =
                notice && notice.key === rowKey && notice.revision === catalog.revision
                  ? notice
                  : null;
              return (
                <div key={model.id} className="flex items-center gap-2 px-4 py-3">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="truncate text-sm text-foreground">{model.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      <span className="font-mono">{model.modelId}</span>
                      <span aria-hidden="true"> · </span>
                      {agentNames}
                    </p>
                    {attachments.some((entry) => entry.label) ? (
                      <p className="text-xs text-muted-foreground" role="status">
                        {attachments
                          .filter((entry) => entry.label)
                          .map(
                            (entry) =>
                              entry.name +
                              " · " +
                              entry.label +
                              (entry.label === "Needs setup" &&
                              entry.assessment?.reason === "model_unavailable"
                                ? " — check the model ID and limits in Edit"
                                : ""),
                          )
                          .join("; ")}
                      </p>
                    ) : null}
                    {attachments.some((entry) => entry.assessment?.state === "available") ? (
                      <Collapsible className="text-xs text-muted-foreground">
                        <CollapsibleTrigger className="group inline-flex items-center gap-1">
                          <ChevronRightIcon
                            aria-hidden="true"
                            className="size-3 group-data-panel-open:rotate-90"
                          />
                          Model limits
                        </CollapsibleTrigger>
                        <CollapsiblePanel>
                          {attachments.map(({ id, name, assessment }) =>
                            assessment?.state === "available" ? (
                              assessment.contextWindow ? (
                                <p key={id}>
                                  {name}: {assessment.contextWindow.toLocaleString()} context
                                  {assessment.maxOutputTokens
                                    ? ", " + assessment.maxOutputTokens.toLocaleString() + " output"
                                    : ""}
                                  {assessment.source ? " · " + assessment.source : ""}
                                </p>
                              ) : (
                                <p key={id}>{name}: agent defaults · limits not reported</p>
                              )
                            ) : null,
                          )}
                        </CollapsiblePanel>
                      </Collapsible>
                    ) : null}
                  </div>
                  {attachments.some(
                    (entry) => entry.label === "Needs setup" || entry.label === "Check agent",
                  ) ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void checkAgain(connection, model)}
                    >
                      Check again
                    </Button>
                  ) : null}
                  {testInstance && rowNotice?.error ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="xs"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            disabled={busy}
                            aria-label={`Test failed. ${rowNotice.text} Select to try again.`}
                            onClick={() => void runTest(connection, model, testInstance)}
                          />
                        }
                      >
                        <CircleAlertIcon />
                        Failed
                        <span role="alert" className="sr-only">
                          {rowNotice.text}
                        </span>
                      </TooltipTrigger>
                      <TooltipPopup>{rowNotice.text}</TooltipPopup>
                    </Tooltip>
                  ) : testInstance && rowNotice ? (
                    <span
                      role="status"
                      className="flex h-7 shrink-0 items-center gap-1 px-[calc(--spacing(2)-1px)] text-sm font-medium text-success sm:h-6 sm:text-xs"
                    >
                      <CheckIcon className="size-4 sm:size-3.5" />
                      {rowNotice.text}
                    </span>
                  ) : testInstance ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void runTest(connection, model, testInstance)}
                          />
                        }
                      >
                        {testing === connection.id + ":" + model.id ? "Testing…" : "Test"}
                      </TooltipTrigger>
                      <TooltipPopup>
                        Sends a small request through{" "}
                        {agents.find((agent) => agent.id === testInstance)?.name ?? testInstance}.
                        API charges may apply.
                      </TooltipPopup>
                    </Tooltip>
                  ) : null}
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={"Edit " + model.name}
                    disabled={busy}
                    onClick={() => setEditor({ target: { connection, model }, settings: catalog })}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={"Remove model " + model.name}
                    disabled={busy}
                    onClick={() => {
                      setRemoveError(null);
                      setRemoving({ connection, model, revision: catalog.revision });
                    }}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {editor ? (
        <ModelConnectionEditor
          settings={editor.settings}
          target={editor.target}
          agents={agents}
          onSave={onSave}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {managing ? (
        <CustomModelConnectionDialog
          connection={managing.connection}
          revision={managing.revision}
          onSave={onSave}
          onDelete={() => {
            setRemoveError(null);
            setRemoving({ connection: managing.connection, revision: managing.revision });
            setManaging(null);
          }}
          onClose={() => setManaging(null)}
        />
      ) : null}
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Remove {removing?.model?.name ?? removing?.connection.name}?</DialogTitle>
            <DialogDescription>
              {removing?.model
                ? "Removes this model from connected agents. The connection and key are kept."
                : "Removes this connection, its saved key and its models from connected agents."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {removeError ? (
              <p role="alert" className="mb-4 text-sm text-destructive">
                {removeError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  if (!removing) return;
                  setBusy(true);
                  setRemoveError(null);
                  const action = removing.model
                    ? save({
                        environmentId,
                        input: {
                          revision: removing.revision,
                          connection: {
                            ...removing.connection,
                            models: removing.connection.models.filter(
                              (m) => m.id !== removing.model!.id,
                            ),
                          },
                        },
                      })
                    : remove({
                        environmentId,
                        input: {
                          revision: removing.revision,
                          connectionId: removing.connection.id,
                        },
                      });
                  void action
                    .then((result) => {
                      resultValue(result);
                      setRemoving(null);
                      void refresh({ environmentId, input: {} });
                    })
                    .catch((cause) =>
                      setRemoveError(
                        cause instanceof Error ? cause.message : "Could not remove connection.",
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Remove
              </Button>
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

export function CustomModelsPanel() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [selected, setSelected] = useState<string | null>(null);
  const [addRequest, setAddRequest] = useState(0);
  const environment =
    environments.find((e) => e.environmentId === (selected ?? primary)) ?? environments[0];
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Custom models"
        id="custom-models"
        variant="plain"
        icon={<BrainCircuitIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={!environment}
            onClick={() => setAddRequest((n) => n + 1)}
          >
            <PlusIcon />
            Add model
          </Button>
        }
      >
        {environments.length > 1 ? (
          <div className="mb-5 max-w-xs">
            <Choice
              label="Execution environment"
              value={environment?.environmentId ?? ""}
              onChange={setSelected}
            >
              {environments.map((e) => (
                <option key={e.environmentId} value={e.environmentId}>
                  {e.label}
                </option>
              ))}
            </Choice>
          </div>
        ) : null}
        {environment ? (
          <CustomModelsContent
            key={environment.environmentId}
            environmentId={environment.environmentId}
            addRequest={addRequest}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Connect an execution environment to add models.
          </p>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

import type {
  ComputeResultsSetupResult,
  ComputeResultsRerunInput,
  EnvironmentId,
} from "@t3tools/contracts";
import { msg, T, useGT } from "gt-react";
import { useEffect, useId, useState } from "react";

import { ProjectFilePickerForTarget } from "~/components/files/ProjectFilePicker";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogAction,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { useStableCallback } from "~/hooks/useStableCallback";
import { m } from "~/i18n/messages";
import { randomUUID } from "~/lib/utils";
import { NotebookFreshRunWarning } from "~/scient/notebook/NotebookFreshRunWarning";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { resultErrorMessage } from "./resultState";

export type ResultRunOptions = Pick<ComputeResultsRerunInput, "parameters" | "inputs">;

type SetupTarget = {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly scriptPath: string;
};

type SetupProps = SetupTarget & {
  readonly onRun: (options: ResultRunOptions) => void;
  readonly onCancel: () => void;
};

type ParameterRow = { readonly id: string; readonly name: string; readonly value: string };
type ParameterError = {
  readonly id: string;
  readonly field: "name" | "value";
  readonly message: string;
};

function isJson(text: string) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function SetupForm(
  props: SetupProps & {
    readonly defaults: ComputeResultsSetupResult;
    readonly formId: string;
  },
) {
  const gt = useGT();
  const [parameters, setParameters] = useState<ReadonlyArray<ParameterRow>>(() =>
    props.defaults.parameters.map(({ name, value }) => ({ id: randomUUID(), name, value })),
  );
  const [inputs, setInputs] = useState(props.defaults.inputs);
  const [error, setError] = useState<ParameterError | null>(null);

  const edit = (id: string, field: ParameterError["field"], text: string) => {
    if (error?.id === id && error.field === field) setError(null);
    setParameters((rows) => rows.map((row) => (row.id === id ? { ...row, [field]: text } : row)));
  };

  const submit = (form: HTMLFormElement) => {
    const names = new Set<string>();
    const reject = (issue: ParameterError) => {
      setError(issue);
      const field = form.elements.namedItem(`${issue.id}-${issue.field}`);
      if (field instanceof HTMLElement) field.focus();
    };
    for (const { id, name, value } of parameters) {
      if (name.trim() === "" || names.has(name)) {
        reject({ id, field: "name", message: gt("Give each parameter a different name.") });
        return;
      }
      if (!isJson(value)) {
        reject({ id, field: "value", message: gt("Enter valid JSON. Put text in double quotes.") });
        return;
      }
      names.add(name);
    }
    props.onRun({
      inputs,
      parameters: Object.fromEntries(parameters.map(({ name, value }) => [name, value])),
    });
  };

  return (
    <form
      id={props.formId}
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit(event.currentTarget);
      }}
    >
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="font-medium text-sm">
          <T>Parameters</T>
        </legend>
        <p className="text-xs text-muted-foreground">
          <T>
            Use JSON values, for example <code>0.5</code> or <code>"control"</code>.
          </T>
        </p>
        {parameters.map(({ id, name, value }) => (
          <div
            key={id}
            className="grid min-w-0 grid-cols-1 items-start gap-2 @min-[420px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          >
            {(["name", "value"] as const).map((field) => {
              const invalid = error?.id === id && error.field === field;
              const fieldName = `${id}-${field}`;
              const labelId = `${fieldName}-label`;
              return (
                <Field key={field} className="min-w-0" invalid={invalid}>
                  <FieldLabel id={labelId} htmlFor={fieldName}>
                    {field === "name" ? <T>Name</T> : <T>Value</T>}
                  </FieldLabel>
                  <Input
                    id={fieldName}
                    name={fieldName}
                    size="sm"
                    maxLength={field === "name" ? 128 : 4096}
                    aria-labelledby={labelId}
                    aria-invalid={invalid || undefined}
                    value={field === "name" ? name : value}
                    onChange={(event) => edit(id, field, event.target.value)}
                  />
                  {invalid ? <FieldError match={true}>{error.message}</FieldError> : null}
                </Field>
              );
            })}
            <div className="justify-self-end @min-[420px]:pt-6">
              <Button
                type="button"
                size="xs"
                variant="ghost-inset"
                aria-label={gt("Remove parameter {name}", { name })}
                onClick={() => setParameters((rows) => rows.filter((row) => row.id !== id))}
              >
                <T>Remove</T>
              </Button>
            </div>
          </div>
        ))}
        <div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={parameters.length >= 200}
            onClick={() =>
              setParameters((rows) => [...rows, { id: randomUUID(), name: "", value: "" }])
            }
          >
            <T>Add parameter</T>
          </Button>
        </div>
      </fieldset>
      <ResultDeclaredInputs
        environmentId={props.environmentId}
        cwd={props.cwd}
        scriptPath={props.scriptPath}
        inputs={inputs}
        suggestedInputs={props.defaults.suggestedInputs}
        onChange={setInputs}
      />
    </form>
  );
}

export function ResultDeclaredInputs(
  props: SetupTarget & {
    readonly inputs: ReadonlyArray<string>;
    readonly suggestedInputs?: ReadonlyArray<string>;
    readonly onChange: (inputs: ReadonlyArray<string>) => void;
    readonly disabled?: boolean;
    /** When a dialog already titles the list, the legend stays for assistive technology only. */
    readonly titled?: boolean;
  },
) {
  const gt = useGT();
  const [picker, setPicker] = useState(false);
  const { inputs } = props;
  const suggestions = props.suggestedInputs?.filter((path) => !inputs.includes(path)) ?? [];
  const all = [...inputs, ...suggestions];
  const fileLabel = (path: string) => {
    const separator = path.lastIndexOf("/");
    const name = path.slice(separator + 1);
    const parent = all.some((other) => other !== path && other.split("/").at(-1) === name)
      ? path.slice(0, separator) || gt("Project root")
      : null;
    return (
      <span className="min-w-0">
        <bdi className="block text-sm font-medium wrap-anywhere">{name}</bdi>
        {parent === null ? null : (
          <bdi className="block text-xs text-muted-foreground wrap-anywhere">{parent}</bdi>
        )}
      </span>
    );
  };
  const addInput = (path: string) => {
    if (!props.disabled && !inputs.includes(path) && inputs.length < 200) {
      props.onChange([...inputs, path]);
    }
  };
  return (
    <>
      <fieldset className="flex min-w-0 flex-col gap-2" disabled={props.disabled}>
        <legend className={props.titled ? "sr-only" : "text-sm font-medium"}>
          <T>Input files</T>
        </legend>
        <p className="text-xs text-muted-foreground">
          <T>The run records these files. If one changes, its results show as out of date.</T>
        </p>
        {inputs.map((path) => (
          <div key={path} className="flex min-w-0 items-center justify-between gap-2 rounded-lg">
            {fileLabel(path)}
            <Button
              type="button"
              size="xs"
              variant="ghost-inset"
              aria-label={gt("Remove input {path}", { path })}
              onClick={() => props.onChange(inputs.filter((entry) => entry !== path))}
            >
              <T>Remove</T>
            </Button>
          </div>
        ))}
        <div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={inputs.length >= 200}
            onClick={() => setPicker(true)}
          >
            <T>Add file…</T>
          </Button>
        </div>
      </fieldset>
      {suggestions.length > 0 ? (
        <fieldset className="flex min-w-0 flex-col gap-2" disabled={props.disabled}>
          <legend className="text-sm font-medium">
            <T>Suggested from the code</T>
          </legend>
          {suggestions.map((path) => (
            <div key={path} className="flex min-w-0 items-center justify-between gap-2 rounded-lg">
              {fileLabel(path)}
              <Button
                type="button"
                size="xs"
                variant="ghost-inset"
                disabled={inputs.length >= 200}
                aria-label={gt("Declare {path}", { path })}
                onClick={() => addInput(path)}
              >
                <T>Add</T>
              </Button>
            </div>
          ))}
        </fieldset>
      ) : null}
      <Dialog open={picker} onOpenChange={setPicker}>
        {picker ? (
          <DialogPopup
            layer="above-popovers"
            padding="none"
            gap="none"
            bottomStickOnMobile={false}
            showCloseButton={false}
            aria-label={gt("Add an input file")}
          >
            <ProjectFilePickerForTarget
              target={{
                environmentId: props.environmentId,
                cwd: props.cwd,
                projectName: props.scriptPath,
              }}
              setOpen={setPicker}
              actionLabel={gt("Add file")}
              compactPaths
              onSelectFile={(path) => {
                addInput(path);
                setPicker(false);
              }}
            />
          </DialogPopup>
        ) : null}
      </Dialog>
    </>
  );
}

export function useSavedResultRunSetup(props: SetupTarget, afterRun?: string | null) {
  const load = useStableCallback(
    useAtomCommand(computeEnvironment.resultsSetup, { reportFailure: false }),
  );
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly result: ComputeResultsSetupResult | { message: string };
  } | null>(null);
  const { cwd, environmentId, scriptPath } = props;
  const key = JSON.stringify([environmentId, cwd, scriptPath, afterRun, attempt]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opening setup fetches the latest saved run.
  useEffect(() => {
    let cancelled = false;
    void load({ environmentId, input: { cwd, scriptPath } }).then((result) => {
      if (cancelled) return;
      setLoaded({
        key,
        result:
          result._tag === "Success"
            ? result.value
            : {
                message: resultErrorMessage(
                  result,
                  m(msg("The result setup could not be loaded.")),
                ),
              },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [cwd, environmentId, key, load, scriptPath]);

  return {
    setup: loaded?.key === key ? loaded.result : null,
    retry: () => setAttempt((current) => current + 1),
  };
}

export function ResultRunSetup(props: SetupProps) {
  const { setup } = useSavedResultRunSetup(props);
  const formId = useId();
  const loaded = setup !== null && !("message" in setup) ? setup : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogPopup
        layer="above-popovers"
        bottomStickOnMobile={false}
        gap="none"
        className="max-h-[calc(100dvh-2rem)]"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>
            <T>Run setup</T>
          </DialogTitle>
          <DialogDescription className="wrap-anywhere">
            <bdi>{props.scriptPath}</bdi>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="@container min-w-0">
          {loaded !== null ? (
            <>
              <SetupForm {...props} formId={formId} defaults={loaded} />
              {props.scriptPath.toLowerCase().endsWith(".ipynb") ? (
                <p className="mt-4 text-sm text-muted-foreground">
                  <NotebookFreshRunWarning />
                </p>
              ) : null}
            </>
          ) : setup !== null && "message" in setup ? (
            <p role="alert" className="text-sm text-destructive">
              {setup.message}
            </p>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              <T>Loading run setup…</T>
            </p>
          )}
        </DialogPanel>
        <DialogFooter className="shrink-0">
          <Button type="button" variant="outline" onClick={props.onCancel}>
            <T>Cancel</T>
          </Button>
          <DialogAction type="submit" form={formId} disabled={loaded === null}>
            <T>Run fresh</T>
          </DialogAction>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

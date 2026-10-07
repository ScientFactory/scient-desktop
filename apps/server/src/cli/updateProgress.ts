import type { PinnedRuntimeProgress } from "../cloud/pinnedRuntime.ts";

/** Reports the actual npm installation stages; redirected output remains plain. */
export function createUpdateProgress(
  output: Pick<NodeJS.WriteStream, "write" | "isTTY" | "columns"> = process.stderr,
) {
  const interactive = output.isTTY && process.env.TERM !== "dumb";
  const color = interactive && !process.env.NO_COLOR;
  const style = (code: number, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  let stage: PinnedRuntimeProgress["stage"] | undefined;
  let lineOpen = false;
  const finish = () => {
    if (lineOpen) output.write("\r\x1b[2K");
    lineOpen = false;
  };
  const status = (message: string) => {
    finish();
    let line = `  ${message}`;
    if (interactive) line = line.slice(0, Math.max(0, (output.columns || 80) - 1));
    output.write(interactive ? `\r\x1b[2K${style(2, line)}` : `${line}\n`);
    lineOpen = Boolean(interactive);
  };
  return {
    finish,
    status,
    heading(message: string, detail = "") {
      finish();
      output.write(`  ${style(2, message)}${detail ? ` ${style(1, detail)}` : ""}\n\n`);
    },
    success(message: string) {
      finish();
      output.write(`  ${style(32, message)}\n\n`);
    },
    report(progress: PinnedRuntimeProgress) {
      if (progress.stage !== stage) {
        stage = progress.stage;
        const labels = {
          prepare: "Preparing the pinned release...",
          install: "Installing the Scient release and its native dependencies...",
          validate: "Checking the installed runtime...",
          cached: "Using the installed release...",
        };
        status(labels[stage]);
      }
    },
  };
}

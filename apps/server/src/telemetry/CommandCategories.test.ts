import { describe, expect, it } from "@effect/vitest";
import { classifyCommand } from "./CommandCategories.ts";

describe("terminal command categories", () => {
  it.each([
    // How each provider writes a command: Codex wraps it in a login shell, Claude passes it bare.
    ['/bin/zsh -lc "python analysis.py --seed 1"', ["python"]],
    ["python3.11 analysis.py", ["python"]],
    ['powershell.exe -Command "C:\\Python312\\python.exe run.py"', ["python"]],
    ['cmd /c "Rscript model.R"', ["r"]],
    ["cd data && Rscript -e 'summary(x)' 2>&1 | tail -5", ["r", "file-inspection"]],
    ["MPLBACKEND=Agg uv run python plot.py", ["python"]],
    ["uv pip install pandas", ["python-package-install"]],
    ["python -m pip install --upgrade numpy", ["python-package-install"]],
    ["conda run -n analysis python fit.py", ["python"]],
    ["jupyter nbconvert --execute notebook.ipynb", ["jupyter"]],
    ["python -m nbconvert --to html notebook.ipynb", ["jupyter"]],
    ["latexmk -pdf main.tex && biber main", ["latex"]],
    ["pandoc paper.md -o paper.docx", ["document-convert"]],
    ["quarto render report.qmd", ["quarto"]],
    ["stata-mp -b do clean.do", ["stata"]],
    ["sbatch job.sh; squeue -u me", ["hpc"]],
    ["npx tsx script.ts", ["javascript"]],
    ["npx pandoc --version", ["document-convert"]],
    ["timeout 60 julia sim.jl", ["julia"]],
    ["echo 'python is mentioned here' ; true", []],
    ["git status && git diff", ["version-control"]],
    ["some-unknown-tool --flag", ["shell-other"]],
    ['bash -c "echo hi; matlab -batch run"', ["matlab"]],
  ] as const)("%s", (command, expected) => {
    expect(classifyCommand(command)).toEqual(expected);
  });
});

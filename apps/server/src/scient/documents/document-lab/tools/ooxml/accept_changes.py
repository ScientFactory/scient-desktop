# Modified by Scient lab 2026-11-22: use a per-job LibreOffice profile and publish only on verified completion.
"""Accept all tracked changes in a DOCX file using LibreOffice.

Requires LibreOffice (soffice) to be installed.
"""

import argparse
from collections import Counter
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

from defusedxml.ElementTree import ParseError
from defusedxml.common import DefusedXmlException

from docx_feature_inventory import REVISION_FEATURES, check_zip_members, inventory
from office.soffice import get_soffice_env

ACCEPT_CHANGES_MACRO = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">
    Sub AcceptAllTrackedChanges()
        Dim document As Object
        Dim dispatcher As Object

        document = ThisComponent.CurrentController.Frame
        dispatcher = createUnoService("com.sun.star.frame.DispatchHelper")

        dispatcher.executeDispatch(document, ".uno:AcceptAllTrackedChanges", "", 0, Array())
        ThisComponent.store()
        ThisComponent.close(True)
        StarDesktop.terminate()
    End Sub
</script:module>"""


def accept_changes(
    input_file: str,
    output_file: str,
) -> tuple[None, str]:
    input_path = Path(input_file)
    output_path = Path(output_file)

    if not input_path.exists():
        return None, f"Error: Input file not found: {input_file}"

    if not input_path.suffix.lower() == ".docx":
        return None, f"Error: Input file is not a DOCX file: {input_file}"

    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with (
            tempfile.TemporaryDirectory(prefix="scient_docx_profile_") as profile_dir,
            tempfile.TemporaryDirectory(dir=output_path.parent) as staging_dir,
        ):
            staged_output = Path(staging_dir).resolve() / "accepted.docx"
            shutil.copy2(input_path, staged_output)
            with zipfile.ZipFile(staged_output) as package:
                check_zip_members(package)
            profile = Path(profile_dir).resolve()
            env = get_soffice_env()
            cmd = ["soffice", "--headless", f"-env:UserInstallation={profile.as_uri()}",
                   "--norestore"]
            _setup_libreoffice_macro(profile, cmd, env)
            result = subprocess.run(
                [*cmd,
                 "vnd.sun.star.script:Standard.Module1.AcceptAllTrackedChanges?language=Basic&location=application",
                 str(staged_output)],
                capture_output=True, text=True, timeout=30, check=True, env=env,
            )
            remaining = Counter()
            for counts in inventory(staged_output).values():
                remaining.update({kind: counts[kind] for kind in REVISION_FEATURES if counts[kind]})
            if remaining:
                revisions = ", ".join(f"{kind}={remaining[kind]}" for kind in sorted(remaining))
                detail = result.stderr.strip()
                return None, f"Error: LibreOffice left tracked revisions ({revisions}). {detail}".rstrip()
            os.replace(staged_output, output_path)
    except subprocess.TimeoutExpired as error:
        return None, f"Error: LibreOffice timed out after {error.timeout} seconds"
    except subprocess.CalledProcessError as error:
        return None, f"Error: LibreOffice failed (exit {error.returncode}): {error.stderr}"
    except (OSError, ValueError, RuntimeError, KeyError, zipfile.BadZipFile,
            ParseError, DefusedXmlException) as error:
        return None, f"Error: {error}"

    return (
        None,
        f"Successfully accepted all tracked changes: {input_file} -> {output_file}",
    )


def _setup_libreoffice_macro(profile: Path, cmd: list[str], env: dict) -> None:
    subprocess.run([*cmd, "--terminate_after_init"], capture_output=True, text=True,
                   timeout=10, check=True, env=env)
    macro_dir = profile / "user" / "basic" / "Standard"
    macro_dir.mkdir(parents=True, exist_ok=True)
    (macro_dir / "Module1.xba").write_text(ACCEPT_CHANGES_MACRO, encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Accept all tracked changes in a DOCX file"
    )
    parser.add_argument("input_file", help="Input DOCX file with tracked changes")
    parser.add_argument(
        "output_file", help="Output DOCX file (clean, no tracked changes)"
    )
    args = parser.parse_args()

    _, message = accept_changes(args.input_file, args.output_file)
    print(message)

    if message.startswith("Error:"):
        raise SystemExit(1)

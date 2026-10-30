#!/usr/bin/env python3
"""Scient SQL kernel: DuckDB behind the Jupyter protocol.

One in-memory DuckDB connection lives as long as the kernel, so tables and
views survive between runs and Restart starts empty.  Relative paths resolve
against the kernel's working directory, which is the project.
"""

from __future__ import annotations

import datetime
import decimal
import html
import json
import math
import threading
from typing import Any, Optional

import duckdb
from ipykernel.kernelapp import IPKernelApp
from ipykernel.kernelbase import Kernel

MAX_ROWS = 100
MAX_CELL_TEXT = 512
MAX_PLAIN_CELL = 40
MAX_TABLE_JSON_BYTES = 512 * 1024
MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991
JOIN_INTERVAL = 0.05

# DDL and DML answer with a one-column acknowledgement rather than data.
ACKNOWLEDGEMENT_COLUMNS = {"Count", "Success"}


def cell_value(value: Any) -> Any:
    """A JSON scalar for one result cell."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value if abs(value) <= MAX_SAFE_JSON_INTEGER else str(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, decimal.Decimal):
        return float(value) if value.is_finite() else str(value)
    if isinstance(value, (datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray, memoryview)):
        return "\\x" + bytes(value)[:64].hex()
    text = value if isinstance(value, str) else str(value)
    return text if len(text) <= MAX_CELL_TEXT else text[:MAX_CELL_TEXT] + "…"


def plain_table(columns: list[str], rows: list[list[Any]], footer: Optional[str]) -> str:
    def text(value: Any) -> str:
        shown = "NULL" if value is None else str(value)
        return shown if len(shown) <= MAX_PLAIN_CELL else shown[: MAX_PLAIN_CELL - 1] + "…"

    cells = [[text(column) for column in columns]] + [[text(value) for value in row] for row in rows]
    widths = [max(len(row[index]) for row in cells) for index in range(len(columns))]
    lines = ["  ".join(value.ljust(width) for value, width in zip(row, widths)).rstrip() for row in cells]
    lines.insert(1, "  ".join("-" * width for width in widths))
    if footer is not None:
        lines.append(footer)
    return "\n".join(lines)


def html_table(columns: list[str], rows: list[list[Any]], footer: Optional[str]) -> str:
    def cell(tag: str, value: Any) -> str:
        return f"<{tag}>{'NULL' if value is None else html.escape(str(value))}</{tag}>"

    head = "".join(cell("th", column) for column in columns)
    body = "".join("<tr>" + "".join(cell("td", value) for value in row) + "</tr>" for row in rows)
    table = f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"
    return table if footer is None else f"{table}<p>{html.escape(footer)}</p>"


def table_bundle(columns: list[str], raw_rows: list[tuple[Any, ...]], truncated: bool) -> dict[str, Any]:
    rows = [[cell_value(value) for value in row] for row in raw_rows]
    footer = f"First {MAX_ROWS} rows" if truncated else None
    bundle: dict[str, Any] = {
        "text/plain": plain_table(columns, rows, footer),
        "text/html": html_table(columns, rows, footer),
    }
    if len(set(columns)) == len(columns) and all(columns):
        resource = {
            "schema": {"fields": [{"name": column} for column in columns]},
            "data": [dict(zip(columns, row)) for row in rows],
            "scientPreview": {"truncated": truncated},
        }
        if len(json.dumps(resource, ensure_ascii=False).encode("utf-8")) <= MAX_TABLE_JSON_BYTES:
            bundle["application/vnd.dataresource+json"] = resource
    return bundle


class StatementError(Exception):
    def __init__(self, error: duckdb.Error, line: int) -> None:
        super().__init__(str(error))
        self.error = error
        self.line = line


class ScientSqlKernel(Kernel):
    implementation = "scient-sql"
    implementation_version = "1"
    language = "sql"
    language_version = duckdb.__version__
    language_info = {
        "name": "sql",
        "version": duckdb.__version__,
        "mimetype": "application/sql",
        "file_extension": ".sql",
        "codemirror_mode": "sql",
    }
    banner = f"DuckDB {duckdb.__version__}"

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._connection = duckdb.connect(":memory:")
        self._cancelled = threading.Event()

    def _run_statements(self, code: str, results: list[Any], failure: list[BaseException]) -> None:
        try:
            position = 0
            for statement in self._connection.extract_statements(code):
                if self._cancelled.is_set():
                    return
                offset = code.find(statement.query.strip(), position)
                if offset >= 0:
                    position = offset
                try:
                    cursor = self._connection.execute(statement)
                    columns = [column[0] for column in cursor.description or []]
                    if not columns or (
                        statement.type != duckdb.StatementType.SELECT
                        and len(columns) == 1
                        and columns[0] in ACKNOWLEDGEMENT_COLUMNS
                    ):
                        continue
                    rows = cursor.fetchmany(MAX_ROWS + 1)
                    results.append(table_bundle(columns, rows[:MAX_ROWS], len(rows) > MAX_ROWS))
                except duckdb.Error as error:
                    raise StatementError(error, code.count("\n", 0, position) + 1) from error
        except BaseException as error:  # noqa: BLE001 - reported to the main thread
            failure.append(error)

    def _execute(self, code: str) -> list[Any]:
        """Run on a worker so an interrupt reaches the query without waiting for DuckDB."""
        results: list[Any] = []
        failure: list[BaseException] = []
        self._cancelled.clear()
        worker = threading.Thread(target=self._run_statements, args=(code, results, failure))
        worker.start()
        try:
            while worker.is_alive():
                worker.join(JOIN_INTERVAL)
        except KeyboardInterrupt:
            # DuckDB interrupts only a running query, so keep asking until the worker stops.
            self._cancelled.set()
            while worker.is_alive():
                self._connection.interrupt()
                worker.join(JOIN_INTERVAL)
            raise
        if failure:
            raise failure[0]
        return results

    def _error(self, name: str, value: str, traceback: list[str]) -> dict[str, Any]:
        content = {"ename": name, "evalue": value, "traceback": traceback}
        self.send_response(self.iopub_socket, "error", content)
        return {"status": "error", "execution_count": self.execution_count, **content}

    def do_execute(
        self,
        code: str,
        silent: bool,
        store_history: bool = True,
        user_expressions: Optional[dict[str, str]] = None,
        allow_stdin: bool = False,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        try:
            results = self._execute(code) if code.strip() else []
        except KeyboardInterrupt:
            return self._error("KeyboardInterrupt", "Query interrupted", ["Query interrupted"])
        except StatementError as error:
            message = str(error.error)
            return self._error(type(error.error).__name__, message, [f"line {error.line}", message])
        except duckdb.Error as error:
            return self._error(type(error).__name__, str(error), [str(error)])
        if not silent:
            for index, bundle in enumerate(results):
                last = index == len(results) - 1
                self.send_response(
                    self.iopub_socket,
                    "execute_result" if last else "display_data",
                    {"data": bundle, "metadata": {}}
                    | ({"execution_count": self.execution_count} if last else {}),
                )
        return {
            "status": "ok",
            "execution_count": self.execution_count,
            "payload": [],
            "user_expressions": {
                name: self._user_expression(query) for name, query in (user_expressions or {}).items()
            },
        }

    def _user_expression(self, query: str) -> dict[str, Any]:
        """Evaluate a SQL expression query; its first value is the text/plain result."""
        try:
            row = self._connection.execute(query).fetchone()
            value = None if row is None else row[0]
            return {"status": "ok", "data": {"text/plain": "" if value is None else str(value)}, "metadata": {}}
        except duckdb.Error as error:
            return {"status": "error", "ename": type(error).__name__, "evalue": str(error), "traceback": []}

    def do_shutdown(self, restart: bool) -> dict[str, Any]:
        self._connection.close()
        return super().do_shutdown(restart)


if __name__ == "__main__":
    IPKernelApp.launch_instance(kernel_class=ScientSqlKernel)

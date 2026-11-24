#!/usr/bin/env python3
"""Unit tests for the SQL kernel's result tables, with DuckDB and Jupyter stubbed out."""

import decimal
import json
import os
import runpy
import types
import unittest
from unittest.mock import patch

STUBS = {
    "duckdb": types.SimpleNamespace(
        Error=Exception, __version__="test", StatementType=types.SimpleNamespace(SELECT="select")
    ),
    "ipykernel": types.SimpleNamespace(),
    "ipykernel.kernelapp": types.SimpleNamespace(IPKernelApp=object),
    "ipykernel.kernelbase": types.SimpleNamespace(Kernel=object),
}
with patch.dict("sys.modules", STUBS):
    sql = types.SimpleNamespace(
        **runpy.run_path(os.path.join(os.path.dirname(__file__), "scient_sql_kernel.py"))
    )


class DecimalTableTest(unittest.TestCase):
    def test_keeps_the_exact_digits_of_each_decimal(self):
        rows = [(decimal.Decimal("9007199254740993.00"), decimal.Decimal("1000000000000000128"), decimal.Decimal("0.10"))]
        bundle = sql.table_bundle(["a", "b", "c"], rows, False)
        self.assertIn("9007199254740993.00", bundle["text/plain"])
        self.assertIn("1000000000000000128", bundle["text/html"])
        wire = json.dumps(bundle["application/vnd.dataresource+json"]["data"][0])
        self.assertEqual(
            json.loads(wire, parse_float=decimal.Decimal),
            {"a": "9007199254740993.00", "b": "1000000000000000128", "c": decimal.Decimal("0.1")},
        )



class StreamingTest(unittest.TestCase):
    def test_shows_finished_tables_when_a_later_statement_fails(self):
        statement = lambda query: types.SimpleNamespace(query=query, type="select")  # noqa: E731

        class Connection:
            def extract_statements(self, code):
                return [statement(part) for part in code.split(";")]

            def execute(self, query):
                if query.query == "fail":
                    raise Exception("no such table")
                return types.SimpleNamespace(description=[("n",)], fetchmany=lambda _: [(1,)])

        kernel = sql.ScientSqlKernel.__new__(sql.ScientSqlKernel)
        kernel._connection = Connection()
        kernel._cancelled = __import__("threading").Event()
        shown = []
        with self.assertRaises(sql.StatementError):
            kernel._execute("first;second;fail", lambda bundle, last: shown.append(last))
        self.assertEqual(shown, [False, False])


if __name__ == "__main__":
    unittest.main()

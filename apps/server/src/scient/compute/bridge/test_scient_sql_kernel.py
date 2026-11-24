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
    "duckdb": types.SimpleNamespace(Error=Exception, __version__="test"),
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


if __name__ == "__main__":
    unittest.main()

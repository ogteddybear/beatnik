import assert from "node:assert/strict";
import { test } from "node:test";

import { csvCell } from "./events-csv";

test("CSV quoting preserves commas, quotes and newlines and neutralizes formulas", () => {
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
  assert.equal(csvCell("=SUM(A1)"), '"\'=SUM(A1)"');
  assert.equal(csvCell(" \t+42"), '"\' \t+42"');
  assert.equal(csvCell("\ttext"), '"\'\ttext"');
  assert.equal(csvCell(null), '""');
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterScoreRows, shouldIgnoreObjective } from "../sapi/src/ignore.ts";

describe("data-backup ignore", () => {
  it("默认排除 sfmc_money", () => {
    assert.equal(shouldIgnoreObjective("sfmc_money"), true);
    assert.equal(shouldIgnoreObjective("sfmc_level"), false);
  });

  it("filterScoreRows", () => {
    const rows = filterScoreRows([
      { objective: "sfmc_money", score: 1 },
      { objective: "kills", score: 2 },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.objective, "kills");
  });
});

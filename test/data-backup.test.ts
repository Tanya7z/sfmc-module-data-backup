import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterScoreRows, shouldIgnoreObjective } from "../sapi/src/ignore.js";
import {
  BackupTaskQueue,
  playerSnapshotHash,
} from "../sapi/src/backup-policy.js";

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

describe("data-backup task queue", () => {
  it("跨类别任务严格串行", async () => {
    const queue = new BackupTaskQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run(async () => {
      order.push("world:start");
      await gate;
      order.push("world:end");
    });
    const second = queue.run(async () => {
      order.push("scoreboard");
    });

    await Promise.resolve();
    assert.deepEqual(order, ["world:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["world:start", "world:end", "scoreboard"]);
  });

  it("玩家指纹忽略保存时间但覆盖重生点与 XUID", () => {
    const base = {
      name: "Steve",
      xuid: "1",
      level: 2,
      spawn_dimension: "minecraft:overworld",
      spawn_x: 1,
    };
    assert.equal(
      playerSnapshotHash({ ...base, updated_at: 1 }),
      playerSnapshotHash({ ...base, updated_at: 2 }),
    );
    assert.notEqual(
      playerSnapshotHash(base),
      playerSnapshotHash({ ...base, xuid: "2" }),
    );
    assert.notEqual(
      playerSnapshotHash(base),
      playerSnapshotHash({ ...base, spawn_x: 2 }),
    );
  });
});

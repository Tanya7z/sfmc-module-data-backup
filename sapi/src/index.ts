/**
 * @sfmc-bds/module-data-backup — 世界 / 玩家 / 计分板灾备
 */

import { Player, system, world } from "@minecraft/server";
import { config } from "@sfmc-bds/sdk/sapi/config";
import { db } from "@sfmc-bds/sdk/sapi/db";
import { ModuleRegistry } from "@sfmc-bds/sdk/module-loader";
import { Command, debug, Msg, Permission } from "@sfmc-bds/sdk/sapi/runtime";
import { service } from "@sfmc-bds/sdk/sapi/service";
import {
  DEFAULT_IGNORE,
  filterScoreRows,
  newSnapshotId,
  shouldIgnoreObjective,
} from "./ignore.js";

const MODULE_ID = "data-backup";
const PLAYERS_TABLE = "sfmc_players";
const WORLD_TABLE = "sfmc_world";
const SCORE_TABLE = "sfmc_scoreboards";

const GAME_RULE_KEYS = [
  "commandBlockOutput",
  "doDayLightCycle",
  "doEntityDrops",
  "doFireTick",
  "doImmediateRespawn",
  "doInsomnia",
  "doLimitedCrafting",
  "doMobLoot",
  "doMobSpawning",
  "doTileDrops",
  "doWeatherCycle",
  "drowningDamage",
  "fallDamage",
  "fireDamage",
  "freezeDamage",
  "keepInventory",
  "mobGriefing",
  "naturalRegeneration",
  "randomTickSpeed",
  "sendCommandFeedback",
  "showCoordinates",
  "showDeathMessage",
  "showTags",
  "spawnRadius",
  "tntExplodes",
] as const;

const unprovide: Array<() => void> = [];
const eventCleanups: Array<() => void> = [];
let worldRunId: number | undefined;
let scoreRunId: number | undefined;
let worldInterval = 600;
let scoreEnabled = true;
let scoreInterval = 6000;
let ignoreObjectives: string[] = [...DEFAULT_IGNORE];
let latestSnapshotId = "";

function serializeGameRules(): string {
  const g = world.gameRules as unknown as Record<string, unknown>;
  const rules: Record<string, unknown> = {};
  for (const key of GAME_RULE_KEYS) {
    try {
      if (g[key] !== undefined) rules[key] = g[key];
    } catch {
      /* ignore */
    }
  }
  return JSON.stringify(rules);
}

function snapshotPlayer(player: Player): Record<string, unknown> {
  return {
    id: player.id,
    name: player.name,
    xuid: "",
    last_online: Date.now(),
    level: player.level,
    total_xp: player.getTotalXp(),
    tags: player.getTags().join(","),
    updated_at: Date.now(),
  };
}

async function upsertPlayer(row: Record<string, unknown>): Promise<void> {
  const id = String(row.id);
  await db.tx(async (tx) => {
    const existing = await tx.get(PLAYERS_TABLE, id);
    if (existing) await tx.update(PLAYERS_TABLE, id, row);
    else await tx.insert(PLAYERS_TABLE, row);
  });
}

async function saveAllPlayers(): Promise<void> {
  const players = world.getAllPlayers();
  if (players.length === 0) return;
  try {
    await db.tx(async (tx) => {
      for (const player of players) {
        const row = snapshotPlayer(player);
        const id = String(row.id);
        const existing = await tx.get(PLAYERS_TABLE, id);
        if (existing) await tx.update(PLAYERS_TABLE, id, row);
        else await tx.insert(PLAYERS_TABLE, row);
      }
    });
  } catch (err) {
    debug.e(
      "BACKUP",
      "saveAllPlayers",
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

async function saveWorld(): Promise<void> {
  const spawn = world.getDefaultSpawnLocation();
  const row = {
    id: "singleton",
    seed: String((world as unknown as { seed?: number }).seed ?? ""),
    difficulty: String(world.getDifficulty?.() ?? ""),
    spawn_x: spawn.x,
    spawn_y: spawn.y,
    spawn_z: spawn.z,
    gamerules: serializeGameRules(),
    updated_at: Date.now(),
  };
  await db.tx(async (tx) => {
    const existing = await tx.get(WORLD_TABLE, "singleton");
    if (existing) await tx.update(WORLD_TABLE, "singleton", row);
    else await tx.insert(WORLD_TABLE, row);
  });
}

interface ScoreRow {
  id: string;
  snapshot_id: string;
  objective: string;
  participant: string;
  score: number;
  updated_at: number;
  [key: string]: unknown;
}

async function snapshotScoreboards(): Promise<string> {
  const snapshotId = newSnapshotId();
  const rows: ScoreRow[] = [];
  const now = Date.now();
  for (const obj of world.scoreboard.getObjectives()) {
    if (shouldIgnoreObjective(obj.id, ignoreObjectives)) continue;
    for (const participant of obj.getParticipants()) {
      const score = obj.getScore(participant);
      if (score === undefined) continue;
      const name = String(participant.displayName || participant.id);
      rows.push({
        id: `${snapshotId}|${obj.id}|${name}`,
        snapshot_id: snapshotId,
        objective: obj.id,
        participant: name,
        score,
        updated_at: now,
      });
    }
  }

  // 换代：先读旧行 id，事务内删除再插入新代（避免无界追加）
  const old = await db.query<{ id: string }>(SCORE_TABLE, { limit: 50000 });
  await db.tx(async (tx) => {
    for (const r of old) await tx.delete(SCORE_TABLE, r.id);
    for (const r of rows)
      await tx.insert(SCORE_TABLE, r as unknown as Record<string, unknown>);
  });

  latestSnapshotId = snapshotId;
  return snapshotId;
}

async function restoreScoreboard(opts: {
  objective?: string;
  snapshotId?: string;
}): Promise<{ ok: boolean; restoredCount: number }> {
  const snapshotId = opts.snapshotId || latestSnapshotId;
  let rows = await db.query<ScoreRow>(SCORE_TABLE, {
    where: snapshotId ? { eq: ["snapshot_id", snapshotId] } : undefined,
    limit: 50000,
  });
  if (!snapshotId) {
    // 取最新 snapshot_id
    const all = await db.query<ScoreRow>(SCORE_TABLE, {
      orderBy: { field: "updated_at", dir: "desc" },
      limit: 1,
    });
    const sid = all[0]?.snapshot_id;
    if (!sid) return { ok: false, restoredCount: 0 };
    rows = await db.query<ScoreRow>(SCORE_TABLE, {
      where: { eq: ["snapshot_id", sid] },
      limit: 50000,
    });
  }

  rows = filterScoreRows(rows, ignoreObjectives);
  if (opts.objective) {
    rows = rows.filter((r) => r.objective === opts.objective);
  }

  let restored = 0;
  for (const row of rows) {
    if (shouldIgnoreObjective(row.objective, ignoreObjectives)) continue;
    let obj = world.scoreboard.getObjective(row.objective);
    if (!obj) {
      try {
        obj = world.scoreboard.addObjective(row.objective, row.objective);
      } catch {
        continue;
      }
    }
    try {
      obj.setScore(row.participant, row.score);
      restored++;
    } catch {
      /* 离线参与者字符串标识 */
      try {
        obj.setScore(row.participant, row.score);
        restored++;
      } catch {
        /* ignore */
      }
    }
  }
  return { ok: true, restoredCount: restored };
}

async function createSnapshot(
  scope: string,
): Promise<{ ok: boolean; snapshotId: string }> {
  if (scope === "world" || scope === "all") {
    await saveWorld();
    await saveAllPlayers();
  }
  let snapshotId = latestSnapshotId || newSnapshotId();
  if (scope === "scoreboard" || scope === "all") {
    if (scoreEnabled) snapshotId = await snapshotScoreboards();
  }
  return { ok: true, snapshotId };
}

function registerCommands(): void {
  Command.register(
    "scoreboard",
    "scoreboard.restore",
    (player) => {
      // 平台仅首 token；子命令 restore 通过同一入口触发恢复
      void restoreScoreboard({}).then((r) => {
        const msg = r.ok
          ? `计分板恢复完成，共 ${r.restoredCount} 条（已跳过 ignore 名单）`
          : "计分板恢复失败：无可用快照";
        if (player) Msg.info(msg, player);
        else debug.i("BACKUP", msg);
      });
    },
    "scoreboard restore — 从最新快照恢复通用计分板",
    MODULE_ID,
  );
}

registerCommands();

ModuleRegistry.register({
  id: MODULE_ID,
  afterWorldLoad: true,
  lifecycle: {
    registerPermissions() {
      Permission.register("scoreboard.restore", Permission.Admin);
    },
    registerEvents() {
      const spawnCb = world.afterEvents.playerSpawn.subscribe((ev) => {
        if (ev.initialSpawn) {
          void upsertPlayer(snapshotPlayer(ev.player)).catch((err) =>
            debug.e(
              "BACKUP",
              "playerSpawn",
              err instanceof Error ? err : new Error(String(err)),
            ),
          );
        }
      });
      eventCleanups.push(() => {
        try {
          world.afterEvents.playerSpawn.unsubscribe(spawnCb);
        } catch {
          /* ignore */
        }
      });
    },
    async init() {
      const wi = await config.get<number>("world_interval_ticks");
      const sc = await config.get<{
        enabled?: boolean;
        interval_ticks?: number;
        ignore_objectives?: string[];
      }>("scoreboard");
      if (typeof wi === "number" && wi > 0) worldInterval = wi;
      if (sc) {
        if (typeof sc.enabled === "boolean") scoreEnabled = sc.enabled;
        if (typeof sc.interval_ticks === "number" && sc.interval_ticks > 0) {
          scoreInterval = sc.interval_ticks;
        }
        if (
          Array.isArray(sc.ignore_objectives) &&
          sc.ignore_objectives.length
        ) {
          ignoreObjectives = sc.ignore_objectives.map(String);
        }
      }

      await db.defineTable(PLAYERS_TABLE, {
        id: { type: "TEXT", primary: true },
        name: { type: "TEXT", default: "" },
        xuid: { type: "TEXT", default: "" },
        last_online: { type: "INTEGER", default: 0 },
        level: { type: "INTEGER", default: 0 },
        total_xp: { type: "INTEGER", default: 0 },
        tags: { type: "TEXT", default: "" },
        updated_at: { type: "INTEGER", default: 0 },
      });
      await db.defineTable(WORLD_TABLE, {
        id: { type: "TEXT", primary: true },
        seed: { type: "TEXT", default: "" },
        difficulty: { type: "TEXT", default: "" },
        spawn_x: { type: "INTEGER", default: 0 },
        spawn_y: { type: "INTEGER", default: 0 },
        spawn_z: { type: "INTEGER", default: 0 },
        gamerules: { type: "TEXT", default: "{}" },
        updated_at: { type: "INTEGER", default: 0 },
      });
      await db.defineTable(SCORE_TABLE, {
        id: { type: "TEXT", primary: true },
        snapshot_id: { type: "TEXT", notNull: true, index: true },
        objective: { type: "TEXT", notNull: true, index: true },
        participant: { type: "TEXT", notNull: true },
        score: { type: "INTEGER", default: 0 },
        updated_at: { type: "INTEGER", default: 0 },
      });

      await saveWorld();
      await saveAllPlayers();
      if (scoreEnabled) {
        try {
          latestSnapshotId = await snapshotScoreboards();
        } catch (err) {
          debug.e(
            "BACKUP",
            "init scoreboard",
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      }

      worldRunId = system.runInterval(() => {
        void (async () => {
          try {
            await saveWorld();
            await saveAllPlayers();
          } catch (err) {
            debug.e(
              "BACKUP",
              "periodic save",
              err instanceof Error ? err : new Error(String(err)),
            );
          }
        })();
      }, worldInterval);

      if (scoreEnabled) {
        scoreRunId = system.runInterval(() => {
          void snapshotScoreboards().catch((err) =>
            debug.e(
              "BACKUP",
              "score tick",
              err instanceof Error ? err : new Error(String(err)),
            ),
          );
        }, scoreInterval);
      }

      unprovide.push(
        service.provide("backup.createSnapshot", (input) =>
          createSnapshot(String(input.scope ?? "all")),
        ),
      );
      unprovide.push(
        service.provide("backup.restoreScoreboard", (input) =>
          restoreScoreboard({
            objective:
              typeof input.objective === "string" ? input.objective : undefined,
            snapshotId:
              typeof input.snapshotId === "string"
                ? input.snapshotId
                : undefined,
          }),
        ),
      );
      unprovide.push(
        service.provide("backup.getScoreboardSnapshot", async (input) => {
          const snapshotId =
            typeof input.snapshotId === "string"
              ? input.snapshotId
              : latestSnapshotId;
          let rows = await db.query<ScoreRow>(SCORE_TABLE, {
            where: snapshotId ? { eq: ["snapshot_id", snapshotId] } : undefined,
            limit: 50000,
          });
          rows = filterScoreRows(rows, ignoreObjectives);
          if (typeof input.objective === "string") {
            rows = rows.filter((r) => r.objective === input.objective);
          }
          if (typeof input.participant === "string") {
            rows = rows.filter((r) => r.participant === input.participant);
          }
          return {
            snapshotId: snapshotId || rows[0]?.snapshot_id || "",
            scores: rows.map((r) => ({
              objective: r.objective,
              participant: r.participant,
              score: r.score,
            })),
          };
        }),
      );
      unprovide.push(
        service.provide("backup.getPlayerSnapshot", async (input) => {
          const playerId = String(input.playerId ?? "");
          if (!playerId) return { player: null };
          const row = await db.get<Record<string, unknown>>(
            PLAYERS_TABLE,
            playerId,
          );
          return { player: row ?? null };
        }),
      );
      unprovide.push(
        service.provide("backup.getWorldSnapshot", async () => {
          const row = await db.get<Record<string, unknown>>(
            WORLD_TABLE,
            "singleton",
          );
          return { world: row ?? null };
        }),
      );

      debug.i(
        "BACKUP",
        `init world=${worldInterval} score=${scoreInterval} ignore=${ignoreObjectives.join(",")}`,
      );
    },
    cleanup() {
      for (const off of unprovide.splice(0, unprovide.length)) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      for (const c of eventCleanups.splice(0, eventCleanups.length)) c();
      if (worldRunId !== undefined) {
        try {
          system.clearRun(worldRunId);
        } catch {
          /* ignore */
        }
        worldRunId = undefined;
      }
      if (scoreRunId !== undefined) {
        try {
          system.clearRun(scoreRunId);
        } catch {
          /* ignore */
        }
        scoreRunId = undefined;
      }
      void (async () => {
        try {
          await saveWorld();
          await saveAllPlayers();
          if (scoreEnabled) await snapshotScoreboards();
        } catch {
          /* best-effort */
        }
      })();
      debug.i("BACKUP", "cleanup");
    },
  },
});

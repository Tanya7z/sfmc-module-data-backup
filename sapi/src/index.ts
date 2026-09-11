/**
 * @sfmc-bds/module-data-backup — 世界 / 玩家 / 计分板灾备
 */

import { Player, system, world } from "@minecraft/server";
import { config } from "@sfmc-bds/sdk/sapi/config";
import { db } from "@sfmc-bds/sdk/sapi/db";
import { ModuleRegistry } from "@sfmc-bds/sdk/module-loader";
import { debug, Permission } from "@sfmc-bds/sdk/sapi/runtime";
import { service } from "@sfmc-bds/sdk/sapi/service";
import {
  BackupTaskQueue,
  playerSnapshotHash,
  worldSnapshotHash,
} from "./backup-policy.js";
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
let playerReconcileRunId: number | undefined;
let scoreRunId: number | undefined;
let playerReconcileInterval = 6000;
let scoreEnabled = true;
let scoreInterval = 6000;
let ignoreObjectives: string[] = [...DEFAULT_IGNORE];
let latestSnapshotId = "";
const backupTasks = new BackupTaskQueue();
const playerHashes = new Map<string, string>();

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
  let spawn: ReturnType<Player["getSpawnPoint"]>;
  try {
    spawn = player.getSpawnPoint();
  } catch {
    spawn = undefined;
  }
  let dimension = "";
  let x: number | null = null;
  let y: number | null = null;
  let z: number | null = null;
  try {
    dimension = player.dimension.id;
    ({ x, y, z } = player.location);
  } catch {
    // 玩家离开前的受限执行阶段可能无法读取位置，保留空值。
  }
  let gameMode = "";
  try {
    gameMode = String(player.getGameMode());
  } catch {
    // 同上，单字段不可用不应丢弃整份快照。
  }
  return {
    id: player.id,
    name: player.name,
    xuid: "",
    level: player.level,
    total_xp: player.getTotalXp(),
    tags: player.getTags().join(","),
    spawn_dimension: spawn?.dimension.id ?? "",
    spawn_x: spawn?.x ?? null,
    spawn_y: spawn?.y ?? null,
    spawn_z: spawn?.z ?? null,
    dimension,
    x,
    y,
    z,
    game_mode: gameMode,
  };
}

async function upsertPlayer(
  snapshot: Record<string, unknown>,
  touchLastOnline = false,
): Promise<boolean> {
  const name = String(snapshot.name ?? "");
  const matches = await db.query<Record<string, unknown>>(PLAYERS_TABLE, {
    where: { eq: ["name", name] },
    orderBy: { field: "updated_at", dir: "desc" },
    limit: 10,
  });
  const identity = matches.find((row) => String(row.xuid ?? "").length > 0);
  const xuid = String(identity?.xuid ?? "");
  const id = xuid || String(snapshot.id);
  const row = { ...snapshot, id, xuid };
  const hash = playerSnapshotHash(row);
  const existing = matches.find((candidate) => String(candidate.id) === id);
  if (
    !touchLastOnline &&
    (playerHashes.get(id) === hash ||
      String(existing?.snapshot_hash ?? "") === hash)
  ) {
    return false;
  }
  const now = Date.now();
  await db.tx(async (tx) => {
    const current = await tx.get(PLAYERS_TABLE, id);
    const persisted = {
      ...row,
      last_online: now,
      snapshot_hash: hash,
      updated_at: now,
    };
    if (current) await tx.update(PLAYERS_TABLE, id, persisted);
    else await tx.insert(PLAYERS_TABLE, persisted);
    if (xuid) {
      for (const duplicate of matches) {
        const duplicateId = String(duplicate.id ?? "");
        if (
          duplicateId &&
          duplicateId !== id &&
          String(duplicate.xuid ?? "") === ""
        ) {
          await tx.delete(PLAYERS_TABLE, duplicateId, { hard: true });
          playerHashes.delete(duplicateId);
        }
      }
    }
  });
  playerHashes.set(id, hash);
  return true;
}

async function saveAllPlayers(): Promise<number> {
  const players = world.getAllPlayers();
  let changed = 0;
  for (const player of players)
    if (await upsertPlayer(snapshotPlayer(player))) changed++;
  return changed;
}

async function saveWorld(): Promise<boolean> {
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
  const existing = await db.get<Record<string, unknown>>(
    WORLD_TABLE,
    "singleton",
  );
  if (existing && worldSnapshotHash(existing) === worldSnapshotHash(row))
    return false;
  await db.tx(async (tx) => {
    const current = await tx.get(WORLD_TABLE, "singleton");
    if (current) await tx.update(WORLD_TABLE, "singleton", row);
    else await tx.insert(WORLD_TABLE, row);
  });
  return true;
}

async function saveWorldAndPlayers(): Promise<void> {
  await saveWorld();
  await saveAllPlayers();
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

  // 每代快照使用独立 snapshot_id 和主键，历史数据永久保留，由管理员显式维护。
  await db.tx(async (tx) => {
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
  if (scope === "all") {
    await saveWorldAndPlayers();
  } else if (scope === "world") {
    await saveWorld();
  } else if (scope === "player" || scope === "players") {
    await saveAllPlayers();
  }
  let snapshotId = latestSnapshotId || newSnapshotId();
  if (scope === "scoreboard" || scope === "all") {
    if (scoreEnabled) snapshotId = await snapshotScoreboards();
  }
  return { ok: true, snapshotId };
}

ModuleRegistry.register({
  id: MODULE_ID,
  afterWorldLoad: true,
  lifecycle: {
    registerPermissions() {
      Permission.register("scoreboard.restore", Permission.Admin);
    },
    registerEvents() {
      const spawnCb = world.afterEvents.playerSpawn.subscribe((ev) => {
        void backupTasks
          .run(() => upsertPlayer(snapshotPlayer(ev.player), ev.initialSpawn))
          .catch((err) =>
            debug.e(
              "BACKUP",
              "playerSpawn",
              err instanceof Error ? err : new Error(String(err)),
            ),
          );
      });
      const leaveCb = world.beforeEvents.playerLeave.subscribe((ev) => {
        try {
          const snapshot = snapshotPlayer(ev.player);
          system.run(() => {
            void backupTasks
              .run(() => upsertPlayer(snapshot, true))
              .catch((err) =>
                debug.e(
                  "BACKUP",
                  "playerLeave",
                  err instanceof Error ? err : new Error(String(err)),
                ),
              );
          });
        } catch (err) {
          debug.e(
            "BACKUP",
            "playerLeave snapshot",
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      });
      eventCleanups.push(() => {
        try {
          world.afterEvents.playerSpawn.unsubscribe(spawnCb);
        } catch {
          /* ignore */
        }
        try {
          world.beforeEvents.playerLeave.unsubscribe(leaveCb);
        } catch {
          /* ignore */
        }
      });
    },
    async init() {
      const reconcileInterval = await config.get<number>(
        "player_reconcile_interval_ticks",
      );
      const sc = await config.get<{
        enabled?: boolean;
        interval_ticks?: number;
        ignore_objectives?: string[];
      }>("scoreboard");
      if (typeof reconcileInterval === "number" && reconcileInterval > 0) {
        playerReconcileInterval = reconcileInterval;
      }
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

      await backupTasks
        .run(async () => {
          await db.defineTable(PLAYERS_TABLE, {
            id: { type: "TEXT", primary: true },
            name: { type: "TEXT", default: "" },
            xuid: { type: "TEXT", default: "" },
            last_online: { type: "INTEGER", default: 0 },
            level: { type: "INTEGER", default: 0 },
            total_xp: { type: "INTEGER", default: 0 },
            tags: { type: "TEXT", default: "" },
            spawn_dimension: { type: "TEXT", default: "" },
            spawn_x: { type: "REAL" },
            spawn_y: { type: "REAL" },
            spawn_z: { type: "REAL" },
            dimension: { type: "TEXT", default: "" },
            x: { type: "REAL" },
            y: { type: "REAL" },
            z: { type: "REAL" },
            game_mode: { type: "TEXT", default: "" },
            snapshot_hash: { type: "TEXT", default: "" },
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

          await saveWorldAndPlayers();
          if (scoreEnabled) latestSnapshotId = await snapshotScoreboards();
        })
        .catch((err) => {
          debug.e(
            "BACKUP",
            "init snapshot",
            err instanceof Error ? err : new Error(String(err)),
          );
        });

      playerReconcileRunId = system.runInterval(() => {
        void backupTasks
          .run(async () => {
            const changed = await saveAllPlayers();
            if (changed > 0)
              debug.i("BACKUP", `player reconcile changed=${changed}`);
          })
          .catch((err) =>
            debug.e(
              "BACKUP",
              "player reconcile",
              err instanceof Error ? err : new Error(String(err)),
            ),
          );
      }, playerReconcileInterval);

      if (scoreEnabled) {
        scoreRunId = system.runInterval(() => {
          void backupTasks
            .run(() => snapshotScoreboards())
            .then((id) => {
              latestSnapshotId = id;
            })
            .catch((err) =>
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
          backupTasks.run(() => createSnapshot(String(input.scope ?? "all"))),
        ),
      );
      unprovide.push(
        service.provide("backup.restoreScoreboard", (input) =>
          backupTasks.run(() =>
            restoreScoreboard({
              objective:
                typeof input.objective === "string"
                  ? input.objective
                  : undefined,
              snapshotId:
                typeof input.snapshotId === "string"
                  ? input.snapshotId
                  : undefined,
            }),
          ),
        ),
      );
      unprovide.push(
        service.provide("backup.getScoreboardSnapshot", (input) =>
          backupTasks.run(async () => {
            const snapshotId =
              typeof input.snapshotId === "string"
                ? input.snapshotId
                : latestSnapshotId;
            let rows = await db.query<ScoreRow>(SCORE_TABLE, {
              where: snapshotId
                ? { eq: ["snapshot_id", snapshotId] }
                : undefined,
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
        ),
      );
      unprovide.push(
        service.provide("backup.getPlayerSnapshot", (input) =>
          backupTasks.run(async () => {
            const playerId = String(input.playerId ?? "");
            if (!playerId) return { player: null };
            const direct = await db.get<Record<string, unknown>>(
              PLAYERS_TABLE,
              playerId,
            );
            const row =
              direct ??
              (
                await db.query<Record<string, unknown>>(PLAYERS_TABLE, {
                  where: {
                    or: [
                      { eq: ["xuid", playerId] },
                      { eq: ["name", playerId] },
                    ],
                  },
                  orderBy: { field: "updated_at", dir: "desc" },
                  limit: 1,
                })
              )[0];
            return { player: row ?? null };
          }),
        ),
      );
      unprovide.push(
        service.provide("backup.getWorldSnapshot", () =>
          backupTasks.run(async () => {
            const row = await db.get<Record<string, unknown>>(
              WORLD_TABLE,
              "singleton",
            );
            return { world: row ?? null };
          }),
        ),
      );

      debug.i(
        "BACKUP",
        `init playerReconcile=${playerReconcileInterval} score=${scoreInterval} ignore=${ignoreObjectives.join(",")}`,
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
      if (playerReconcileRunId !== undefined) {
        try {
          system.clearRun(playerReconcileRunId);
        } catch {
          /* ignore */
        }
        playerReconcileRunId = undefined;
      }
      if (scoreRunId !== undefined) {
        try {
          system.clearRun(scoreRunId);
        } catch {
          /* ignore */
        }
        scoreRunId = undefined;
      }
      void backupTasks
        .run(async () => {
          await saveWorldAndPlayers();
          if (scoreEnabled) latestSnapshotId = await snapshotScoreboards();
        })
        .catch(() => {
          /* best-effort */
        });
      debug.i("BACKUP", "cleanup");
    },
  },
});

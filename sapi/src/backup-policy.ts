export class BackupTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function playerSnapshotHash(row: Record<string, unknown>): string {
  return JSON.stringify({
    name: row.name ?? "",
    xuid: row.xuid ?? "",
    level: row.level ?? 0,
    total_xp: row.total_xp ?? 0,
    tags: row.tags ?? "",
    spawn_dimension: row.spawn_dimension ?? "",
    spawn_x: row.spawn_x ?? null,
    spawn_y: row.spawn_y ?? null,
    spawn_z: row.spawn_z ?? null,
    dimension: row.dimension ?? "",
    x: row.x ?? null,
    y: row.y ?? null,
    z: row.z ?? null,
    game_mode: row.game_mode ?? "",
  });
}

export function worldSnapshotHash(row: Record<string, unknown>): string {
  return JSON.stringify({
    seed: row.seed ?? "",
    difficulty: row.difficulty ?? "",
    spawn_x: row.spawn_x ?? 0,
    spawn_y: row.spawn_y ?? 0,
    spawn_z: row.spawn_z ?? 0,
    gamerules: row.gamerules ?? "{}",
  });
}

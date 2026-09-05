/** 计分板忽略名单与过滤纯函数。 */

export const DEFAULT_IGNORE = ["sfmc_money"];

/** 是否应跳过该 objective（备份与 restore 共用）。 */
export function shouldIgnoreObjective(
  objectiveId: string,
  ignoreList: string[] = DEFAULT_IGNORE,
): boolean {
  return ignoreList.includes(objectiveId);
}

/** 过滤分数行。 */
export function filterScoreRows<T extends { objective: string }>(
  rows: T[],
  ignoreList: string[] = DEFAULT_IGNORE,
): T[] {
  return rows.filter((r) => !shouldIgnoreObjective(r.objective, ignoreList));
}

/** 生成快照代际 id。 */
export function newSnapshotId(now = Date.now()): string {
  return `sb_${now}`;
}

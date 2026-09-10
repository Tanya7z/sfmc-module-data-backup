# @sfmc-bds/module-data-backup

Wave B official SFMC module: **data-backup**（世界与计分板灾备）.

玩家快照在进入、离开、重生、停服和手动快照时触发保存，并通过低频内容指纹校验补偿无原生事件的经验、标签及重生点变化。世界摘要仅在启服、停服和手动快照时比较保存；计分板按配置周期保存。所有数据库任务共用一个串行队列。

## Develop

```bash
npm install
npm run typecheck
npm test
```

Install into platform:

```bash
sfmc mod install data-backup --from dir:. --link
```

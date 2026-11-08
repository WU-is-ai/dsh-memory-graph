# dsh-memory-graph

> 把 AI 助手的记忆画成一片星空。**把 mnemon 记忆库渲染成可导航的星图。**
>
> 不是仪表盘：金色是重要、橙色是正在变淡、紫色是快忘了。遗忘是显示权重，不是删除。

![star map](docs/screenshot.png)

<sub>当前实测：37 条记忆 · 718 条关系 · 64 个实体。半径是时间，越新越靠外；颜色是权重，越淡越容易忘。</sub>

---

## 它解决什么问题

AI 助手有记忆，但记忆锁在数据库里：看不见、不知道哪些重要、不知道哪些快被遗忘、换台机器就丢。

这个插件把 mnemon 的记忆库直接读出来，画成一张可交互的星图：

- **每个光点是一条记忆**，亮度 = 权重，颜色 = 衰减档位
- **连线是记忆之间的关系**（时间 / 语义 / 因果 / 实体）
- **紫色小点是实体**（人、事、物），用来把星空填密
- 点一个光点，看它的内容、重要度、上次被调用是什么时候

设计原则只有一条：

> **遗忘 ≠ 删除。** 权重再低，数据也一条不减。变淡的意思是「不再自动跳到嘴边」，不是消失。

---

## 怎么工作

分两半，都很薄：

| 半边 | 文件 | 职责 |
|---|---|---|
| Host | `index.js` | 只读打开 mnemon 的 SQLite，算权重，注册一个 web 路由 `/dsh-memory-graph` 返回一份 JSON |
| Client | `client.js` | 挂到 `shell.overlay`，把 JSON 画成星图 |

Host **从不写库**。记忆库是 mnemon 的，这个插件只是看。

### 权重（遗忘曲线）

移植自 Ebbinghaus 式衰减，适配 mnemon 的 1–5 `importance`：

```
weight = importance/5 - min(rate, 0.03) * ageDays     地板 0.05
rate   = 0.008 * fresh * salience * review
fresh  = 1 / (1 + ageDays / 7)
salience = importance >= 3 ? 1.25 : 1.0
review   = 1 - 0.15 * min(access_count, 4)

importance >= 4 永不衰减
```

---

## 安装

需要 DSH（DeepSeek Harness）与本机安装的 `dsh-mnemon`。

```yaml
# cordis.patch.yml
- id: memory-graph
  module: '@you/dsh-memory-graph'
  config:
    dataDir: D:\dsh-memory\data
```

`dataDir` 指向 mnemon 的库目录（含 `mnemon.db` 与 `.dsh-memory-bodies.json`）。

刷新页面，右下角出现一颗金星，点开。

---

## 功能

- **分区视图**：全部 / 日记 / 私聊 / 群聊 / 工作，只看某一类记忆
- **权重过滤**：滑杆拉高只看「重要的」，拉低连「快忘的」一起看
- **点星看详情**：正文、权重、重要度、访问次数、相关记忆（按 entity / temporal 分组）
- **导出**：快照图、Markdown、整库备份
- **软删除 + 回收站**：删掉的记忆正文与向量都还在，随时可恢复

## 关系是怎么来的（读图前必看）

当前 718 条边的构成：

| 类型 | 条数 | 来源 |
|---|---|---|
| temporal | 448 | 写入时间邻近，**自动生成** |
| entity | 266 | 共现实体，**自动生成** |
| semantic | 4 | 显式建立，人工判断 |

**前两类是自动连的，不是「这两条记忆真的有关」。** 连线多 ≠ 关系深——星图上边多，是因为机器在找邻近，不是因为它想明白了。真正的人工关系目前只有 4 条。

---

## 状态

v0.2 — 能看、能筛、能导出、能恢复。已知不足：

- [ ] 权重只用于显示，**没有接回 mnemon 的召回排序**
- [ ] 自动连边（temporal / entity）太密，缺一个「只看语义关系」的开关
- [ ] 实体关系图（人物图）未做，`edges` 表里已有 entity 类型
- [ ] 上下文预算未做：还没有按权重决定哪些记忆进上下文
- [ ] 大库（>2000 条）未压测

## License

MIT

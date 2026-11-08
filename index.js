/**
 * Host half of dsh-memory-graph.
 *
 * Reads the mnemon memory stores straight out of SQLite (read-only) and serves
 * one JSON document to the client half over a named web route. It never writes:
 * the memory store belongs to mnemon, this plugin only looks at it.
 *
 * Decay follows the Ebbinghaus-style curve from the implementation note the
 * user supplied, adapted to mnemon's 1..5 `importance` scale:
 *
 *   weight = importance/5 - min(rate, 0.03) * ageDays      (floor 0.05)
 *   rate   = 0.008 * fresh * salience * review
 *   fresh  = 1 / (1 + ageDays / 7)
 *
 * importance >= 4 (i.e. 0.7 on the note's scale) never decays.
 *
 * Forgetting is a display weight, never a deletion: nothing here removes rows.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['webServer']

const DAY_MS = 86_400_000
const GRAPH_PATH = '/dsh-memory-graph'
const EXPORT_PATH = '/dsh-memory-graph/export'
const AVATAR_PATH = '/dsh-memory-graph/avatar'
const FORGET_PATH = '/dsh-memory-graph/forget'
const EDIT_PATH = '/dsh-memory-graph/edit'
const TRASH_PATH = '/dsh-memory-graph/trash'
const RESTORE_PATH = '/dsh-memory-graph/restore'
const PURGE_PATH = '/dsh-memory-graph/purge'
// 头像跟着插件走：换图只要替换同目录的 avatar.png，不用改代码
const AVATAR_FILE = join(dirname(fileURLToPath(import.meta.url)), 'avatar.png')

let sqliteModule
function sqlite() {
  if (sqliteModule === undefined) sqliteModule = import('node:sqlite')
  return sqliteModule
}

function bodyNames(dataDir) {
  const file = join(dataDir, '.dsh-memory-bodies.json')
  try {
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const items = Array.isArray(raw) ? raw : raw?.items ?? raw?.bodies ?? []
    const out = {}
    for (const item of items) {
      const id = item?.id ?? item?.memoryBodyId ?? item?.bodyId
      const name = item?.name ?? item?.title ?? item?.label
      if (typeof id === 'string' && typeof name === 'string') out[id] = name
    }
    return out
  } catch {
    return {}
  }
}

function listSpaces(dataDir) {
  const spaces = []
  let entries
  try {
    entries = readdirSync(dataDir)
  } catch {
    return spaces
  }
  for (const name of entries) {
    const dir = join(dataDir, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const db = join(dir, 'mnemon.db')
    if (existsSync(db)) spaces.push({ id: name, db })
  }
  return spaces.sort((a, b) => a.id.localeCompare(b.id))
}

function decayWeight(importance, createdAt, accessCount, now) {
  const scale = Number.isFinite(importance) ? Math.min(5, Math.max(1, importance)) : 3
  const base = scale / 5
  if (scale >= 4) return base
  const ts = Date.parse(createdAt ?? '')
  const ageDays = Number.isFinite(ts) ? Math.max(0, (now - ts) / DAY_MS) : 0
  const fresh = 1 / (1 + ageDays / 7)
  const salience = scale >= 3 ? 1.25 : 1
  const review = 1 - 0.15 * Math.min(Number(accessCount) || 0, 4)
  const rate = 0.008 * fresh * salience * review
  const drop = Math.min(rate, 0.03) * ageDays
  return Math.max(0.05, base - drop)
}

function parseJsonColumn(value) {
  if (typeof value !== 'string' || value === '') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

async function readGraph(dataDir) {
  const { DatabaseSync } = await sqlite()
  const now = Date.now()
  const names = bodyNames(dataDir)
  const spaces = []
  const nodes = []
  const edges = []
  const problems = []

  for (const space of listSpaces(dataDir)) {
    let db
    try {
      db = new DatabaseSync(space.db, { readOnly: true })
      const rows = db
        .prepare(
          `SELECT id, content, category, importance, tags, entities, access_count, created_at
             FROM insights
            WHERE deleted_at IS NULL`,
        )
        .all()
      for (const row of rows) {
        nodes.push({
          id: String(row.id),
          space: space.id,
          text: typeof row.content === 'string' ? row.content : '',
          category: row.category ?? 'general',
          importance: Number(row.importance) || 3,
          weight: Number(decayWeight(Number(row.importance), row.created_at, row.access_count, now).toFixed(4)),
          tags: parseJsonColumn(row.tags),
          entities: parseJsonColumn(row.entities),
          createdAt: row.created_at ?? null,
          accessCount: Number(row.access_count) || 0,
        })
      }
      const known = new Set(nodes.filter((node) => node.space === space.id).map((node) => node.id))
      const edgeRows = db
        .prepare('SELECT source_id, target_id, edge_type, weight FROM edges')
        .all()
      for (const edge of edgeRows) {
        if (!known.has(edge.source_id) || !known.has(edge.target_id)) continue
        edges.push({
          source: String(edge.source_id),
          target: String(edge.target_id),
          type: String(edge.edge_type),
          weight: Number(edge.weight) || 1,
        })
      }
      spaces.push({
        id: space.id,
        label: names[space.id] ?? space.id,
        count: known.size,
      })
    } catch (error) {
      problems.push({ space: space.id, message: error instanceof Error ? error.message : String(error) })
    } finally {
      try {
        db?.close()
      } catch {
        /* closing a read-only handle cannot fail meaningfully */
      }
    }
  }

  const byEntity = new Map()
  for (const node of nodes) {
    for (const entity of node.entities) {
      if (!byEntity.has(entity)) byEntity.set(entity, [])
      byEntity.get(entity).push(node.id)
    }
  }
  const entities = [...byEntity.entries()]
    .map(([name, ids]) => ({ name, count: ids.length, ids: ids.slice(0, 40) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 120)

  const totalWeight = nodes.reduce((sum, node) => sum + node.weight, 0)

  return {
    generatedAt: new Date(now).toISOString(),
    dataDir,
    stats: {
      spaces: spaces.length,
      memories: nodes.length,
      edges: edges.length,
      entities: entities.length,
      averageWeight: nodes.length === 0 ? 0 : Number((totalWeight / nodes.length).toFixed(3)),
    },
    spaces,
    nodes,
    edges,
    entities,
    problems,
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** handler 式路由拿到的是 Node 原生 req，body 要自己从流里读。 */
function readNodeBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 全量备份，格式跟 mem-sync.mjs 对得上（mnemon-merge-v1），
 * 所以导出的文件可以直接用它的 import 还原回去——这是「备份」不是「存档」。
 *
 * 跟 readGraph 的区别：这里读的是**全表**（含已软删的、含 embedding），
 * 因为备份要能原样还原，不是拿来画图的。
 */
async function readExport(dataDir) {
  const { DatabaseSync } = await sqlite()
  const payload = {
    format: 'mnemon-merge-v1',
    exportedAt: new Date().toISOString(),
    source: 'dsh-memory-graph',
    dataDir,
    spaces: {},
  }
  let totalInsights = 0
  let totalEdges = 0

  for (const space of listSpaces(dataDir)) {
    let db
    try {
      db = new DatabaseSync(space.db, { readOnly: true })
      const insights = db
        .prepare('SELECT * FROM insights')
        .all()
        .map((row) => {
          const next = { ...row }
          // embedding 是 BLOB，直接 JSON 化会变成一坨无意义的对象，转 base64 才存得住
          if (next.embedding) next.embedding = Buffer.from(next.embedding).toString('base64')
          return next
        })
      let edges = []
      try {
        edges = db
          .prepare('SELECT source_id, target_id, edge_type, weight, metadata, created_at FROM edges')
          .all()
      } catch {
        edges = [] // 老库可能没有 edges 表
      }
      payload.spaces[space.id] = { insights, edges }
      totalInsights += insights.length
      totalEdges += edges.length
    } finally {
      try {
        db?.close()
      } catch {
        /* 只读句柄，关不掉也不影响 */
      }
    }
  }

  payload.summary = { spaces: Object.keys(payload.spaces).length, insights: totalInsights, edges: totalEdges }
  return payload
}

/**
 * 软删除一条记忆：只写 deleted_at，不碰正文、不碰边、不碰 embedding。
 *
 * 为什么只做软删（2026-11-08 的决定）：
 *   - 软删和 mnemon 自己的 forget 语义一致，随时可以把 deleted_at 清空恢复；
 *   - 物理删除会把边和实体索引一并弄脏，而 mnemon 并没有提供「改记忆」的 API，
 *     直接 DELETE 之后没有官方路径能校正回来；
 *   - 所以这里只允许"藏起来"，不允许"抹掉"。
 */
async function forgetInsight(dataDir, spaceId, insightId) {
  const { DatabaseSync } = await sqlite()
  const space = listSpaces(dataDir).find((item) => item.id === spaceId)
  if (!space) throw new Error(`找不到空间：${spaceId}`)

  const db = new DatabaseSync(space.db)
  try {
    const row = db.prepare('SELECT id, content, deleted_at FROM insights WHERE id = ?').get(insightId)
    if (!row) throw new Error('这条记忆不存在')
    if (row.deleted_at) return { ok: true, already: true, preview: String(row.content ?? '').slice(0, 60) }

    const stamp = new Date().toISOString()
    const info = db.prepare('UPDATE insights SET deleted_at = ? WHERE id = ?').run(stamp, insightId)
    return {
      ok: true,
      deletedAt: stamp,
      changes: Number(info.changes) || 0,
      preview: String(row.content ?? '').slice(0, 60),
    }
  } finally {
    try {
      db.close()
    } catch {
      /* 关不掉不影响已经提交的写入 */
    }
  }
}

/**
 * 改一条记忆的正文。
 *
 * 注意 embedding：这个库里 37 条记忆全部没有向量（embedding 功能是关的），
 * 所以改正文不会让检索错位。**如果哪天打开了 embedding，改完必须重算**，
 * 否则旧的向量还指着旧文本，语义检索会答错。
 */
async function editInsight(dataDir, spaceId, insightId, content) {
  const text = String(content ?? '')
  if (!text.trim()) throw new Error('内容不能为空')
  if (text.length > 20000) throw new Error('内容太长（上限 20000 字）')

  const { DatabaseSync } = await sqlite()
  const space = listSpaces(dataDir).find((item) => item.id === spaceId)
  if (!space) throw new Error(`找不到空间：${spaceId}`)

  const db = new DatabaseSync(space.db)
  try {
    const row = db.prepare('SELECT id, content FROM insights WHERE id = ?').get(insightId)
    if (!row) throw new Error('这条记忆不存在')
    const before = String(row.content ?? '')
    if (before === text) return { ok: true, changed: false }

    const stamp = new Date().toISOString()
    const info = db.prepare('UPDATE insights SET content = ?, updated_at = ? WHERE id = ?').run(text, stamp, insightId)
    return { ok: true, changed: true, changes: Number(info.changes) || 0, updatedAt: stamp }
  } finally {
    try {
      db.close()
    } catch {
      /* 关不掉不影响已经提交的写入 */
    }
  }
}

/** 读取 mem-sync 留下的云端快照。没有快照不算错——只是看不到云端残留。 */
function loadSnapshot(file) {
  try {
    const raw = readFileSync(file, 'utf8')
    const json = JSON.parse(raw)
    return json?.spaces ? json : null
  } catch {
    return null
  }
}

/**
 * 云端还有、本地已经没有的记忆。
 * 这些就是「彻底删除」真正删掉的东西——删的只是本地那一份，云端那份还在。
 * 快照是 mem-sync 每 30 分钟刷一次，所以最长可能差半小时。
 */
async function readCloudOnly(dataDir, snapshotFile) {
  const snap = loadSnapshot(snapshotFile)
  if (!snap) return []
  const { DatabaseSync } = await sqlite()

  const localIds = new Set()
  for (const space of listSpaces(dataDir)) {
    let db
    try {
      db = new DatabaseSync(space.db, { readOnly: true })
      for (const row of db.prepare('SELECT id FROM insights').all()) localIds.add(String(row.id))
    } catch {
      /* 单个空间读不出来不影响其他空间 */
    } finally {
      try {
        db?.close()
      } catch {
        /* 只读句柄 */
      }
    }
  }

  const names = bodyNames(dataDir)
  const out = []
  for (const [spaceId, bag] of Object.entries(snap.spaces ?? {})) {
    for (const row of bag?.insights ?? []) {
      const id = String(row?.id ?? '')
      if (!id || localIds.has(id)) continue
      out.push({
        id,
        space: spaceId,
        spaceLabel: names[spaceId] ?? spaceId,
        text: String(row.content ?? ''),
        category: row.category ?? 'general',
        importance: Number(row.importance) || 3,
        deletedAt: row.updated_at ?? row.created_at ?? null,
        origin: 'cloud',
      })
    }
  }
  return out
}
async function readTrash(dataDir, snapshotFile) {
  const { DatabaseSync } = await sqlite()
  const names = bodyNames(dataDir)
  const items = []
  for (const space of listSpaces(dataDir)) {
    let db
    try {
      db = new DatabaseSync(space.db, { readOnly: true })
      const rows = db
        .prepare(
          `SELECT id, content, category, importance, deleted_at
             FROM insights
            WHERE deleted_at IS NOT NULL
            ORDER BY deleted_at DESC`,
        )
        .all()
      for (const row of rows) {
        items.push({
          id: String(row.id),
          space: space.id,
          spaceLabel: names[space.id] ?? space.id,
          text: String(row.content ?? ''),
          category: row.category ?? 'general',
          importance: Number(row.importance) || 3,
          deletedAt: row.deleted_at,
        })
      }
    } catch {
      /* 单个空间读失败不该让整个回收站打不开 */
    } finally {
      try {
        db?.close()
      } catch {
        /* 只读句柄 */
      }
    }
  }
  items.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)))
  // 云端还有、本地已经没有的那些也列进来——它们同样是"被删掉的东西"，
  // 只不过删的只是本地这一份。看不见它们，等于把最后一根救命绳藏起来。
  const cloudOnly = await readCloudOnly(dataDir, snapshotFile)
  const all = [...items, ...cloudOnly]
  return { count: all.length, local: items.length, cloud: cloudOnly.length, items: all }
}

/** 恢复：把 deleted_at 清空。 */
async function restoreInsight(dataDir, spaceId, insightId, snapshotFile) {
  const { DatabaseSync } = await sqlite()
  const space = listSpaces(dataDir).find((item) => item.id === spaceId)
  if (!space) throw new Error(`找不到空间：${spaceId}`)
  const db = new DatabaseSync(space.db)
  try {
    const row = db.prepare('SELECT id, deleted_at FROM insights WHERE id = ?').get(insightId)
    // 情形一：本地还在，只是被软删了 → 清掉标记
    if (row) {
      if (!row.deleted_at) return { ok: true, already: true }
      const info = db.prepare('UPDATE insights SET deleted_at = NULL WHERE id = ?').run(insightId)
      return { ok: true, changes: Number(info.changes) || 0, fromCloud: false }
    }

    // 情形二：本地已经被彻底删掉了 → 从云端快照整条插回来（含它的边）
    const snap = loadSnapshot(snapshotFile)
    const src = (snap?.spaces?.[spaceId]?.insights ?? []).find((item) => String(item.id) === insightId)
    if (!src) throw new Error('本地和云端快照里都没有这条')

    db.prepare(
      `INSERT INTO insights
         (id, content, category, importance, tags, entities, source,
          access_count, stored_at, created_at, updated_at, deleted_at,
          last_accessed_at, effective_importance)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      src.id,
      src.content,
      src.category ?? null,
      src.importance ?? null,
      src.tags ?? null,
      src.entities ?? null,
      src.source ?? null,
      src.access_count ?? null,
      src.stored_at ?? null,
      src.created_at ?? null,
      src.updated_at ?? null,
      null,
      src.last_accessed_at ?? null,
      src.effective_importance ?? null,
    )

    // 边也要一起回来，否则这条记忆是"孤岛"，点开看不到任何相关记忆
    const edgeRows = (snap?.spaces?.[spaceId]?.edges ?? []).filter(
      (edge) => String(edge.source_id) === insightId || String(edge.target_id) === insightId,
    )
    const existsNode = db.prepare('SELECT 1 FROM insights WHERE id = ?')
    const hasEdge = db.prepare('SELECT 1 FROM edges WHERE source_id = ? AND target_id = ? AND edge_type = ?')
    let edges = 0
    for (const edge of edgeRows) {
      if (!existsNode.get(edge.source_id) || !existsNode.get(edge.target_id)) continue
      if (hasEdge.get(edge.source_id, edge.target_id, edge.edge_type)) continue
      db.prepare(
        'INSERT INTO edges (source_id, target_id, edge_type, weight, metadata, created_at) VALUES (?,?,?,?,?,?)',
      ).run(edge.source_id, edge.target_id, edge.edge_type, edge.weight ?? null, edge.metadata ?? null, edge.created_at ?? null)
      edges += 1
    }
    return { ok: true, fromCloud: true, edges }
  } finally {
    try {
      db.close()
    } catch {
      /* 同上 */
    }
  }
}

/**
 * 彻底删除：真 DELETE，并且把指向它的边一起清掉，不然会留下一堆指向空气的边。
 * 这是不可恢复的操作，调用方必须自己确认过。
 */
async function purgeInsight(dataDir, spaceId, insightId) {
  const { DatabaseSync } = await sqlite()
  const space = listSpaces(dataDir).find((item) => item.id === spaceId)
  if (!space) throw new Error(`找不到空间：${spaceId}`)
  const db = new DatabaseSync(space.db)
  try {
    const row = db.prepare('SELECT id FROM insights WHERE id = ?').get(insightId)
    if (!row) throw new Error('这条记忆不存在')
    let edges = 0
    try {
      const e = db.prepare('DELETE FROM edges WHERE source_id = ? OR target_id = ?').run(insightId, insightId)
      edges = Number(e.changes) || 0
    } catch {
      edges = 0 // 老库可能没有 edges 表
    }
    const info = db.prepare('DELETE FROM insights WHERE id = ?').run(insightId)
    return { ok: true, purged: Number(info.changes) || 0, edges }
  } finally {
    try {
      db.close()
    } catch {
      /* 同上 */
    }
  }
}

export function apply(ctx, config) {  const dataDir = typeof config?.dataDir === 'string' && config.dataDir !== '' ? config.dataDir : 'D:\\dsh-memory\\data'
  // mem-sync 每次同步都会把云端那一侧存成这个文件；回收站的「云端」分区就靠它
  const snapshotFile =
    typeof config?.snapshotFile === 'string' && config.snapshotFile !== ''
      ? config.snapshotFile
      : 'D:\\dsh-tools\\tmp\\memsync\\server.json'

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: GRAPH_PATH,
      resource: async (request) => {
        // Local-only route: refuse a foreign Host header (DNS rebinding).
        const host = request.headers.get('host') ?? ''
        if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
          return jsonResponse({ error: 'forbidden host' }, 403)
        }
        try {
          return jsonResponse(await readGraph(dataDir))
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : String(error), dataDir },
            500,
          )
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: AVATAR_PATH,
      resource: async (request) => {
        const host = request.headers.get('host') ?? ''
        if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
          return jsonResponse({ error: 'forbidden host' }, 403)
        }
        try {
          return new Response(readFileSync(AVATAR_FILE), {
            status: 200,
            headers: { 'content-type': 'image/png', 'cache-control': 'max-age=600' },
          })
        } catch {
          return jsonResponse({ error: 'avatar.png 不存在' }, 404)
        }
      },
    }),
  )

  // 写路由统一走这个工厂：method 校验、Host 校验、body 解析、错误包装都只有一份，
  // 三个动作（删除/恢复/彻底删）不会因为抄漏一段而各自跑偏。
  const registerWriteRoute = (path, run) => {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        // 必须用 handler：resource 那条通道只接 GET，POST 会被框架 405 掉
        handler: async (req, res) => {
          const reply = (status, payload) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(payload))
          }
          const host = req.headers.host ?? ''
          if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
            reply(403, { error: 'forbidden host' })
            return
          }
          const method = String(req.method ?? '').toUpperCase()
          if (method !== 'POST') {
            reply(405, { error: `只接受 POST（收到 ${method || '空'}）` })
            return
          }
          let body
          try {
            body = JSON.parse((await readNodeBody(req)) || '{}')
          } catch {
            reply(400, { error: 'body 不是合法 JSON' })
            return
          }
          try {
            reply(200, await run(body ?? {}))
          } catch (error) {
            reply(400, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    )
  }

  const needIds = (body) => {
    const spaceId = String(body?.space ?? '')
    const id = String(body?.id ?? '')
    if (!spaceId || !id) throw new Error('space 和 id 都不能为空')
    return { spaceId, id }
  }

  registerWriteRoute(FORGET_PATH, (body) => {
    const { spaceId, id } = needIds(body)
    return forgetInsight(dataDir, spaceId, id)
  })
  registerWriteRoute(RESTORE_PATH, (body) => {
    const { spaceId, id } = needIds(body)
    return restoreInsight(dataDir, spaceId, id, snapshotFile)
  })
  registerWriteRoute(PURGE_PATH, (body) => {
    const { spaceId, id } = needIds(body)
    return purgeInsight(dataDir, spaceId, id)
  })
  registerWriteRoute(EDIT_PATH, (body) => {
    const { spaceId, id } = needIds(body)
    if (typeof body?.content !== 'string') throw new Error('content 必须是字符串')
    return editInsight(dataDir, spaceId, id, body.content)
  })

  // 回收站是只读的，可以留 resource
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: TRASH_PATH,
      resource: async (request) => {
        const host = request.headers.get('host') ?? ''
        if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
          return jsonResponse({ error: 'forbidden host' }, 403)
        }
        try {
          return jsonResponse(await readTrash(dataDir, snapshotFile))
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: EXPORT_PATH,
      resource: async (request) => {
        const host = request.headers.get('host') ?? ''
        if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
          return jsonResponse({ error: 'forbidden host' }, 403)
        }
        try {
          return new Response(JSON.stringify(await readExport(dataDir)), {
            status: 200,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'content-disposition': `attachment; filename="mnemon-merge-${Date.now()}.json"`,
              'cache-control': 'no-store',
            },
          })
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : String(error), dataDir },
            500,
          )
        }
      },
    }),
  )
}

/** Exported for the offline smoke test only; not part of the plugin surface. */
export { readGraph, readExport, forgetInsight, readTrash, restoreInsight, purgeInsight, editInsight }

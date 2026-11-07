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
import { join } from 'node:path'

export const inject = ['webServer']

const DAY_MS = 86_400_000
const GRAPH_PATH = '/dsh-memory-graph'

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

export function apply(ctx, config) {  const dataDir = typeof config?.dataDir === 'string' && config.dataDir !== '' ? config.dataDir : 'D:\\dsh-memory\\data'

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
}

/** Exported for the offline smoke test only; not part of the plugin surface. */
export { readGraph }

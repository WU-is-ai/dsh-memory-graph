/**
 * Client half of dsh-memory-graph — 3D 行星系版（2026-11-07 第三版）。
 *
 * 对比第二版的改动，只有两处，都是为了让「坏了也能看见」：
 *   1. 加了 ErrorBoundary：画图里抛错时，面板显示错误原文，**按钮不会消失**
 *   2. canvas 的初始化包了 try/catch：拿不到 2d 上下文就退化成文字说明
 *
 * 其余照旧：每条记忆 = 一颗行星，半径由遗忘权重决定；轨道面倾斜 64°，
 * 真透视投影；按 z 排序绘制；实体作为卫星绕行星；行星底下有标签。
 */

window.__ModuleLoader__.load({
  id: 'dsh-memory-graph',
  factory(require) {
    const React = require('react')
    const el = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const GOLD = '#ffcc55'
    const AMBER = '#ff9f43'
    const VIOLET = '#7b6bff'
    const CYAN = '#8fd0ff'
    const MOON = '#c79bff'

    const TILT = (64 * Math.PI) / 180
    const CAM_Z = 1500
    const FOCAL = 1150
    const R_INNER = 210
    const R_OUTER = 640
    const SUN_R = 38
    // 头像由 host 端从插件目录读 avatar.png 发出来；换图不需改代码
    const AVATAR_URL = '/dsh-memory-graph/avatar'

    // 权重 → 颜色，连续过渡而不是三档跳变。
    // 色带从青→蓝→紫→粉→金→暖白：中低权重也有颜色，不再是一片暖橙。
    const WEIGHT_STOPS = [
      [0.0, [86, 196, 255]], // 青
      [0.22, [110, 150, 255]], // 蓝
      [0.42, [176, 120, 255]], // 紫
      [0.6, [255, 128, 196]], // 粉
      [0.78, [255, 196, 96]], // 金
      [1.0, [255, 244, 214]], // 暖白
    ]

    function weightColor(weight) {
      const w = Math.max(0, Math.min(1, Number.isFinite(weight) ? weight : 0.5))
      for (let i = 1; i < WEIGHT_STOPS.length; i += 1) {
        const [w1, c1] = WEIGHT_STOPS[i]
        const [w0, c0] = WEIGHT_STOPS[i - 1]
        if (w <= w1) {
          const k = (w - w0) / Math.max(1e-6, w1 - w0)
          return `rgb(${Math.round(c0[0] + (c1[0] - c0[0]) * k)},${Math.round(c0[1] + (c1[1] - c0[1]) * k)},${Math.round(c0[2] + (c1[2] - c0[2]) * k)})`
        }
      }
      return 'rgb(255,247,214)'
    }

    function makeStars(count) {
      let seed = 20261107
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
      }
      // 背景不是"撒芝麻"，是三条旋臂 + 一层薄晕：
      // 72% 的粒子沿旋臂排（内密外疏），其余散在盘面里补厚度。
      const ARMS = 3
      const SPIRAL = 0.0032
      const stars = []
      for (let i = 0; i < count; i += 1) {
        const onArm = rnd() < 0.72
        let r
        let a
        if (onArm) {
          const arm = Math.floor(rnd() * ARMS)
          r = 220 + Math.pow(rnd(), 0.62) * 1750
          a = (arm / ARMS) * Math.PI * 2 + r * SPIRAL + (rnd() - 0.5) * 0.55
        } else {
          r = 120 + Math.pow(rnd(), 0.5) * 1900
          a = rnd() * Math.PI * 2
        }
        // 盘面厚度：越往外越厚，但不至于变成球。
        // 注意这里存的是「平铺」坐标（y 就是离盘面的高度），倾斜交给 project 里的视角旋转，
        // 这样拖动转视角时，背景星和行星轨道才会一起转。
        const h = (rnd() - 0.5) * (90 + r * 0.16)
        stars.push({
          x: Math.cos(a) * r,
          y: h,
          z: Math.sin(a) * r,
          size: 0.5 + rnd() * 1.15,
          base: 0.1 + rnd() * 0.34,
          phase: rnd() * Math.PI * 2,
          speed: 0.6 + rnd() * 1.8,
        })
      }
      return stars
    }

    // 由 id 派生稳定的伪随机数：同一颗星每次刷新都长一个样，不会跳来跳去
    function hash01(seed) {
      const text = String(seed)
      let h = 2166136261
      for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i)
        h = Math.imul(h, 16777619)
      }
      return (h >>> 0) / 4294967296
    }

    // 标签上的短日期：MM-DD。年份在星图上没有分辨意义，省掉。
    function shortDate(value) {
      const ts = Date.parse(value ?? '')
      if (!Number.isFinite(ts)) return ''
      const d = new Date(ts)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }

    function buildSystem(data) {
      const nodes = data.nodes ?? []

      // 半径改由「时间」决定，不再由权重决定：
      // 最早的一条落在最内圈，最新的被推到最外圈——用得越久，这片星系越大。
      // 权重仍然有用，但它管的是颜色和亮度（weightColor + draw 里的 alpha），不再管位置。
      const times = nodes.map((node) => {
        const raw = Date.parse(node.createdAt ?? '')
        return Number.isFinite(raw) ? raw : 0
      })
      const order = nodes
        .map((node, index) => index)
        .sort((a, b) => times[a] - times[b] || a - b) // 同一时刻按原顺序，保证每次刷新位置一致
      const rankOf = new Map()
      order.forEach((nodeIndex, rank) => rankOf.set(nodeIndex, rank))
      const lastRank = Math.max(1, order.length - 1)
      const newestIndex = order.length ? order[order.length - 1] : -1

      const planets = nodes
        .map((node, index) => {
          const weight = typeof node.weight === 'number' ? node.weight : 0.5
          const tRank = (rankOf.get(index) ?? 0) / lastRank
          const radius = R_INNER + tRank * (R_OUTER - R_INNER)
          const period = 26 + tRank * 96
          return {
            ...node,
            weight,
            color: weightColor(weight),
            radius,
            period,
            phase: (index * 2.399963) % (Math.PI * 2),
            // 记忆星必须明显大于背景星点，否则两者糊成一片、分不出谁是内容谁是背景
            size: 6 + Math.min(5, Number(node.importance) || 3) * 1.8,
            isNewest: index === newestIndex,
            // 每条轨道各有各的倾角（±8.6°）：全挤在一个平面就像个靶盘
            incl: (hash01(`${node.id}:incl`) - 0.5) * 0.3,
            // 自转起始相位 + 表面斑点：让每颗星有张自己的脸
            spin: hash01(`${node.id}:spin`) * Math.PI * 2,
            spots: Array.from({ length: 4 }, (_, k) => ({
              ang: hash01(`${node.id}:sa${k}`) * Math.PI * 2,
              dist: 0.12 + hash01(`${node.id}:sd${k}`) * 0.5,
              rx: 0.18 + hash01(`${node.id}:sx${k}`) * 0.14,
              ry: 0.11 + hash01(`${node.id}:sy${k}`) * 0.1,
              dark: hash01(`${node.id}:sk${k}`) > 0.42,
            })),
            moons: [],
          }
        })
        .sort((a, b) => a.radius - b.radius)

      const byId = new Map(planets.map((planet) => [planet.id, planet]))
      for (const entity of data.entities ?? []) {
        const owners = (entity.ids ?? []).map((id) => byId.get(id)).filter(Boolean)
        if (owners.length === 0) continue
        owners[0].moons.push({
          name: entity.name,
          count: Number(entity.count) || owners.length,
          orbit: 16 + (owners[0].moons.length % 3) * 6,
          period: 5 + (owners[0].moons.length % 4) * 1.6,
          phase: owners[0].moons.length * 0.9,
        })
      }
      return { planets }
    }

    function useGraph() {
      const [state, setState] = useState({ status: 'idle', data: null, error: null })
      const load = useCallback((signal) => {
        setState((prev) => ({ ...prev, status: 'loading', error: null }))
        fetch('/dsh-memory-graph', { cache: 'no-store', signal })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((data) => {
            if (data?.error) throw new Error(data.error)
            setState({ status: 'ready', data, error: null })
          })
          .catch((error) => {
            if (error?.name === 'AbortError') return
            setState({ status: 'error', data: null, error: error instanceof Error ? error.message : String(error) })
          })
      }, [])
      return [state, load]
    }

    /** 画图抛错时不要连按钮一起消失 —— 把错误留在屏幕上。 */
    class GraphBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }

      componentDidCatch(error) {
        console.error('[memory-graph] render failed', error)
      }

      render() {
        if (this.state.error) {
          return el(
            'div',
            { style: { padding: '24px', color: AMBER, fontSize: '12.5px', lineHeight: 1.9 } },
            el('div', null, '星图画不出来，错误原文：'),
            el('div', { style: { color: '#ffd7a8', marginTop: 8, whiteSpace: 'pre-wrap' } }, this.state.error),
          )
        }
        return this.props.children
      }
    }

    const S = {
      button: {
        position: 'fixed',
        right: '24px',
        bottom: '132px',
        zIndex: 60,
        width: '46px',
        height: '46px',
        borderRadius: '50%',
        display: 'grid',
        placeItems: 'center',
        cursor: 'pointer',
        pointerEvents: 'auto',
        border: '1px solid rgba(255,204,85,0.35)',
        background: 'radial-gradient(circle at 50% 35%, #1b2436 0%, #070a12 70%)',
        color: GOLD,
        boxShadow: '0 0 18px rgba(255,204,85,0.22), 0 10px 30px rgba(0,0,0,0.45)',
      },
      backdrop: {
        pointerEvents: 'auto',
        position: 'fixed',
        inset: '0',
        zIndex: 95,
        background: 'rgba(2,4,8,0.9)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        flexDirection: 'column',
      },
      header: {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '14px 20px',
        borderBottom: '1px solid rgba(255,204,85,0.14)',
      },
      title: { fontSize: '14px', letterSpacing: '0.08em', color: GOLD },
      sub: { fontSize: '11.5px', color: 'rgba(200,214,232,0.6)', marginTop: '3px' },
      body: { flex: '1 1 auto', display: 'flex', minHeight: 0 },
      canvas: { position: 'relative', flex: '1 1 auto', minWidth: 0, background: '#000', overflow: 'hidden' },
      aside: {
        flex: '0 0 340px',
        borderLeft: '1px solid rgba(255,255,255,0.07)',
        padding: '16px',
        overflowY: 'auto',
        background: 'rgba(6,9,16,0.9)',
      },
      closeFloat: {
        position: 'absolute',
        left: '18px',
        bottom: '18px',
        pointerEvents: 'auto',
        font: 'inherit',
        fontSize: '12px',
        color: '#cfe6ff',
        background: 'rgba(10,14,22,0.85)',
        border: '1px solid rgba(143,208,255,0.3)',
        borderRadius: '999px',
        padding: '7px 14px',
        cursor: 'pointer',
      },
      legendRow: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' },
      dot: (color) => ({ width: '7px', height: '7px', borderRadius: '50%', background: color, boxShadow: `0 0 8px ${color}`, flex: '0 0 auto' }),
      hint: { fontSize: '11px', color: 'rgba(200,214,232,0.45)', lineHeight: 1.75, marginTop: '10px' },
      dangerBtn: {
        marginTop: '14px',
        font: 'inherit',
        fontSize: '11.5px',
        color: '#ff9d9d',
        background: 'rgba(255,90,90,0.08)',
        border: '1px solid rgba(255,90,90,0.32)',
        borderRadius: '999px',
        padding: '6px 14px',
        cursor: 'pointer',
      },
      toast: {
        position: 'fixed',
        left: '50%',
        bottom: '26px',
        transform: 'translateX(-50%)',
        zIndex: 120,
        padding: '8px 18px',
        borderRadius: '999px',
        fontSize: '12px',
        color: '#0a0d14',
        background: 'linear-gradient(180deg,#ffd97a,#ffb84d)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        pointerEvents: 'none',
      },
      editor: {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1.72,
        color: '#dbe9ff',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '8px',
        padding: '10px',
        resize: 'vertical',
        outline: 'none',
      },
      weightBar: { display: 'flex', alignItems: 'center', gap: '6px' },
      weightRange: { width: '84px', accentColor: '#ffcc55', cursor: 'pointer' },
      toolbar: {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        padding: '8px 20px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(4,8,14,0.55)',
        flexWrap: 'wrap',
      },
      chip: (active) => ({
        font: 'inherit',
        fontSize: '12px',
        padding: '5px 12px',
        borderRadius: '999px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        color: active ? '#0a0d14' : 'rgba(200,214,232,0.82)',
        background: active ? 'linear-gradient(180deg,#ffd97a,#ffb84d)' : 'rgba(255,255,255,0.05)',
        border: active ? '1px solid rgba(255,204,85,0.7)' : '1px solid rgba(255,255,255,0.1)',
        fontWeight: active ? 600 : 400,
        transition: 'background 120ms ease, color 120ms ease',
      }),
      search: {
        font: 'inherit',
        fontSize: '12px',
        padding: '5px 12px',
        borderRadius: '999px',
        minWidth: '170px',
        color: '#dbe9ff',
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.1)',
        outline: 'none',
      },
      grow: { flex: '1 1 auto' },
      count: { fontSize: '11.5px', color: 'rgba(200,214,232,0.55)' },
      timeline: {
        position: 'absolute',
        left: '14px',
        right: '14px',
        bottom: '58px',
        padding: '10px 12px 17px 48px',
        borderRadius: '10px',
        background: 'rgba(5,9,15,0.62)',
        border: '1px solid rgba(255,255,255,0.07)',
        // 容器本身不吃鼠标，否则画布下半截拖不动；只有那几个点单独打开
        pointerEvents: 'none',
      },
      timelineRow: { position: 'relative', height: '15px' },
      timelineRowLabel: {
        position: 'absolute',
        left: '-40px',
        top: '50%',
        transform: 'translateY(-50%)',
        fontSize: '9.5px',
        color: 'rgba(200,214,232,0.5)',
        pointerEvents: 'none',
      },
      timelineRowAxis: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: '50%',
        height: '1px',
        background: 'rgba(255,255,255,0.07)',
      },
      timelineCap: {
        position: 'absolute',
        bottom: '3px',
        fontSize: '9.5px',
        color: 'rgba(200,214,232,0.42)',
        pointerEvents: 'none',
      },
      timelineDot: (color, active, size) => ({
        position: 'absolute',
        top: '50%',
        width: `${size}px`,
        height: `${size}px`,
        marginLeft: `${-size / 2}px`,
        marginTop: `${-size / 2}px`,
        borderRadius: '50%',
        background: color,
        border: active ? '1.5px solid #ffffff' : 'none',
        boxShadow: `0 0 ${active ? 10 : 5}px ${color}`,
        cursor: 'pointer',
        pointerEvents: 'auto',
        padding: 0,
        transition: 'transform 120ms ease',
      }),
    }

    // 功能栏的分类。注意「私聊 / 群聊」不是空间，是写记忆时打的标签。
    const FILTERS = [
      { id: 'all', label: '全部' },
      { id: 'diary', label: '日记' },
      { id: 'private', label: '私聊' },
      { id: 'group', label: '群聊' },
      { id: 'work', label: '工作' },
    ]

    function matchesFilter(node, filter, labelOf) {
      if (filter === 'all') return true
      const space = labelOf(node.space) || ''
      const tags = node.tags ?? []
      if (filter === 'diary') return space.includes('日记')
      if (filter === 'work') return space.includes('工作')
      if (filter === 'private') return tags.includes('私聊')
      if (filter === 'group') return tags.includes('群聊')
      return true
    }

    // 时间轴只收「经历型」的记忆：日记和工作。
    // 私聊/群聊是每 10 分钟批量写进来的对话日志，时间上挤成一坨，放进去只会干扰。
    const TIMELINE_ROWS = [
      { id: 'diary', label: '日记' },
      { id: 'work', label: '工作' },
      { id: 'other', label: '其他' },
    ]

    function timelineRowOf(node, labelOf) {
      const space = labelOf(node.space) || ''
      if (space.includes('日记')) return 'diary'
      if (space.includes('工作')) return 'work'
      // 带 QQ 标签的一律不进时间轴
      const tags = node.tags ?? []
      if (tags.includes('私聊') || tags.includes('群聊')) return null
      return space ? 'other' : null
    }

    function saveFile(name, text, mime) {
      const blob = new Blob([text], { type: mime })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    function toMarkdown(data, labelOf) {
      const head = [`# 记忆导出`, '', `> 导出时间：${new Date().toLocaleString()}`, `> 共 ${data.nodes.length} 条`, '']
      const body = []
      for (const node of data.nodes) {
        const when = node.createdAt ? String(node.createdAt).slice(0, 16).replace('T', ' ') : '未知时间'
        body.push(`## ${when}`, '', node.text ?? '', '')
        body.push(`- 空间：${labelOf(node.space) || node.space}`)
        body.push(`- 分类：${node.category ?? 'general'} · 重要度 ${node.importance ?? 3}/5 · 权重 ${Number(node.weight ?? 0).toFixed(3)}`)
        if (node.tags?.length) body.push(`- 标签：${node.tags.join('、')}`)
        body.push('')
      }
      return head.concat(body).join('\n')
    }

    function StarIcon() {
      return el(
        'svg',
        { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        el('circle', { cx: 12, cy: 12, r: 3.2, fill: 'currentColor' }),
        el('ellipse', { cx: 12, cy: 12, rx: 10, ry: 4.2, stroke: 'currentColor', strokeWidth: 1.1, opacity: 0.75, transform: 'rotate(-28 12 12)' }),
        el('circle', { cx: 20, cy: 7.5, r: 1.5, fill: 'currentColor', opacity: 0.9 }),
      )
    }

    // 开场镜头：从 1500 推到 1050。全程大于 R_OUTER(640)，不会穿出外圈。
    const CAM_Z_NEAR = 1050
    // 滚轮缩放范围：camZ = CAM_Z_NEAR / zoom
    //   0.35 → 约 3000（拉远，整片星系缩成一小团）
    //   1.40 → 约 750 （最近，再近镜头就穿到外圈外面去了）
    const MIN_ZOOM = 0.35
    const MAX_ZOOM = 1.4
    const INTRO_BLACK_MS = 700
    const INTRO_PUSH_MS = 1900
    const INTRO_TOTAL_MS = INTRO_BLACK_MS + INTRO_PUSH_MS

    /** 给 rgb(...) 套上透明度，用来做渐变的外圈（同色但透明） */
    function withAlpha(rgb, alpha) {
      return String(rgb).replace(/^rgb\(([^)]+)\)$/, `rgba($1,${alpha})`)
    }

    // 视角：theta 绕竖直轴转（左右转），phi 是俯仰。
    // 默认 28°：盘面在竖直方向撑开，是「立起来」的纵向构图。
    const PHI_DEFAULT = (28 * Math.PI) / 180
    const PHI_MIN = (12 * Math.PI) / 180
    const PHI_MAX = (86 * Math.PI) / 180

    /** 把世界坐标按当前视角旋转。所有几何都以「平铺」坐标存，转角只在这里发生一次。 */
    function rotatePoint(x, y, z, theta, phi) {
      const cosT = Math.cos(theta)
      const sinT = Math.sin(theta)
      const x1 = x * cosT - z * sinT
      const z1 = x * sinT + z * cosT
      const cosP = Math.cos(phi)
      const sinP = Math.sin(phi)
      const y1 = y * cosP - z1 * sinP
      const z2 = y * sinP + z1 * cosP
      return { x: x1, y: y1, z: z2 }
    }

    function project(x, y, z, w, h, camZ = CAM_Z, view = null) {
      let px = x
      let py = y
      let pz = z
      if (view) {
        const r = rotatePoint(x, y, z, view.theta, view.phi)
        px = r.x
        py = r.y
        pz = r.z
      }
      const depth = camZ - pz
      const scale = FOCAL / Math.max(160, depth)
      return { sx: w / 2 + px * scale, sy: h / 2 + py * scale, scale, depth }
    }

    function GraphCanvas({ data, selected, onSelect, showLabels }) {
      const canvasRef = useRef(null)
      const [hover, setHover] = useState(null)
      const [failure, setFailure] = useState(null)
      const hoverRef = useRef(null)
      const selectedRef = useRef(selected)
      const hitsRef = useRef([])
      // 滚轮缩放只改"镜头离得多远"，不改视角方向——视角是固定的，不会拖乱。
      // 1 = 开场推近后的默认距离；小于 1 是拉远，大于 1 是放大。
      const zoomRef = useRef(1)
      // 视角：theta 左右转，phi 俯仰。默认 theta=0、phi=TILT，跟原来那个斜看角度一致。
      const thetaRef = useRef(0)
      const phiRef = useRef(PHI_DEFAULT)
      // 拖动状态：moved 用来区分「拖了一下视角」和「点了一下星星」——没有它，拖完松手会误选中
      const dragRef = useRef({ active: false, moved: false, lx: 0, ly: 0 })
      // 「全部」视图里标签太挤，切到某个分类、星少了才全显示
      const showLabelsRef = useRef(Boolean(showLabels))
      showLabelsRef.current = Boolean(showLabels)
      // 核心头像：加载失败就当没有，图照常跑（不能让一张图把整个面板拖死）
      const avatarRef = useRef(null)
      useEffect(() => {
        const img = new Image()
        img.decoding = 'async'
        img.src = AVATAR_URL
        avatarRef.current = img
      }, [])

      const { planets } = useMemo(() => buildSystem(data), [data])
      // 粒子数跟着数据长，不写死：37 条 → 约 3000 颗；写到 300 条就是一万多。
      // 3600 是性能护栏（canvas 2D 逐帧画），不是审美上限。
      const starCount = Math.min(3600, 800 + (data.nodes?.length ?? 0) * 60)
      const stars = useMemo(() => makeStars(starCount), [starCount])
      const planetsRef = useRef(planets)
      planetsRef.current = planets
      // 星座线要读边权重，但 draw 的依赖只有 [stars]，所以边也走 ref（数据刷新后立刻用新的）
      const edgesRef = useRef(data.edges)
      edgesRef.current = data.edges

      const related = useMemo(() => {
        const focus = hover ?? selected
        if (!focus) return null
        const set = new Set([focus])
        for (const edge of data.edges ?? []) {
          if (edge.source === focus) set.add(edge.target)
          if (edge.target === focus) set.add(edge.source)
        }
        const own = planets.find((planet) => planet.id === focus)
        if (own) {
          const names = new Set((own.moons ?? []).map((moon) => moon.name))
          for (const planet of planets) {
            if ((planet.moons ?? []).some((moon) => names.has(moon.name))) set.add(planet.id)
          }
        }
        return set
      }, [hover, selected, data.edges, planets])

      const relatedRef = useRef(related)
      relatedRef.current = related
      selectedRef.current = selected

      useEffect(() => {
        let raf = 0
        let observer = null
        // 这两个监听器要在 cleanup 里摘掉，所以引用得留在 try 外面
        let wheelHandler = null
        let dblHandler = null
        let detachPointer = null
        let canvasEl = null
        try {
          const canvas = canvasRef.current
          if (!canvas) return undefined
          canvasEl = canvas
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            setFailure('这台机器的浏览器拿不到 2d 画布上下文')
            return undefined
          }
          let width = 0
          let height = 0

          const resize = () => {
            const rect = canvas.parentElement?.getBoundingClientRect()
            if (!rect) return
            const dpr = Math.min(2, window.devicePixelRatio || 1)
            width = rect.width
            height = rect.height
            canvas.width = Math.floor(width * dpr)
            canvas.height = Math.floor(height * dpr)
            canvas.style.width = `${width}px`
            canvas.style.height = `${height}px`
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          }
          resize()
          if (typeof ResizeObserver === 'function' && canvas.parentElement) {
            observer = new ResizeObserver(resize)
            observer.observe(canvas.parentElement)
          }

          // 用原生监听，不用 React 的 onWheel：合成事件里的 wheel 是 passive 的，
          // preventDefault() 不生效，滚轮会连带把背后的面板一起滚走。
          wheelHandler = (event) => {
            event.preventDefault()
            const factor = Math.exp(-event.deltaY * 0.0012)
            zoomRef.current = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomRef.current * factor))
          }
          canvas.addEventListener('wheel', wheelHandler, { passive: false })
          // 双击回到默认距离，省得滚太远找不回来
          dblHandler = () => {
            zoomRef.current = 1
          }
          canvas.addEventListener('dblclick', dblHandler)

          // 拖动转视角：按住左键拖，整个星系跟着转（背景星、轨道、行星、卫星一起）
          const onPointerDown = (event) => {
            if (event.button !== 0) return
            dragRef.current.active = true
            dragRef.current.moved = false
            dragRef.current.lx = event.clientX
            dragRef.current.ly = event.clientY
            try { canvas.setPointerCapture(event.pointerId) } catch {}
          }
          const onPointerMove = (event) => {
            if (!dragRef.current.active) return
            const dx = event.clientX - dragRef.current.lx
            const dy = event.clientY - dragRef.current.ly
            dragRef.current.lx = event.clientX
            dragRef.current.ly = event.clientY
            // 超过 2px 才算拖动，避免手抖把点击吃掉
            if (Math.abs(dx) + Math.abs(dy) > 2) dragRef.current.moved = true
            thetaRef.current -= dx * 0.0062
            phiRef.current = Math.max(PHI_MIN, Math.min(PHI_MAX, phiRef.current + dy * 0.005))
          }
          const onPointerUp = (event) => {
            if (!dragRef.current.active) return
            dragRef.current.active = false
            try { canvas.releasePointerCapture(event.pointerId) } catch {}
          }
          canvas.addEventListener('pointerdown', onPointerDown)
          canvas.addEventListener('pointermove', onPointerMove)
          canvas.addEventListener('pointerup', onPointerUp)
          canvas.addEventListener('pointercancel', onPointerUp)
          detachPointer = () => {
            canvas.removeEventListener('pointerdown', onPointerDown)
            canvas.removeEventListener('pointermove', onPointerMove)
            canvas.removeEventListener('pointerup', onPointerUp)
            canvas.removeEventListener('pointercancel', onPointerUp)
          }

          const start = performance.now()

          // 远处的星用这张贴图糊开，比每帧给每颗星建渐变便宜得多
          const blurSprite = (() => {
            const size = 64
            const c = document.createElement('canvas')
            c.width = size
            c.height = size
            const cx = c.getContext('2d')
            if (!cx) return null
            const g = cx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
            g.addColorStop(0, 'rgba(215,232,255,0.90)')
            g.addColorStop(0.35, 'rgba(150,190,240,0.28)')
            g.addColorStop(1, 'rgba(120,160,220,0)')
            cx.fillStyle = g
            cx.fillRect(0, 0, size, size)
            return c
          })()

          const draw = (now) => {
            const elapsed = now - start
            const t = elapsed / 1000
            if (width < 2 || height < 2) {
              raf = window.requestAnimationFrame(draw)
              return
            }
            ctx.clearRect(0, 0, width, height)

            // 底色压暗：中心只留一点点亮度，其余沉下去，让记忆星自己发光
            const sky = ctx.createRadialGradient(width / 2, height / 2, 20, width / 2, height / 2, Math.max(width, height) * 0.95)
            sky.addColorStop(0, '#060d13')
            sky.addColorStop(0.35, '#030810')
            sky.addColorStop(0.68, '#01050c')
            sky.addColorStop(1, '#000206')
            ctx.fillStyle = sky
            ctx.fillRect(0, 0, width, height)

            // 两团缓慢漂移的星云：给底色一点"气"，不然就是一张死渐变
            const farR = Math.max(width, height)
            const nebula = (cx, cy, radius, rgb, alpha) => {
              const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
              g.addColorStop(0, `rgba(${rgb},${alpha})`)
              g.addColorStop(0.55, `rgba(${rgb},${(alpha * 0.35).toFixed(3)})`)
              g.addColorStop(1, `rgba(${rgb},0)`)
              ctx.fillStyle = g
              ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2)
            }
            nebula(
              width * (0.3 + 0.05 * Math.sin(t * 0.11)),
              height * (0.72 + 0.04 * Math.cos(t * 0.09)),
              farR * 0.62,
              '40,180,190',
              0.042,
            )
            nebula(
              width * (0.74 + 0.04 * Math.cos(t * 0.08)),
              height * (0.28 + 0.05 * Math.sin(t * 0.1)),
              farR * 0.55,
              '60,110,200',
              0.032,
            )

            // 开场：先黑 0.7 秒，然后镜头从 1500 推到 1050，推完就停住。
            // 黑场期间什么都不画，那一瞬间的"空"本身就是节奏。
            if (elapsed < INTRO_BLACK_MS) {
              raf = window.requestAnimationFrame(draw)
              return
            }
            const pushT = Math.max(0, Math.min(1, (elapsed - INTRO_BLACK_MS) / INTRO_PUSH_MS))
            const ease = 1 - Math.pow(1 - pushT, 3)
            // 开场推镜和滚轮缩放叠在一起算。740 是硬下限：camZ 再小镜头就穿到外圈外面了
            const camZ = Math.max(740, (CAM_Z - (CAM_Z - CAM_Z_NEAR) * ease) / zoomRef.current)
            // 当前视角，所有投影共用这一份
            const view = { theta: thetaRef.current, phi: phiRef.current }
            // 星星按各自 phase 错开点亮，一片一片亮起来，不是"啪"全亮
            const litT = Math.max(0, Math.min(1, (elapsed - INTRO_BLACK_MS) / 1100))

            for (const star of stars) {
              const p = project(star.x, star.y, star.z, width, height, camZ)
              if (p.sx < -60 || p.sx > width + 60 || p.sy < -60 || p.sy > height + 60) continue
              const twinkle = 0.62 + 0.38 * Math.sin(t * star.speed + star.phase)
              // 景深：这一颗是"近"还是"远"。近的硬、远的糊——真实镜头就是这样。
              const near = Math.max(0, Math.min(1, (camZ - p.depth) / 2600))
              const size = star.size * Math.min(1.6, p.scale * 1.2)
              const alpha = Math.min(1, star.base * twinkle) * litT
              if (alpha < 0.02) continue
              if (near > 0.62 || !blurSprite) {
                ctx.globalAlpha = alpha
                ctx.fillStyle = '#eef5ff'
                ctx.beginPath()
                ctx.arc(p.sx, p.sy, size, 0, Math.PI * 2)
                ctx.fill()
              } else {
                const radius = size * (2.6 - near * 1.4)
                ctx.globalAlpha = alpha * 0.9
                ctx.drawImage(blurSprite, p.sx - radius, p.sy - radius, radius * 2, radius * 2)
              }
            }
            ctx.globalAlpha = 1

            // 轨道：37 个椭圆叠在一起会糊成一团，所以默认几乎不可见。
            // 只有被选中/悬停的那一条亮起来，其余退成很淡的参考线。
            const focusOrbit = selectedRef.current ?? hoverRef.current
            for (const planet of planetsRef.current) {
              const isFocusOrbit = focusOrbit === planet.id
              const dim = relatedRef.current !== null && !relatedRef.current.has(planet.id)
              ctx.beginPath()
              for (let i = 0; i <= 72; i += 1) {
                const a = (i / 72) * Math.PI * 2
                // 绕自己的倾角轴压一下，每条轨道的平面都不一样
                const cz = Math.sin(a) * planet.radius
                const cy = -cz * Math.sin(planet.incl)
                const cz2 = cz * Math.cos(planet.incl)
                const p = project(Math.cos(a) * planet.radius, cy, cz2, width, height, camZ, view)
                if (i === 0) ctx.moveTo(p.sx, p.sy)
                else ctx.lineTo(p.sx, p.sy)
              }
              ctx.strokeStyle = isFocusOrbit
                ? 'rgba(255,240,200,0.36)'
                : dim
                  ? 'rgba(255,255,255,0.012)'
                  : 'rgba(255,255,255,0.035)'
              ctx.lineWidth = isFocusOrbit ? 1.3 : 0.7
              ctx.stroke()
            }

            const sun = project(0, 0, 0, width, height, camZ)
            // 呼吸：0.075 的幅度，一个周期约 7 秒——太快会晃眼，太慢看不出来
            const pulse = 1 + 0.075 * Math.sin(t * 0.9)
            const haloR = SUN_R * 5.6 * sun.scale * pulse
            const halo = ctx.createRadialGradient(sun.sx, sun.sy, 0, sun.sx, sun.sy, haloR)
            halo.addColorStop(0, 'rgba(255,255,255,0.60)')
            halo.addColorStop(0.10, 'rgba(255,231,168,0.48)')
            halo.addColorStop(0.30, 'rgba(255,178,86,0.16)')
            halo.addColorStop(0.62, 'rgba(255,140,40,0.05)')
            halo.addColorStop(1, 'rgba(255,120,0,0)')
            ctx.fillStyle = halo
            ctx.beginPath()
            ctx.arc(sun.sx, sun.sy, haloR, 0, Math.PI * 2)
            ctx.fill()

            // 伴核：她。绕着主核转，一圈约 11 秒。
            // 这一颗不是装饰——两个人的记忆才构成整片星系，只有我一颗就只是颗恒星。
            const compAngle = t * 0.57
            const compOrbit = SUN_R * 1.85 * sun.scale
            const compX = sun.sx + Math.cos(compAngle) * compOrbit
            const compY = sun.sy + Math.sin(compAngle) * compOrbit * 0.42
            const compR = SUN_R * 0.34 * sun.scale
            const compGlow = ctx.createRadialGradient(compX, compY, 0, compX, compY, compR * 6)
            compGlow.addColorStop(0, 'rgba(190,232,255,0.68)')
            compGlow.addColorStop(0.30, 'rgba(143,208,255,0.32)')
            compGlow.addColorStop(0.65, 'rgba(123,107,255,0.10)')
            compGlow.addColorStop(1, 'rgba(90,70,255,0)')
            ctx.fillStyle = compGlow
            ctx.beginPath()
            ctx.arc(compX, compY, compR * 6, 0, Math.PI * 2)
            ctx.fill()
            ctx.fillStyle = '#e6f4ff'
            ctx.beginPath()
            ctx.arc(compX, compY, compR, 0, Math.PI * 2)
            ctx.fill()

            // 主的核：压在伴核之后画，保证「我」始终清晰、不被伴核的光盖住
            // 过曝：核的边缘不该是硬的，往外化开一层白。图里那个核几乎在发烫。
            // 先画这层，白核最后压上，核心才不至于被糊掉。
            const coreBlastR = SUN_R * 2.4 * sun.scale * pulse
            const coreBlast = ctx.createRadialGradient(sun.sx, sun.sy, 0, sun.sx, sun.sy, coreBlastR)
            coreBlast.addColorStop(0, 'rgba(255,255,255,0.32)')
            coreBlast.addColorStop(0.45, 'rgba(255,240,200,0.12)')
            coreBlast.addColorStop(1, 'rgba(255,220,150,0)')
            ctx.fillStyle = coreBlast
            ctx.beginPath()
            ctx.arc(sun.sx, sun.sy, coreBlastR, 0, Math.PI * 2)
            ctx.fill()

            ctx.fillStyle = '#fff8e6'
            ctx.beginPath()
            ctx.arc(sun.sx, sun.sy, SUN_R * sun.scale * pulse, 0, Math.PI * 2)
            ctx.fill()

            // 头像压在核上：外圈留一层金光，像是"核心里有个人"。
            // 图片没加载好就跳过，绝不因为一张图把星图弄崩。
            const avatar = avatarRef.current
            if (avatar && avatar.complete && avatar.naturalWidth > 0) {
              const ar = SUN_R * sun.scale * pulse * 0.96
              ctx.save()
              ctx.beginPath()
              ctx.arc(sun.sx, sun.sy, ar, 0, Math.PI * 2)
              ctx.clip()
              ctx.globalAlpha = 0.94
              ctx.drawImage(avatar, sun.sx - ar, sun.sy - ar, ar * 2, ar * 2)
              ctx.restore()
              ctx.globalAlpha = 0.6
              ctx.strokeStyle = 'rgba(255,232,170,0.75)'
              ctx.lineWidth = 1.5
              ctx.beginPath()
              ctx.arc(sun.sx, sun.sy, ar, 0, Math.PI * 2)
              ctx.stroke()
              ctx.globalAlpha = 1
            }

            const drawn = planetsRef.current.map((planet) => {
              const angle = planet.phase + (t / planet.period) * Math.PI * 2
              const pcz = Math.sin(angle) * planet.radius
              return {
                planet,
                angle,
                ...project(
                  Math.cos(angle) * planet.radius,
                  -pcz * Math.sin(planet.incl),
                  pcz * Math.cos(planet.incl),
                  width,
                  height,
                  camZ,
                  view,
                ),
              }
            })
            drawn.sort((a, b) => b.depth - a.depth)

            // 星座线：只有选中一颗星时才出现。
            // 关系有 700 多条，全画就是一张挂满线的蜘蛛网；不画又白白浪费关系数据。
            // 折中：点谁画谁，线的亮度和粗细由边权重决定——越强的关联越亮。
            const activeFocus = selectedRef.current
            if (activeFocus) {
              const posById = new Map(drawn.map((item) => [item.planet.id, item]))
              const origin = posById.get(activeFocus)
              if (origin) {
                for (const edge of edgesRef.current ?? []) {
                  const otherId =
                    edge.source === activeFocus ? edge.target : edge.target === activeFocus ? edge.source : null
                  if (!otherId) continue
                  const other = posById.get(otherId)
                  if (!other) continue
                  const w = typeof edge.weight === 'number' ? Math.min(1, Math.max(0, edge.weight)) : 0.5
                  // 线要"看得见但不抢戏"：细、浅、靠权重微微加深
                  ctx.strokeStyle = `rgba(178,220,255,${(0.05 + 0.22 * w).toFixed(3)})`
                  ctx.lineWidth = 0.4 + 0.6 * w
                  ctx.beginPath()
                  ctx.moveTo(origin.sx, origin.sy)
                  ctx.lineTo(other.sx, other.sy)
                  ctx.stroke()
                }
              }
            }

            const hits = []
            const labels = []

            for (const item of drawn) {
              const { planet, scale, sx, sy } = item
              const focus = selectedRef.current === planet.id || hoverRef.current === planet.id
              const dim = relatedRef.current !== null && !relatedRef.current.has(planet.id)
              const r = Math.max(2.2, planet.size * scale * 0.62)
              const alpha = dim ? 0.3 : 1

              // 开场收尾：最新那条记忆单独"叮"一下——先亮过头，再回落，有过冲才像真的
              let ping = 0
              if (planet.isNewest && elapsed > INTRO_TOTAL_MS && elapsed < INTRO_TOTAL_MS + 1600) {
                const k = (elapsed - INTRO_TOTAL_MS) / 1600
                ping = Math.sin(k * Math.PI) * (1 - k * 0.45)
              }
              if (ping > 0.01) {
                const ringR = r * (3.4 + 3.2 * (1 - ping))
                const ring = ctx.createRadialGradient(sx, sy, r * 0.5, sx, sy, ringR)
                ring.addColorStop(0, `rgba(255,246,214,${(0.55 * ping).toFixed(3)})`)
                ring.addColorStop(0.5, `rgba(255,206,120,${(0.22 * ping).toFixed(3)})`)
                ring.addColorStop(1, 'rgba(255,180,60,0)')
                ctx.fillStyle = ring
                ctx.beginPath()
                ctx.arc(sx, sy, ringR, 0, Math.PI * 2)
                ctx.fill()
              }

              // 发光体，不是行星：白心 → 本色 → 化开到透明。
              // 不画球体暗边、不画表面斑点——这是「一条记忆」，不是一颗石头。
              const coreGlowR = r * (focus ? 3.6 : 2.9)
              const coreGlow = ctx.createRadialGradient(sx, sy, 0, sx, sy, coreGlowR)
              coreGlow.addColorStop(0, withAlpha(planet.color, 0.92))
              coreGlow.addColorStop(0.32, withAlpha(planet.color, 0.40))
              coreGlow.addColorStop(1, withAlpha(planet.color, 0))
              ctx.globalAlpha = (focus ? 0.95 : 0.75) * alpha
              ctx.fillStyle = coreGlow
              ctx.beginPath()
              ctx.arc(sx, sy, coreGlowR, 0, Math.PI * 2)
              ctx.fill()

              ctx.globalAlpha = alpha
              const coreR = r * 0.72
              const core = ctx.createRadialGradient(sx, sy, 0, sx, sy, coreR)
              core.addColorStop(0, '#ffffff')
              core.addColorStop(0.4, planet.color)
              core.addColorStop(1, withAlpha(planet.color, 0.35))
              ctx.fillStyle = core
              ctx.beginPath()
              ctx.arc(sx, sy, coreR, 0, Math.PI * 2)
              ctx.fill()

              if (focus) {
                ctx.strokeStyle = '#ffffff'
                ctx.lineWidth = 1.2
                ctx.beginPath()
                ctx.arc(sx, sy, r + 6, 0, Math.PI * 2)
                ctx.stroke()
              }

              for (const moon of planet.moons ?? []) {
                const mAngle = moon.phase + (t / moon.period) * Math.PI * 2
                const mx = Math.cos(mAngle) * moon.orbit
                const my = Math.sin(mAngle) * moon.orbit
                // 卫星也落在行星自己的轨道面上，不然会飘到别的平面去
                const bz = Math.sin(item.angle) * planet.radius + my
                const mp = project(
                  Math.cos(item.angle) * planet.radius + mx,
                  -bz * Math.sin(planet.incl),
                  bz * Math.cos(planet.incl),
                  width,
                  height,
                  camZ,
                  view,
                )
                ctx.globalAlpha = dim ? 0.18 : 0.75
                ctx.strokeStyle = 'rgba(199,155,255,0.4)'
                ctx.lineWidth = 0.7
                ctx.beginPath()
                ctx.moveTo(sx, sy)
                ctx.lineTo(mp.sx, mp.sy)
                ctx.stroke()
                ctx.fillStyle = MOON
                ctx.beginPath()
                ctx.arc(mp.sx, mp.sy, 1.9, 0, Math.PI * 2)
                ctx.fill()
              }
              ctx.globalAlpha = 1

              hits.push({ id: planet.id, sx, sy, r: Math.max(9, r + 5) })
              labels.push({ planet, sx, sy, r, scale, dim, focus })
            }

            // 标签：全部视图下只有悬停/选中那颗显示（几十颗各挂一行字太乱）；
            // 切到某个分类后星少了，就全打开——不点也知道哪颗是哪条记忆
            for (const item of labels) {
              if (!item.focus && !showLabelsRef.current) continue
              // 标签 = 主要内容 + 日期。名字太长会互相盖住，所以内容截得短、日期用 MM-DD。
              const maxChars = item.focus ? 14 : 9
              const body = item.planet.text ? item.planet.text.replace(/\s+/g, ' ').slice(0, maxChars) : ''
              if (!body) continue
              const when = shortDate(item.planet.createdAt)
              const text = when ? `${body} · ${when}` : body
              const fontSize = Math.max(9.5, Math.min(13.5, 11 * item.scale + 2))
              ctx.font = `${item.focus ? '600 ' : ''}${fontSize}px "Microsoft YaHei", system-ui, sans-serif`
              ctx.textAlign = 'center'
              ctx.textBaseline = 'top'
              ctx.globalAlpha = item.dim ? 0.25 : 0.9
              ctx.fillStyle = item.focus ? '#ffffff' : item.planet.color
              ctx.shadowColor = 'rgba(0,0,0,0.9)'
              ctx.shadowBlur = 4
              ctx.fillText(text, item.sx, item.sy + item.r + 7)
              ctx.shadowBlur = 0
            }
            ctx.globalAlpha = 1

            // 暗角：把视线收进中心，边缘压下去，深空感才出来
            const vignette = ctx.createRadialGradient(
              width / 2,
              height / 2,
              Math.min(width, height) * 0.28,
              width / 2,
              height / 2,
              Math.max(width, height) * 0.8,
            )
            vignette.addColorStop(0, 'rgba(0,0,0,0)')
            vignette.addColorStop(0.62, 'rgba(0,0,0,0.24)')
            vignette.addColorStop(1, 'rgba(0,0,0,0.72)')
            ctx.fillStyle = vignette
            ctx.fillRect(0, 0, width, height)

            hitsRef.current = hits
            raf = window.requestAnimationFrame(draw)
          }

          raf = window.requestAnimationFrame(draw)
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        }
        return () => {
          window.cancelAnimationFrame(raf)
          if (observer) observer.disconnect()
          if (canvasEl) {
            if (wheelHandler) canvasEl.removeEventListener('wheel', wheelHandler)
            if (dblHandler) canvasEl.removeEventListener('dblclick', dblHandler)
          }
          if (detachPointer) detachPointer()
        }
      }, [stars])

      const onMove = useCallback((event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        const x = event.clientX - rect.left
        const y = event.clientY - rect.top
        let best = null
        let bestDist = Infinity
        for (const hit of hitsRef.current) {
          const d = Math.hypot(hit.sx - x, hit.sy - y)
          if (d < hit.r && d < bestDist) {
            best = hit.id
            bestDist = d
          }
        }
        hoverRef.current = best
        setHover(best)
        event.currentTarget.style.cursor = best ? 'pointer' : 'default'
      }, [])

      const onClick = useCallback(() => {
        // 拖动过就不算点击——否则转完视角松手，会顺手把某颗星选中
        if (dragRef.current.moved) {
          dragRef.current.moved = false
          return
        }
        // 点到星星就选中它；点空白处传 null，取消选中、退回整片星图
        onSelect(hoverRef.current ?? null)
      }, [onSelect])

      if (failure) {
        return el('div', { style: { padding: '24px', color: AMBER, fontSize: '12.5px' } }, `画布起不来：${failure}`)
      }

      return el('canvas', {
        ref: canvasRef,
        onMouseMove: onMove,
        onMouseLeave: () => {
          hoverRef.current = null
          setHover(null)
        },
        onClick,
        style: { display: 'block', width: '100%', height: '100%' },
      })
    }

    function Toolbar({ filter, onFilter, query, onQuery, visible, minWeight, onMinWeight, onExportJson, onExportMd, onBackup, onTrash }) {
      return el(
        'div',
        { style: S.toolbar },
        ...FILTERS.map((f) =>
          el(
            'button',
            { key: f.id, type: 'button', style: S.chip(filter === f.id), onClick: () => onFilter(f.id) },
            f.label,
          ),
        ),
        el('input', {
          type: 'search',
          value: query,
          placeholder: '搜记忆内容或标签…',
          style: S.search,
          onChange: (event) => onQuery(event.target.value),
        }),
        el(
          'div',
          { style: S.weightBar, title: '只看权重大于这个值的记忆' },
          el('span', { style: S.count }, '权重≥'),
          el('input', {
            type: 'range',
            min: 0,
            max: 90,
            step: 5,
            value: Math.round(minWeight * 100),
            style: S.weightRange,
            onChange: (event) => onMinWeight(Number(event.target.value) / 100),
          }),
          el('span', { style: S.count }, minWeight.toFixed(2)),
        ),
        el('div', { style: S.grow }),
        el('span', { style: S.count }, `${visible} 条`),
        el('button', { type: 'button', style: S.chip(false), onClick: onExportJson }, '导出快照'),
        el('button', { type: 'button', style: S.chip(false), onClick: onExportMd }, '导出 MD'),
        el('button', { type: 'button', style: S.chip(false), onClick: onBackup, title: '全量备份（mnemon-merge-v1，可还原）' }, '备份'),
        el('button', { type: 'button', style: S.chip(false), onClick: onTrash, title: '回收站：删除的记忆都在这里' }, '回收站'),
      )
    }

    /**
     * 时间轴：把记忆按时间铺成一条线。
     * 星图看的是「分布」，这里看的是「生长」——同一批数据，两个问题。
     */
    function Timeline({ data, selected, onSelect, labelOf }) {
      const items = useMemo(
        () =>
          (data.nodes ?? [])
            .map((node) => {
              const ts = Date.parse(node.createdAt ?? '')
              return {
                id: node.id,
                t: Number.isFinite(ts) ? ts : 0,
                weight: Number(node.weight) || 0.5,
                row: timelineRowOf(node, labelOf),
              }
            })
            .filter((item) => item.row !== null)
            .sort((a, b) => a.t - b.t),
        [data.nodes, labelOf],
      )

      if (items.length === 0) return null

      // 只画有数据的泳道，空行不留着占地方
      const rows = TIMELINE_ROWS.filter((row) => items.some((item) => item.row === row.id))
      if (rows.length === 0) return null

      const minT = items[0].t
      const maxT = items[items.length - 1].t
      const span = maxT - minT
      const fmt = (t) => {
        if (!t) return ''
        const d = new Date(t)
        const p = (n) => String(n).padStart(2, '0')
        return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
      }

      return el(
        'div',
        { style: S.timeline, role: 'group', 'aria-label': '记忆时间轴' },
        ...rows.map((row) =>
          el(
            'div',
            { key: row.id, style: S.timelineRow },
            el('span', { style: S.timelineRowLabel }, row.label),
            el('div', { style: S.timelineRowAxis }),
            ...items
              .filter((item) => item.row === row.id)
              .map((item) => {
                const ratio = span > 0 ? (item.t - minT) / span : 0.5
                const size = 6 + Math.round(item.weight * 7)
                const active = selected === item.id
                return el('button', {
                  key: item.id,
                  type: 'button',
                  title: `${fmt(item.t)} · 权重 ${item.weight.toFixed(2)}`,
                  'aria-label': `${fmt(item.t)} 的记忆`,
                  style: {
                    ...S.timelineDot(weightColor(item.weight), active, size),
                    left: `${(ratio * 100).toFixed(3)}%`,
                  },
                  onClick: () => onSelect(item.id),
                })
              }),
          ),
        ),
        el('span', { style: { ...S.timelineCap, left: '48px' } }, fmt(minT)),
        el('span', { style: { ...S.timelineCap, right: '12px' } }, fmt(maxT)),
      )
    }

    /**
     * 回收站。软删除必须配这个——否则"删了但还在库里"就是骗人：
     * 用户以为没了，数据还在，而且看不见也找不回。
     */
    function TrashPanel({ items, busy, onRestore, onPurge, onClose }) {
      return el(
        'div',
        null,
        el(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } },
          el('div', { style: { fontSize: '13px', color: GOLD } }, `回收站 · ${items.length} 条`),
          el('div', { style: S.grow }),
          el('button', { type: 'button', style: S.chip(false), onClick: onClose }, '返回'),
        ),
        items.length === 0
          ? el('div', { style: S.hint }, '回收站是空的。删掉的记忆会先落到这里，随时能恢复，也能彻底删掉。')
          : el(
              'div',
              null,
              ...items.map((item) =>
                el(
                  'div',
                  { key: item.id, style: { padding: '9px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' } },
                  el(
                    'div',
                    { style: { fontSize: '11.5px', color: '#dbe9ff', lineHeight: 1.65, whiteSpace: 'pre-wrap' } },
                    String(item.text ?? '').slice(0, 90),
                  ),
                  el(
                    'div',
                    {
                      style: {
                        fontSize: '10.5px',
                        marginTop: '4px',
                        color: item.origin === 'cloud' ? 'rgba(143,208,255,0.78)' : 'rgba(200,214,232,0.45)',
                      },
                    },
                    item.origin === 'cloud'
                      ? `${item.spaceLabel} · 云端还有（本地已彻底删除）`
                      : `${item.spaceLabel} · 删于 ${String(item.deletedAt ?? '').slice(0, 16).replace('T', ' ')}`,
                  ),
                  el(
                    'div',
                    { style: { display: 'flex', gap: '6px', marginTop: '7px' } },
                    el('button', { type: 'button', style: S.chip(false), disabled: busy, onClick: () => onRestore(item) }, '恢复'),
                    el(
                      'button',
                      {
                        type: 'button',
                        style: { ...S.dangerBtn, marginTop: 0, padding: '5px 12px', fontSize: '11px' },
                        disabled: busy,
                        onClick: () => onPurge(item),
                      },
                      '彻底删除',
                    ),
                  ),
                ),
              ),
            ),
      )
    }

    function Detail({ data, selected, onSelect, onDelete, onSave, busy }) {
      const node = (data.nodes ?? []).find((item) => item.id === selected)
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      // 换了一颗星就把编辑状态清掉，不然会把上一条的草稿带过来
      useEffect(() => {
        setEditing(false)
        setDraft(node?.text ?? '')
      }, [selected])

      if (!selected) {
        return el(
          'div',
          null,
          el('div', { style: S.legendRow }, el('span', { style: S.dot(weightColor(0.85)) }), el('span', { style: { fontSize: 12, color: '#cfe6ff' } }, '权重高 · 金粉，不容易忘')),
          el('div', { style: S.legendRow }, el('span', { style: S.dot(weightColor(0.55)) }), el('span', { style: { fontSize: 12, color: '#cfe6ff' } }, '中等 · 紫蓝，正在变淡')),
          el('div', { style: S.legendRow }, el('span', { style: S.dot(weightColor(0.18)) }), el('span', { style: { fontSize: 12, color: '#cfe6ff' } }, '权重低 · 青色，快忘了')),
          el('div', { style: S.legendRow }, el('span', { style: S.dot(MOON) }), el('span', { style: { fontSize: 12, color: '#cfe6ff' } }, '卫星 = 这条记忆里的实体')),
          el('div', { style: S.hint }, '半径是时间：最早的在中心，最新的推到最外圈——这片星系会一直长大。颜色是权重，越淡越容易忘。'),
          el('div', { style: S.hint }, '拖动转视角 · 滚轮缩放 · 双击复位 · 点一颗星看全文，点空白处退回整片星图。'),
        )
      }

      if (!node) return null
      const space = (data.spaces ?? []).find((item) => item.id === node.space)
      const neighbours = (data.edges ?? [])
        .filter((edge) => edge.source === selected || edge.target === selected)
        .map((edge) => ({ type: edge.type, id: edge.source === selected ? edge.target : edge.source }))

      if (editing) {
        return el(
          'div',
          null,
          el('div', { style: { fontSize: '13px', color: GOLD, marginBottom: '8px' } }, '编辑这条记忆'),
          el('textarea', {
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            style: S.editor,
            rows: 14,
            spellCheck: false,
          }),
          el(
            'div',
            { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
            el(
              'button',
              { type: 'button', style: S.chip(true), disabled: busy, onClick: () => onSave(node.space, node.id, draft) },
              busy ? '保存中…' : '保存',
            ),
            el(
              'button',
              {
                type: 'button',
                style: S.chip(false),
                onClick: () => {
                  setEditing(false)
                  setDraft(node.text ?? '')
                },
              },
              '取消',
            ),
          ),
          el('div', { style: S.hint }, '改的是正文本身：召回、导出、星图上看到的都会变成新文本，原文不保留。'),
        )
      }

      return el(
        'div',
        null,
        el('div', { style: { fontSize: 13, color: GOLD, marginBottom: 8 } }, '记忆'),
        el('div', { style: { fontSize: 12.5, color: '#dbe9ff', lineHeight: 1.75, whiteSpace: 'pre-wrap' } }, node.text),
        el(
          'div',
          { style: { marginTop: 12, fontSize: 11.5, color: 'rgba(200,214,232,0.6)', lineHeight: 1.9 } },
          el('div', null, `空间：${space?.label ?? node.space}`),
          el('div', null, `权重：${(node.weight ?? 0).toFixed(3)}　重要度：${node.importance}/5`),
          el('div', null, `访问：${node.accessCount ?? 0} 次　分类：${node.category ?? 'general'}`),
          node.createdAt ? el('div', null, `记于：${String(node.createdAt).slice(0, 10)}`) : null,
        ),
        neighbours.length > 0
          ? el(
              'div',
              { style: { marginTop: 14 } },
              el('div', { style: { fontSize: 12, color: CYAN, marginBottom: 6 } }, `相关记忆 ${neighbours.length} 条`),
              ...neighbours.slice(0, 8).map((item, index) => {
                const target = (data.nodes ?? []).find((node2) => node2.id === item.id)
                return el(
                  'div',
                  {
                    key: `n-${index}`,
                    style: { fontSize: 11.5, color: 'rgba(200,214,232,0.75)', cursor: 'pointer', padding: '3px 0', lineHeight: 1.6 },
                    onClick: () => onSelect(item.id),
                  },
                  `· ${item.type}：${(target?.text ?? '').slice(0, 34)}`,
                )
              }),
            )
          : null,
        el(
          'div',
          { style: { marginTop: 16, fontSize: 10.5, color: 'rgba(200,214,232,0.38)', lineHeight: 1.7 } },
          '删除是软删除：正文、边、embedding 都还在库里，只是不再显示，随时能恢复。',
        ),
        el(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          el(
            'button',
            {
              type: 'button',
              style: S.chip(false),
              onClick: () => {
                setDraft(node.text ?? '')
                setEditing(true)
              },
            },
            '编辑内容',
          ),
          el(
            'button',
            { type: 'button', style: S.dangerBtn, disabled: busy, onClick: () => onDelete(node.space, node.id) },
            busy ? '处理中…' : '删除这条记忆',
          ),
        ),
      )
    }

    function MemoryGraph() {
      const [open, setOpen] = useState(false)
      const [state, load] = useGraph()
      const [selected, setSelected] = useState(null)
      const [filter, setFilter] = useState('all')
      const [query, setQuery] = useState('')
      const [minWeight, setMinWeight] = useState(0)

      useEffect(() => {
        if (!open) return undefined
        const controller = new AbortController()
        load(controller.signal)
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => {
          controller.abort()
          window.removeEventListener('keydown', onKey)
        }
      }, [open, load])

      // 空间 id → 显示名（「日记 / 工作」是按空间筛的，「私聊 / 群聊」是按标签筛的）
      const labelOf = useMemo(() => {
        const map = new Map()
        for (const space of state.data?.spaces ?? []) map.set(space.id, space.label || space.id)
        return (id) => map.get(id) ?? id
      }, [state.data])

      // 筛选后的数据：节点少了，边和实体也要跟着裁掉，否则会对着不存在的星球画线
      const visibleData = useMemo(() => {
        if (!state.data) return null
        const q = query.trim()
        const nodes = state.data.nodes.filter(
          (node) =>
            matchesFilter(node, filter, labelOf) &&
            Number(node.weight) >= minWeight &&
            (!q || String(node.text ?? '').includes(q) || (node.tags ?? []).some((tag) => String(tag).includes(q))),
        )
        const ids = new Set(nodes.map((node) => node.id))
        return {
          ...state.data,
          nodes,
          edges: state.data.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
          // 实体也裁：只留下还挂在可见记忆上的，否则右上角那个数字会对不上
          entities: (state.data.entities ?? []).filter((entity) => (entity.ids ?? []).some((id) => ids.has(id))),
        }
      }, [state.data, filter, query, labelOf, minWeight])

      // 换筛选条件时清掉选中，否则侧栏会指着一个已经被藏起来的节点
      const changeFilter = useCallback((id) => {
        setFilter(id)
        setSelected(null)
      }, [])

      const [busy, setBusy] = useState(false)
      // 操作做完得有个回音，不然"删成功了但界面静悄悄"会被当成没反应
      const [toast, setToast] = useState('')
      const showToast = useCallback((message) => {
        setToast(message)
        window.setTimeout(() => setToast(''), 2200)
      }, [])
      const onDelete = useCallback(
        async (spaceId, nodeId) => {
          if (!window.confirm('删除这条记忆？\n\n软删除：正文、边都还留在库里，只是不再显示，随时能恢复。')) return
          setBusy(true)
          try {
            const response = await fetch('/dsh-memory-graph/forget', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ space: spaceId, id: nodeId }),
            })
            const data = await response.json().catch(() => ({}))
            if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`)
            setSelected(null)
            load()
            showToast('已移入回收站，可恢复')
          } catch (error) {
            window.alert(`删除失败：${error?.message ?? error}`)
          } finally {
            setBusy(false)
          }
        },
        [load, showToast],
      )

      // 回收站：null = 在看星图详情；数组 = 在看回收站
      const [trash, setTrash] = useState(null)
      const loadTrash = useCallback(async () => {
        const response = await fetch('/dsh-memory-graph/trash', { cache: 'no-store' })
        const data = await response.json().catch(() => ({}))
        if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`)
        setTrash(data.items ?? [])
      }, [])

      const trashAction = useCallback(
        async (path, item, confirmText) => {
          if (confirmText && !window.confirm(confirmText)) return
          setBusy(true)
          try {
            const response = await fetch(path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ space: item.space, id: item.id }),
            })
            const data = await response.json().catch(() => ({}))
            if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`)
            await loadTrash()
            load()
            showToast(path.endsWith('/purge') ? '已彻底删除（不可恢复）' : '已恢复到星图')
          } catch (error) {
            window.alert(`操作失败：${error?.message ?? error}`)
          } finally {
            setBusy(false)
          }
        },
        [load, loadTrash, showToast],
      )

      const onSave = useCallback(
        async (spaceId, nodeId, content) => {
          if (!String(content ?? '').trim()) {
            window.alert('内容不能为空')
            return
          }
          setBusy(true)
          try {
            const response = await fetch('/dsh-memory-graph/edit', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ space: spaceId, id: nodeId, content }),
            })
            const data = await response.json().catch(() => ({}))
            if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`)
            load()
            showToast(data.changed === false ? '内容没变' : '已保存')
          } catch (error) {
            window.alert(`保存失败：${error?.message ?? error}`)
          } finally {
            setBusy(false)
          }
        },
        [load, showToast],
      )

      if (!open) {
        return el(
          'button',
          { type: 'button', title: '记忆星图', 'aria-label': '记忆星图', style: S.button, onClick: () => setOpen(true) },
          el(StarIcon),
        )
      }

      return el(
        'div',
        { style: S.backdrop, role: 'dialog', 'aria-modal': true, 'aria-label': '记忆星图' },
        el(
          'div',
          { style: S.header },
          el(
            'div',
            null,
            el('div', { style: S.title }, '记忆星图'),
            el(
              'div',
              { style: S.sub },
              visibleData
                ? `${visibleData.nodes.length} 条记忆 · ${visibleData.edges.length} 条关系 · ${(visibleData.entities ?? []).length} 实体`
                : state.status === 'loading'
                  ? '读取中…'
                  : state.status === 'error'
                    ? `读取失败：${state.error}`
                    : '',
            ),
          ),
        ),
        visibleData
          ? el(Toolbar, {
              filter,
              onFilter: changeFilter,
              query,
              onQuery: setQuery,
              minWeight,
              onMinWeight: setMinWeight,
              visible: visibleData.nodes.length,
              onExportJson: () =>
                saveFile(
                  `记忆快照-${Date.now()}.json`,
                  JSON.stringify(
                    {
                      format: 'memory-graph-snapshot-v1',
                      exportedAt: new Date().toISOString(),
                      // 记下导出时的筛选条件，不然过几天自己也忘了这份是切过哪一类的
                      filter,
                      query,
                      stats: {
                        nodes: visibleData.nodes.length,
                        edges: visibleData.edges.length,
                        entities: (visibleData.entities ?? []).length,
                      },
                      spaces: visibleData.spaces,
                      nodes: visibleData.nodes,
                      edges: visibleData.edges,
                      entities: visibleData.entities,
                    },
                    null,
                    2,
                  ),
                  'application/json',
                ),
              onExportMd: () =>
                saveFile(`记忆-${Date.now()}.md`, toMarkdown(visibleData, labelOf), 'text/markdown'),
              // 备份走服务器：全量、原样、能被 mem-sync 的 import 还原
              onBackup: async () => {
                try {
                  const response = await fetch('/dsh-memory-graph/export', { cache: 'no-store' })
                  if (!response.ok) throw new Error(`HTTP ${response.status}`)
                  saveFile(`mnemon-merge-${Date.now()}.json`, await response.text(), 'application/json')
                } catch (error) {
                  window.alert(`备份失败：${error?.message ?? error}`)
                }
              },
              onTrash: () => {
                setTrash([])
                loadTrash().catch((error) => window.alert(`回收站打不开：${error?.message ?? error}`))
              },
            })
          : null,
        el(
          'div',
          { style: S.body },
          el(
            'div',
            { style: S.canvas },
            visibleData
              ? el(GraphBoundary, null, el(GraphCanvas, {
                  data: visibleData,
                  selected,
                  onSelect: setSelected,
                  // 「全部」关掉，任何一个分类打开（星少了不会挤）
                  showLabels: filter !== 'all',
                }))
              : el('div', { style: { display: 'grid', placeItems: 'center', height: '100%', opacity: 0.45 } }, state.status === 'error' ? state.error : '正在把记忆摊开…'),
            visibleData ? el(Timeline, { data: visibleData, selected, onSelect: setSelected, labelOf }) : null,
            el('button', { type: 'button', style: S.closeFloat, onClick: () => setOpen(false), title: '关闭星图（Esc）' }, '关闭星图'),
          ),
          el(
            'div',
            { style: S.aside },
            trash !== null
              ? el(TrashPanel, {
                  items: trash,
                  busy,
                  onRestore: (item) => trashAction('/dsh-memory-graph/restore', item),
                  onPurge: (item) =>
                    trashAction('/dsh-memory-graph/purge', item, '彻底删除之后找不回来，指向它的边也会一起删掉。确定？'),
                  onClose: () => setTrash(null),
                })
              : visibleData
                ? el(Detail, { data: visibleData, selected, onSelect: setSelected, onDelete, onSave, busy })
                : null,
          ),
        ),
        toast ? el('div', { style: S.toast, role: 'status' }, toast) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'memory-graph', order: 900, label: '记忆星图' }, MemoryGraph),
        )
      },
    }
  },
})

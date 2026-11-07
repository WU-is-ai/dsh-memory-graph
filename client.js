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
    const SUN_R = 46

    function weightColor(weight) {
      if (weight >= 0.72) return GOLD
      if (weight >= 0.45) return AMBER
      return VIOLET
    }

    function makeStars(count) {
      let seed = 20261107
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
      }
      const stars = []
      for (let i = 0; i < count; i += 1) {
        const a = rnd() * Math.PI * 2
        const r = 260 + rnd() * 1800
        stars.push({
          x: Math.cos(a) * r,
          y: (rnd() - 0.5) * 1500,
          z: Math.sin(a) * r,
          size: 0.6 + rnd() * 1.6,
          base: 0.25 + rnd() * 0.6,
          phase: rnd() * Math.PI * 2,
          speed: 0.6 + rnd() * 1.8,
        })
      }
      return stars
    }

    function buildSystem(data) {
      const nodes = data.nodes ?? []
      const planets = nodes
        .map((node, index) => {
          const weight = typeof node.weight === 'number' ? node.weight : 0.5
          const radius = R_INNER + (1 - weight) * (R_OUTER - R_INNER)
          const period = 26 + ((radius - R_INNER) / (R_OUTER - R_INNER)) * 96
          return {
            ...node,
            weight,
            color: weightColor(weight),
            radius,
            period,
            phase: (index * 2.399963) % (Math.PI * 2),
            size: 5 + Math.min(5, Number(node.importance) || 3) * 1.5,
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

    function project(x, y, z, w, h) {
      const depth = CAM_Z - z
      const scale = FOCAL / Math.max(160, depth)
      return { sx: w / 2 + x * scale, sy: h / 2 + y * scale, scale, depth }
    }

    function GraphCanvas({ data, selected, onSelect }) {
      const canvasRef = useRef(null)
      const [hover, setHover] = useState(null)
      const [failure, setFailure] = useState(null)
      const hoverRef = useRef(null)
      const selectedRef = useRef(selected)
      const hitsRef = useRef([])

      const { planets } = useMemo(() => buildSystem(data), [data])
      const stars = useMemo(() => makeStars(260), [])
      const planetsRef = useRef(planets)
      planetsRef.current = planets

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
        try {
          const canvas = canvasRef.current
          if (!canvas) return undefined
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

          const start = performance.now()

          const draw = (now) => {
            const t = (now - start) / 1000
            if (width < 2 || height < 2) {
              raf = window.requestAnimationFrame(draw)
              return
            }
            ctx.clearRect(0, 0, width, height)

            const sky = ctx.createRadialGradient(width / 2, height / 2, 40, width / 2, height / 2, Math.max(width, height) * 0.8)
            sky.addColorStop(0, '#080d18')
            sky.addColorStop(0.55, '#03050b')
            sky.addColorStop(1, '#000000')
            ctx.fillStyle = sky
            ctx.fillRect(0, 0, width, height)

            for (const star of stars) {
              const p = project(star.x, star.y, star.z, width, height)
              if (p.sx < -40 || p.sx > width + 40 || p.sy < -40 || p.sy > height + 40) continue
              const twinkle = 0.62 + 0.38 * Math.sin(t * star.speed + star.phase)
              ctx.globalAlpha = Math.min(1, star.base * twinkle)
              ctx.fillStyle = '#e8f1ff'
              ctx.beginPath()
              ctx.arc(p.sx, p.sy, star.size * Math.min(1.5, p.scale * 1.1), 0, Math.PI * 2)
              ctx.fill()
            }
            ctx.globalAlpha = 1

            for (const planet of planetsRef.current) {
              const dim = relatedRef.current !== null && !relatedRef.current.has(planet.id)
              ctx.beginPath()
              for (let i = 0; i <= 72; i += 1) {
                const a = (i / 72) * Math.PI * 2
                const yy = Math.sin(a) * planet.radius
                const p = project(Math.cos(a) * planet.radius, yy * Math.sin(TILT), yy * Math.cos(TILT), width, height)
                if (i === 0) ctx.moveTo(p.sx, p.sy)
                else ctx.lineTo(p.sx, p.sy)
              }
              ctx.strokeStyle = dim ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.12)'
              ctx.lineWidth = 1
              ctx.stroke()
            }

            const sun = project(0, 0, 0, width, height)
            const pulse = 1 + 0.04 * Math.sin(t * 1.6)
            const halo = ctx.createRadialGradient(sun.sx, sun.sy, 0, sun.sx, sun.sy, SUN_R * 5.2 * sun.scale * pulse)
            halo.addColorStop(0, 'rgba(255,255,255,0.95)')
            halo.addColorStop(0.18, 'rgba(255,217,138,0.75)')
            halo.addColorStop(0.45, 'rgba(255,159,67,0.22)')
            halo.addColorStop(1, 'rgba(255,120,0,0)')
            ctx.fillStyle = halo
            ctx.beginPath()
            ctx.arc(sun.sx, sun.sy, SUN_R * 5.2 * sun.scale * pulse, 0, Math.PI * 2)
            ctx.fill()
            ctx.fillStyle = '#fff8e6'
            ctx.beginPath()
            ctx.arc(sun.sx, sun.sy, SUN_R * sun.scale, 0, Math.PI * 2)
            ctx.fill()

            const drawn = planetsRef.current.map((planet) => {
              const angle = planet.phase + (t / planet.period) * Math.PI * 2
              const yy = Math.sin(angle) * planet.radius
              return {
                planet,
                angle,
                ...project(Math.cos(angle) * planet.radius, yy * Math.sin(TILT), yy * Math.cos(TILT), width, height),
              }
            })
            drawn.sort((a, b) => b.depth - a.depth)

            const hits = []
            const labels = []

            for (const item of drawn) {
              const { planet, scale, sx, sy } = item
              const focus = selectedRef.current === planet.id || hoverRef.current === planet.id
              const dim = relatedRef.current !== null && !relatedRef.current.has(planet.id)
              const r = Math.max(2.2, planet.size * scale * 0.62)
              const alpha = dim ? 0.3 : 1

              const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 5.5)
              glow.addColorStop(0, planet.color)
              glow.addColorStop(1, 'rgba(0,0,0,0)')
              ctx.globalAlpha = (focus ? 0.55 : 0.28) * alpha
              ctx.fillStyle = glow
              ctx.beginPath()
              ctx.arc(sx, sy, r * 5.5, 0, Math.PI * 2)
              ctx.fill()

              ctx.globalAlpha = alpha
              const body = ctx.createRadialGradient(sx - r * 0.35, sy - r * 0.35, r * 0.2, sx, sy, r)
              body.addColorStop(0, '#ffffff')
              body.addColorStop(0.35, planet.color)
              body.addColorStop(1, 'rgba(0,0,0,0.65)')
              ctx.fillStyle = body
              ctx.beginPath()
              ctx.arc(sx, sy, r, 0, Math.PI * 2)
              ctx.fill()

              if (focus) {
                ctx.strokeStyle = '#ffffff'
                ctx.lineWidth = 1.4
                ctx.beginPath()
                ctx.arc(sx, sy, r + 5, 0, Math.PI * 2)
                ctx.stroke()
              }

              for (const moon of planet.moons ?? []) {
                const mAngle = moon.phase + (t / moon.period) * Math.PI * 2
                const mx = Math.cos(mAngle) * moon.orbit
                const my = Math.sin(mAngle) * moon.orbit
                const mp = project(
                  Math.cos(item.angle) * planet.radius + mx,
                  Math.sin(item.angle) * planet.radius * Math.sin(TILT) + my * Math.sin(TILT),
                  Math.sin(item.angle) * planet.radius * Math.cos(TILT) + my * Math.cos(TILT),
                  width,
                  height,
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

            for (const item of labels) {
              const text = item.planet.text ? item.planet.text.replace(/\s+/g, ' ').slice(0, 16) : ''
              if (!text) continue
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
        if (hoverRef.current) onSelect(hoverRef.current)
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

    function Detail({ data, selected, onSelect }) {
      if (!selected) {
        return el(
          'div',
          null,
          el('div', { style: S.legendRow }, el('span', { style: S.dot(GOLD) }), el('span', { style: { fontSize: 12, color: '#cfe6ff' } }, '权重 ≥ 0.72 · 不容易忘，内圈')),
          el('div', { style: S.legendRow }, el('span', { style: S.dot(AMBER) }), el('span', { style: { fontSize: 12, color: '#cfe6ff' } }, '0.45 – 0.72 · 正在变淡')),
          el('div', { style: S.legendRow }, el('span', { style: S.dot(VIOLET) }), el('span', { style: { fontSize: 12, color: '#cfe6ff' } }, '< 0.45 · 快忘了，外圈')),
          el('div', { style: S.legendRow }, el('span', { style: S.dot(MOON) }), el('span', { style: { fontSize: 12, color: '#cfe6ff' } }, '卫星 = 这条记忆里的实体')),
          el('div', { style: S.hint }, '轨道是斜着看的，近处大、远处小。点一颗行星看内容；鼠标停在行星上，同实体的会一起亮。'),
        )
      }

      const node = (data.nodes ?? []).find((item) => item.id === selected)
      if (!node) return null
      const space = (data.spaces ?? []).find((item) => item.id === node.space)
      const neighbours = (data.edges ?? [])
        .filter((edge) => edge.source === selected || edge.target === selected)
        .map((edge) => ({ type: edge.type, id: edge.source === selected ? edge.target : edge.source }))

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
      )
    }

    function MemoryGraph() {
      const [open, setOpen] = useState(false)
      const [state, load] = useGraph()
      const [selected, setSelected] = useState(null)

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
              state.status === 'ready'
                ? `${state.data.stats.memories} 条记忆 · ${state.data.stats.edges} 条关系 · ${state.data.stats.entities} 实体`
                : state.status === 'loading'
                  ? '读取中…'
                  : state.status === 'error'
                    ? `读取失败：${state.error}`
                    : '',
            ),
          ),
        ),
        el(
          'div',
          { style: S.body },
          el(
            'div',
            { style: S.canvas },
            state.status === 'ready'
              ? el(GraphBoundary, null, el(GraphCanvas, { data: state.data, selected, onSelect: setSelected }))
              : el('div', { style: { display: 'grid', placeItems: 'center', height: '100%', opacity: 0.45 } }, state.status === 'error' ? state.error : '正在把记忆摊开…'),
            el('button', { type: 'button', style: S.closeFloat, onClick: () => setOpen(false), title: '关闭星图（Esc）' }, '关闭星图'),
          ),
          el('div', { style: S.aside }, state.status === 'ready' ? el(Detail, { data: state.data, selected, onSelect: setSelected }) : null),
        ),
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

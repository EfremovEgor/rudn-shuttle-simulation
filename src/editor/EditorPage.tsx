import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import EditorScene from './EditorScene'
import type { Draft, Selection, View } from './EditorScene'
import type { BuildingKind, CampusMap, MapBuilding, MapRoad, MapStop, MapTree, MapZone, Pt, RoadKind, ZoneKind } from '../map/schema'
import { ROAD_PRESETS, emptyMap, newId } from '../map/schema'
import { applyHandle, hitHandle } from './handles'
import type { Handle } from './handles'
import { applyMap, DEFAULT_MAP } from '../map/runtime'
import { downloadMap, readMapFile, storeMap } from '../map/storage'
import { resetSim } from '../sim/engine'
import { resetEvents } from '../sim/events'
import { lidar } from '../sim/lidar'
import { useCampus } from '../sim/store'

type Tool = 'select' | 'building' | 'tree' | 'road' | 'zone' | 'route' | 'stop' | 'walk' | 'erase'

const TOOLS: { id: Tool; label: string; icon: string; hint: string }[] = [
  { id: 'select', label: 'Выбор', icon: '⬚', hint: 'Перетащите объект, за белые маркеры — размер, за оранжевый — поворот' },
  { id: 'building', label: 'Здание', icon: '▭', hint: 'Протяните прямоугольник — появится здание' },
  { id: 'tree', label: 'Деревья', icon: '❍', hint: 'Клик — посадить дерево, зажать и вести — аллея' },
  { id: 'road', label: 'Дороги', icon: '⤳', hint: 'Клики — точки дороги, двойной клик — завершить; тип выбирается справа' },
  { id: 'zone', label: 'Ландшафт', icon: '▨', hint: 'Протяните прямоугольник: газон, вода, покрытие' },
  { id: 'route', label: 'Маршрут', icon: '➤', hint: 'Клики добавляют точки маршрута шаттла' },
  { id: 'stop', label: 'Остановка', icon: '◉', hint: 'Клик ставит остановку (примагничивается к маршруту)' },
  { id: 'walk', label: 'Пешеходы', icon: '⋯', hint: 'Маршрут прогулки пешеходов' },
  { id: 'erase', label: 'Удалить', icon: '✕', hint: 'Клик по объекту удаляет его' },
]

const ZONE_KINDS: { id: ZoneKind; label: string }[] = [
  { id: 'lawn', label: 'Газон' },
  { id: 'water', label: 'Вода' },
  { id: 'pavement', label: 'Покрытие' },
  { id: 'field', label: 'Поле' },
]
const ROAD_KINDS = (Object.keys(ROAD_PRESETS) as RoadKind[]).map((id) => ({ id, label: ROAD_PRESETS[id].label }))
const BUILDING_KINDS: { id: BuildingKind; label: string }[] = [
  { id: 'academic', label: 'Учебный' },
  { id: 'medical', label: 'Медицинский' },
  { id: 'service', label: 'Служебный' },
  { id: 'retail', label: 'Торговый' },
  { id: 'other', label: 'Прочее' },
]

/* ─── геометрические помощники для попадания курсором ───────────────────── */
function insideRect(px: number, py: number, cx: number, cy: number, hw: number, hh: number, rot = 0) {
  const dx = px - cx
  const dy = py - cy
  const c = Math.cos(-rot)
  const s = Math.sin(-rot)
  return Math.abs(dx * c - dy * s) <= hw && Math.abs(dx * s + dy * c) <= hh
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy || 1e-6
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
}

function distToPolyline(px: number, py: number, pts: Pt[], closed = false) {
  let best = Infinity
  const n = pts.length
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    best = Math.min(best, distToSegment(px, py, a[0], a[1], b[0], b[1]))
  }
  return best
}

function hitTest(doc: CampusMap, x: number, y: number, tol: number): Selection {
  for (const s of doc.stops) if (Math.hypot(s.x - x, s.y - y) < Math.max(3.5, tol)) return { kind: 'stop', id: s.id }
  for (let i = 0; i < doc.route.points.length; i++) {
    const [px, py] = doc.route.points[i]
    if (Math.hypot(px - x, py - y) < Math.max(2.6, tol)) return { kind: 'routePoint', index: i }
  }
  for (const t of doc.trees) if (Math.hypot(t.x - x, t.y - y) < Math.max(t.r, tol)) return { kind: 'tree', id: t.id }
  for (const b of doc.buildings) if (insideRect(x, y, b.cx, b.cy, b.hw, b.hh, b.rot)) return { kind: 'building', id: b.id }
  for (const r of doc.roads) if (distToPolyline(x, y, r.points) < r.width / 2 + 1) return { kind: 'road', id: r.id }
  for (const w of doc.walks) if (distToPolyline(x, y, w.points) < Math.max(2, tol)) return { kind: 'walk', id: w.id }
  for (const z of doc.zones) if (insideRect(x, y, z.cx, z.cy, z.hw, z.hh)) return { kind: 'zone', id: z.id }
  return null
}

function boundsOf(doc: CampusMap) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const acc = (x: number, y: number) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  doc.buildings.forEach((b) => {
    acc(b.cx - b.hw - 10, b.cy - b.hh - 10)
    acc(b.cx + b.hw + 10, b.cy + b.hh + 10)
  })
  doc.zones.forEach((z) => {
    acc(z.cx - z.hw, z.cy - z.hh)
    acc(z.cx + z.hw, z.cy + z.hh)
  })
  doc.trees.forEach((t) => acc(t.x, t.y))
  doc.roads.forEach((r) => r.points.forEach(([x, y]) => acc(x, y)))
  doc.route.points.forEach(([x, y]) => acc(x, y))
  if (!isFinite(minX)) return { minX: -150, minY: -100, maxX: 150, maxY: 100 }
  return { minX: minX - 15, minY: minY - 15, maxX: maxX + 15, maxY: maxY + 15 }
}

export default function EditorPage({ onOpenSim }: { onOpenSim: () => void }) {
  const current = useCampus((s) => s.rt)
  const [doc, setDoc] = useState<CampusMap>(() => structuredClone(current.doc))
  const [tool, setTool] = useState<Tool>('select')
  const [sel, setSel] = useState<Selection>(null)
  const [draft, setDraft] = useState<Draft>(null)
  const [zoneKind, setZoneKind] = useState<ZoneKind>('lawn')
  const [roadKind, setRoadKind] = useState<RoadKind>('two-lane')
  const [roadWidth, setRoadWidth] = useState(ROAD_PRESETS['two-lane'].width)
  const [treeSize, setTreeSize] = useState(3)
  const [status, setStatus] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  const wrap = useRef<HTMLDivElement>(null)
  const size = useRef({ w: 1, h: 1 })
  const view = useRef<View>({ cx: 0, cy: 0, zoom: 2 })
  const past = useRef<CampusMap[]>([])
  const future = useRef<CampusMap[]>([])
  const drag = useRef<
    | { mode: 'pan'; sx: number; sy: number; cx: number; cy: number }
    | { mode: 'move'; sel: Selection; lastX: number; lastY: number }
    | { mode: 'resize'; sel: Selection; handle: Handle }
    | { mode: 'rect' }
    | { mode: 'scatter'; lastX: number; lastY: number }
    | null
  >(null)
  /** пока пользователь не двигал вид сам, карта сама вписывается в панель */
  const viewTouched = useRef(false)
  const docRef = useRef(doc)
  docRef.current = doc
  const draftRef = useRef<Draft>(null)
  draftRef.current = draft
  const fileInput = useRef<HTMLInputElement>(null)

  /* ─── история ─────────────────────────────────────────────────────────── */
  /** markDirty=false — снимок «на всякий случай» перед возможным перетаскиванием */
  const snapshot = useCallback((markDirty = true) => {
    past.current.push(structuredClone(docRef.current))
    if (past.current.length > 60) past.current.shift()
    future.current.length = 0
    if (markDirty) setDirty(true)
  }, [])

  const undo = useCallback(() => {
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(structuredClone(docRef.current))
    setDoc(prev)
    setSel(null)
  }, [])

  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next) return
    past.current.push(structuredClone(docRef.current))
    setDoc(next)
    setSel(null)
  }, [])

  /* ─── размеры и стартовый вид ─────────────────────────────────────────── */
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const measure = () => {
      size.current = { w: el.clientWidth, h: el.clientHeight }
      if (!viewTouched.current) fitViewRef.current()
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fitViewRef = useRef<() => void>(() => {})

  const fitView = useCallback(() => {
    const b = boundsOf(docRef.current)
    const w = b.maxX - b.minX
    const h = b.maxY - b.minY
    view.current = {
      cx: (b.minX + b.maxX) / 2,
      cy: (b.minY + b.maxY) / 2,
      zoom: Math.max(0.4, Math.min(size.current.w / (w + 20), size.current.h / (h + 20))),
    }
  }, [])

  fitViewRef.current = fitView

  useEffect(() => {
    const id = setTimeout(fitView, 60)
    return () => clearTimeout(id)
  }, [fitView])

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const el = wrap.current
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    const v = view.current
    return {
      x: v.cx + (clientX - r.left - r.width / 2) / v.zoom,
      y: v.cy - (clientY - r.top - r.height / 2) / v.zoom,
    }
  }, [])

  /* ─── операции с документом ───────────────────────────────────────────── */
  const addBuilding = (x0: number, y0: number, x1: number, y1: number) => {
    const b: MapBuilding = {
      id: newId('bld'),
      name: 'Новое здание',
      short: 'Здание',
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      hw: Math.abs(x1 - x0) / 2,
      hh: Math.abs(y1 - y0) / 2,
      rot: 0,
      height: 12,
      kind: 'academic',
    }
    snapshot()
    setDoc((d) => ({ ...d, buildings: [...d.buildings, b] }))
    setSel({ kind: 'building', id: b.id })
    setTool('select')
  }

  const addZone = (x0: number, y0: number, x1: number, y1: number) => {
    const z: MapZone = {
      id: newId('zone'),
      kind: zoneKind,
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      hw: Math.abs(x1 - x0) / 2,
      hh: Math.abs(y1 - y0) / 2,
    }
    snapshot()
    setDoc((d) => ({ ...d, zones: [...d.zones, z] }))
    setSel({ kind: 'zone', id: z.id })
  }

  const plantTree = (x: number, y: number, withSnapshot: boolean) => {
    const r = treeSize * (0.75 + Math.random() * 0.5)
    const t: MapTree = {
      id: newId('tree'),
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      r: Math.round(r * 100) / 100,
      h: Math.round((r * 2.4 + Math.random() * 2) * 100) / 100,
      trunk: Math.round((1.6 + Math.random()) * 100) / 100,
    }
    if (withSnapshot) snapshot()
    setDoc((d) => ({ ...d, trees: [...d.trees, t] }))
  }

  const finishPoly = useCallback(() => {
    const cur = draftRef.current
    if (!cur || cur.kind !== 'poly') return
    setDraft(null)
    if (cur.points.length < 2) return
    snapshot()
    if (cur.target === 'road') {
      const r: MapRoad = { id: newId('road'), points: cur.points, width: roadWidth, kind: roadKind }
      setDoc((d) => ({ ...d, roads: [...d.roads, r] }))
    } else {
      setDoc((d) => ({ ...d, walks: [...d.walks, { id: newId('walk'), points: cur.points, people: 1 }] }))
    }
  }, [roadKind, roadWidth, snapshot])

  const addStop = (x: number, y: number) => {
    // примагничивание к ближайшей точке маршрута
    let sx = x
    let sy = y
    const pts = docRef.current.route.points
    let best = Infinity
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const len2 = dx * dx + dy * dy || 1e-6
      let t = ((x - a[0]) * dx + (y - a[1]) * dy) / len2
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const px = a[0] + dx * t
      const py = a[1] + dy * t
      const d = Math.hypot(px - x, py - y)
      if (d < best) {
        best = d
        sx = px
        sy = py
      }
    }
    if (best > 18) {
      sx = x
      sy = y
    }
    const n = docRef.current.stops.length + 1
    const s: MapStop = {
      id: newId('stop'),
      code: `ОСТ-${String(n).padStart(2, '0')}`,
      name: `Остановка ${n}`,
      x: Math.round(sx * 100) / 100,
      y: Math.round(sy * 100) / 100,
      dwell: 7,
    }
    snapshot()
    setDoc((d) => ({ ...d, stops: [...d.stops, s] }))
    setSel({ kind: 'stop', id: s.id })
  }

  const removeSelection = useCallback(
    (target: Selection) => {
      if (!target) return
      snapshot()
      setDoc((d) => {
        if (target.kind === 'routePoint') {
          const points = d.route.points.filter((_, i) => i !== target.index)
          return { ...d, route: { ...d.route, points } }
        }
        const id = target.id
        return {
          ...d,
          buildings: d.buildings.filter((b) => b.id !== id),
          trees: d.trees.filter((t) => t.id !== id),
          roads: d.roads.filter((r) => r.id !== id),
          zones: d.zones.filter((z) => z.id !== id),
          stops: d.stops.filter((s) => s.id !== id),
          walks: d.walks.filter((w) => w.id !== id),
        }
      })
      setSel(null)
    },
    [snapshot],
  )

  const moveSelection = (target: Selection, dx: number, dy: number) => {
    if (!target) return
    setDoc((d) => {
      if (target.kind === 'routePoint') {
        const points = d.route.points.map((p, i): Pt => (i === target.index ? [p[0] + dx, p[1] + dy] : p))
        return { ...d, route: { ...d.route, points } }
      }
      const id = target.id
      switch (target.kind) {
        case 'building':
          return { ...d, buildings: d.buildings.map((b) => (b.id === id ? { ...b, cx: b.cx + dx, cy: b.cy + dy } : b)) }
        case 'tree':
          return { ...d, trees: d.trees.map((t) => (t.id === id ? { ...t, x: t.x + dx, y: t.y + dy } : t)) }
        case 'zone':
          return { ...d, zones: d.zones.map((z) => (z.id === id ? { ...z, cx: z.cx + dx, cy: z.cy + dy } : z)) }
        case 'stop':
          return { ...d, stops: d.stops.map((s) => (s.id === id ? { ...s, x: s.x + dx, y: s.y + dy } : s)) }
        case 'road':
          return {
            ...d,
            roads: d.roads.map((r) =>
              r.id === id ? { ...r, points: r.points.map((p): Pt => [p[0] + dx, p[1] + dy]) } : r,
            ),
          }
        case 'walk':
          return {
            ...d,
            walks: d.walks.map((w) =>
              w.id === id ? { ...w, points: w.points.map((p): Pt => [p[0] + dx, p[1] + dy]) } : w,
            ),
          }
        default:
          return d
      }
    })
  }

  /* ─── указатель ───────────────────────────────────────────────────────── */
  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    const { x, y } = toWorld(e.clientX, e.clientY)
    const tol = 6 / view.current.zoom

    if (e.button === 1 || e.button === 2 || e.altKey) {
      viewTouched.current = true
      drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, cx: view.current.cx, cy: view.current.cy }
      return
    }
    if (e.button !== 0) return

    switch (tool) {
      case 'select': {
        const handle = hitHandle(doc, sel, x, y, Math.max(2, 13 / view.current.zoom))
        if (handle) {
          snapshot(false)
          drag.current = { mode: 'resize', sel, handle }
          break
        }
        const hit = hitTest(doc, x, y, tol)
        setSel(hit)
        if (hit) {
          snapshot(false)
          drag.current = { mode: 'move', sel: hit, lastX: x, lastY: y }
        }
        break
      }
      case 'erase': {
        const hit = hitTest(doc, x, y, tol)
        if (hit) removeSelection(hit)
        break
      }
      case 'building':
      case 'zone':
        setDraft({ kind: 'rect', target: tool, x0: x, y0: y, x1: x, y1: y })
        drag.current = { mode: 'rect' }
        break
      case 'tree':
        plantTree(x, y, true)
        drag.current = { mode: 'scatter', lastX: x, lastY: y }
        break
      case 'road':
      case 'walk':
        setDraft((cur) =>
          cur && cur.kind === 'poly'
            ? { ...cur, points: [...cur.points, [x, y]] }
            : { kind: 'poly', target: tool, points: [[x, y]], cursor: [x, y] },
        )
        break
      case 'route': {
        const hit = hitTest(doc, x, y, tol)
        if (hit && hit.kind === 'routePoint') {
          setSel(hit)
          snapshot(false)
          drag.current = { mode: 'move', sel: hit, lastX: x, lastY: y }
        } else {
          snapshot()
          setDoc((d) => {
            const pts = d.route.points
            const np: Pt = [Math.round(x * 100) / 100, Math.round(y * 100) / 100]
            // если кликнули рядом с существующим участком — вставляем точку в него
            let insertAt = pts.length
            if (pts.length >= 2) {
              let best = Infinity
              let bi = -1
              const last = d.route.closed ? pts.length : pts.length - 1
              for (let i = 0; i < last; i++) {
                const a = pts[i]
                const b = pts[(i + 1) % pts.length]
                const dd = distToSegment(x, y, a[0], a[1], b[0], b[1])
                if (dd < best) {
                  best = dd
                  bi = i
                }
              }
              if (best < 20 && bi >= 0) insertAt = bi + 1
            }
            const next = pts.slice()
            next.splice(insertAt, 0, np)
            return { ...d, route: { ...d.route, points: next } }
          })
        }
        break
      }
      case 'stop':
        addStop(x, y)
        break
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    const { x, y } = toWorld(e.clientX, e.clientY)

    if (d?.mode === 'pan') {
      view.current.cx = d.cx - (e.clientX - d.sx) / view.current.zoom
      view.current.cy = d.cy + (e.clientY - d.sy) / view.current.zoom
      return
    }
    if (d?.mode === 'rect') {
      setDraft((cur) => (cur && cur.kind === 'rect' ? { ...cur, x1: x, y1: y } : cur))
      return
    }
    if (d?.mode === 'resize') {
      setDirty(true)
      setDoc((cur) => applyHandle(cur, d.sel, d.handle, x, y, e.shiftKey))
      return
    }
    if (d?.mode === 'move') {
      setDirty(true)
      moveSelection(d.sel, x - d.lastX, y - d.lastY)
      d.lastX = x
      d.lastY = y
      return
    }
    if (d?.mode === 'scatter') {
      if (Math.hypot(x - d.lastX, y - d.lastY) > treeSize * 2.2) {
        plantTree(x, y, false)
        d.lastX = x
        d.lastY = y
      }
      return
    }
    setDraft((cur) => (cur && cur.kind === 'poly' ? { ...cur, cursor: [x, y] } : cur))
  }

  const onPointerUp = () => {
    const d = drag.current
    if (d?.mode === 'rect') {
      const cur = draftRef.current
      setDraft(null)
      if (cur && cur.kind === 'rect') {
        const w = Math.abs(cur.x1 - cur.x0)
        const h = Math.abs(cur.y1 - cur.y0)
        if (w > 1 && h > 1) {
          if (cur.target === 'building') addBuilding(cur.x0, cur.y0, cur.x1, cur.y1)
          else addZone(cur.x0, cur.y0, cur.x1, cur.y1)
        }
      }
    }
    drag.current = null
  }

  const onWheel = (e: React.WheelEvent) => {
    viewTouched.current = true
    const before = toWorld(e.clientX, e.clientY)
    const v = view.current
    v.zoom = Math.max(0.35, Math.min(28, v.zoom * Math.exp(-e.deltaY * 0.0016)))
    const after = toWorld(e.clientX, e.clientY)
    v.cx += before.x - after.x
    v.cy += before.y - after.y
  }

  /* ─── клавиатура ──────────────────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
      } else if (e.key === 'Escape') {
        setDraft(null)
        setSel(null)
      } else if (e.key === 'Enter') {
        finishPoly()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        removeSelection(sel)
      } else if (e.key === 'f' || e.key === 'а') {
        fitView()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, finishPoly, removeSelection, sel, fitView])

  /* ─── сохранение и загрузка ───────────────────────────────────────────── */
  const flash = (msg: string) => {
    setStatus(msg)
    setTimeout(() => setStatus(null), 2600)
  }

  const apply = (open: boolean) => {
    const clean: CampusMap = { ...doc, bounds: boundsOf(doc), updated: new Date().toISOString() }
    applyMap(clean)
    resetSim()
    resetEvents()
    lidar.rebuild()
    storeMap(clean)
    setDoc(clean)
    setDirty(false)
    if (open) onOpenSim()
    else flash('Карта применена и сохранена в браузере')
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const loaded = await readMapFile(file)
      past.current.push(structuredClone(docRef.current))
      setDoc(loaded)
      setSel(null)
      setDirty(true)
      setTimeout(fitView, 40)
      flash(`Загружено: ${loaded.name}`)
    } catch (err) {
      flash(`Ошибка чтения файла: ${(err as Error).message}`)
    }
  }

  const chooseRoadKind = (k: RoadKind) => {
    setRoadKind(k)
    setRoadWidth(ROAD_PRESETS[k].width)
  }

  const stats = useMemo(
    () => ({
      buildings: doc.buildings.length,
      trees: doc.trees.length,
      roads: doc.roads.length,
      zones: doc.zones.length,
      stops: doc.stops.length,
      route: doc.route.points.length,
    }),
    [doc],
  )

  const activeTool = TOOLS.find((t) => t.id === tool)!

  return (
    <div className="editor">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <span />
          </div>
          <div className="brand-text">
            <b>Редактор карты</b>
            <span>{doc.name}</span>
          </div>
        </div>
        <div className="controls">
          <button className="btn" onClick={undo} title="Ctrl+Z">
            ↶ Отменить
          </button>
          <button className="btn" onClick={redo} title="Ctrl+Shift+Z">
            ↷ Вернуть
          </button>
          <span className="tool-sep" />
          <button className="btn" onClick={() => fileInput.current?.click()}>
            Открыть файл
          </button>
          <button className="btn" onClick={() => downloadMap(doc)}>
            Сохранить в файл
          </button>
          <button className="btn btn-primary" onClick={() => apply(false)}>
            Применить
          </button>
          <button className="btn" onClick={() => apply(true)}>
            В симуляцию →
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              void onFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>
      </header>

      <div className="editor-body">
        <aside className="tools">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={tool === t.id ? 'tool on' : 'tool'}
              onClick={() => {
                setTool(t.id)
                setDraft(null)
              }}
              title={t.hint}
            >
              <i>{t.icon}</i>
              <span>{t.label}</span>
            </button>
          ))}
          <div className="tools-sep" />
          <button
            className="tool"
            onClick={() => {
              viewTouched.current = false
              fitView()
            }}
            title="Показать всю карту (F)"
          >
            <i>⤢</i>
            <span>Вписать</span>
          </button>
        </aside>

        <div
          className="editor-canvas"
          ref={wrap}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onDoubleClick={finishPoly}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
        >
          <EditorScene doc={doc} view={view} sel={sel} draft={draft} />
          <div className="editor-hint">
            <b>{activeTool.label}.</b> {activeTool.hint} · правая кнопка — панорама, колесо — масштаб
          </div>
          {status && <div className="editor-toast">{status}</div>}
        </div>

        <aside className="inspector">
          <Inspector
            doc={doc}
            setDoc={setDoc}
            snapshot={snapshot}
            sel={sel}
            remove={() => removeSelection(sel)}
            zoneKind={zoneKind}
            setZoneKind={setZoneKind}
            roadKind={roadKind}
            setRoadKind={chooseRoadKind}
            roadWidth={roadWidth}
            setRoadWidth={setRoadWidth}
            treeSize={treeSize}
            setTreeSize={setTreeSize}
            tool={tool}
            stats={stats}
            dirty={dirty}
            resetToDefault={() => {
              snapshot()
              setDoc(structuredClone(DEFAULT_MAP))
              setTimeout(fitView, 40)
            }}
            clearMap={() => {
              snapshot()
              setDoc(emptyMap('Пустая карта'))
              setTimeout(fitView, 40)
            }}
          />
        </aside>
      </div>
    </div>
  )
}

/* ─── правая панель свойств ─────────────────────────────────────────────── */
type InspectorProps = {
  doc: CampusMap
  setDoc: React.Dispatch<React.SetStateAction<CampusMap>>
  snapshot: () => void
  sel: Selection
  remove: () => void
  zoneKind: ZoneKind
  setZoneKind: (k: ZoneKind) => void
  roadKind: RoadKind
  setRoadKind: (k: RoadKind) => void
  roadWidth: number
  setRoadWidth: (w: number) => void
  treeSize: number
  setTreeSize: (s: number) => void
  tool: Tool
  stats: Record<string, number>
  dirty: boolean
  resetToDefault: () => void
  clearMap: () => void
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

function Inspector(p: InspectorProps) {
  const { doc, setDoc, sel } = p
  const building = sel?.kind === 'building' ? doc.buildings.find((b) => b.id === sel.id) : undefined
  const stop = sel?.kind === 'stop' ? doc.stops.find((s) => s.id === sel.id) : undefined
  const zone = sel?.kind === 'zone' ? doc.zones.find((z) => z.id === sel.id) : undefined
  const road = sel?.kind === 'road' ? doc.roads.find((r) => r.id === sel.id) : undefined
  const tree = sel?.kind === 'tree' ? doc.trees.find((t) => t.id === sel.id) : undefined
  const walk = sel?.kind === 'walk' ? doc.walks.find((w) => w.id === sel.id) : undefined

  const patchBuilding = (patch: Partial<MapBuilding>) =>
    setDoc((d) => ({ ...d, buildings: d.buildings.map((b) => (b.id === building!.id ? { ...b, ...patch } : b)) }))
  const patchStop = (patch: Partial<MapStop>) =>
    setDoc((d) => ({ ...d, stops: d.stops.map((s) => (s.id === stop!.id ? { ...s, ...patch } : s)) }))
  const patchZone = (patch: Partial<MapZone>) =>
    setDoc((d) => ({ ...d, zones: d.zones.map((z) => (z.id === zone!.id ? { ...z, ...patch } : z)) }))
  const patchRoad = (patch: Partial<MapRoad>) =>
    setDoc((d) => ({ ...d, roads: d.roads.map((r) => (r.id === road!.id ? { ...r, ...patch } : r)) }))
  const patchTree = (patch: Partial<MapTree>) =>
    setDoc((d) => ({ ...d, trees: d.trees.map((t) => (t.id === tree!.id ? { ...t, ...patch } : t)) }))

  return (
    <div className="inspector-inner">
      <section>
        <h3>Карта</h3>
        <Field label="Название">
          <input value={doc.name} onChange={(e) => setDoc((d) => ({ ...d, name: e.target.value }))} />
        </Field>
        <Field label="Описание">
          <input
            value={doc.description}
            onChange={(e) => setDoc((d) => ({ ...d, description: e.target.value }))}
          />
        </Field>
        <Field label={`Скорость шаттла · ${(doc.cruiseSpeed * 3.6).toFixed(1)} км/ч`}>
          <input
            type="range"
            min={1}
            max={8}
            step={0.1}
            value={doc.cruiseSpeed}
            onChange={(e) => setDoc((d) => ({ ...d, cruiseSpeed: Number(e.target.value) }))}
          />
        </Field>
        <div className="stats">
          <span>здания {p.stats.buildings}</span>
          <span>деревья {p.stats.trees}</span>
          <span>дороги {p.stats.roads}</span>
          <span>зоны {p.stats.zones}</span>
          <span>остановки {p.stats.stops}</span>
          <span>точки маршрута {p.stats.route}</span>
        </div>
        {p.dirty && <div className="warn-note">Есть несохранённые изменения — нажмите «Применить».</div>}
        {doc.route.points.length < 3 && (
          <div className="warn-note">Маршрут короче трёх точек — шаттлу негде ехать.</div>
        )}
        {doc.stops.length === 0 && <div className="warn-note">Не задано ни одной остановки.</div>}
      </section>

      {p.tool === 'zone' && (
        <section>
          <h3>Новый участок</h3>
          <Field label="Тип">
            <select value={p.zoneKind} onChange={(e) => p.setZoneKind(e.target.value as ZoneKind)}>
              {ZONE_KINDS.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.label}
                </option>
              ))}
            </select>
          </Field>
        </section>
      )}

      {p.tool === 'road' && (
        <section>
          <h3>Новая дорога</h3>
          <div className="kind-row">
            {ROAD_KINDS.map((r) => (
              <button
                key={r.id}
                className={p.roadKind === r.id ? 'kind on' : 'kind'}
                onClick={() => p.setRoadKind(r.id)}
              >
                <i className={`road-ico road-${r.id}`} />
                {r.label}
              </button>
            ))}
          </div>
          <Field label={`Ширина · ${p.roadWidth} м`}>
            <input
              type="range"
              min={ROAD_PRESETS[p.roadKind].min}
              max={ROAD_PRESETS[p.roadKind].max}
              step={0.5}
              value={p.roadWidth}
              onChange={(e) => p.setRoadWidth(Number(e.target.value))}
            />
          </Field>
        </section>
      )}

      {p.tool === 'walk' && (
        <section>
          <h3>Маршрут пешеходов</h3>
          <div className="hint-note">
            Клики задают ломаную, по которой будут ходить люди. Двойной клик завершает маршрут.
          </div>
        </section>
      )}

      {p.tool === 'tree' && (
        <section>
          <h3>Посадка</h3>
          <Field label={`Размер кроны · ${p.treeSize.toFixed(1)} м`}>
            <input
              type="range"
              min={1}
              max={7}
              step={0.1}
              value={p.treeSize}
              onChange={(e) => p.setTreeSize(Number(e.target.value))}
            />
          </Field>
        </section>
      )}

      {p.tool === 'route' && (
        <section>
          <h3>Маршрут</h3>
          <Field label={`Скругление углов · ${doc.route.corner} м`}>
            <input
              type="range"
              min={0}
              max={20}
              step={1}
              value={doc.route.corner}
              onChange={(e) => setDoc((d) => ({ ...d, route: { ...d.route, corner: Number(e.target.value) } }))}
            />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={doc.route.closed}
              onChange={(e) => setDoc((d) => ({ ...d, route: { ...d.route, closed: e.target.checked } }))}
            />
            замкнутое кольцо
          </label>
          <button
            className="btn btn-danger"
            onClick={() => {
              p.snapshot()
              setDoc((d) => ({ ...d, route: { ...d.route, points: [] } }))
            }}
          >
            Очистить маршрут
          </button>
        </section>
      )}

      {building && (
        <section>
          <h3>Здание</h3>
          <Field label="Название">
            <input value={building.name} onChange={(e) => patchBuilding({ name: e.target.value })} />
          </Field>
          <Field label="Подпись на карте">
            <input value={building.short} onChange={(e) => patchBuilding({ short: e.target.value })} />
          </Field>
          <Field label="Тип">
            <select value={building.kind} onChange={(e) => patchBuilding({ kind: e.target.value as BuildingKind })}>
              {BUILDING_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Высота · ${building.height} м`}>
            <input
              type="range"
              min={3}
              max={60}
              step={1}
              value={building.height}
              onChange={(e) => patchBuilding({ height: Number(e.target.value) })}
            />
          </Field>
          <Field label={`Поворот · ${Math.round(((building.rot || 0) * 180) / Math.PI)}°`}>
            <input
              type="range"
              min={-90}
              max={90}
              step={1}
              value={Math.round(((building.rot || 0) * 180) / Math.PI)}
              onChange={(e) => patchBuilding({ rot: (Number(e.target.value) * Math.PI) / 180 })}
            />
          </Field>
          <div className="pair">
            <Field label="Ширина, м">
              <input
                type="number"
                value={Math.round(building.hw * 2)}
                onChange={(e) => patchBuilding({ hw: Math.max(1, Number(e.target.value)) / 2 })}
              />
            </Field>
            <Field label="Глубина, м">
              <input
                type="number"
                value={Math.round(building.hh * 2)}
                onChange={(e) => patchBuilding({ hh: Math.max(1, Number(e.target.value)) / 2 })}
              />
            </Field>
          </div>
          <button className="btn btn-danger" onClick={p.remove}>
            Удалить здание
          </button>
        </section>
      )}

      {stop && (
        <section>
          <h3>Остановка</h3>
          <Field label="Код">
            <input value={stop.code} onChange={(e) => patchStop({ code: e.target.value })} />
          </Field>
          <Field label="Название">
            <input value={stop.name} onChange={(e) => patchStop({ name: e.target.value })} />
          </Field>
          <Field label={`Стоянка · ${stop.dwell} с`}>
            <input
              type="range"
              min={2}
              max={30}
              step={1}
              value={stop.dwell}
              onChange={(e) => patchStop({ dwell: Number(e.target.value) })}
            />
          </Field>
          <button className="btn btn-danger" onClick={p.remove}>
            Удалить остановку
          </button>
        </section>
      )}

      {zone && (
        <section>
          <h3>Участок ландшафта</h3>
          <Field label="Тип">
            <select value={zone.kind} onChange={(e) => patchZone({ kind: e.target.value as ZoneKind })}>
              {ZONE_KINDS.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="pair">
            <Field label="Ширина, м">
              <input
                type="number"
                value={Math.round(zone.hw * 2)}
                onChange={(e) => patchZone({ hw: Math.max(1, Number(e.target.value)) / 2 })}
              />
            </Field>
            <Field label="Высота, м">
              <input
                type="number"
                value={Math.round(zone.hh * 2)}
                onChange={(e) => patchZone({ hh: Math.max(1, Number(e.target.value)) / 2 })}
              />
            </Field>
          </div>
          <button className="btn btn-danger" onClick={p.remove}>
            Удалить участок
          </button>
        </section>
      )}

      {road && (
        <section>
          <h3>Дорога</h3>
          <div className="kind-row">
            {ROAD_KINDS.map((r) => (
              <button
                key={r.id}
                className={road.kind === r.id ? 'kind on' : 'kind'}
                onClick={() => {
                  const pr = ROAD_PRESETS[r.id]
                  patchRoad({ kind: r.id, width: Math.min(pr.max, Math.max(pr.min, road.width)) })
                }}
              >
                <i className={`road-ico road-${r.id}`} />
                {r.label}
              </button>
            ))}
          </div>
          <Field label={`Ширина · ${road.width} м`}>
            <input
              type="range"
              min={ROAD_PRESETS[road.kind].min}
              max={ROAD_PRESETS[road.kind].max}
              step={0.5}
              value={road.width}
              onChange={(e) => patchRoad({ width: Number(e.target.value) })}
            />
          </Field>
          <button className="btn btn-danger" onClick={p.remove}>
            Удалить дорогу
          </button>
        </section>
      )}

      {tree && (
        <section>
          <h3>Дерево</h3>
          <Field label={`Крона · ${tree.r} м`}>
            <input
              type="range"
              min={0.6}
              max={8}
              step={0.1}
              value={tree.r}
              onChange={(e) => patchTree({ r: Number(e.target.value) })}
            />
          </Field>
          <Field label={`Высота · ${tree.h} м`}>
            <input
              type="range"
              min={2}
              max={22}
              step={0.5}
              value={tree.h}
              onChange={(e) => patchTree({ h: Number(e.target.value) })}
            />
          </Field>
          <button className="btn btn-danger" onClick={p.remove}>
            Удалить дерево
          </button>
        </section>
      )}

      {walk && (
        <section>
          <h3>Пешеходный маршрут</h3>
          <Field label={`Пешеходов · ${walk.people}`}>
            <input
              type="range"
              min={0}
              max={4}
              step={1}
              value={walk.people}
              onChange={(e) =>
                setDoc((d) => ({
                  ...d,
                  walks: d.walks.map((w) => (w.id === walk.id ? { ...w, people: Number(e.target.value) } : w)),
                }))
              }
            />
          </Field>
          <button className="btn btn-danger" onClick={p.remove}>
            Удалить маршрут
          </button>
        </section>
      )}

      <section>
        <h3>Шаблоны</h3>
        <button className="btn" onClick={p.resetToDefault}>
          Вернуть карту РУДН
        </button>
        <button className="btn" onClick={p.clearMap}>
          Пустая карта
        </button>
      </section>
    </div>
  )
}

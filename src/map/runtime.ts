/**
 * Рантайм карты: из документа .map.json собираются структуры, которыми
 * пользуются симуляция и обе сцены — маршрут с параметризацией по длине,
 * остановки с привязкой к маршруту и препятствия для лучевой модели лидара.
 */
import { roundPolyline, RoutePath } from '../sim/geometry'
import type { Vec2 } from '../sim/geometry'
import type { CampusMap, MapBuilding, MapStop, MapTree } from './schema'
import rudn from './rudn.map.json'
import { normalizeMap } from './schema'

export type ObstacleClass = 'building' | 'tree' | 'person'

export type Obstacle = {
  id: string
  label: string
  cls: ObstacleClass
  /** 0 — прямоугольник (здание), 1 — окружность (ствол, крона, человек) */
  shape: 0 | 1
  cx: number
  cy: number
  hw: number
  hh: number
  radius: number
  /** поворот прямоугольника */
  cos: number
  sin: number
  z0: number
  z1: number
  /** радиус описанной окружности — быстрая отбраковка */
  br: number
}

export type RuntimeStop = MapStop & { s: number; index: number }

export type Extent = {
  cx: number
  cy: number
  hw: number
  hh: number
  top: number
  cls: ObstacleClass
  label: string
}

export type CampusRuntime = {
  doc: CampusMap
  revision: number
  valid: boolean
  route: RoutePath
  routePoints: Vec2[]
  stops: RuntimeStop[]
  buildings: MapBuilding[]
  trees: MapTree[]
  obstacles: Obstacle[]
  extents: Map<string, Extent>
  walks: Vec2[][]
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  center: Vec2
  extent: { w: number; h: number }
  cruise: number
}

const FALLBACK_ROUTE: Vec2[] = [
  { x: -30, y: -20 },
  { x: 30, y: -20 },
  { x: 30, y: 20 },
  { x: -30, y: 20 },
]

function buildObstacles(doc: CampusMap) {
  const obstacles: Obstacle[] = []
  const extents = new Map<string, Extent>()

  doc.buildings.forEach((b) => {
    const id = `b:${b.id}`
    obstacles.push({
      id,
      label: b.short || b.name,
      cls: 'building',
      shape: 0,
      cx: b.cx,
      cy: b.cy,
      hw: b.hw,
      hh: b.hh,
      radius: 0,
      cos: Math.cos(b.rot || 0),
      sin: Math.sin(b.rot || 0),
      z0: 0,
      z1: b.height,
      br: Math.hypot(b.hw, b.hh),
    })
    extents.set(id, {
      cx: b.cx,
      cy: b.cy,
      hw: Math.max(b.hw, b.hh * Math.abs(Math.sin(b.rot || 0))),
      hh: Math.max(b.hh, b.hw * Math.abs(Math.sin(b.rot || 0))),
      top: b.height,
      cls: 'building',
      label: b.short || b.name,
    })
  })

  doc.trees.forEach((t, i) => {
    const id = `t:${i}`
    const trunkR = 0.22 + t.r * 0.06
    obstacles.push({
      id, label: 'Дерево', cls: 'tree', shape: 1,
      cx: t.x, cy: t.y, hw: trunkR, hh: trunkR, radius: trunkR,
      cos: 1, sin: 0, z0: 0, z1: t.trunk, br: trunkR,
    })
    obstacles.push({
      id, label: 'Дерево', cls: 'tree', shape: 1,
      cx: t.x, cy: t.y, hw: t.r, hh: t.r, radius: t.r,
      cos: 1, sin: 0, z0: t.trunk, z1: t.h, br: t.r,
    })
    extents.set(id, { cx: t.x, cy: t.y, hw: t.r, hh: t.r, top: t.h, cls: 'tree', label: 'Дерево' })
  })

  return { obstacles, extents }
}

function build(doc: CampusMap, revision: number): CampusRuntime {
  const raw: Vec2[] = doc.route.points.map(([x, y]) => ({ x, y }))
  const valid = raw.length >= 3
  const pts = valid ? raw : FALLBACK_ROUTE
  const routePoints = roundPolyline(pts, doc.route.corner ?? 7, doc.route.closed !== false, 10)
  const route = new RoutePath(routePoints, doc.cruiseSpeed || 3.3)

  const stops: RuntimeStop[] = doc.stops
    .map((s, index) => ({ ...s, index, s: route.project(s.x, s.y) }))
    .sort((a, b) => a.s - b.s)
    .map((s, index) => ({ ...s, index }))

  const { obstacles, extents } = buildObstacles(doc)

  const walks: Vec2[][] = []
  doc.walks.forEach((w) => {
    if (w.points.length < 2) return
    const line = w.points.map(([x, y]) => ({ x, y }))
    for (let k = 0; k < Math.max(1, w.people); k++) walks.push(line)
  })

  const b = doc.bounds
  return {
    doc,
    revision,
    valid: valid && stops.length > 0,
    route,
    routePoints,
    stops,
    buildings: doc.buildings,
    trees: doc.trees,
    obstacles,
    extents,
    walks,
    bounds: b,
    center: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 },
    extent: { w: b.maxX - b.minX, h: b.maxY - b.minY },
    cruise: doc.cruiseSpeed || 3.3,
  }
}

export const DEFAULT_MAP: CampusMap = normalizeMap(rudn)

export let campus: CampusRuntime = build(DEFAULT_MAP, 0)

type Listener = (rt: CampusRuntime) => void
const listeners = new Set<Listener>()

export function onCampusChange(fn: Listener) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Применить новую карту: пересобирает маршрут, остановки и препятствия. */
export function applyMap(doc: CampusMap) {
  campus = build(doc, campus.revision + 1)
  listeners.forEach((fn) => fn(campus))
  return campus
}

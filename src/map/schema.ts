/**
 * Формат файла карты (.map.json).
 * Все координаты — метры: X на восток, Y на север. Точка (0,0) — центр кампуса.
 * Этот файл читают и симуляция, и редактор.
 */

export type BuildingKind = 'academic' | 'medical' | 'service' | 'retail' | 'other'
export type ZoneKind = 'lawn' | 'water' | 'pavement' | 'field'
/** Двухполосная проезжая часть, однополосный проезд, пешеходная дорожка. */
export type RoadKind = 'two-lane' | 'one-lane' | 'walk'

/** Параметры по умолчанию для каждого типа дороги. */
export const ROAD_PRESETS: Record<RoadKind, { label: string; width: number; min: number; max: number }> = {
  'two-lane': { label: 'Двухполосная', width: 7, min: 5, max: 24 },
  'one-lane': { label: 'Однополосная', width: 3.5, min: 2.5, max: 6 },
  walk: { label: 'Пешеходная', width: 2.2, min: 1, max: 5 },
}

/** Старые названия типов из карт первой версии. */
function migrateRoadKind(kind: unknown, width: number): RoadKind {
  if (kind === 'two-lane' || kind === 'one-lane' || kind === 'walk') return kind
  if (kind === 'path') return 'walk'
  return width >= 6 ? 'two-lane' : 'one-lane'
}

export type Pt = [number, number]

export type MapBuilding = {
  id: string
  name: string
  short: string
  cx: number
  cy: number
  hw: number
  hh: number
  /** поворот вокруг вертикали, радианы */
  rot: number
  height: number
  kind: BuildingKind
}

export type MapTree = {
  id: string
  x: number
  y: number
  /** радиус кроны */
  r: number
  /** полная высота */
  h: number
  /** высота начала кроны */
  trunk: number
}

export type MapRoad = {
  id: string
  points: Pt[]
  width: number
  kind: RoadKind
  name?: string
}

export type MapZone = {
  id: string
  kind: ZoneKind
  cx: number
  cy: number
  hw: number
  hh: number
  name?: string
}

export type MapStop = {
  id: string
  code: string
  name: string
  x: number
  y: number
  /** стоянка на остановке, с */
  dwell: number
}

export type MapRoute = {
  points: Pt[]
  closed: boolean
  /** радиус скругления углов, м */
  corner: number
}

export type MapWalk = {
  id: string
  points: Pt[]
  /** сколько пешеходов ходит по маршруту */
  people: number
}

export type CampusMap = {
  version: 1
  name: string
  description: string
  updated: string
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  /** крейсерская скорость шаттла, м/с */
  cruiseSpeed: number
  buildings: MapBuilding[]
  trees: MapTree[]
  roads: MapRoad[]
  zones: MapZone[]
  stops: MapStop[]
  walks: MapWalk[]
  route: MapRoute
}

export const MAP_VERSION = 1 as const

export function emptyMap(name = 'Новая карта'): CampusMap {
  return {
    version: MAP_VERSION,
    name,
    description: '',
    updated: new Date().toISOString(),
    bounds: { minX: -220, minY: -150, maxX: 220, maxY: 150 },
    cruiseSpeed: 3.3,
    buildings: [],
    trees: [],
    roads: [],
    zones: [],
    stops: [],
    walks: [],
    route: { points: [], closed: true, corner: 7 },
  }
}

let seq = 0
export function newId(prefix: string) {
  seq += 1
  return `${prefix}-${Date.now().toString(36).slice(-4)}${seq.toString(36)}`
}

/** Проверка и мягкое восстановление документа, загруженного из файла. */
export function normalizeMap(raw: unknown): CampusMap {
  const base = emptyMap()
  if (!raw || typeof raw !== 'object') throw new Error('Файл карты пуст или повреждён')
  const m = raw as Partial<CampusMap>
  if (m.version !== MAP_VERSION) throw new Error(`Неподдерживаемая версия карты: ${String(m.version)}`)
  return {
    ...base,
    ...m,
    version: MAP_VERSION,
    buildings: m.buildings ?? [],
    trees: m.trees ?? [],
    roads: (m.roads ?? []).map((r) => ({ ...r, kind: migrateRoadKind(r.kind, r.width) })),
    zones: m.zones ?? [],
    stops: m.stops ?? [],
    walks: m.walks ?? [],
    route: m.route ?? base.route,
    bounds: m.bounds ?? base.bounds,
    cruiseSpeed: m.cruiseSpeed ?? base.cruiseSpeed,
  }
}

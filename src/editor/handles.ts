/**
 * Маркеры изменения размера: расчёт их положения (для отрисовки и для
 * попадания курсором) и применение перетаскивания к документу карты.
 */
import type { CampusMap, MapRoad, MapWalk, Pt } from '../map/schema'
import type { Selection } from './EditorScene'

export type Handle =
  | { id: string; kind: 'corner' | 'edge'; x: number; y: number; sx: number; sy: number }
  | { id: string; kind: 'rot'; x: number; y: number }
  | { id: string; kind: 'radius'; x: number; y: number }
  | { id: string; kind: 'vertex'; x: number; y: number; index: number }

const round = (v: number) => Math.round(v * 100) / 100
const MIN_HALF = 0.5

/** Углы, середины сторон и ручка поворота выделенного объекта. */
export function computeHandles(doc: CampusMap, sel: Selection): Handle[] {
  if (!sel) return []

  if (sel.kind === 'building' || sel.kind === 'zone') {
    const o =
      sel.kind === 'building'
        ? doc.buildings.find((b) => b.id === sel.id)
        : doc.zones.find((z) => z.id === sel.id)
    if (!o) return []
    const rot = sel.kind === 'building' ? (doc.buildings.find((b) => b.id === sel.id)?.rot ?? 0) : 0
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    const at = (u: number, v: number) => ({ x: o.cx + u * c - v * s, y: o.cy + u * s + v * c })

    const out: Handle[] = []
    for (const sx of [-1, 0, 1]) {
      for (const sy of [-1, 0, 1]) {
        if (sx === 0 && sy === 0) continue
        const p = at(sx * o.hw, sy * o.hh)
        out.push({
          id: `h${sx}${sy}`,
          kind: sx !== 0 && sy !== 0 ? 'corner' : 'edge',
          x: p.x,
          y: p.y,
          sx,
          sy,
        })
      }
    }
    if (sel.kind === 'building') {
      const p = at(0, o.hh + Math.max(4, o.hh * 0.35))
      out.push({ id: 'rot', kind: 'rot', x: p.x, y: p.y })
    }
    return out
  }

  if (sel.kind === 'tree') {
    const t = doc.trees.find((x) => x.id === sel.id)
    if (!t) return []
    return [{ id: 'radius', kind: 'radius', x: t.x + t.r, y: t.y }]
  }

  if (sel.kind === 'road' || sel.kind === 'walk') {
    const o: MapRoad | MapWalk | undefined =
      sel.kind === 'road' ? doc.roads.find((r) => r.id === sel.id) : doc.walks.find((w) => w.id === sel.id)
    if (!o) return []
    return o.points.map(([x, y], index) => ({ id: `v${index}`, kind: 'vertex' as const, x, y, index }))
  }

  return []
}

/** Ближайший маркер в радиусе tol. */
export function hitHandle(doc: CampusMap, sel: Selection, x: number, y: number, tol: number): Handle | null {
  let best: Handle | null = null
  let bestD = tol
  for (const h of computeHandles(doc, sel)) {
    const d = Math.hypot(h.x - x, h.y - y)
    if (d <= bestD) {
      bestD = d
      best = h
    }
  }
  return best
}

/** Применение перетаскивания маркера. Возвращает новый документ. */
export function applyHandle(
  doc: CampusMap,
  sel: Selection,
  h: Handle,
  px: number,
  py: number,
  snap: boolean,
): CampusMap {
  if (!sel) return doc

  if ((sel.kind === 'building' || sel.kind === 'zone') && (h.kind === 'corner' || h.kind === 'edge')) {
    const rot = sel.kind === 'building' ? (doc.buildings.find((b) => b.id === sel.id)?.rot ?? 0) : 0
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    const src =
      sel.kind === 'building'
        ? doc.buildings.find((b) => b.id === sel.id)
        : doc.zones.find((z) => z.id === sel.id)
    if (!src) return doc

    // неподвижная точка — противоположный угол (или противоположная сторона)
    const fx = src.cx + -h.sx * src.hw * c - -h.sy * src.hh * s
    const fy = src.cy + -h.sx * src.hw * s + -h.sy * src.hh * c
    const du = (px - fx) * c + (py - fy) * s
    const dv = -(px - fx) * s + (py - fy) * c

    const hw = h.sx !== 0 ? Math.max(MIN_HALF, Math.abs(du) / 2) : src.hw
    const hh = h.sy !== 0 ? Math.max(MIN_HALF, Math.abs(dv) / 2) : src.hh
    const ou = h.sx !== 0 ? Math.sign(du || 1) * hw : 0
    const ov = h.sy !== 0 ? Math.sign(dv || 1) * hh : 0
    const patch = {
      cx: round(fx + ou * c - ov * s),
      cy: round(fy + ou * s + ov * c),
      hw: round(hw),
      hh: round(hh),
    }
    return sel.kind === 'building'
      ? { ...doc, buildings: doc.buildings.map((b) => (b.id === sel.id ? { ...b, ...patch } : b)) }
      : { ...doc, zones: doc.zones.map((z) => (z.id === sel.id ? { ...z, ...patch } : z)) }
  }

  if (sel.kind === 'building' && h.kind === 'rot') {
    const b = doc.buildings.find((x) => x.id === sel.id)
    if (!b) return doc
    let rot = Math.atan2(py - b.cy, px - b.cx) - Math.PI / 2
    if (snap) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12)
    return { ...doc, buildings: doc.buildings.map((x) => (x.id === sel.id ? { ...x, rot } : x)) }
  }

  if (sel.kind === 'tree' && h.kind === 'radius') {
    const t = doc.trees.find((x) => x.id === sel.id)
    if (!t) return doc
    const r = Math.max(0.4, Math.min(12, Math.hypot(px - t.x, py - t.y)))
    // высота кроны тянется за радиусом, чтобы дерево не выглядело сплющенным
    const h2 = Math.max(t.trunk + 1, round(Math.max(t.h, r * 2.2)))
    return { ...doc, trees: doc.trees.map((x) => (x.id === sel.id ? { ...x, r: round(r), h: h2 } : x)) }
  }

  if (h.kind === 'vertex' && (sel.kind === 'road' || sel.kind === 'walk')) {
    const np: Pt = [round(px), round(py)]
    const upd = <T extends { id: string; points: Pt[] }>(list: T[]) =>
      list.map((o) => (o.id === sel.id ? { ...o, points: o.points.map((p, i) => (i === h.index ? np : p)) } : o))
    return sel.kind === 'road' ? { ...doc, roads: upd(doc.roads) } : { ...doc, walks: upd(doc.walks) }
  }

  return doc
}

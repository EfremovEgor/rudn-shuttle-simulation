import * as THREE from 'three'
import type { Vec2 } from '../../sim/geometry'

/**
 * Мир симуляции: X — восток, Y — север.
 * Сцена three.js: X — восток, Z — юг (z = -y), Y — высота.
 */
export const w2t = (x: number, y: number, h = 0): [number, number, number] => [x, h, -y]

/** Группа, в локальных координатах которой (x, y, h) = (восток, север, высота). */
export const FLAT_ROTATION: [number, number, number] = [-Math.PI / 2, 0, 0]

/** Лента вдоль ломаной (дорога, маршрут, тропа). UV: u — вдоль в метрах, v — поперёк. */
export function ribbonGeometry(pts: Vec2[], width: number, h: number, closed = false) {
  const n = pts.length
  const g = new THREE.BufferGeometry()
  if (n < 2) return g
  const half = width / 2
  const count = closed ? n + 1 : n
  const pos = new Float32Array(count * 2 * 3)
  const uv = new Float32Array(count * 2 * 2)

  let total = 0
  const cum: number[] = [0]
  for (let i = 1; i < count; i++) {
    const a = pts[(i - 1) % n]
    const b = pts[i % n]
    total += Math.hypot(b.x - a.x, b.y - a.y)
    cum.push(total)
  }

  for (let i = 0; i < count; i++) {
    const prev = pts[(i - 1 + n) % n]
    const cur = pts[i % n]
    const next = pts[(i + 1) % n]
    let tx: number
    let ty: number
    if (!closed && i === 0) {
      tx = next.x - cur.x
      ty = next.y - cur.y
    } else if (!closed && i === count - 1) {
      tx = cur.x - prev.x
      ty = cur.y - prev.y
    } else {
      tx = next.x - prev.x
      ty = next.y - prev.y
    }
    const len = Math.hypot(tx, ty) || 1
    const nx = -ty / len
    const ny = tx / len
    const o = i * 6
    pos[o] = cur.x + nx * half
    pos[o + 1] = h
    pos[o + 2] = -(cur.y + ny * half)
    pos[o + 3] = cur.x - nx * half
    pos[o + 4] = h
    pos[o + 5] = -(cur.y - ny * half)
    uv[i * 4] = cum[i]
    uv[i * 4 + 1] = 0
    uv[i * 4 + 2] = cum[i]
    uv[i * 4 + 3] = 1
  }

  const idx: number[] = []
  for (let i = 0; i < count - 1; i++) {
    const a = i * 2
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.userData.length = total
  return g
}

/** Прямоугольник в плоскости земли (мировые метры), с поворотом. */
export function rectGeometry(cx: number, cy: number, hw: number, hh: number, h: number, rot = 0) {
  const g = new THREE.BufferGeometry()
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const corner = (sx: number, sy: number) => {
    const lx = sx * hw
    const ly = sy * hh
    return [cx + lx * c - ly * s, h, -(cy + lx * s + ly * c)]
  }
  const pos = new Float32Array([
    ...corner(-1, -1),
    ...corner(1, -1),
    ...corner(1, 1),
    ...corner(-1, 1),
  ])
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
}

/** Контур прямоугольника как замкнутая ломаная (для drei <Line>). */
export function rectOutline(
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  h: number,
  rot = 0,
): [number, number, number][] {
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const corner = (sx: number, sy: number): [number, number, number] => {
    const lx = sx * hw
    const ly = sy * hh
    return [cx + lx * c - ly * s, h, -(cy + lx * s + ly * c)]
  }
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), corner(-1, -1)]
}

/** Скруглённый прямоугольник в плоскости XY — корпус шаттла на карте. */
export function roundedRectShape(w: number, h: number, r: number) {
  const s = new THREE.Shape()
  const hw = w / 2
  const hh = h / 2
  s.moveTo(-hw + r, -hh)
  s.lineTo(hw - r, -hh)
  s.quadraticCurveTo(hw, -hh, hw, -hh + r)
  s.lineTo(hw, hh - r)
  s.quadraticCurveTo(hw, hh, hw - r, hh)
  s.lineTo(-hw + r, hh)
  s.quadraticCurveTo(-hw, hh, -hw, hh - r)
  s.lineTo(-hw, -hh + r)
  s.quadraticCurveTo(-hw, -hh, -hw + r, -hh)
  return s
}

/** Сетка координат: линии через каждые step метров. */
export function gridGeometry(minX: number, maxX: number, minY: number, maxY: number, step: number, h: number) {
  const pts: number[] = []
  const x0 = Math.ceil(minX / step) * step
  const y0 = Math.ceil(minY / step) * step
  for (let x = x0; x <= maxX; x += step) pts.push(x, h, -minY, x, h, -maxY)
  for (let y = y0; y <= maxY; y += step) pts.push(minX, h, -y, maxX, h, -y)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3))
  return g
}

/** Светлая схематичная палитра (без неона). */
export const PALETTE = {
  bg: '#f4f6f8',
  ground: '#eef1f4',
  grid: '#e2e7ec',
  lawn: '#dcebd2',
  field: '#e8eede',
  water: '#cfe2f2',
  pavement: '#e6e9ed',
  roadTwoLane: '#ccd3db',
  roadOneLane: '#d9dee5',
  roadWalk: '#e7e9ec',
  roadMarking: '#fdfefe',
  roadEdge: '#c3cad3',
  building: '#dbe1e8',
  buildingEdge: '#8e9cac',
  buildingLit: '#cfe1f2',
  buildingEdgeLit: '#2f7fbf',
  route: '#2563eb',
  routeSoft: '#93b4f7',
  stop: '#e8830c',
  shuttle: '#1f2937',
  shuttleTrim: '#ffffff',
  hazard: '#dc2626',
  person: '#ea7317',
  tree: '#8bbd7a',
  treeLit: '#2f9e44',
  label: '#5b6875',
  sensor: '#0f766e',
}

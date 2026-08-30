/** Общие геометрические утилиты симуляции. Мир: X — восток, Y — север (метры). */

export type Vec2 = { x: number; y: number }

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const invLerp = (a: number, b: number, v: number) => (b - a === 0 ? 0 : (v - a) / (b - a))
export const TAU = Math.PI * 2

/** Кадронезависимое экспоненциальное сглаживание. */
export const damp = (cur: number, target: number, lambda: number, dt: number) =>
  lerp(cur, target, 1 - Math.exp(-lambda * dt))

/** Кратчайшая разница углов в диапазоне (-PI, PI]. */
export function angleDelta(a: number, b: number) {
  let d = (b - a) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return d
}

export const dampAngle = (cur: number, target: number, lambda: number, dt: number) =>
  cur + angleDelta(cur, target) * (1 - Math.exp(-lambda * dt))

/** Детерминированный ГПСЧ — сцена кампуса всегда одинаковая. */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Скругление углов ломаной квадратичными кривыми Безье (филеты на поворотах). */
export function roundPolyline(pts: Vec2[], radius: number, closed: boolean, segments = 12): Vec2[] {
  const n = pts.length
  if (n < 3) return pts.slice()
  const out: Vec2[] = []
  const at = (i: number) => pts[(i + n) % n]

  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) {
      out.push({ ...pts[i] })
      continue
    }
    const p = at(i)
    const a = at(i - 1)
    const b = at(i + 1)
    const ax = a.x - p.x
    const ay = a.y - p.y
    const bx = b.x - p.x
    const by = b.y - p.y
    const la = Math.hypot(ax, ay)
    const lb = Math.hypot(bx, by)
    if (la < 1e-5 || lb < 1e-5) {
      out.push({ ...p })
      continue
    }
    const sin = Math.abs((ax * by - ay * bx) / (la * lb))
    if (sin < 1e-3) {
      out.push({ ...p })
      continue
    }
    const r = Math.min(radius, la * 0.45, lb * 0.45)
    const p0 = { x: p.x + (ax / la) * r, y: p.y + (ay / la) * r }
    const p2 = { x: p.x + (bx / lb) * r, y: p.y + (by / lb) * r }
    for (let s = 0; s <= segments; s++) {
      const t = s / segments
      const it = 1 - t
      out.push({
        x: it * it * p0.x + 2 * it * t * p.x + t * t * p2.x,
        y: it * it * p0.y + 2 * it * t * p.y + t * t * p2.y,
      })
    }
  }
  return out
}

export type PathSample = { x: number; y: number; heading: number; limit: number }

/**
 * Замкнутый маршрут с равномерной параметризацией по длине дуги.
 * Хранит предрассчитанный профиль допустимой скорости (кривизна поворотов).
 */
export class RoutePath {
  readonly pts: Vec2[]
  readonly cum: number[] = []
  readonly heading: number[] = []
  readonly limits: number[] = []
  readonly length: number

  constructor(pts: Vec2[], cruise: number) {
    this.pts = pts
    const n = pts.length
    let acc = 0
    this.cum.push(0)
    for (let i = 0; i < n; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % n]
      const dx = b.x - a.x
      const dy = b.y - a.y
      this.heading.push(Math.atan2(dy, dx))
      acc += Math.hypot(dx, dy)
      this.cum.push(acc)
    }
    this.length = acc

    // Профиль скорости: чем круче поворот в ближайшие 10 м, тем медленнее едем.
    for (let i = 0; i < n; i++) {
      let turn = 0
      let travelled = 0
      let j = i
      while (travelled < 12 && j < i + n) {
        const h0 = this.heading[j % n]
        const h1 = this.heading[(j + 1) % n]
        turn += Math.abs(angleDelta(h0, h1))
        travelled += this.cum[(j % n) + 1] - this.cum[j % n]
        j++
      }
      this.limits.push(clamp(cruise / (1 + turn * 2.6), 0.9, cruise))
    }
  }

  wrap(s: number) {
    const L = this.length
    return ((s % L) + L) % L
  }

  /** Индекс сегмента для расстояния s. */
  private seg(s: number) {
    let lo = 0
    let hi = this.cum.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (this.cum[mid] <= s) lo = mid
      else hi = mid
    }
    return lo
  }

  sample(sRaw: number): PathSample {
    const s = this.wrap(sRaw)
    const i = this.seg(s)
    const a = this.pts[i]
    const b = this.pts[(i + 1) % this.pts.length]
    const segLen = this.cum[i + 1] - this.cum[i] || 1e-6
    const t = (s - this.cum[i]) / segLen
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      heading: this.heading[i],
      limit: this.limits[i],
    }
  }

  limitAt(sRaw: number) {
    return this.limits[this.seg(this.wrap(sRaw))]
  }

  /** Расстояние вдоль маршрута до точки, ближайшей к (x, y). */
  project(x: number, y: number) {
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < this.pts.length; i++) {
      const a = this.pts[i]
      const b = this.pts[(i + 1) % this.pts.length]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len2 = dx * dx + dy * dy || 1e-6
      const t = clamp(((x - a.x) * dx + (y - a.y) * dy) / len2, 0, 1)
      const px = a.x + dx * t
      const py = a.y + dy * t
      const d = (px - x) ** 2 + (py - y) ** 2
      if (d < bestD) {
        bestD = d
        best = this.cum[i] + Math.hypot(dx, dy) * t
      }
    }
    return best
  }

  /** Дистанция вперёд по маршруту от a до b (всегда положительная). */
  ahead(a: number, b: number) {
    return this.wrap(b - a)
  }
}

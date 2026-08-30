/**
 * Модель вращающегося 16-лучевого лидара (аналог VLP-16) на крыше шаттла.
 * Каждый кадр досвечивается сектор азимутов: для луча решается 2D-пересечение
 * с препятствиями кампуса, затем по каналам считается высота попадания —
 * стена, крона, ствол, асфальт или «нет отражения».
 *
 * Точки пишутся в общий буфер в координатах three.js (x, вверх, -y).
 */
import { TAU } from './geometry'
import { campus } from '../map/runtime'
import type { Obstacle, ObstacleClass } from '../map/runtime'
import { sim } from './engine'

export const N_AZIMUTH = 900
export const N_CHANNELS = 16
export const MAX_RANGE = 55
export const SENSOR_HEIGHT = 2.35
/** оборотов в секунду */
export const SPIN_HZ = 8
export const POINT_LIFETIME = 0.72
export const TOTAL_POINTS = N_AZIMUTH * N_CHANNELS

/** Углы места каналов, градусы: плотнее у горизонта. */
const ELEVATIONS_DEG = [
  -16, -13, -10.5, -8.5, -7, -5.6, -4.4, -3.3, -2.3, -1.4, -0.6, 0.4, 1.4, 2.6, 4, 6,
]
const TAN_ELEV = ELEVATIONS_DEG.map((d) => Math.tan((d * Math.PI) / 180))

export type Detection = {
  id: string
  label: string
  cls: ObstacleClass
  track: string
  cx: number
  cy: number
  hw: number
  hh: number
  top: number
  dist: number
  points: number
}

type Hit = { t: number; z0: number; z1: number; obs: Obstacle }

const NOISE: number[] = []
for (let i = 0; i < 4096; i++) NOISE.push(Math.random() * 2 - 1)

const PLACEHOLDER: Obstacle = {
  id: '', label: '', cls: 'building', shape: 0,
  cx: 0, cy: 0, hw: 0, hh: 0, radius: 0, cos: 1, sin: 0, z0: 0, z1: 0, br: 0,
}

export class LidarSim {
  positions = new Float32Array(TOTAL_POINTS * 3)
  birth = new Float32Array(TOTAL_POINTS)
  intensity = new Float32Array(TOTAL_POINTS)
  cls = new Float32Array(TOTAL_POINTS)

  time = 0
  azimuth = 0
  revolution = 0
  detections: Detection[] = []
  /** время последнего попадания по дереву — карта подсвечивает «увиденное» */
  treeHitTime = new Float32Array(1)
  buildingHitTime = new Map<string, number>()
  pointsPerSecond = Math.round(TOTAL_POINTS * SPIN_HZ)
  activeCount = 0
  dirtyLo = Infinity
  dirtyHi = -Infinity
  dirtyAll = false

  private azFloat = 0
  private active: Obstacle[] = []
  private lastActiveUpdate = -999
  private lastActivePos = { x: 1e9, y: 1e9 }
  private hits: Hit[] = []
  private hitCount = 0
  private accum = new Map<string, { count: number; dist: number }>()
  private tracks = new Map<string, string>()
  private trackSeq = 1
  private dynamic: Obstacle[] = []
  private noiseCursor = 0

  constructor() {
    for (let i = 0; i < 64; i++) this.hits.push({ t: 0, z0: 0, z1: 0, obs: PLACEHOLDER })
    this.rebuild()
  }

  /** Полный сброс — вызывается при смене карты. */
  rebuild() {
    this.intensity.fill(-1)
    this.birth.fill(-1000)
    this.positions.fill(0)
    this.treeHitTime = new Float32Array(Math.max(1, campus.trees.length))
    this.buildingHitTime.clear()
    this.detections = []
    this.accum.clear()
    this.tracks.clear()
    this.trackSeq = 1
    this.active.length = 0
    this.lastActiveUpdate = -999
    this.lastActivePos = { x: 1e9, y: 1e9 }
    this.dirtyAll = true
  }

  private noise() {
    this.noiseCursor = (this.noiseCursor + 1) & 4095
    return NOISE[this.noiseCursor]
  }

  /** Пешеходы — динамические цилиндры, обновляются каждый кадр. */
  private syncDynamic() {
    while (this.dynamic.length < sim.pedestrians.length) {
      this.dynamic.push({
        id: `p:${this.dynamic.length}`,
        label: 'Пешеход',
        cls: 'person',
        shape: 1,
        cx: 0, cy: 0, hw: 0.32, hh: 0.32, radius: 0.32,
        cos: 1, sin: 0, z0: 0, z1: 1.78, br: 0.32,
      })
    }
    this.dynamic.length = sim.pedestrians.length
    for (let i = 0; i < sim.pedestrians.length; i++) {
      const p = sim.pedestrians[i]
      const o = this.dynamic[i]
      o.cx = p.x
      o.cy = p.y
      o.id = `p:${p.id}`
    }
  }

  private updateActive(ox: number, oy: number) {
    const moved = (ox - this.lastActivePos.x) ** 2 + (oy - this.lastActivePos.y) ** 2
    if (moved < 4 && this.time - this.lastActiveUpdate < 0.4) return
    this.lastActiveUpdate = this.time
    this.lastActivePos.x = ox
    this.lastActivePos.y = oy
    this.active.length = 0
    const reach = MAX_RANGE + 12
    const list = campus.obstacles
    for (let i = 0; i < list.length; i++) {
      const o = list[i]
      if (Math.hypot(o.cx - ox, o.cy - oy) - o.br < reach) this.active.push(o)
    }
    this.activeCount = this.active.length
  }

  /** 2D-пересечения луча со всеми активными препятствиями. */
  private castRay(ox: number, oy: number, dx: number, dy: number) {
    this.hitCount = 0
    const push = (t: number, o: Obstacle) => {
      if (t <= 0.4 || t > MAX_RANGE) return
      if (this.hitCount >= this.hits.length) this.hits.push({ t: 0, z0: 0, z1: 0, obs: o })
      const h = this.hits[this.hitCount++]
      h.t = t
      h.z0 = o.z0
      h.z1 = o.z1
      h.obs = o
    }

    const test = (o: Obstacle) => {
      const rx = o.cx - ox
      const ry = o.cy - oy
      const proj = rx * dx + ry * dy
      if (proj < -o.br || proj > MAX_RANGE + o.br) return
      const perp = Math.abs(-rx * dy + ry * dx)
      if (perp > o.br + 0.05) return

      if (o.shape === 1) {
        const disc = o.radius * o.radius - perp * perp
        if (disc <= 0) return
        push(proj - Math.sqrt(disc), o)
      } else {
        // переводим луч в систему координат повёрнутого прямоугольника
        const lx = rx * o.cos + ry * o.sin
        const ly = -rx * o.sin + ry * o.cos
        let ldx = dx * o.cos + dy * o.sin
        let ldy = -dx * o.sin + dy * o.cos
        if (Math.abs(ldx) < 1e-9) ldx = ldx < 0 ? -1e-9 : 1e-9
        if (Math.abs(ldy) < 1e-9) ldy = ldy < 0 ? -1e-9 : 1e-9
        let t1 = (lx - o.hw) / ldx
        let t2 = (lx + o.hw) / ldx
        if (t1 > t2) {
          const tmp = t1
          t1 = t2
          t2 = tmp
        }
        let t3 = (ly - o.hh) / ldy
        let t4 = (ly + o.hh) / ldy
        if (t3 > t4) {
          const tmp = t3
          t3 = t4
          t4 = tmp
        }
        const tmin = Math.max(t1, t3)
        const tmax = Math.min(t2, t4)
        if (tmax < Math.max(tmin, 0)) return
        push(tmin, o)
      }
    }

    for (let i = 0; i < this.active.length; i++) test(this.active[i])
    for (let i = 0; i < this.dynamic.length; i++) test(this.dynamic[i])

    // сортировка вставками — попаданий обычно единицы
    for (let i = 1; i < this.hitCount; i++) {
      const h = this.hits[i]
      let j = i - 1
      while (j >= 0 && this.hits[j].t > h.t) {
        this.hits[j + 1] = this.hits[j]
        j--
      }
      this.hits[j + 1] = h
    }
  }

  private scanColumn(col: number, ox: number, oy: number) {
    const angle = (col / N_AZIMUTH) * TAU
    const dx = Math.cos(angle)
    const dy = Math.sin(angle)
    this.castRay(ox, oy, dx, dy)

    const base = col * N_CHANNELS
    for (let ch = 0; ch < N_CHANNELS; ch++) {
      const tan = TAN_ELEV[ch]
      const i3 = (base + ch) * 3
      let range = -1
      let z = 0
      let cls = 0
      let obsId: string | null = null

      const tGround = tan < -1e-4 ? SENSOR_HEIGHT / -tan : Infinity

      for (let k = 0; k < this.hitCount; k++) {
        const h = this.hits[k]
        if (h.t > tGround) break
        const zh = SENSOR_HEIGHT + h.t * tan
        if (zh >= h.z0 && zh <= h.z1) {
          range = h.t
          z = zh
          obsId = h.obs.id
          cls = h.obs.cls === 'building' ? 1 : h.obs.cls === 'tree' ? 2 : 3
          break
        }
      }

      if (range < 0 && tGround <= MAX_RANGE) {
        range = tGround
        z = 0
        cls = 0
      }

      if (range < 0) {
        this.intensity[base + ch] = -1
        continue
      }

      const jitter = this.noise() * (cls === 2 ? 0.09 : 0.02)
      const r = range + jitter
      this.positions[i3] = ox + dx * r
      this.positions[i3 + 1] = z + (cls === 2 ? this.noise() * 0.12 : 0)
      this.positions[i3 + 2] = -(oy + dy * r)
      this.birth[base + ch] = this.time
      this.cls[base + ch] = cls
      const falloff = 1 - Math.min(range / MAX_RANGE, 1) * 0.45
      const baseInt = cls === 0 ? 0.22 : cls === 1 ? 0.55 : cls === 2 ? 0.82 : 0.95
      this.intensity[base + ch] = Math.max(0.05, (baseInt + this.noise() * 0.08) * falloff)

      if (obsId) {
        const rec = this.accum.get(obsId)
        if (rec) {
          rec.count++
          if (range < rec.dist) rec.dist = range
        } else {
          this.accum.set(obsId, { count: 1, dist: range })
        }
        if (cls === 2) {
          const ti = Number(obsId.slice(2))
          if (ti >= 0 && ti < this.treeHitTime.length) this.treeHitTime[ti] = this.time
        } else if (cls === 1) {
          this.buildingHitTime.set(obsId, this.time)
        }
      }
    }
  }

  private publishDetections() {
    const list: Detection[] = []
    for (const [id, rec] of this.accum) {
      if (rec.count < 4) continue
      const cls: ObstacleClass = id.startsWith('p:') ? 'person' : id.startsWith('t:') ? 'tree' : 'building'
      let ext = campus.extents.get(id)
      if (!ext && cls === 'person') {
        const pid = Number(id.slice(2))
        const p = sim.pedestrians.find((q) => q.id === pid)
        if (!p) continue
        ext = { cx: p.x, cy: p.y, hw: 0.42, hh: 0.42, top: 1.78, cls: 'person', label: 'Пешеход' }
      }
      if (!ext) continue
      if (!this.tracks.has(id)) this.tracks.set(id, `TRK-${String(this.trackSeq++).padStart(3, '0')}`)
      list.push({
        id,
        label: ext.label,
        cls,
        track: this.tracks.get(id)!,
        cx: ext.cx,
        cy: ext.cy,
        hw: ext.hw,
        hh: ext.hh,
        top: ext.top,
        dist: rec.dist,
        points: rec.count,
      })
    }
    list.sort((a, b) => {
      const w = (d: Detection) => (d.cls === 'person' ? -1000 : 0) + d.dist
      return w(a) - w(b)
    })
    this.detections = list.slice(0, 9)
    this.accum.clear()
  }

  step(dt: number) {
    if (!sim.running) return
    const scaled = Math.min(dt, 0.1) * sim.timeScale
    this.time += scaled
    const ox = sim.x
    const oy = sim.y
    this.syncDynamic()
    this.updateActive(ox, oy)

    const prev = this.azFloat
    this.azFloat += N_AZIMUTH * SPIN_HZ * scaled
    let steps = Math.floor(this.azFloat) - Math.floor(prev)
    if (steps > N_AZIMUTH) steps = N_AZIMUTH
    const start = Math.floor(prev)
    for (let k = 1; k <= steps; k++) {
      const col = (((start + k) % N_AZIMUTH) + N_AZIMUTH) % N_AZIMUTH
      if (col === 0) {
        this.revolution++
        this.publishDetections()
      }
      this.scanColumn(col, ox, oy)
      const lo = col * N_CHANNELS
      if (lo < this.dirtyLo) this.dirtyLo = lo
      if (lo + N_CHANNELS > this.dirtyHi) this.dirtyHi = lo + N_CHANNELS
    }
    if (steps >= N_AZIMUTH) this.dirtyAll = true
    if (this.azFloat > N_AZIMUTH * 1024) this.azFloat %= N_AZIMUTH
    this.azimuth = ((this.azFloat / N_AZIMUTH) % 1) * TAU
  }
}

/** Диапазон изменённых точек для частичной выгрузки буфера в GPU. */
export function consumeDirty(l: LidarSim): { offset: number; count: number } | null {
  if (l.dirtyAll) {
    l.dirtyAll = false
    l.dirtyLo = Infinity
    l.dirtyHi = -Infinity
    return { offset: 0, count: TOTAL_POINTS }
  }
  if (l.dirtyHi <= l.dirtyLo) return null
  const r = { offset: l.dirtyLo, count: l.dirtyHi - l.dirtyLo }
  l.dirtyLo = Infinity
  l.dirtyHi = -Infinity
  return r
}

export const lidar = new LidarSim()

/**
 * Ядро симуляции: продольная динамика шаттла, расписание остановок,
 * пешеходы и реакция на препятствия. Состояние — один мутабельный объект,
 * который читают все сцены (без ре-рендеров React на каждом кадре).
 */
import { campus } from '../map/runtime'
import { clamp, damp, dampAngle, mulberry32 } from './geometry'
import type { Vec2 } from './geometry'

export type ShuttleMode = 'DRIVE' | 'APPROACH' | 'BOARDING' | 'HAZARD' | 'PAUSED'

export type Pedestrian = {
  id: number
  route: Vec2[]
  seg: number
  t: number
  speed: number
  x: number
  y: number
  heading: number
  phase: number
  alert: boolean
}

export type Hazard = { dist: number; lateral: number; id: number } | null

const ACCEL = 0.85
const DECEL = 1.3
const EMERGENCY_DECEL = 2.8
const SAFETY_GAP = 6.5
const CORRIDOR_HALF_WIDTH = 2.4
const LOOKAHEAD = 15

export const sim = {
  time: 0,
  running: true,
  timeScale: 1,
  /** путь вдоль маршрута, м */
  s: 0,
  speed: 0,
  accel: 0,
  targetSpeed: 0,
  x: 0,
  y: 0,
  heading: 0,
  /** сглаженный курс — для плавного поворота иконки и камер */
  yaw: 0,
  mode: 'DRIVE' as ShuttleMode,
  battery: 86.4,
  odometer: 0,
  laps: 0,
  doors: 0,
  passengers: 7,
  dwell: 0,
  nextStop: 0,
  /** остановка засчитывается только после того, как шаттл от неё отъехал */
  stopArmed: true,
  distToStop: 0,
  etaToStop: 0,
  hazard: null as Hazard,
  pedestrians: [] as Pedestrian[],
  trail: [] as { x: number; y: number }[],
}

const rnd = mulberry32(7391)

function initPedestrians() {
  sim.pedestrians = []
  campus.walks.forEach((route, i) => {
    const seg = Math.floor(rnd() * route.length)
    sim.pedestrians.push({
      id: i,
      route,
      seg,
      t: rnd(),
      speed: 1.05 + rnd() * 0.75,
      x: route[seg].x,
      y: route[seg].y,
      heading: 0,
      phase: rnd() * 10,
      alert: false,
    })
  })
}

export function resetSim() {
  const stops = campus.stops
  sim.time = 0
  sim.s = stops.length ? stops[0].s : 0
  sim.speed = 0
  sim.odometer = 0
  sim.laps = 0
  sim.battery = 86.4
  sim.passengers = 7
  sim.doors = 0
  sim.nextStop = 0
  sim.stopArmed = true
  sim.hazard = null
  sim.trail = []
  if (stops.length) {
    sim.dwell = stops[0].dwell
    sim.mode = 'BOARDING'
  } else {
    sim.dwell = 0
    sim.mode = 'DRIVE'
  }
  initPedestrians()
  const p = campus.route.sample(sim.s)
  sim.x = p.x
  sim.y = p.y
  sim.heading = p.heading
  sim.yaw = p.heading
}

resetSim()

function stepPedestrians(dt: number) {
  for (const p of sim.pedestrians) {
    const n = p.route.length
    const a = p.route[p.seg % n]
    const b = p.route[(p.seg + 1) % n]
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    p.t += (p.speed * dt) / len
    while (p.t >= 1) {
      p.t -= 1
      p.seg = (p.seg + 1) % n
    }
    const a2 = p.route[p.seg % n]
    const b2 = p.route[(p.seg + 1) % n]
    p.x = a2.x + (b2.x - a2.x) * p.t
    p.y = a2.y + (b2.y - a2.y) * p.t
    p.heading = Math.atan2(b2.y - a2.y, b2.x - a2.x)
    p.phase += dt * p.speed * 3.4
    p.alert = false
  }
}

/** Поиск пешехода в коридоре движения — срабатывание лидара и камер. */
function scanCorridor(): Hazard {
  const fx = Math.cos(sim.heading)
  const fy = Math.sin(sim.heading)
  let best: Hazard = null
  let bestPed: Pedestrian | null = null
  for (const p of sim.pedestrians) {
    const dx = p.x - sim.x
    const dy = p.y - sim.y
    const u = dx * fx + dy * fy
    const v = -dx * fy + dy * fx
    if (u < -1 || u > LOOKAHEAD) continue
    if (Math.abs(v) > CORRIDOR_HALF_WIDTH + u * 0.06) continue
    if (!best || u < best.dist) {
      best = { dist: u, lateral: v, id: p.id }
      bestPed = p
    }
  }
  if (bestPed) bestPed.alert = true
  return best
}

/** Шаг симуляции. При ускорении времени дробится на подшаги ≤ 50 мс. */
export function stepSim(dtReal: number) {
  if (!sim.running) {
    sim.mode = 'PAUSED'
    return
  }
  const total = Math.min(dtReal, 0.1) * sim.timeScale
  const parts = Math.max(1, Math.min(8, Math.ceil(total / 0.05)))
  for (let i = 0; i < parts; i++) advance(total / parts)
}

function advance(dt: number) {
  const route = campus.route
  const stops = campus.stops
  sim.time += dt

  stepPedestrians(dt)
  sim.hazard = scanCorridor()
  const hazard = sim.hazard

  const stop = stops.length ? stops[Math.min(sim.nextStop, stops.length - 1)] : null
  const distToStop = stop ? route.ahead(sim.s, stop.s) : Infinity
  sim.distToStop = stop ? distToStop : 0

  if (sim.mode === 'BOARDING' && stop) {
    sim.dwell -= dt
    sim.speed = 0
    sim.targetSpeed = 0
    if (sim.dwell <= 0) {
      sim.mode = 'DRIVE'
      sim.stopArmed = false
      sim.nextStop = (sim.nextStop + 1) % stops.length
      if (sim.nextStop === 0) sim.laps += 1
      sim.passengers = clamp(sim.passengers + Math.round((rnd() - 0.45) * 6), 0, 12)
    }
  } else {
    // Профиль скорости: круиз / кривизна / подъезд к остановке / препятствие
    const cruise = campus.cruise
    const routeLimit = Math.min(route.limitAt(sim.s + 5), route.limitAt(sim.s + 12))
    const stopLimit = stop && sim.stopArmed ? Math.sqrt(2 * DECEL * Math.max(0, distToStop - 0.5)) : cruise
    let hazardLimit = cruise
    if (hazard) {
      hazardLimit =
        hazard.dist <= SAFETY_GAP ? 0 : Math.sqrt(2 * EMERGENCY_DECEL * (hazard.dist - SAFETY_GAP))
    }
    const target = Math.min(cruise, routeLimit, stopLimit, hazardLimit)
    sim.targetSpeed = target

    const diff = target - sim.speed
    const rate = diff > 0 ? ACCEL : hazard && hazardLimit < 0.6 ? EMERGENCY_DECEL : DECEL
    const step = Math.sign(diff) * rate * dt
    sim.speed = Math.max(0, Math.abs(step) > Math.abs(diff) ? target : sim.speed + step)
    sim.accel = damp(sim.accel, diff > 0 ? rate : -rate, 6, dt)

    if (hazard && sim.speed < 0.05) sim.mode = 'HAZARD'
    else if (stop && sim.stopArmed && distToStop < 22) sim.mode = 'APPROACH'
    else sim.mode = 'DRIVE'

    if (!sim.stopArmed && distToStop > 8) sim.stopArmed = true

    const ds = sim.speed * dt
    if (stop && sim.stopArmed && (distToStop < 0.7 || ds >= distToStop)) {
      // подъехали или проскочили бы точку за этот шаг — фиксируемся на остановке
      sim.s = stop.s
      sim.speed = 0
      sim.mode = 'BOARDING'
      sim.dwell = stop.dwell
      sim.odometer += distToStop
    } else {
      sim.s = route.wrap(sim.s + ds)
      sim.odometer += ds
    }
    sim.battery -= sim.speed * dt * 0.0026 + dt * 0.0004
    if (sim.battery < 12) sim.battery = 86.4 // условная смена батареи на базе
  }

  sim.etaToStop = sim.speed > 0.3 ? distToStop / Math.max(sim.speed, 0.3) : distToStop / campus.cruise

  const p = route.sample(sim.s)
  sim.x = p.x
  sim.y = p.y
  sim.heading = p.heading
  sim.yaw = dampAngle(sim.yaw, p.heading, 7, dt)

  sim.doors = damp(sim.doors, sim.mode === 'BOARDING' && sim.dwell > 1.2 ? 1 : 0, 3.5, dt)

  const last = sim.trail[sim.trail.length - 1]
  if (!last || (last.x - sim.x) ** 2 + (last.y - sim.y) ** 2 > 1.4) {
    sim.trail.push({ x: sim.x, y: sim.y })
    if (sim.trail.length > 240) sim.trail.shift()
  }
}

export const MODE_LABEL: Record<ShuttleMode, string> = {
  DRIVE: 'Автопилот · движение',
  APPROACH: 'Подъезд к остановке',
  BOARDING: 'Посадка / высадка',
  HAZARD: 'Экстренная остановка',
  PAUSED: 'Симуляция на паузе',
}

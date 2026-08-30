/**
 * Журнал событий для демонстрационного режима: пешеходы в коридоре,
 * прибытие на остановку, двери, отправление. Переходы состояний ищутся
 * в том же цикле, что и физика, — без дополнительных таймеров.
 */
import { create } from 'zustand'
import { campus } from '../map/runtime'
import { sim } from './engine'
import type { ShuttleMode } from './engine'

export type EventKind = 'pedestrian' | 'stop' | 'doors' | 'drive'

export type SimEvent = {
  id: number
  kind: EventKind
  title: string
  detail: string
  /** модельное время события, с */
  at: number
}

const MAX_EVENTS = 5

export const useEvents = create<{ list: SimEvent[] }>(() => ({ list: [] }))

let seq = 0
function push(kind: EventKind, title: string, detail: string) {
  const ev: SimEvent = { id: ++seq, kind, title, detail, at: sim.time }
  useEvents.setState((s) => ({ list: [ev, ...s.list].slice(0, MAX_EVENTS) }))
}

/** дистанция, с которой помеха реально влияет на скорость */
const HAZARD_NEAR = 9.5
/** сколько секунд коридор должен быть чист, чтобы снять предупреждение */
const HAZARD_CLEAR = 0.8

let prevMode: ShuttleMode = sim.mode
let prevHazard = false
let prevDoorsOpen = false
let prevStop = sim.nextStop
let clearTimer = 0
let prevTime = sim.time

function stopLabel(index: number) {
  const s = campus.stops[index]
  return s ? `${s.code} · ${s.name}` : 'остановка'
}

export function resetEvents() {
  useEvents.setState({ list: [] })
  prevMode = sim.mode
  prevHazard = false
  prevDoorsOpen = sim.doors > 0.5
  prevStop = sim.nextStop
  clearTimer = HAZARD_CLEAR
  prevTime = sim.time
}

/** Вызывается каждый кадр после stepSim. */
export function detectEvents() {
  if (!sim.running) return

  const dt = Math.max(0, sim.time - prevTime)
  prevTime = sim.time

  // помеха засчитывается, только когда она действительно тормозит шаттл;
  // короткие пропадания сглаживаются, чтобы сообщения не мигали
  const near = sim.hazard !== null && sim.hazard.dist < HAZARD_NEAR
  clearTimer = near ? 0 : clearTimer + dt
  const hazard = near || (prevHazard && clearTimer < HAZARD_CLEAR)

  if (hazard && !prevHazard) {
    const d = sim.hazard ? sim.hazard.dist.toFixed(1) : '—'
    push(
      'pedestrian',
      'Пешеход в коридоре движения',
      sim.speed < 0.4 ? `дистанция ${d} м · шаттл остановлен` : `дистанция ${d} м · торможение`,
    )
  } else if (!hazard && prevHazard) {
    push('drive', 'Путь свободен', 'пешеход покинул коридор, движение возобновлено')
  }
  prevHazard = hazard

  if (sim.mode !== prevMode) {
    if (sim.mode === 'APPROACH') {
      push('stop', 'Подъезд к остановке', stopLabel(sim.nextStop))
    } else if (sim.mode === 'BOARDING') {
      push('stop', 'Прибытие на остановку', stopLabel(sim.nextStop))
    } else if (sim.mode === 'DRIVE' && prevMode === 'BOARDING') {
      push('drive', 'Отправление', `следующая — ${stopLabel(sim.nextStop)}`)
    }
    prevMode = sim.mode
  }

  if (sim.nextStop !== prevStop) prevStop = sim.nextStop

  const doorsOpen = sim.doors > 0.55
  if (doorsOpen !== prevDoorsOpen) {
    if (doorsOpen) push('doors', 'Двери открыты', 'посадка и высадка пассажиров')
    else push('doors', 'Двери закрыты', 'шаттл готов к движению')
    prevDoorsOpen = doorsOpen
  }
}

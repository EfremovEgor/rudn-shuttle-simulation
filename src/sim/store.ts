import { create } from 'zustand'
import { sim } from './engine'
import type { ShuttleMode } from './engine'
import { lidar } from './lidar'
import { campus, onCampusChange } from '../map/runtime'
import type { CampusRuntime } from '../map/runtime'

export type LidarView = 'chase' | 'orbit' | 'top'
export type ColorMode = 'height' | 'intensity' | 'class'
export type CameraId = 0 | 1 | 2 | 3

export const CAMERA_NAMES = ['Фронтальная', 'Левая', 'Правая', 'Кормовая']

/** Ступени ускорения времени: от замедленного показа до ×10. */
export const TIME_SCALES = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

export const formatScale = (v: number) => `×${v}`

/** Шаг вверх/вниз по ступеням ускорения (кнопки + и −). */
export function stepTimeScale(dir: 1 | -1) {
  const cur = useUi.getState().timeScale
  let i = TIME_SCALES.indexOf(cur)
  if (i < 0) {
    i = TIME_SCALES.findIndex((v) => v >= cur)
    if (i < 0) i = TIME_SCALES.length - 1
  }
  const next = TIME_SCALES[Math.max(0, Math.min(TIME_SCALES.length - 1, i + dir))]
  if (next !== cur) useUi.setState({ timeScale: next })
}

/** Текущая карта — сцены пересобираются при смене revision. */
export const useCampus = create<{ rt: CampusRuntime }>(() => ({ rt: campus }))
onCampusChange((rt) => useCampus.setState({ rt }))

type UiState = {
  running: boolean
  timeScale: number
  follow: boolean
  showTrees: boolean
  showLabels: boolean
  showCoverage: boolean
  showCamera: boolean
  lidarView: LidarView
  colorMode: ColorMode
  camera: CameraId
  set: (patch: Partial<Omit<UiState, 'set' | 'toggle'>>) => void
  toggle: (key: 'running' | 'follow' | 'showTrees' | 'showLabels' | 'showCoverage' | 'showCamera') => void
}

export const useUi = create<UiState>((set) => ({
  running: true,
  timeScale: 1,
  follow: false,
  showTrees: true,
  showLabels: true,
  showCoverage: true,
  showCamera: true,
  lidarView: 'chase',
  colorMode: 'height',
  camera: 0,
  set: (patch) => set(patch),
  toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<UiState>),
}))

export type Telemetry = {
  mode: ShuttleMode
  speed: number
  targetSpeed: number
  battery: number
  passengers: number
  odometer: number
  laps: number
  simTime: number
  doors: number
  dwell: number
  nextStopName: string
  nextStopCode: string
  distToStop: number
  eta: number
  hazardDist: number | null
  detections: number
  persons: number
  nearest: { label: string; dist: number; cls: string } | null
  revolution: number
  activeObstacles: number
  progress: number
}

export const useTelemetry = create<Telemetry>(() => ({
  mode: 'DRIVE',
  speed: 0,
  targetSpeed: 0,
  battery: 86,
  passengers: 7,
  odometer: 0,
  laps: 0,
  simTime: 0,
  doors: 0,
  dwell: 0,
  nextStopName: '—',
  nextStopCode: '—',
  distToStop: 0,
  eta: 0,
  hazardDist: null,
  detections: 0,
  persons: 0,
  nearest: null,
  revolution: 0,
  activeObstacles: 0,
  progress: 0,
}))

const CLS_LABEL: Record<string, string> = {
  building: 'Здание',
  tree: 'Дерево',
  person: 'Человек',
}

export function publishTelemetry() {
  const stops = campus.stops
  const stop = stops.length ? stops[Math.min(sim.nextStop, stops.length - 1)] : null
  const d = lidar.detections
  const near = d[0]
  useTelemetry.setState({
    mode: sim.mode,
    speed: sim.speed,
    targetSpeed: sim.targetSpeed,
    battery: sim.battery,
    passengers: sim.passengers,
    odometer: sim.odometer,
    laps: sim.laps,
    simTime: sim.time,
    doors: sim.doors,
    dwell: Math.max(0, sim.dwell),
    nextStopName: stop ? stop.name : 'Маршрут без остановок',
    nextStopCode: stop ? stop.code : '—',
    distToStop: sim.distToStop,
    eta: sim.etaToStop,
    hazardDist: sim.hazard ? sim.hazard.dist : null,
    detections: d.length,
    persons: d.filter((x) => x.cls === 'person').length,
    nearest: near ? { label: near.label, dist: near.dist, cls: CLS_LABEL[near.cls] ?? near.cls } : null,
    revolution: lidar.revolution,
    activeObstacles: lidar.activeCount,
    progress: campus.route.length ? sim.s / campus.route.length : 0,
  })
}

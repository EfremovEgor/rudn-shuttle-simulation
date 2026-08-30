import { useEffect, useRef, useState } from 'react'

import { MapView } from './MapScreen'
import { LidarView } from './LidarScreen'
import CameraFeed from './CameraFeed'
import { CAMERA_NAMES, formatScale, stepTimeScale, TIME_SCALES, useTelemetry, useUi } from '../sim/store'
import type { CameraId } from '../sim/store'
import { useEvents } from '../sim/events'
import type { EventKind } from '../sim/events'

/**
 * Демонстрационный режим для большого экрана 1920×1080:
 * только две сцены, четыре камеры, статус движения и события —
 * пешеходы, остановки, двери. Без телеметрии и настроек.
 */

const EVENT_ICON: Record<EventKind, string> = {
  pedestrian: '⚠',
  stop: '◉',
  doors: '⇔',
  drive: '▶',
}

const CAMERAS: CameraId[] = [0, 1, 2, 3]

function statusOf(t: ReturnType<typeof useTelemetry.getState>, running: boolean) {
  if (!running) return { tone: 'idle', text: 'Пауза', hint: 'симуляция остановлена' }
  if (t.hazardDist !== null && t.hazardDist < 9.5)
    return t.speed < 0.3
      ? { tone: 'alert', text: 'Стоп · пешеход', hint: `помеха в ${t.hazardDist.toFixed(1)} м впереди` }
      : { tone: 'alert', text: 'Пешеход впереди', hint: `${t.hazardDist.toFixed(1)} м · снижение скорости` }
  if (t.mode === 'BOARDING')
    return {
      tone: 'board',
      text: 'Посадка / высадка',
      hint: t.doors > 0.5 ? 'двери открыты' : 'двери закрываются',
    }
  if (t.speed < 0.3) return { tone: 'idle', text: 'Остановлен', hint: 'скорость 0 км/ч' }
  return { tone: 'move', text: 'В движении', hint: `${(t.speed * 3.6).toFixed(1)} км/ч` }
}

function fmt(at: number) {
  const m = Math.floor(at / 60)
  const s = Math.floor(at % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function DemoPage({ onExit }: { onExit: () => void }) {
  const t = useTelemetry()
  const running = useUi((s) => s.running)
  const timeScale = useUi((s) => s.timeScale)
  const toggle = useUi((s) => s.toggle)
  const events = useEvents((s) => s.list)
  const status = statusOf(t, running)
  const root = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(false)

  useEffect(() => {
    const onChange = () => setFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault()
        toggle('running')
      } else if (e.key === '+' || e.key === '=' || e.key === 'Add') {
        stepTimeScale(1)
      } else if (e.key === '-' || e.key === '_') {
        stepTimeScale(-1)
      } else if (e.key === 'Escape' && !document.fullscreenElement) {
        onExit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onExit, toggle])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void root.current?.requestFullscreen()
  }

  return (
    <div className="demo" ref={root}>
      <header className="demo-head">
        <div className="demo-title">
          <span className="demo-mark" />
          <div>
            <b>РУДН · автономный электрошаттл</b>
            <span>демонстрация движения по кампусу</span>
          </div>
        </div>

        <div className={`demo-status st-${status.tone}`}>
          <i />
          <b>{status.text}</b>
          <span>{status.hint}</span>
        </div>

        <div className="demo-stop">
          <span>Следующая остановка</span>
          <b>{t.nextStopName}</b>
          <em>
            {t.mode === 'BOARDING' ? `отправление через ${t.dwell.toFixed(0)} с` : `${t.distToStop.toFixed(0)} м`}
          </em>
        </div>

        <div className="demo-actions">
          <div className="stepper demo-stepper" title="Скорость симуляции (клавиши + и −)">
            <button className="step-btn" onClick={() => stepTimeScale(-1)} disabled={timeScale <= TIME_SCALES[0]}>
              −
            </button>
            <span className="step-val">{formatScale(timeScale)}</span>
            <button
              className="step-btn"
              onClick={() => stepTimeScale(1)}
              disabled={timeScale >= TIME_SCALES[TIME_SCALES.length - 1]}
            >
              +
            </button>
          </div>
          <button className="demo-btn" onClick={() => toggle('running')}>
            {running ? '❚❚' : '▶'}
          </button>
          <button className="demo-btn" onClick={toggleFullscreen} title="На весь экран">
            {full ? '⤡' : '⛶'}
          </button>
          <button className="demo-btn" onClick={onExit} title="Выйти из демо-режима (Esc)">
            ✕
          </button>
        </div>
      </header>

      <main className="demo-main">
        <section className="demo-panel">
          <h2>Экран 1 · схема территории</h2>
          <div className="demo-canvas">
            <MapView />
          </div>
        </section>
        <section className="demo-panel">
          <h2>Экран 2 · облако точек лидара</h2>
          <div className="demo-canvas">
            <LidarView camera={false} />
          </div>
        </section>
      </main>

      <footer className="demo-foot">
        <div className="demo-cams">
          {CAMERAS.map((id) => (
            <div className="demo-cam" key={id}>
              <CameraFeed camId={id} variant="tile" />
              <span>
                CAM-{id + 1} · {CAMERA_NAMES[id]}
              </span>
            </div>
          ))}
        </div>

        <div className="demo-events">
          <h3>События</h3>
          <ul>
            {events.map((e) => (
              <li key={e.id} className={`ev ev-${e.kind}`}>
                <i>{EVENT_ICON[e.kind]}</i>
                <div>
                  <b>{e.title}</b>
                  <span>{e.detail}</span>
                </div>
                <em>{fmt(e.at)}</em>
              </li>
            ))}
            {events.length === 0 && <li className="ev ev-empty">Ожидание событий…</li>}
          </ul>
        </div>
      </footer>
    </div>
  )
}

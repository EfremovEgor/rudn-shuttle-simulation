import { useCallback, useEffect, useRef, useState } from 'react'

import MapScreen from './components/MapScreen'
import LidarScreen from './components/LidarScreen'
import Hud from './components/Hud'
import EditorPage from './editor/EditorPage'
import DemoPage from './components/DemoPage'
import { resetSim } from './sim/engine'
import { simTick } from './sim/loop'
import { formatScale, publishTelemetry, stepTimeScale, TIME_SCALES, useCampus, useUi } from './sim/store'
import { resetEvents } from './sim/events'

type Route = 'sim' | 'editor' | 'demo'

function useHashRoute(): [Route, (r: Route) => void] {
  const read = (): Route => {
    const h = window.location.hash.replace(/^#\/?/, '')
    return h === 'editor' || h === 'demo' ? h : 'sim'
  }
  const [route, setRoute] = useState<Route>(read)
  useEffect(() => {
    const on = () => setRoute(read())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const go = useCallback((r: Route) => {
    window.location.hash = `#/${r}`
  }, [])
  return [route, go]
}

/** Единый цикл: динамика шаттла → скан лидара → публикация телеметрии. */
function useSimulationLoop(active: boolean) {
  useEffect(() => {
    if (!active) return
    let raf = 0
    let last = performance.now()
    let acc = 0
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.12)
      last = now
      simTick(dt)
      acc += dt
      if (acc > 0.09) {
        acc = 0
        publishTelemetry()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active])
}

function SimPage() {
  const ui = useUi()
  const rt = useCampus((s) => s.rt)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) return
      if (e.code === 'Space') {
        e.preventDefault()
        ui.toggle('running')
      } else if (e.key === '+' || e.key === '=' || e.key === 'Add') stepTimeScale(1)
      else if (e.key === '-' || e.key === '_') stepTimeScale(-1)
      else if (e.key === 'f' || e.key === 'а') ui.toggle('follow')
      else if (e.key === 'c' || e.key === 'с') ui.set({ camera: ((ui.camera + 1) % 4) as 0 | 1 | 2 | 3 })
      else if (e.key === '1') ui.set({ lidarView: 'chase' })
      else if (e.key === '2') ui.set({ lidarView: 'top' })
      else if (e.key === '3') ui.set({ lidarView: 'orbit' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ui])

  return (
    <>
      <div className="subbar">
        <div className="subbar-left">
          <button
            className={ui.running ? 'btn btn-primary' : 'btn btn-primary btn-off'}
            onClick={() => ui.toggle('running')}
          >
            {ui.running ? '❚❚ Пауза' : '▶ Пуск'}
          </button>
          <div className="stepper" title="Скорость симуляции (клавиши + и −)">
            <button
              className="step-btn"
              onClick={() => stepTimeScale(-1)}
              disabled={ui.timeScale <= TIME_SCALES[0]}
            >
              −
            </button>
            <span className="step-val">{formatScale(ui.timeScale)}</span>
            <button
              className="step-btn"
              onClick={() => stepTimeScale(1)}
              disabled={ui.timeScale >= TIME_SCALES[TIME_SCALES.length - 1]}
            >
              +
            </button>
          </div>
          <button
            className="btn"
            onClick={() => {
              resetSim()
              resetEvents()
            }}
          >
            ⟲ Сброс
          </button>
        </div>
        <div className="subbar-right">
          <span className="subbar-map" title={rt.doc.description}>
            {rt.doc.name}
          </span>
          <div className="seg">
            <button className={ui.showTrees ? 'seg-btn on' : 'seg-btn'} onClick={() => ui.toggle('showTrees')}>
              Деревья
            </button>
            <button className={ui.showLabels ? 'seg-btn on' : 'seg-btn'} onClick={() => ui.toggle('showLabels')}>
              Подписи
            </button>
            <button className={ui.showCoverage ? 'seg-btn on' : 'seg-btn'} onClick={() => ui.toggle('showCoverage')}>
              Зона лидара
            </button>
          </div>
        </div>
      </div>

      <main className="screens">
        <MapScreen />
        <LidarScreen />
      </main>

      <Hud />
    </>
  )
}

export default function App() {
  const [route, go] = useHashRoute()
  const clockRef = useRef<HTMLSpanElement>(null)
  useSimulationLoop(route === 'sim' || route === 'demo')

  useEffect(() => {
    const id = setInterval(() => {
      if (clockRef.current) clockRef.current.textContent = new Date().toLocaleTimeString('ru-RU', { hour12: false })
    }, 1000)
    return () => clearInterval(id)
  }, [])

  if (route === 'editor') return <EditorPage onOpenSim={() => go('sim')} />
  if (route === 'demo') return <DemoPage onExit={() => go('sim')} />

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <span />
          </div>
          <div className="brand-text">
            <b>РУДН · автономный электрошаттл</b>
            <span>симуляция движения по кампусу: лидар и камеры</span>
          </div>
        </div>
        <nav className="nav">
          <button className="nav-btn on">Симуляция</button>
          <button className="nav-btn" onClick={() => go('editor')}>
            Редактор карты
          </button>
          <button className="nav-btn nav-demo" onClick={() => go('demo')} title="Полноэкранный режим для презентации">
            Демо-режим
          </button>
          <span className="clock">
            <span className="dot dot-live" />
            <span ref={clockRef} className="mono" />
          </span>
        </nav>
      </header>

      <SimPage />
    </div>
  )
}

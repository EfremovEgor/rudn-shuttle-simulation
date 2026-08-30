import { useEffect, useRef } from 'react'
import { MODE_LABEL } from '../sim/engine'
import { useCampus, useTelemetry } from '../sim/store'
import type { CampusRuntime } from '../map/runtime'
import { lidar } from '../sim/lidar'

const MODE_CLASS: Record<string, string> = {
  DRIVE: 'ok',
  APPROACH: 'warn',
  BOARDING: 'info',
  HAZARD: 'bad',
  PAUSED: 'idle',
}

function Gauge({ value, max }: { value: number; max: number }) {
  const r = 46
  const circ = Math.PI * r * 1.5
  const k = Math.min(value / max, 1.15)
  return (
    <svg viewBox="0 0 120 120" className="gauge">
      <defs>
        <linearGradient id="gaugeGrad" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#2563eb" />
          <stop offset="70%" stopColor="#0ea5e9" />
          <stop offset="100%" stopColor="#f59e0b" />
        </linearGradient>
      </defs>
      <circle
        cx="60"
        cy="60"
        r={r}
        className="gauge-track"
        strokeDasharray={`${circ} ${circ * 3}`}
        transform="rotate(135 60 60)"
      />
      <circle
        cx="60"
        cy="60"
        r={r}
        className="gauge-value"
        stroke="url(#gaugeGrad)"
        strokeDasharray={`${circ * k} ${circ * 3}`}
        transform="rotate(135 60 60)"
      />
      {Array.from({ length: 9 }, (_, i) => {
        const a = (135 + (270 / 8) * i) * (Math.PI / 180)
        const x1 = 60 + Math.cos(a) * 36
        const y1 = 60 + Math.sin(a) * 36
        const x2 = 60 + Math.cos(a) * 31
        const y2 = 60 + Math.sin(a) * 31
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="gauge-tick" />
      })}
    </svg>
  )
}

function Bar({ value, tone = 'cyan' }: { value: number; tone?: string }) {
  return (
    <div className="bar">
      <div className={`bar-fill tone-${tone}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  )
}

/** Полоса маршрута с отметками остановок и бегунком шаттла. */
function RouteStrip({ progress, rt }: { progress: number; rt: CampusRuntime }) {
  return (
    <div className="route-strip">
      <div className="route-strip-line" />
      <div className="route-strip-fill" style={{ width: `${progress * 100}%` }} />
      {rt.stops.map((s, i) => (
        <div key={s.id} className="route-strip-stop" style={{ left: `${(s.s / rt.route.length) * 100}%` }}>
          <i />
          <span>{String.fromCharCode(65 + i)}</span>
        </div>
      ))}
      <div className="route-strip-shuttle" style={{ left: `${progress * 100}%` }} />
    </div>
  )
}

/** Бегущая «осциллограмма» плотности точек — чисто визуальный индикатор. */
function ScanWave() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cvs = ref.current
    if (!cvs) return
    const ctx = cvs.getContext('2d')
    if (!ctx) return
    const w = (cvs.width = 260)
    const h = (cvs.height = 44)
    const hist: number[] = new Array(w).fill(0)
    let raf = 0
    const draw = () => {
      hist.shift()
      hist.push(lidar.detections.length / 9 + Math.abs(Math.sin(lidar.time * 3)) * 0.15)
      ctx.clearRect(0, 0, w, h)
      ctx.beginPath()
      for (let i = 0; i < w; i++) {
        const y = h - 3 - hist[i] * (h - 8)
        if (i === 0) ctx.moveTo(i, y)
        else ctx.lineTo(i, y)
      }
      ctx.strokeStyle = '#2563eb'
      ctx.lineWidth = 1.4
      ctx.stroke()
      ctx.lineTo(w, h)
      ctx.lineTo(0, h)
      ctx.closePath()
      ctx.fillStyle = 'rgba(37,99,235,0.10)'
      ctx.fill()
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={ref} className="scanwave" />
}

export default function Hud() {
  const t = useTelemetry()
  const rt = useCampus((s) => s.rt)
  const kmh = t.speed * 3.6
  const mm = Math.floor(t.simTime / 60)
  const ss = Math.floor(t.simTime % 60)

  return (
    <footer className="hud">
      <div className="hud-card hud-speed">
        <Gauge value={kmh} max={rt.cruise * 3.6 * 1.15} />
        <div className="hud-speed-value">
          <b>{kmh.toFixed(1)}</b>
          <span>км/ч</span>
        </div>
        <div className="hud-speed-sub">
          цель {(t.targetSpeed * 3.6).toFixed(1)} · {t.mode === 'HAZARD' ? 'торможение' : 'норма'}
        </div>
      </div>

      <div className="hud-card hud-mode">
        <div className={`mode-badge mode-${MODE_CLASS[t.mode]}`}>
          <span className="mode-pulse" />
          {MODE_LABEL[t.mode]}
        </div>
        <div className="hud-rows">
          <div className="hud-row">
            <span>Следующая</span>
            <b>{t.nextStopCode}</b>
          </div>
          <div className="hud-row hud-row-wide">
            <span>{t.nextStopName}</span>
          </div>
          <div className="hud-row">
            <span>Расстояние</span>
            <b>{t.distToStop.toFixed(0)} м</b>
          </div>
          <div className="hud-row">
            <span>{t.mode === 'BOARDING' ? 'Отправление через' : 'Прибытие через'}</span>
            <b>{t.mode === 'BOARDING' ? `${t.dwell.toFixed(0)} с` : `${Math.ceil(t.eta)} с`}</b>
          </div>
        </div>
        <div className="doors">
          <span>Двери</span>
          <div className="door-track">
            <div className="door door-l" style={{ transform: `translateX(${-t.doors * 100}%)` }} />
            <div className="door door-r" style={{ transform: `translateX(${t.doors * 100}%)` }} />
          </div>
          <b>{t.doors > 0.5 ? 'открыты' : 'закрыты'}</b>
        </div>
      </div>

      <div className="hud-card hud-route">
        <div className="hud-card-title">Маршрут · {Math.round(rt.route.length)} м · {rt.stops.length} ост.</div>
        <RouteStrip progress={t.progress} rt={rt} />
        <div className="hud-grid">
          <div>
            <span>Пробег</span>
            <b>{(t.odometer / 1000).toFixed(2)} км</b>
          </div>
          <div>
            <span>Круги</span>
            <b>{t.laps}</b>
          </div>
          <div>
            <span>Время</span>
            <b>
              {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
            </b>
          </div>
          <div>
            <span>Пассажиры</span>
            <b>{t.passengers} / 12</b>
          </div>
        </div>
        <div className="hud-row">
          <span>Батарея</span>
          <b>{t.battery.toFixed(1)}%</b>
        </div>
        <Bar value={t.battery / 100} tone={t.battery < 25 ? 'red' : 'green'} />
      </div>

      <div className="hud-card hud-sensors">
        <div className="hud-card-title">Восприятие</div>
        <div className="sensor-list">
          <div className="sensor ok">
            <i /> Лидар 360°
            <b>{lidar.pointsPerSecond / 1000}k т/с</b>
          </div>
          <div className="sensor ok">
            <i /> Камеры ×4
            <b>30 fps</b>
          </div>
          <div className="sensor ok">
            <i /> GNSS / IMU
            <b>±3 см</b>
          </div>
        </div>
        <ScanWave />
        <div className="hud-grid tight">
          <div>
            <span>Объектов</span>
            <b>{t.detections}</b>
          </div>
          <div>
            <span>Людей</span>
            <b className={t.persons ? 'accent' : ''}>{t.persons}</b>
          </div>
          <div>
            <span>В радиусе</span>
            <b>{t.activeObstacles}</b>
          </div>
          <div>
            <span>Оборот</span>
            <b>#{t.revolution}</b>
          </div>
        </div>
        {t.nearest && (
          <div className="nearest">
            <span>Ближайший</span>
            <b>
              {t.nearest.cls} · {t.nearest.label}
            </b>
            <em>{t.nearest.dist.toFixed(1)} м</em>
          </div>
        )}
        {t.hazardDist !== null && (
          <div className="hazard-strip">
            Пешеход в коридоре · {t.hazardDist.toFixed(1)} м · экстренное торможение
          </div>
        )}
      </div>
    </footer>
  )
}

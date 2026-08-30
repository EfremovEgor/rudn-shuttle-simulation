/**
 * Один шаг общего цикла симуляции. Вынесен из App, чтобы страница симуляции
 * и демо-режим делили один и тот же код: настройки интерфейса (пауза,
 * ускорение времени) применяются к ядру здесь, а не в компонентах.
 */
import { sim, stepSim } from './engine'
import { lidar } from './lidar'
import { detectEvents } from './events'
import { useUi } from './store'

export function simTick(dt: number) {
  const ui = useUi.getState()
  sim.running = ui.running
  sim.timeScale = ui.timeScale

  stepSim(dt)
  lidar.step(dt)
  detectEvents()
}

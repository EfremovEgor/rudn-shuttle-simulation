import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyMap } from './map/runtime'
import { loadStoredMap } from './map/storage'
import { resetSim } from './sim/engine'
import { lidar } from './sim/lidar'

// Карта, сохранённая редактором, подхватывается до первого рендера
const stored = loadStoredMap()
if (stored) {
  applyMap(stored)
  resetSim()
  lidar.rebuild()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

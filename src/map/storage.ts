import { normalizeMap } from './schema'
import type { CampusMap } from './schema'

const KEY = 'rudn-shuttle:map:v1'

export function loadStoredMap(): CampusMap | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    return normalizeMap(JSON.parse(raw))
  } catch {
    return null
  }
}

export function storeMap(doc: CampusMap) {
  try {
    localStorage.setItem(KEY, JSON.stringify(doc))
    return true
  } catch {
    return false
  }
}

export function clearStoredMap() {
  localStorage.removeItem(KEY)
}

export function mapFileName(doc: CampusMap) {
  const slug = doc.name
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
  return `${slug || 'campus'}.map.json`
}

/** Скачать карту отдельным файлом .map.json */
export function downloadMap(doc: CampusMap) {
  const payload = { ...doc, updated: new Date().toISOString() }
  const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = mapFileName(doc)
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function readMapFile(file: File): Promise<CampusMap> {
  const text = await file.text()
  return normalizeMap(JSON.parse(text))
}

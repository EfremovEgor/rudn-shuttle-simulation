import { useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, Line } from '@react-three/drei'
import * as THREE from 'three'

import type { CampusMap, Pt } from '../map/schema'
import { computeHandles } from './handles'
import { roundPolyline } from '../sim/geometry'
import RoadLayer from '../components/three/RoadLayer'
import { FLAT_ROTATION, PALETTE, gridGeometry, rectGeometry, rectOutline, ribbonGeometry } from '../components/three/utils'

export type View = { cx: number; cy: number; zoom: number }
export type Selection =
  | { kind: 'building' | 'tree' | 'road' | 'zone' | 'stop' | 'walk'; id: string }
  | { kind: 'routePoint'; index: number }
  | null

export type Draft =
  | { kind: 'rect'; target: 'building' | 'zone'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'poly'; target: 'road' | 'walk'; points: Pt[]; cursor: Pt }
  | null

const ZONE_COLOR = {
  lawn: PALETTE.lawn,
  water: PALETTE.water,
  pavement: PALETTE.pavement,
  field: PALETTE.field,
}
const ACCENT = '#2563eb'

function CameraRig({ view }: { view: React.RefObject<View> }) {
  const camera = useThree((s) => s.camera) as THREE.OrthographicCamera
  useFrame(() => {
    const v = view.current
    if (!v) return
    camera.position.set(v.cx, 200, -v.cy)
    camera.rotation.set(-Math.PI / 2, 0, 0)
    if (camera.zoom !== v.zoom) {
      camera.zoom = v.zoom
      camera.updateProjectionMatrix()
    }
  })
  return null
}

function Grid({ doc }: { doc: CampusMap }) {
  const b = doc.bounds
  const fine = useMemo(() => gridGeometry(b.minX - 200, b.maxX + 200, b.minY - 200, b.maxY + 200, 10, 0.005), [b])
  const coarse = useMemo(() => gridGeometry(b.minX - 200, b.maxX + 200, b.minY - 200, b.maxY + 200, 50, 0.006), [b])
  return (
    <group>
      <lineSegments geometry={fine}>
        <lineBasicMaterial color="#eff2f6" />
      </lineSegments>
      <lineSegments geometry={coarse}>
        <lineBasicMaterial color="#dfe5ec" />
      </lineSegments>
    </group>
  )
}

function Trees({ doc, selId }: { doc: CampusMap; selId: string | null }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const base = useMemo(() => new THREE.Color(PALETTE.tree), [])
  const sel = useMemo(() => new THREE.Color(ACCENT), [])

  useEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    const m = new THREE.Matrix4()
    doc.trees.forEach((t, i) => {
      m.makeScale(t.r, t.r, 1)
      m.setPosition(t.x, t.y, 0.12)
      mesh.setMatrixAt(i, m)
      mesh.setColorAt(i, t.id === selId ? sel : base)
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [doc.trees, selId, base, sel])

  if (!doc.trees.length) return null
  return (
    <group rotation={FLAT_ROTATION}>
      <instancedMesh ref={ref} args={[undefined, undefined, doc.trees.length]} frustumCulled={false}>
        <circleGeometry args={[1, 12]} />
        <meshBasicMaterial color="#ffffff" />
      </instancedMesh>
    </group>
  )
}

function RouteLayer({ doc, sel }: { doc: CampusMap; sel: Selection }) {
  const pts = doc.route.points
  const smooth = useMemo(() => {
    if (pts.length < 3) return pts.map(([x, y]) => ({ x, y }))
    return roundPolyline(
      pts.map(([x, y]) => ({ x, y })),
      doc.route.corner ?? 7,
      doc.route.closed,
      8,
    )
  }, [pts, doc.route.corner, doc.route.closed])

  const ribbon = useMemo(
    () => (smooth.length > 1 ? ribbonGeometry(smooth, 3.6, 0.2, doc.route.closed) : null),
    [smooth, doc.route.closed],
  )
  const line = useMemo<[number, number, number][]>(() => {
    const l = smooth.map((p) => [p.x, 0.24, -p.y] as [number, number, number])
    if (doc.route.closed && l.length > 1) l.push(l[0])
    return l
  }, [smooth, doc.route.closed])

  // стрелки направления движения
  const arrows = useMemo(() => {
    const out: { x: number; y: number; a: number }[] = []
    for (let i = 0; i < smooth.length - 1; i += 6) {
      const p = smooth[i]
      const q = smooth[Math.min(i + 1, smooth.length - 1)]
      out.push({ x: p.x, y: p.y, a: Math.atan2(q.y - p.y, q.x - p.x) })
    }
    return out
  }, [smooth])

  const arrowGeom = useMemo(() => {
    const s = new THREE.Shape()
    s.moveTo(1.4, 0)
    s.lineTo(-0.9, 0.85)
    s.lineTo(-0.4, 0)
    s.lineTo(-0.9, -0.85)
    s.closePath()
    return new THREE.ShapeGeometry(s)
  }, [])

  return (
    <group>
      {ribbon && (
        <mesh geometry={ribbon} renderOrder={2}>
          <meshBasicMaterial color={PALETTE.routeSoft} transparent opacity={0.85} />
        </mesh>
      )}
      {line.length > 1 && <Line points={line} color={ACCENT} lineWidth={1.6} />}
      {arrows.map((a, i) => (
        <mesh key={i} geometry={arrowGeom} position={[a.x, 0.3, -a.y]} rotation={[-Math.PI / 2, 0, a.a]}>
          <meshBasicMaterial color={ACCENT} transparent opacity={0.55} />
        </mesh>
      ))}
      {pts.map(([x, y], i) => {
        const active = sel?.kind === 'routePoint' && sel.index === i
        return (
          <mesh key={i} position={[x, 0.4, -y]} rotation={FLAT_ROTATION}>
            <circleGeometry args={[active ? 2.4 : 1.7, 16]} />
            <meshBasicMaterial color={active ? '#dc2626' : '#ffffff'} />
          </mesh>
        )
      })}
      {pts.map(([x, y], i) => (
        <mesh key={`r${i}`} position={[x, 0.41, -y]} rotation={FLAT_ROTATION}>
          <ringGeometry args={[1.2, 1.7, 16]} />
          <meshBasicMaterial color={ACCENT} />
        </mesh>
      ))}
    </group>
  )
}

function DraftLayer({ draft }: { draft: Draft }) {
  if (!draft) return null
  if (draft.kind === 'rect') {
    const cx = (draft.x0 + draft.x1) / 2
    const cy = (draft.y0 + draft.y1) / 2
    const hw = Math.abs(draft.x1 - draft.x0) / 2
    const hh = Math.abs(draft.y1 - draft.y0) / 2
    if (hw < 0.2 || hh < 0.2) return null
    return (
      <group>
        <mesh geometry={rectGeometry(cx, cy, hw, hh, 0.5)}>
          <meshBasicMaterial color={ACCENT} transparent opacity={0.25} />
        </mesh>
        <Line points={rectOutline(cx, cy, hw, hh, 0.52)} color={ACCENT} lineWidth={1.6} dashed dashSize={3} gapSize={2} />
      </group>
    )
  }
  const pts: [number, number, number][] = [...draft.points, draft.cursor].map(([x, y]) => [x, 0.5, -y])
  if (pts.length < 2) return null
  return <Line points={pts} color={ACCENT} lineWidth={2} dashed dashSize={3} gapSize={2} />
}


/* ─── маркеры изменения размера ─────────────────────────────────────────── */
function HandleLayer({ doc, sel, view }: { doc: CampusMap; sel: Selection; view: React.RefObject<View> }) {
  const grp = useRef<THREE.Group>(null)
  const handles = useMemo(() => computeHandles(doc, sel), [doc, sel])

  // маркеры держат постоянный размер на экране независимо от масштаба
  useFrame(() => {
    const g = grp.current
    if (!g) return
    const k = 7.5 / (view.current?.zoom ?? 1)
    for (const child of g.children) child.scale.setScalar(k)
  })

  return (
    <group ref={grp}>
      {handles.map((h) => (
        <group key={h.id} position={[h.x, 0.7, -h.y]}>
          <mesh rotation={FLAT_ROTATION}>
            <circleGeometry args={[1, 16]} />
            <meshBasicMaterial color={h.kind === 'rot' ? '#e8830c' : '#ffffff'} />
          </mesh>
          <mesh rotation={FLAT_ROTATION} position={[0, 0.01, 0]}>
            <ringGeometry args={[0.72, 1, 16]} />
            <meshBasicMaterial color={h.kind === 'rot' ? '#b45309' : ACCENT} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

export default function EditorScene({
  doc,
  view,
  sel,
  draft,
}: {
  doc: CampusMap
  view: React.RefObject<View>
  sel: Selection
  draft: Draft
}) {
  const selId = sel && 'id' in sel ? sel.id : null

  const zones = useMemo(
    () => doc.zones.map((z) => ({ z, geom: rectGeometry(z.cx, z.cy, z.hw, z.hh, 0.02) })),
    [doc.zones],
  )
  const walks = useMemo(
    () =>
      doc.walks.map((w) => ({
        w,
        line: w.points.map(([x, y]) => [x, 0.12, -y] as [number, number, number]),
      })),
    [doc.walks],
  )
  const buildings = useMemo(
    () =>
      doc.buildings.map((b) => ({
        b,
        geom: rectGeometry(b.cx, b.cy, b.hw, b.hh, 0.14, b.rot),
        outline: rectOutline(b.cx, b.cy, b.hw, b.hh, 0.16, b.rot),
      })),
    [doc.buildings],
  )

  return (
    <Canvas
      orthographic
      dpr={[1, 2]}
      camera={{ position: [0, 200, 0], zoom: 2, near: 1, far: 600 }}
      gl={{ antialias: true }}
    >
      <color attach="background" args={['#fbfcfd']} />
      <CameraRig view={view} />
      <Grid doc={doc} />

      {zones.map(({ z, geom }) => (
        <group key={z.id}>
          <mesh geometry={geom}>
            <meshBasicMaterial color={ZONE_COLOR[z.kind]} />
          </mesh>
          {selId === z.id && (
            <Line points={rectOutline(z.cx, z.cy, z.hw, z.hh, 0.3)} color={ACCENT} lineWidth={2} />
          )}
        </group>
      ))}

      <RoadLayer roads={doc.roads} y={0.05} />
      {doc.roads
        .filter((r) => r.id === selId && r.points.length > 1)
        .map((r) => (
          <Line
            key={`sel${r.id}`}
            points={r.points.map(([x, y]) => [x, 0.3, -y] as [number, number, number])}
            color={ACCENT}
            lineWidth={2}
          />
        ))}

      {walks.map(({ w, line }) => (
        <group key={w.id}>
          {line.length > 1 && (
            <Line points={line} color={selId === w.id ? ACCENT : '#b9c3cd'} lineWidth={selId === w.id ? 2 : 1.2} dashed dashSize={2} gapSize={2} />
          )}
        </group>
      ))}

      <Trees doc={doc} selId={selId} />

      {buildings.map(({ b, geom, outline }) => (
        <group key={b.id}>
          <mesh geometry={geom}>
            <meshBasicMaterial color={selId === b.id ? '#c9dcf5' : PALETTE.building} />
          </mesh>
          <Line points={outline} color={selId === b.id ? ACCENT : PALETTE.buildingEdge} lineWidth={selId === b.id ? 2 : 1.1} />
          <Html position={[b.cx, 0.5, -b.cy]} center zIndexRange={[20, 0]}>
            <div className="map-label">{b.short || b.name}</div>
          </Html>
        </group>
      ))}

      <RouteLayer doc={doc} sel={sel} />

      {doc.stops.map((s) => (
        <group key={s.id} position={[s.x, 0.45, -s.y]}>
          <mesh rotation={FLAT_ROTATION}>
            <circleGeometry args={[2.6, 24]} />
            <meshBasicMaterial color="#ffffff" />
          </mesh>
          <mesh rotation={FLAT_ROTATION} position={[0, 0.02, 0]}>
            <ringGeometry args={[1.7, 2.6, 24]} />
            <meshBasicMaterial color={selId === s.id ? ACCENT : PALETTE.stop} />
          </mesh>
          <Html position={[0, 1, 0]} center zIndexRange={[40, 10]}>
            <div className="stop-label">
              <b>{s.code}</b>
              <span>{s.name}</span>
            </div>
          </Html>
        </group>
      ))}

      <HandleLayer doc={doc} sel={sel} view={view} />
      <DraftLayer draft={draft} />
    </Canvas>
  )
}

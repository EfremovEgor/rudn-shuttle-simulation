import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

import { sim } from '../sim/engine'
import { lidar } from '../sim/lidar'
import { CAMERA_NAMES, useCampus, useUi } from '../sim/store'
import type { CameraId } from '../sim/store'
import type { CampusRuntime } from '../map/runtime'
import { damp } from '../sim/geometry'
import RoadLayer from './three/RoadLayer'
import { rectGeometry, ribbonGeometry } from './three/utils'

/** Углы установки камер относительно продольной оси шаттла. */
const CAMERA_YAW = [0, Math.PI / 2, -Math.PI / 2, Math.PI]
const ZONE_3D = { lawn: '#9dc08b', water: '#a8c8e0', pavement: '#d3d7dc', field: '#c8ceb0' }

function StaticWorld({ rt }: { rt: CampusRuntime }) {
  const buildings = useRef<THREE.InstancedMesh>(null)
  const trunks = useRef<THREE.InstancedMesh>(null)
  const crowns = useRef<THREE.InstancedMesh>(null)

  const route = useMemo(() => ribbonGeometry(rt.routePoints, 3.8, 0.03, rt.doc.route.closed), [rt])
  const zones = useMemo(
    () => rt.doc.zones.map((z) => ({ geom: rectGeometry(z.cx, z.cy, z.hw, z.hh, 0.015), kind: z.kind })),
    [rt],
  )

  useEffect(() => {
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const p = new THREE.Vector3()
    const s = new THREE.Vector3()

    if (buildings.current) {
      rt.buildings.forEach((b, i) => {
        e.set(0, b.rot || 0, 0)
        q.setFromEuler(e)
        p.set(b.cx, b.height / 2, -b.cy)
        s.set(b.hw * 2, b.height, b.hh * 2)
        m.compose(p, q, s)
        buildings.current!.setMatrixAt(i, m)
      })
      buildings.current.instanceMatrix.needsUpdate = true
    }
    q.identity()
    if (trunks.current && crowns.current) {
      rt.trees.forEach((t, i) => {
        p.set(t.x, t.trunk / 2, -t.y)
        s.set(0.34, t.trunk, 0.34)
        m.compose(p, q, s)
        trunks.current!.setMatrixAt(i, m)

        const ch = Math.max(0.5, t.h - t.trunk)
        p.set(t.x, t.trunk + ch / 2, -t.y)
        s.set(t.r, ch * 0.62, t.r)
        m.compose(p, q, s)
        crowns.current!.setMatrixAt(i, m)
      })
      trunks.current.instanceMatrix.needsUpdate = true
      crowns.current.instanceMatrix.needsUpdate = true
    }
  }, [rt])

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[1400, 1400]} />
        <meshLambertMaterial color="#c9ced5" />
      </mesh>
      {zones.map((z, i) => (
        <mesh key={`z${i}`} geometry={z.geom}>
          <meshBasicMaterial color={ZONE_3D[z.kind]} />
        </mesh>
      ))}
      <RoadLayer roads={rt.doc.roads} y={0.02} />
      <mesh geometry={route}>
        <meshBasicMaterial color="#8fa9d8" />
      </mesh>
      {rt.stops.map((s) => (
        <mesh key={s.id} position={[s.x, 0.06, -s.y]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[2.4, 3.2, 28]} />
          <meshBasicMaterial color="#e8830c" side={THREE.DoubleSide} />
        </mesh>
      ))}
      <instancedMesh
        ref={buildings}
        args={[undefined, undefined, Math.max(1, rt.buildings.length)]}
        frustumCulled={false}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshLambertMaterial color="#c2cbd6" />
      </instancedMesh>
      <instancedMesh ref={trunks} args={[undefined, undefined, Math.max(1, rt.trees.length)]} frustumCulled={false}>
        <cylinderGeometry args={[1, 1, 1, 5]} />
        <meshLambertMaterial color="#8a7050" />
      </instancedMesh>
      <instancedMesh ref={crowns} args={[undefined, undefined, Math.max(1, rt.trees.length)]} frustumCulled={false}>
        <icosahedronGeometry args={[1, 0]} />
        <meshLambertMaterial color="#6ba05c" flatShading />
      </instancedMesh>
    </group>
  )
}

function People() {
  const ref = useRef<THREE.InstancedMesh>(null)
  const m = useMemo(() => new THREE.Matrix4(), [])
  const q = useMemo(() => new THREE.Quaternion(), [])
  const e = useMemo(() => new THREE.Euler(), [])
  const p = useMemo(() => new THREE.Vector3(), [])
  const s = useMemo(() => new THREE.Vector3(1, 1, 1), [])
  const col = useMemo(() => new THREE.Color(), [])
  const cNorm = useMemo(() => new THREE.Color('#5b6472'), [])
  const cAlert = useMemo(() => new THREE.Color('#ea580c'), [])

  useEffect(() => {
    const inst = ref.current
    if (!inst) return
    for (let i = 0; i < inst.count; i++) inst.setColorAt(i, cNorm)
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true
  }, [cNorm])

  useFrame(() => {
    const inst = ref.current
    if (!inst || !inst.instanceColor) return
    for (let i = 0; i < inst.count; i++) {
      const ped = sim.pedestrians[i]
      if (!ped) {
        m.makeScale(0, 0, 0)
        inst.setMatrixAt(i, m)
        continue
      }
      e.set(0, ped.heading, Math.sin(ped.phase) * 0.06)
      q.setFromEuler(e)
      p.set(ped.x, 0.88 + Math.sin(ped.phase * 2) * 0.05, -ped.y)
      m.compose(p, q, s)
      inst.setMatrixAt(i, m)
      col.copy(ped.alert ? cAlert : cNorm)
      inst.setColorAt(i, col)
    }
    inst.instanceMatrix.needsUpdate = true
    inst.instanceColor.needsUpdate = true
  })

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, 24]} frustumCulled={false}>
      <capsuleGeometry args={[0.28, 1.05, 4, 8]} />
      <meshLambertMaterial />
    </instancedMesh>
  )
}

/** Рамки людей, попавших в поле зрения камеры. */
function VisionBoxes() {
  const grp = useRef<THREE.Group>(null)
  const geo = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), [])
  const pool = 6

  useFrame(() => {
    const g = grp.current
    if (!g) return
    const persons = lidar.detections.filter((d) => d.cls === 'person').slice(0, pool)
    for (let i = 0; i < pool; i++) {
      const child = g.children[i] as THREE.LineSegments
      const d = persons[i]
      const ped = d ? sim.pedestrians.find((q) => `p:${q.id}` === d.id) : null
      if (!ped) {
        child.visible = false
        continue
      }
      child.visible = true
      child.position.set(ped.x, 0.95, -ped.y)
      child.scale.set(1.1, 1.9, 1.1)
      ;(child.material as THREE.LineBasicMaterial).color.set(ped.alert ? '#dc2626' : '#0f766e')
    }
  })

  return (
    <group ref={grp}>
      {Array.from({ length: pool }, (_, i) => (
        <lineSegments key={i} geometry={geo} visible={false}>
          <lineBasicMaterial color="#0f766e" depthTest={false} />
        </lineSegments>
      ))}
    </group>
  )
}

function CameraRig({ camId }: { camId: CameraId }) {
  const camera = useThree((s) => s.camera)
  const yaw = useRef(0)
  const look = useRef(new THREE.Vector3())

  useFrame((_, dt) => {
    const target = sim.yaw + CAMERA_YAW[camId]
    let delta = ((target - yaw.current + Math.PI) % (Math.PI * 2)) - Math.PI
    if (delta < -Math.PI) delta += Math.PI * 2
    yaw.current += delta * (1 - Math.exp(-9 * dt))

    const c = Math.cos(sim.yaw)
    const s = Math.sin(sim.yaw)
    const shake = Math.sin(lidar.time * 13) * 0.01 * Math.min(sim.speed, 3)
    camera.position.set(sim.x + c * 1.9, 2.05 + shake, -(sim.y + s * 1.9))

    look.current.set(
      camera.position.x + Math.cos(yaw.current) * 20,
      damp(look.current.y, 1.4, 5, dt),
      camera.position.z - Math.sin(yaw.current) * 20,
    )
    camera.up.set(0, 1, 0)
    camera.lookAt(look.current)
  })
  return null
}

/**
 * Врезка бортовой камеры. variant='pip' — одна камера поверх экрана лидара,
 * variant='tile' — плитка для демонстрационного режима (без переключателя).
 */
export default function CameraFeed({ camId, variant = 'pip' }: { camId?: CameraId; variant?: 'pip' | 'tile' }) {
  const rt = useCampus((s) => s.rt)
  const active = useUi((s) => s.camera)
  const set = useUi((s) => s.set)
  const [clock, setClock] = useState('')
  const id = camId ?? active
  const tile = variant === 'tile'

  useEffect(() => {
    if (tile) return
    const t = setInterval(() => setClock(new Date().toLocaleTimeString('ru-RU', { hour12: false })), 500)
    return () => clearInterval(t)
  }, [tile])

  return (
    <div className={tile ? 'camfeed camtile' : 'camfeed'}>
      <Canvas
        key={rt.revision}
        dpr={tile ? 1 : [1, 1.5]}
        camera={{ fov: 68, near: 0.2, far: 600, position: [sim.x, 2, -sim.y] }}
        gl={{ antialias: false }}
      >
        <color attach="background" args={['#dbe7f3']} />
        <fog attach="fog" args={['#dbe7f3', 60, 320]} />
        <hemisphereLight args={['#ffffff', '#8f9aa6', 2.1]} />
        <directionalLight position={[60, 90, 30]} intensity={1.4} color="#fff6e5" />
        <CameraRig camId={id} />
        <StaticWorld rt={rt} />
        <People />
        <VisionBoxes />
      </Canvas>

      <div className="camfeed-hud">
        <div className="camfeed-top">
          <span className="cam-name">
            CAM-{id + 1} · {CAMERA_NAMES[id]}
          </span>
          {!tile && <span className="mono">{clock}</span>}
        </div>
        <div className="crosshair" />
        {!tile && (
          <div className="camfeed-bottom">
            {CAMERA_NAMES.map((n, i) => (
              <button
                key={n}
                className={i === id ? 'cam-pip on' : 'cam-pip'}
                onClick={() => set({ camera: i as CameraId })}
                title={n}
              >
                {i + 1}
              </button>
            ))}
            <span className="mono dim">1920×1080 · 30 fps</span>
          </div>
        )}
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, Line } from '@react-three/drei'
import * as THREE from 'three'

import { sim } from '../sim/engine'
import { lidar, MAX_RANGE } from '../sim/lidar'
import { useCampus, useUi } from '../sim/store'
import type { CampusRuntime } from '../map/runtime'
import { clamp, damp } from '../sim/geometry'
import RoadLayer from './three/RoadLayer'
import {
  FLAT_ROTATION,
  PALETTE,
  gridGeometry,
  rectGeometry,
  rectOutline,
  ribbonGeometry,
  roundedRectShape,
} from './three/utils'

const ZONE_COLOR = {
  lawn: PALETTE.lawn,
  water: PALETTE.water,
  pavement: PALETTE.pavement,
  field: PALETTE.field,
}

/* ─── камера: обзор кампуса ⇄ слежение за шаттлом ───────────────────────── */
function MapCamera({ rt }: { rt: CampusRuntime }) {
  const camera = useThree((s) => s.camera) as THREE.OrthographicCamera
  const size = useThree((s) => s.size)
  const follow = useUi((s) => s.follow)

  useFrame((_, dt) => {
    const fit = Math.min(size.width / (rt.extent.w + 30), size.height / (rt.extent.h + 30))
    const targetZoom = follow ? Math.max(fit * 3.4, 4.2) : fit
    const tx = follow ? sim.x : rt.center.x
    const tz = follow ? -sim.y : -rt.center.y
    const k = follow ? 2.6 : 2.2
    camera.position.x = damp(camera.position.x, tx, k, dt)
    camera.position.z = damp(camera.position.z, tz, k, dt)
    camera.position.y = 200
    camera.rotation.set(-Math.PI / 2, 0, 0)
    camera.zoom = damp(camera.zoom, targetZoom, 2.4, dt)
    camera.updateProjectionMatrix()
  })
  return null
}

/* ─── подложка: газоны, вода, дороги, сетка ─────────────────────────────── */
function Basemap({ rt }: { rt: CampusRuntime }) {
  const zones = useMemo(
    () => rt.doc.zones.map((z) => ({ geom: rectGeometry(z.cx, z.cy, z.hw, z.hh, 0.02), kind: z.kind })),
    [rt],
  )
  const grid = useMemo(
    () => gridGeometry(rt.bounds.minX, rt.bounds.maxX, rt.bounds.minY, rt.bounds.maxY, 25, 0.01),
    [rt],
  )

  return (
    <group>
      <mesh geometry={rectGeometry(rt.center.x, rt.center.y, rt.extent.w, rt.extent.h, 0)}>
        <meshBasicMaterial color={PALETTE.ground} />
      </mesh>
      <lineSegments geometry={grid}>
        <lineBasicMaterial color={PALETTE.grid} />
      </lineSegments>
      {zones.map((z, i) => (
        <mesh key={`z${i}`} geometry={z.geom}>
          <meshBasicMaterial color={ZONE_COLOR[z.kind]} />
        </mesh>
      ))}
      <RoadLayer roads={rt.doc.roads} y={0.05} />
    </group>
  )
}

/* ─── здания: подсвечиваются, когда по ним прилетает луч лидара ─────────── */
type MaterialHolder = { material?: THREE.Material } | null

function Buildings({ rt }: { rt: CampusRuntime }) {
  const showLabels = useUi((s) => s.showLabels)
  const fills = useRef<(THREE.MeshBasicMaterial | null)[]>([])
  const edges = useRef<(THREE.LineBasicMaterial | null)[]>([])

  const geoms = useMemo(
    () => rt.buildings.map((b) => rectGeometry(b.cx, b.cy, b.hw, b.hh, 0.14, b.rot)),
    [rt],
  )
  const outlines = useMemo(
    () => rt.buildings.map((b) => rectOutline(b.cx, b.cy, b.hw, b.hh, 0.16, b.rot)),
    [rt],
  )

  const cBase = useMemo(() => new THREE.Color(PALETTE.building), [])
  const cLit = useMemo(() => new THREE.Color(PALETTE.buildingLit), [])
  const eBase = useMemo(() => new THREE.Color(PALETTE.buildingEdge), [])
  const eLit = useMemo(() => new THREE.Color(PALETTE.buildingEdgeLit), [])

  useFrame(() => {
    for (let i = 0; i < rt.buildings.length; i++) {
      const t = lidar.buildingHitTime.get(`b:${rt.buildings[i].id}`) ?? -99
      const k = clamp(1 - (lidar.time - t) / 1.6, 0, 1)
      fills.current[i]?.color.copy(cBase).lerp(cLit, k)
      const edge = edges.current[i]
      if (edge) {
        edge.color.copy(eBase).lerp(eLit, k)
        edge.opacity = 0.75 + k * 0.25
      }
    }
  })

  return (
    <group>
      {rt.buildings.map((b, i) => (
        <mesh key={b.id} geometry={geoms[i]}>
          <meshBasicMaterial ref={(m) => void (fills.current[i] = m)} color={PALETTE.building} />
        </mesh>
      ))}
      {rt.buildings.map((b, i) => (
        <Line
          key={`o${b.id}`}
          points={outlines[i]}
          color={PALETTE.buildingEdge}
          lineWidth={1.2}
          transparent
          opacity={0.8}
          ref={(l: MaterialHolder) => {
            edges.current[i] = (l?.material as THREE.LineBasicMaterial) ?? null
          }}
        />
      ))}
      {showLabels &&
        rt.buildings.map((b) => (
          <Html key={`l${b.id}`} position={[b.cx, 0.5, -b.cy]} center zIndexRange={[20, 0]}>
            <div className="map-label">{b.short || b.name}</div>
          </Html>
        ))}
    </group>
  )
}

/* ─── деревья: темнеют в такт лучу лидара ───────────────────────────────── */
function Trees({ rt }: { rt: CampusRuntime }) {
  const show = useUi((s) => s.showTrees)
  const ref = useRef<THREE.InstancedMesh>(null)
  const base = useMemo(() => new THREE.Color(PALETTE.tree), [])
  const lit = useMemo(() => new THREE.Color(PALETTE.treeLit), [])
  const tmp = useMemo(() => new THREE.Color(), [])

  useEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    const m = new THREE.Matrix4()
    rt.trees.forEach((t, i) => {
      m.makeScale(t.r, t.r, 1)
      m.setPosition(t.x, t.y, 0.12)
      mesh.setMatrixAt(i, m)
      mesh.setColorAt(i, base)
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [base, show, rt])

  useFrame(() => {
    const mesh = ref.current
    if (!mesh || !mesh.instanceColor) return
    const n = Math.min(rt.trees.length, lidar.treeHitTime.length)
    for (let i = 0; i < n; i++) {
      const k = clamp(1 - (lidar.time - lidar.treeHitTime[i]) / 1.1, 0, 1)
      tmp.copy(base).lerp(lit, k * k)
      mesh.setColorAt(i, tmp)
    }
    mesh.instanceColor.needsUpdate = true
  })

  if (!show || rt.trees.length === 0) return null
  return (
    <group rotation={FLAT_ROTATION}>
      <instancedMesh ref={ref} args={[undefined, undefined, rt.trees.length]} frustumCulled={false}>
        <circleGeometry args={[1, 10]} />
        <meshBasicMaterial color="#ffffff" />
      </instancedMesh>
    </group>
  )
}

/* ─── маршрут: бегущие штрихи вдоль ленты ───────────────────────────────── */
function RouteRibbon({ rt }: { rt: CampusRuntime }) {
  const geom = useMemo(() => ribbonGeometry(rt.routePoints, 3.6, 0.2, rt.doc.route.closed), [rt])
  const mat = useRef<THREE.ShaderMaterial>(null)
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(PALETTE.route) },
      uSoft: { value: new THREE.Color(PALETTE.routeSoft) },
    }),
    [],
  )
  useFrame(() => {
    if (mat.current) mat.current.uniforms.uTime.value = lidar.time
  })
  return (
    <mesh geometry={geom} renderOrder={2}>
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        vertexShader={`
          varying vec2 vUv;
          void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
        `}
        fragmentShader={`
          uniform float uTime; uniform vec3 uColor; uniform vec3 uSoft;
          varying vec2 vUv;
          void main(){
            float edge = smoothstep(0.0,0.14,vUv.y)*smoothstep(1.0,0.86,vUv.y);
            float flow = fract(vUv.x*0.09 - uTime*0.35);
            float stripe = smoothstep(0.55,0.95,flow) * smoothstep(1.0,0.95,flow);
            vec3 c = mix(uSoft, uColor, stripe);
            float a = edge * (0.55 + stripe*0.45);
            gl_FragColor = vec4(c, a);
            #include <colorspace_fragment>
          }
        `}
      />
    </mesh>
  )
}

/* ─── остановки ─────────────────────────────────────────────────────────── */
function Stops({ rt }: { rt: CampusRuntime }) {
  const rings = useRef<(THREE.Mesh | null)[]>([])
  useFrame(() => {
    const t = lidar.time
    for (let i = 0; i < rings.current.length; i++) {
      const m = rings.current[i]
      if (!m) continue
      const phase = (t * 0.45 + (i % 2) * 0.5) % 1
      m.scale.setScalar(1 + phase * 2.2)
      ;(m.material as THREE.MeshBasicMaterial).opacity = (1 - phase) * 0.45
    }
  })

  return (
    <group>
      {rt.stops.map((s, i) => (
        <group key={s.id} position={[s.x, 0.3, -s.y]}>
          {[0, 1].map((k) => (
            <mesh key={k} rotation={FLAT_ROTATION} ref={(m) => void (rings.current[i * 2 + k] = m)}>
              <ringGeometry args={[3.2, 3.8, 40]} />
              <meshBasicMaterial color={PALETTE.stop} transparent opacity={0.4} depthWrite={false} />
            </mesh>
          ))}
          <mesh rotation={FLAT_ROTATION}>
            <circleGeometry args={[2.2, 28]} />
            <meshBasicMaterial color="#ffffff" />
          </mesh>
          <mesh rotation={FLAT_ROTATION} position={[0, 0.02, 0]}>
            <ringGeometry args={[1.5, 2.2, 32]} />
            <meshBasicMaterial color={PALETTE.stop} />
          </mesh>
          <Html position={[0, 1, 0]} center zIndexRange={[40, 10]}>
            <div className="stop-label">
              <b>{s.code}</b>
              <span>{s.name}</span>
            </div>
          </Html>
        </group>
      ))}
    </group>
  )
}

/* ─── зона покрытия лидара с вращающимся лучом ──────────────────────────── */
function LidarCoverage() {
  const show = useUi((s) => s.showCoverage)
  const grp = useRef<THREE.Group>(null)
  const mat = useRef<THREE.ShaderMaterial>(null)
  const uniforms = useMemo(
    () => ({
      uAngle: { value: 0 },
      uRange: { value: MAX_RANGE },
      uColor: { value: new THREE.Color(PALETTE.sensor) },
    }),
    [],
  )
  useFrame(() => {
    if (grp.current) grp.current.position.set(sim.x, 0.24, -sim.y)
    if (mat.current) mat.current.uniforms.uAngle.value = lidar.azimuth
  })
  if (!show) return null
  return (
    <group ref={grp}>
      <mesh rotation={FLAT_ROTATION} renderOrder={3}>
        <circleGeometry args={[MAX_RANGE, 96]} />
        <shaderMaterial
          ref={mat}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          vertexShader={`
            varying vec2 vP;
            void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
          `}
          fragmentShader={`
            uniform float uAngle; uniform float uRange; uniform vec3 uColor;
            varying vec2 vP;
            const float TAU = 6.28318530718;
            void main(){
              float r = length(vP);
              float a = atan(vP.y, vP.x);
              float d = mod(uAngle - a, TAU);
              float tail = exp(-d*2.4);
              float edge = smoothstep(uRange, uRange*0.985, r);
              float ring = smoothstep(0.97, 1.0, abs(sin(r*0.6283185)));
              float beam = smoothstep(0.10, 0.0, d);
              float alpha = edge * (tail*0.10 + ring*0.10 + beam*0.28 + 0.035);
              gl_FragColor = vec4(uColor, alpha);
              #include <colorspace_fragment>
            }
          `}
        />
      </mesh>
    </group>
  )
}

/* ─── след шаттла ───────────────────────────────────────────────────────── */
function Trail() {
  const ref = useRef<THREE.InstancedMesh>(null)
  const m4 = useMemo(() => new THREE.Matrix4(), [])
  const tmp = useMemo(() => new THREE.Color(), [])
  const cTrail = useMemo(() => new THREE.Color(PALETTE.route), [])
  const cBg = useMemo(() => new THREE.Color(PALETTE.ground), [])

  useEffect(() => {
    const inst = ref.current
    if (!inst) return
    for (let i = 0; i < inst.count; i++) inst.setColorAt(i, cBg)
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true
  }, [cBg])

  useFrame(() => {
    const inst = ref.current
    if (!inst || !inst.instanceColor) return
    const n = sim.trail.length
    for (let i = 0; i < inst.count; i++) {
      const idx = n - 1 - i
      if (idx < 0) {
        m4.makeScale(0, 0, 0)
        inst.setMatrixAt(i, m4)
        continue
      }
      const p = sim.trail[idx]
      const k = 1 - i / inst.count
      const s = 0.14 + k * 0.34
      m4.makeScale(s, s, 1)
      m4.setPosition(p.x, p.y, 0.22)
      inst.setMatrixAt(i, m4)
      tmp.copy(cBg).lerp(cTrail, k * k)
      inst.setColorAt(i, tmp)
    }
    inst.instanceMatrix.needsUpdate = true
    inst.instanceColor.needsUpdate = true
  })

  return (
    <group rotation={FLAT_ROTATION}>
      <instancedMesh ref={ref} args={[undefined, undefined, 240]} frustumCulled={false} renderOrder={4}>
        <circleGeometry args={[1, 8]} />
        <meshBasicMaterial />
      </instancedMesh>
    </group>
  )
}

/* ─── шаттл ─────────────────────────────────────────────────────────────── */
function Shuttle() {
  const root = useRef<THREE.Group>(null)
  const halo = useRef<THREE.Mesh>(null)
  const alert = useRef<THREE.Mesh>(null)

  const bodyGeom = useMemo(() => new THREE.ShapeGeometry(roundedRectShape(5, 2.3, 0.6)), [])
  const capGeom = useMemo(() => new THREE.ShapeGeometry(roundedRectShape(1.5, 1.7, 0.3)), [])
  const arrowGeom = useMemo(() => {
    const s = new THREE.Shape()
    s.moveTo(0.2, 0)
    s.lineTo(-0.7, 0.58)
    s.lineTo(-0.45, 0)
    s.lineTo(-0.7, -0.58)
    s.closePath()
    return new THREE.ShapeGeometry(s)
  }, [])
  const wedgeGeom = useMemo(() => {
    const s = new THREE.Shape()
    s.moveTo(0, 0)
    s.absarc(0, 0, 14, -0.6, 0.6, false)
    s.closePath()
    return new THREE.ShapeGeometry(s)
  }, [])

  useFrame(() => {
    const t = lidar.time
    if (root.current) {
      root.current.position.set(sim.x, 0.9, -sim.y)
      root.current.rotation.set(-Math.PI / 2, 0, sim.yaw)
    }
    if (halo.current) {
      const p = (t * 0.7) % 1
      halo.current.scale.setScalar(1 + p * 1.8)
      ;(halo.current.material as THREE.MeshBasicMaterial).opacity = (1 - p) * 0.35
    }
    if (alert.current) {
      const on = sim.hazard !== null
      alert.current.visible = on
      if (on) {
        const b = 0.5 + 0.5 * Math.sin(t * 11)
        ;(alert.current.material as THREE.MeshBasicMaterial).opacity = 0.25 + b * 0.5
        alert.current.scale.setScalar(1 + b * 0.14)
      }
    }
  })

  return (
    <group ref={root} renderOrder={6}>
      <mesh geometry={wedgeGeom} position={[0, 0, -0.02]}>
        <meshBasicMaterial color={PALETTE.sensor} transparent opacity={0.08} depthWrite={false} />
      </mesh>
      <mesh ref={halo}>
        <ringGeometry args={[3.6, 4.2, 40]} />
        <meshBasicMaterial color={PALETTE.route} transparent opacity={0.3} depthWrite={false} />
      </mesh>
      <mesh ref={alert}>
        <ringGeometry args={[5.4, 6.4, 44]} />
        <meshBasicMaterial color={PALETTE.hazard} transparent opacity={0.5} depthWrite={false} />
      </mesh>
      <mesh geometry={bodyGeom} position={[0, 0, 0.01]}>
        <meshBasicMaterial color={PALETTE.shuttle} />
      </mesh>
      <mesh geometry={capGeom} position={[1.35, 0, 0.02]}>
        <meshBasicMaterial color={PALETTE.shuttleTrim} />
      </mesh>
      <mesh geometry={arrowGeom} position={[3, 0, 0.02]}>
        <meshBasicMaterial color={PALETTE.route} />
      </mesh>
    </group>
  )
}

/* ─── пешеходы ──────────────────────────────────────────────────────────── */
function Pedestrians() {
  const ref = useRef<THREE.InstancedMesh>(null)
  const ring = useRef<THREE.Mesh>(null)
  const m4 = useMemo(() => new THREE.Matrix4(), [])
  const col = useMemo(() => new THREE.Color(), [])
  const cNorm = useMemo(() => new THREE.Color('#7a8896'), [])
  const cAlert = useMemo(() => new THREE.Color(PALETTE.person), [])

  useEffect(() => {
    const inst = ref.current
    if (!inst) return
    for (let i = 0; i < inst.count; i++) inst.setColorAt(i, cNorm)
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true
  }, [cNorm])

  useFrame(() => {
    const inst = ref.current
    if (inst && inst.instanceColor) {
      for (let i = 0; i < inst.count; i++) {
        const p = sim.pedestrians[i]
        if (!p) {
          m4.makeScale(0, 0, 0)
          inst.setMatrixAt(i, m4)
          continue
        }
        const bob = 1 + Math.sin(p.phase) * 0.14
        m4.makeScale(bob, bob, 1)
        m4.setPosition(p.x, p.y, 0.3)
        inst.setMatrixAt(i, m4)
        col.copy(p.alert ? cAlert : cNorm)
        inst.setColorAt(i, col)
      }
      inst.instanceMatrix.needsUpdate = true
      inst.instanceColor.needsUpdate = true
    }

    if (ring.current) {
      const hz = sim.hazard
      const ped = hz ? sim.pedestrians.find((p) => p.id === hz.id) : null
      ring.current.visible = !!ped
      if (ped) {
        ring.current.position.set(ped.x, 0.34, -ped.y)
        const b = 0.5 + 0.5 * Math.sin(lidar.time * 8)
        ring.current.scale.setScalar(1 + b * 0.28)
        ;(ring.current.material as THREE.MeshBasicMaterial).opacity = 0.35 + b * 0.5
      }
    }
  })

  return (
    <group>
      <group rotation={FLAT_ROTATION}>
        <instancedMesh ref={ref} args={[undefined, undefined, 24]} frustumCulled={false} renderOrder={5}>
          <circleGeometry args={[0.8, 12]} />
          <meshBasicMaterial />
        </instancedMesh>
      </group>
      <mesh ref={ring} rotation={FLAT_ROTATION} renderOrder={6}>
        <ringGeometry args={[1.7, 2.3, 28]} />
        <meshBasicMaterial color={PALETTE.hazard} transparent opacity={0.8} depthWrite={false} />
      </mesh>
    </group>
  )
}

function MapOverlay({ rt }: { rt: CampusRuntime }) {
  return (
    <>
      <Html position={[rt.bounds.minX + 26, 1, -(rt.bounds.maxY - 24)]} center zIndexRange={[30, 5]}>
        <div className="compass">
          <div className="compass-needle" />
          <span>С</span>
        </div>
      </Html>
      <Html position={[rt.bounds.maxX - 40, 1, -(rt.bounds.minY + 18)]} center zIndexRange={[30, 5]}>
        <div className="scalebar">
          <div className="scalebar-line" />
          <span>50 м</span>
        </div>
      </Html>
    </>
  )
}

/** Сцена карты без обвязки панели — используется и в демо-режиме. */
export function MapView() {
  const rt = useCampus((s) => s.rt)
  return (
    <Canvas
      key={rt.revision}
      orthographic
      dpr={[1, 2]}
      camera={{ position: [rt.center.x, 200, -rt.center.y], zoom: 2, near: 1, far: 600 }}
      gl={{ antialias: true }}
    >
      <color attach="background" args={[PALETTE.bg]} />
      <MapCamera rt={rt} />
      <Basemap rt={rt} />
      <RouteRibbon rt={rt} />
      <Buildings rt={rt} />
      <Trees rt={rt} />
      <Stops rt={rt} />
      <LidarCoverage />
      <Trail />
      <Pedestrians />
      <Shuttle />
      <MapOverlay rt={rt} />
    </Canvas>
  )
}

export default function MapScreen() {
  const rt = useCampus((s) => s.rt)
  const follow = useUi((s) => s.follow)
  const toggle = useUi((s) => s.toggle)

  return (
    <section className="panel">
      <header className="panel-head">
        <div className="panel-title">
          <span className="dot dot-live" />
          Экран 1 · схема территории
        </div>
        <div className="panel-tools">
          <button className={follow ? 'chip chip-on' : 'chip'} onClick={() => toggle('follow')}>
            {follow ? 'Слежение' : 'Обзор'}
          </button>
          <span className="panel-meta">маршрут {Math.round(rt.route.length)} м</span>
        </div>
      </header>
      <div className="panel-body">
        <MapView />
      </div>
    </section>
  )
}

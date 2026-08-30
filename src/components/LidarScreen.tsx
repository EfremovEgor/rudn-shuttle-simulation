import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'

import { sim } from '../sim/engine'
import {
  consumeDirty,
  lidar,
  MAX_RANGE,
  N_CHANNELS,
  POINT_LIFETIME,
  SENSOR_HEIGHT,
} from '../sim/lidar'
import type { Detection } from '../sim/lidar'
import { useUi } from '../sim/store'
import { damp } from '../sim/geometry'
import CameraFeed from './CameraFeed'

const COLOR_MODE_ID = { height: 0, intensity: 1, class: 2 }
const DET_COLOR = { person: '#ea580c', tree: '#16a34a', building: '#2563eb' }

/* ─── облако точек ──────────────────────────────────────────────────────── */
function PointCloud() {
  const colorMode = useUi((s) => s.colorMode)
  const geo = useRef<THREE.BufferGeometry>(null)
  const mat = useRef<THREE.ShaderMaterial>(null)
  const dpr = useThree((s) => s.viewport.dpr)

  const attrs = useMemo(
    () => ({
      position: new THREE.BufferAttribute(lidar.positions, 3),
      aBirth: new THREE.BufferAttribute(lidar.birth, 1),
      aIntensity: new THREE.BufferAttribute(lidar.intensity, 1),
      aClass: new THREE.BufferAttribute(lidar.cls, 1),
    }),
    [],
  )

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uLife: { value: POINT_LIFETIME },
      uSize: { value: 2.7 },
      uDpr: { value: 1 },
      uMode: { value: 0 },
    }),
    [],
  )

  useEffect(() => {
    for (const a of Object.values(attrs)) a.setUsage(THREE.DynamicDrawUsage)
  }, [attrs])

  useFrame(() => {
    if (!geo.current) return
    const range = consumeDirty(lidar)
    if (range) {
      for (const [name, attr] of Object.entries(attrs)) {
        const size = name === 'position' ? 3 : 1
        if (typeof attr.clearUpdateRanges === 'function') {
          attr.clearUpdateRanges()
          attr.addUpdateRange(range.offset * size, range.count * size)
        }
        attr.needsUpdate = true
      }
    }
    if (mat.current) {
      mat.current.uniforms.uTime.value = lidar.time
      mat.current.uniforms.uDpr.value = dpr
      mat.current.uniforms.uMode.value = COLOR_MODE_ID[colorMode]
    }
  })

  return (
    <points frustumCulled={false} renderOrder={10}>
      <bufferGeometry ref={geo}>
        <primitive object={attrs.position} attach="attributes-position" />
        <primitive object={attrs.aBirth} attach="attributes-aBirth" />
        <primitive object={attrs.aIntensity} attach="attributes-aIntensity" />
        <primitive object={attrs.aClass} attach="attributes-aClass" />
      </bufferGeometry>
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        vertexShader={`
          attribute float aBirth;
          attribute float aIntensity;
          attribute float aClass;
          uniform float uTime; uniform float uLife; uniform float uSize; uniform float uDpr;
          varying float vAlpha; varying float vI; varying float vH; varying float vC; varying float vFresh;
          void main(){
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;
            float age = uTime - aBirth;
            float life = clamp(1.0 - age / uLife, 0.0, 1.0);
            vFresh = smoothstep(0.7, 1.0, life);
            vAlpha = aIntensity < 0.0 ? 0.0 : life * life;
            vI = aIntensity;
            vH = position.y;
            vC = aClass;
            float d = max(-mv.z, 1.0);
            gl_PointSize = clamp(uSize * uDpr * (26.0 / d), 1.0, 7.0) * (1.0 + vFresh * 0.4);
            if (vAlpha <= 0.001) gl_PointSize = 0.0;
          }
        `}
        fragmentShader={`
          uniform float uMode;
          varying float vAlpha; varying float vI; varying float vH; varying float vC; varying float vFresh;

          vec3 rampHeight(float h){
            float t = clamp(h / 13.0, 0.0, 1.0);
            vec3 c = mix(vec3(0.42,0.48,0.56), vec3(0.11,0.31,0.85), smoothstep(0.0,0.16,t));
            c = mix(c, vec3(0.05,0.45,0.56), smoothstep(0.16,0.45,t));
            c = mix(c, vec3(0.08,0.50,0.24), smoothstep(0.45,0.75,t));
            c = mix(c, vec3(0.71,0.33,0.04), smoothstep(0.75,1.0,t));
            return c;
          }
          vec3 rampIntensity(float i){
            float t = clamp(i, 0.0, 1.0);
            vec3 c = mix(vec3(0.68,0.73,0.79), vec3(0.15,0.39,0.68), smoothstep(0.0,0.5,t));
            c = mix(c, vec3(0.73,0.18,0.11), smoothstep(0.5,1.0,t));
            return c;
          }
          vec3 rampClass(float c){
            if (c < 0.5) return vec3(0.58,0.64,0.71);
            if (c < 1.5) return vec3(0.15,0.39,0.92);
            if (c < 2.5) return vec3(0.09,0.64,0.29);
            return vec3(0.92,0.35,0.02);
          }

          void main(){
            if (vAlpha <= 0.001) discard;
            vec2 p = gl_PointCoord - 0.5;
            float d2 = dot(p, p);
            if (d2 > 0.25) discard;
            vec3 col = uMode < 0.5 ? rampHeight(vH) : (uMode < 1.5 ? rampIntensity(vI) : rampClass(vC));
            col *= (1.0 - vFresh * 0.32);
            float soft = smoothstep(0.25, 0.03, d2);
            gl_FragColor = vec4(col, vAlpha * soft * (0.7 + vI * 0.3));
            #include <colorspace_fragment>
          }
        `}
      />
    </points>
  )
}

/* ─── опорные кольца дальности вокруг датчика ───────────────────────────── */
function RangeRings() {
  const grp = useRef<THREE.Group>(null)
  const mat = useRef<THREE.ShaderMaterial>(null)
  const uniforms = useMemo(
    () => ({ uAngle: { value: 0 }, uRange: { value: MAX_RANGE }, uColor: { value: new THREE.Color('#5b7285') } }),
    [],
  )
  useFrame(() => {
    if (grp.current) grp.current.position.set(sim.x, 0.02, -sim.y)
    if (mat.current) mat.current.uniforms.uAngle.value = lidar.azimuth
  })
  return (
    <group ref={grp}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[MAX_RANGE, 128]} />
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
              float rings = smoothstep(0.972, 1.0, abs(sin(r * 0.3141593)));
              float spokes = smoothstep(0.996, 1.0, abs(sin(a * 6.0)));
              float fade = smoothstep(uRange, uRange * 0.15, r);
              float sweep = exp(-d * 3.5) * 0.10;
              gl_FragColor = vec4(uColor, (rings * 0.24 + spokes * 0.10) * fade + sweep * fade);
              #include <colorspace_fragment>
            }
          `}
        />
      </mesh>
    </group>
  )
}

/* ─── корпус шаттла и вращающийся луч ───────────────────────────────────── */
function SensorRig() {
  const grp = useRef<THREE.Group>(null)
  const beam = useRef<THREE.Group>(null)
  const box = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(4.9, 2.4, 2.2)), [])
  const skirt = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(4.3, 0.5, 2.4)), [])

  useFrame(() => {
    if (grp.current) {
      grp.current.position.set(sim.x, 0, -sim.y)
      grp.current.rotation.y = sim.yaw
    }
    if (beam.current) beam.current.rotation.y = lidar.azimuth
  })

  return (
    <group ref={grp}>
      <lineSegments geometry={box} position={[0, 1.3, 0]}>
        <lineBasicMaterial color="#1f2937" />
      </lineSegments>
      <lineSegments geometry={skirt} position={[0, 0.3, 0]}>
        <lineBasicMaterial color="#93a3b3" />
      </lineSegments>
      <mesh position={[0, SENSOR_HEIGHT, 0]}>
        <cylinderGeometry args={[0.18, 0.18, 0.26, 12]} />
        <meshBasicMaterial color="#0f766e" />
      </mesh>
      <group ref={beam} position={[0, SENSOR_HEIGHT, 0]}>
        <mesh position={[MAX_RANGE / 2, 0, 0]}>
          <planeGeometry args={[MAX_RANGE, 7]} />
          <shaderMaterial
            transparent
            depthWrite={false}
            side={THREE.DoubleSide}
            vertexShader={`
              varying vec2 vUv;
              void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
            `}
            fragmentShader={`
              varying vec2 vUv;
              void main(){
                float fade = smoothstep(1.0, 0.0, vUv.x) * smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.65, vUv.y);
                gl_FragColor = vec4(vec3(0.06,0.46,0.43), fade * 0.16);
                #include <colorspace_fragment>
              }
            `}
          />
        </mesh>
      </group>
    </group>
  )
}

/* ─── рамки обнаруженных объектов ───────────────────────────────────────── */
function DetectionBoxes() {
  const [dets, setDets] = useState<Detection[]>([])
  const keyRef = useRef('')
  const groups = useRef<(THREE.Group | null)[]>([])
  const unitBox = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), [])

  useFrame(() => {
    const key = lidar.detections.map((d) => d.id).join('|')
    if (key !== keyRef.current) {
      keyRef.current = key
      setDets(lidar.detections.slice())
    }
    const pulse = 0.5 + 0.5 * Math.sin(lidar.time * 4)
    for (let i = 0; i < dets.length; i++) {
      const g = groups.current[i]
      const d = dets[i]
      if (!g || !d) continue
      if (d.cls === 'person') {
        const p = sim.pedestrians.find((q) => `p:${q.id}` === d.id)
        if (p) g.position.set(p.x, 0, -p.y)
      }
      const seg = g.children[0] as THREE.LineSegments
      if (seg) {
        ;(seg.material as THREE.LineBasicMaterial).opacity =
          d.cls === 'person' ? 0.5 + pulse * 0.5 : d.cls === 'tree' ? 0.35 : 0.6
      }
    }
  })

  return (
    <group>
      {dets.map((d, i) => {
        const h = Math.min(d.top, 24)
        return (
          <group key={d.id} position={[d.cx, 0, -d.cy]} ref={(g) => void (groups.current[i] = g)}>
            <lineSegments geometry={unitBox} scale={[d.hw * 2, h, d.hh * 2]} position={[0, h / 2, 0]}>
              <lineBasicMaterial color={DET_COLOR[d.cls]} transparent opacity={0.55} />
            </lineSegments>
            <Html position={[0, h + 1.6, 0]} center zIndexRange={[30, 5]}>
              <div className={`det-tag det-${d.cls}`}>
                <b>{d.label}</b>
                <span>
                  {d.track} · {d.dist.toFixed(1)} м · {d.points} тчк
                </span>
              </div>
            </Html>
          </group>
        )
      })}
    </group>
  )
}

/* ─── камера: погоня / вид сверху / свободный облёт ─────────────────────── */
function LidarCamera() {
  const view = useUi((s) => s.lidarView)
  const camera = useThree((s) => s.camera)
  const look = useRef(new THREE.Vector3())

  useFrame((_, dt) => {
    if (view === 'orbit') return
    const c = Math.cos(sim.yaw)
    const s = Math.sin(sim.yaw)
    if (view === 'chase') {
      camera.position.x = damp(camera.position.x, sim.x - c * 17, 3.2, dt)
      camera.position.y = damp(camera.position.y, 11, 3.2, dt)
      camera.position.z = damp(camera.position.z, -(sim.y - s * 17), 3.2, dt)
      look.current.set(
        damp(look.current.x, sim.x + c * 14, 4, dt),
        damp(look.current.y, 2, 4, dt),
        damp(look.current.z, -(sim.y + s * 14), 4, dt),
      )
      camera.up.set(0, 1, 0)
    } else {
      camera.position.x = damp(camera.position.x, sim.x, 3.2, dt)
      camera.position.y = damp(camera.position.y, 82, 3.2, dt)
      camera.position.z = damp(camera.position.z, -sim.y, 3.2, dt)
      look.current.set(
        damp(look.current.x, sim.x, 5, dt),
        damp(look.current.y, 0, 5, dt),
        damp(look.current.z, -sim.y, 5, dt),
      )
      // «вверх экрана» — направление движения, чтобы вид совпадал с картой
      camera.up.set(c, 0, -s)
    }
    camera.lookAt(look.current)
  })
  return null
}

type Controls = { target: THREE.Vector3 } | null

function OrbitRig() {
  const view = useUi((s) => s.lidarView)
  const ref = useRef<Controls>(null)
  useFrame((_, dt) => {
    const c = ref.current
    if (!c) return
    c.target.set(damp(c.target.x, sim.x, 2, dt), damp(c.target.y, 2, 2, dt), damp(c.target.z, -sim.y, 2, dt))
  })
  if (view !== 'orbit') return null
  return (
    <OrbitControls
      ref={ref as never}
      enablePan={false}
      minDistance={8}
      maxDistance={160}
      maxPolarAngle={Math.PI / 2.05}
      enableDamping
      dampingFactor={0.08}
    />
  )
}

/** Сцена лидара без обвязки панели — используется и в демо-режиме. */
export function LidarView({ camera = true }: { camera?: boolean }) {
  const colorMode = useUi((s) => s.colorMode)
  const showCamera = useUi((s) => s.showCamera)

  return (
    <>
      <Canvas
        dpr={[1, 1.75]}
        camera={{ position: [sim.x - 18, 12, -sim.y], fov: 55, near: 0.5, far: 900 }}
        gl={{ antialias: false, powerPreference: 'high-performance' }}
      >
        <color attach="background" args={['#f7f9fb']} />
        <LidarCamera />
        <OrbitRig />
        <RangeRings />
        <PointCloud />
        <SensorRig />
        <DetectionBoxes />
      </Canvas>

      <div className="lidar-legend">
        <div className="legend-row">
            <b>VLP-16</b>
            <span>
              {N_CHANNELS} каналов · {(lidar.pointsPerSecond / 1000).toFixed(0)}k точек/с · 8 Гц · до {MAX_RANGE} м
            </span>
          </div>
          <div className="legend-scale">
            {colorMode === 'class' ? (
              <>
                <i style={{ background: '#94a3b8' }} /> земля
                <i style={{ background: '#2563eb' }} /> здания
                <i style={{ background: '#16a34a' }} /> деревья
                <i style={{ background: '#ea580c' }} /> люди
              </>
            ) : (
              <>
                <div className={colorMode === 'height' ? 'ramp ramp-height' : 'ramp ramp-int'} />
                <span>{colorMode === 'height' ? '0 → 13 м' : 'слабое → сильное'}</span>
              </>
            )}
          </div>
        </div>

      {camera && showCamera && <CameraFeed />}
    </>
  )
}

export default function LidarScreen() {
  const { lidarView, colorMode, showCamera, set, toggle } = useUi()

  return (
    <section className="panel">
      <header className="panel-head">
        <div className="panel-title">
          <span className="dot dot-scan" />
          Экран 2 · облако точек лидара
        </div>
        <div className="panel-tools">
          {(['chase', 'top', 'orbit'] as const).map((v) => (
            <button key={v} className={lidarView === v ? 'chip chip-on' : 'chip'} onClick={() => set({ lidarView: v })}>
              {v === 'chase' ? 'Погоня' : v === 'top' ? 'Сверху' : 'Облёт'}
            </button>
          ))}
          <span className="tool-sep" />
          {(['height', 'intensity', 'class'] as const).map((v) => (
            <button
              key={v}
              className={colorMode === v ? 'chip chip-alt chip-on' : 'chip chip-alt'}
              onClick={() => set({ colorMode: v })}
            >
              {v === 'height' ? 'Высота' : v === 'intensity' ? 'Отражение' : 'Класс'}
            </button>
          ))}
          <button className={showCamera ? 'chip chip-on' : 'chip'} onClick={() => toggle('showCamera')}>
            Камера
          </button>
        </div>
      </header>
      <div className="panel-body">
        <LidarView />
      </div>
    </section>
  )
}

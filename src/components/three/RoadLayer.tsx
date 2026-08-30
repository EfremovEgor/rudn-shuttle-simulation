import { useMemo } from 'react'
import * as THREE from 'three'

import type { MapRoad, RoadKind } from '../../map/schema'
import { PALETTE, ribbonGeometry } from './utils'

/**
 * Дорожное покрытие: двухполосная проезжая часть (с прерывистой осевой
 * разметкой), однополосный проезд и пешеходная дорожка.
 * Используется и на схеме, и в виде с бортовой камеры.
 */

const FILL: Record<RoadKind, string> = {
  'two-lane': PALETTE.roadTwoLane,
  'one-lane': PALETTE.roadOneLane,
  walk: PALETTE.roadWalk,
}

const MARKING_VERT = `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
`
/** Прерывистая осевая: период 6 м, штрих 3 м (uv.x — метры вдоль дороги). */
const MARKING_FRAG = `
  uniform vec3 uColor;
  varying vec2 vUv;
  void main(){
    float dash = step(fract(vUv.x / 6.0), 0.5);
    float edge = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
    gl_FragColor = vec4(uColor, dash * edge * 0.95);
    #include <colorspace_fragment>
  }
`

export default function RoadLayer({
  roads,
  y = 0.05,
  markings = true,
}: {
  roads: MapRoad[]
  y?: number
  markings?: boolean
}) {
  const built = useMemo(
    () =>
      roads
        .filter((r) => r.points.length >= 2)
        .map((r) => {
          const pts = r.points.map(([x, z]) => ({ x, y: z }))
          return {
            id: r.id,
            kind: r.kind,
            fill: ribbonGeometry(pts, r.width, r.kind === 'walk' ? y + 0.02 : y),
            // осевая линия только у двухполосных дорог
            line: r.kind === 'two-lane' ? ribbonGeometry(pts, 0.28, y + 0.012) : null,
          }
        }),
    [roads, y],
  )

  const markingUniforms = useMemo(() => ({ uColor: { value: new THREE.Color(PALETTE.roadMarking) } }), [])

  return (
    <group>
      {built.map((r) => (
        <mesh key={r.id} geometry={r.fill}>
          <meshBasicMaterial color={FILL[r.kind]} />
        </mesh>
      ))}
      {markings &&
        built.map((r) =>
          r.line ? (
            <mesh key={`m${r.id}`} geometry={r.line} renderOrder={1}>
              <shaderMaterial
                uniforms={markingUniforms}
                transparent
                depthWrite={false}
                vertexShader={MARKING_VERT}
                fragmentShader={MARKING_FRAG}
              />
            </mesh>
          ) : null,
        )}
    </group>
  )
}

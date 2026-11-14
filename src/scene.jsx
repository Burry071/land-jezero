import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'
import {
  GRID,
  WINDOW_M,
  toMeshY,
} from './terrain'

const MESH_STEP = 2 // 128x128 mesh from the 256 grid — same data, half the vertices
const N = Math.floor((GRID - 1) / MESH_STEP) + 1

/** Real Jezero terrain as one draw call. Heights are true HiRISE elevations,
 *  exaggerated x2.5 for visibility (physics uses true values). */
export function TerrainMesh({ heights, orthoUrl }) {
  const tex = useTexture(orthoUrl)
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const verts = new Float32Array(N * N * 3)
    const uvs = new Float32Array(N * N * 2)
    const idx = []
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const i = r * N + c
        const gr = r * MESH_STEP
        const gc = c * MESH_STEP
        const x = (gc / (GRID - 1) - 0.5) * WINDOW_M
        const z = (gr / (GRID - 1) - 0.5) * WINDOW_M
        verts[i * 3] = x
        verts[i * 3 + 1] = toMeshY(heights[gr * GRID + gc])
        verts[i * 3 + 2] = z
        uvs[i * 2] = gc / (GRID - 1)
        uvs[i * 2 + 1] = 1 - gr / (GRID - 1)
      }
    }
    for (let r = 0; r < N - 1; r++) {
      for (let c = 0; c < N - 1; c++) {
        const a = r * N + c
        const b = a + 1
        const d = a + N
        const e = d + 1
        idx.push(a, d, b, b, d, e)
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    g.setIndex(idx)
    g.computeVertexNormals()
    return g
  }, [heights])

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial map={tex} roughness={1} metalness={0} />
    </mesh>
  )
}

/** Target ring at the real Perseverance landing site (window centre). */
/** Target beacon: a tall translucent gold column above the ring, so the
 * landing zone is visible from 950 m up (the flat ring is invisible from
 * there — confirmed in the real playtest). Static geometry, no animation.
 * Additive blending, open-ended, depthWrite off so the terrain stays visible. */
export function TargetBeacon({ groundY }) {
  return (
    <mesh position={[0, groundY + 200, 0]}>
      <cylinderGeometry args={[15, 15, 400, 24, 1, true]} />
      <meshBasicMaterial
        color="#ffd166"
        transparent
        opacity={0.15}
        side={THREE.DoubleSide}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  )
}

export function TargetRing({ groundY }) {
  return (
    <group position={[0, groundY + 2, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[28, 34, 48]} />
        <meshBasicMaterial color="#ffd166" transparent opacity={0.9} side={THREE.DoubleSide} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.5, 0]}>
        <ringGeometry args={[10, 12, 32]} />
        <meshBasicMaterial color="#ffd166" transparent opacity={0.7} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

/** The lander: body, legs, dish, engine flame. Pure primitives — no model file.
 *  Position + thrust are read straight from the sim refs inside useFrame,
 *  so the flight loop never triggers a React re-render (60 fps). */
export function Lander({ simRef, inputRef }) {
  const flame = useRef()
  const glow = useRef()
  const group = useRef()
  useFrame(({ clock }) => {
    const s = simRef.current
    if (!s || !group.current) return
    group.current.position.set(s.x, toMeshY(s.y), s.z)
    const crashed = s.status === 'crashed'
    const thrust = !crashed && s.status === 'flying' ? inputRef.current.main : 0
    if (flame.current) {
      const t = clock.getElapsedTime()
      const flicker = thrust > 0 ? 0.85 + Math.sin(t * 47) * 0.12 + Math.sin(t * 31) * 0.08 : 0
      flame.current.scale.set(1 + flicker * 0.3, Math.max(0.001, thrust * flicker * 2.2), 1 + flicker * 0.3)
      flame.current.visible = thrust > 0
    }
    if (glow.current) glow.current.intensity = thrust > 0 ? 60 : 0
    group.current.rotation.z = crashed ? 0.9 : 0
  })
  return (
    <group ref={group}>
      {/* body */}
      <mesh>
        <cylinderGeometry args={[2.2, 2.8, 3.2, 8]} />
        <meshStandardMaterial color="#d8d3c8" roughness={0.55} metalness={0.35} />
      </mesh>
      {/* gold foil skirt */}
      <mesh position={[0, -1.2, 0]}>
        <cylinderGeometry args={[2.8, 3.4, 1.4, 8]} />
        <meshStandardMaterial color="#c98a2e" roughness={0.4} metalness={0.8} />
      </mesh>
      {/* dish */}
      <mesh position={[0, 2.2, 0]} rotation={[0.5, 0, 0]}>
        <coneGeometry args={[1.6, 0.9, 16, 1, true]} />
        <meshStandardMaterial color="#e8e4da" roughness={0.5} metalness={0.4} side={THREE.DoubleSide} />
      </mesh>
      {/* legs */}
      {[0, 1, 2, 3].map((i) => {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4
        return (
          <mesh key={i} position={[Math.cos(a) * 2.6, -1.6, Math.sin(a) * 2.6]} rotation={[0, 0, Math.cos(a) * 0.5]}>
            <cylinderGeometry args={[0.18, 0.18, 2.6, 6]} />
            <meshStandardMaterial color="#8a8f98" roughness={0.5} metalness={0.7} />
          </mesh>
        )
      })}
      {/* engine flame */}
      <mesh ref={flame} position={[0, -3.4, 0]} rotation={[Math.PI, 0, 0]} visible={false}>
        <coneGeometry args={[1.5, 5, 12]} />
        <meshBasicMaterial color="#ffb347" transparent opacity={0.85} />
      </mesh>
      <pointLight ref={glow} position={[0, -4, 0]} color="#ff9a3c" intensity={0} distance={60} decay={2} />
    </group>
  )
}

/** Touchdown dust burst — one THREE.Points, updated in useFrame. */
export function Dust({ burst }) {
  const ref = useRef()
  const data = useMemo(() => {
    const n = 90
    const pos = new Float32Array(n * 3)
    const vel = []
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 6 + Math.random() * 22
      vel.push([Math.cos(a) * sp, 2 + Math.random() * 9, Math.sin(a) * sp])
    }
    return { n, pos, vel, life: 0 }
  }, [])
  useFrame((_, dt) => {
    if (!ref.current) return
    if (burst.current > data.life) {
      data.life = burst.current
      for (let i = 0; i < data.n; i++) {
        data.pos[i * 3] = burst.x
        data.pos[i * 3 + 1] = burst.y
        data.pos[i * 3 + 2] = burst.z
      }
    }
    const age = burst.current === 0 ? 99 : performance.now() / 1000 - data.life
    const geo = ref.current.geometry
    if (age < 1.4) {
      for (let i = 0; i < data.n; i++) {
        const v = data.vel[i]
        data.pos[i * 3] += v[0] * dt
        data.pos[i * 3 + 1] += v[1] * dt
        data.pos[i * 3 + 2] += v[2] * dt
        data.vel[i][1] -= 3.5 * dt
        if (data.pos[i * 3 + 1] < burst.y) data.pos[i * 3 + 1] = burst.y
      }
      geo.attributes.position.needsUpdate = true
      ref.current.material.opacity = Math.max(0, 0.75 * (1 - age / 1.4))
      ref.current.visible = true
    } else {
      ref.current.visible = false
    }
  })
  return (
    <points ref={ref} visible={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[data.pos, 3]} />
      </bufferGeometry>
      <pointsMaterial size={7} color="#c98a5a" transparent opacity={0} sizeAttenuation depthWrite={false} />
    </points>
  )
}

/** Camera: cinematic orbit on intro, chase cam in flight, trauma shake on impact.
 *  game-feel: shake = trauma^2 via summed sines, decays in real time, visual only.
 *  Lander position is read from the sim ref inside useFrame (no React renders). */
export function CameraRig({ phase, simRef, trauma, reducedMotion }) {
  const { camera } = useThree()
  const t = useRef(0)
  useFrame((_, dt) => {
    t.current += dt
    const time = t.current
    const s = simRef.current
    const lx = s?.x ?? 0
    const ly = s ? toMeshY(s.y) : 200
    const lz = s?.z ?? 0
    let target = new THREE.Vector3()
    let look = new THREE.Vector3()
    if (phase === 'intro') {
      const a = time * 0.03
      target.set(Math.cos(a) * 4200, 2600, Math.sin(a) * 4200)
      look.set(0, -400, 0)
    } else {
      // chase: above and behind the lander relative to its motion toward target
      target.set(lx + 90, ly + 55, lz + 130)
      look.set(lx, ly - 10, lz)
    }
    const snap = reducedMotion || phase === 'done'
    if (snap) {
      camera.position.copy(target)
    } else {
      camera.position.lerp(target, 1 - Math.pow(0.001, dt))
    }
    // trauma shake (game-feel): squared trauma, summed sines, decays in real time
    if (trauma.current > 0 && !reducedMotion) {
      const s = trauma.current * trauma.current
      const sh = Math.sin(time * 51.7) * 6 * s
      const sv = Math.sin(time * 69.3) * 4 * s
      camera.position.x += sh
      camera.position.y += sv
      trauma.current = Math.max(0, trauma.current - 1.4 * dt)
    }
    camera.lookAt(look)
  })
  return null
}

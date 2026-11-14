import { Suspense, useEffect, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import {
  loadTerrain,
  loadOrthoUrl,
  groundHeight,
  groundSlopeDeg,
  toMeshY,
  getMeta,
} from './terrain'
import { step, scoreTouchdown, initialState, driftHint, timeToGround, MAIN_THRUST, MARS_G } from './physics'
import { TerrainMesh, TargetRing, TargetBeacon, Lander, Dust, CameraRig } from './scene'

// review-animations: UI easing — custom curve, sub-300ms, ease-out only.
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)'
const reducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

function usePerfMeter() {
  const [perf, setPerf] = useState({ fps: 0, ms: 0 })
  useEffect(() => {
    let frames = 0
    let last = performance.now()
    let worst = 0
    let raf
    const loop = (now) => {
      frames++
      const dt = now - last
      if (dt > worst) worst = dt
      if (now - last >= 1000) {
        const fps = Math.round((frames * 1000) / (now - last))
        setPerf({ fps, ms: Math.round(worst) })
        window.__LAND_JEZERO_PERF__ = { fps, worstMs: Math.round(worst) }
        frames = 0
        worst = 0
        last = now
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return perf
}

// Telemetry cell colour against its SAFE limit: ok ≤ limit, warn ≤ red, else bad.
const cellCls = (v, ok, bad) => (v <= ok ? 'ok' : v <= bad ? 'warn' : 'bad')
// Net braking deceleration (main thrust minus Mars gravity) for the BRAKE cue.
const NET_BRAKE = MAIN_THRUST - MARS_G // 4.29 m/s²

export default function App() {
  const [terrain, setTerrain] = useState(null)
  const [ortho, setOrtho] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [phase, setPhase] = useState('intro') // intro | flying | done
  const [result, setResult] = useState(null)
  const [hud, setHud] = useState({ agl: 0, vVert: 0, vHoriz: 0, fuel: 100, dist: 0, slope: 0, hint: '', brake: false })
  // The flight sim lives in a ref, never in React state: 60 Hz without re-renders.
  const simRef = useRef(null)
  const inputRef = useRef({ main: 0, left: false, right: false, forward: false, back: false })
  const trauma = useRef(0)
  const burst = useRef({ current: 0, x: 0, y: 0, z: 0 })
  const perf = usePerfMeter()

  useEffect(() => {
    loadTerrain().then(setTerrain).catch((e) => setLoadError(String(e)))
    loadOrthoUrl().then(setOrtho).catch((e) => setLoadError(String(e)))
  }, [])

  // Fixed-step physics (60 Hz accumulator), HUD at 10 Hz.
  useEffect(() => {
    if (phase !== 'flying' || !terrain) return
    let acc = 0
    let last = performance.now()
    let raf
    let hudTimer = 0
    const loop = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      acc += dt
      while (acc >= 1 / 60) {
        acc -= 1 / 60
        let s = step(simRef.current, inputRef.current, 1 / 60, groundHeight)
        if (s.status === 'landed') {
          const slope = groundSlopeDeg(s.impact.x, s.impact.z)
          const dist = Math.hypot(s.impact.x, s.impact.z)
          const scored = scoreTouchdown(s.impact, slope, dist)
          s = { ...s, status: scored.verdict }
          burst.current = performance.now() / 1000
          burst.x = s.impact.x
          burst.y = toMeshY(s.impact.y) + 2
          burst.z = s.impact.z
          // reduced-motion: no dust burst, no camera shake (motion guide)
          if (reducedMotion) burst.current = 0
          trauma.current = reducedMotion ? 0 : scored.verdict === 'crashed' ? 0.9 : 0.45
          setResult({ ...scored, slope, dist, impact: s.impact })
          setPhase('done')
        }
        simRef.current = s
      }
      hudTimer += dt
      if (hudTimer > 0.1) {
        hudTimer = 0
        const s = simRef.current
        if (s) {
          const agl = Math.max(0, s.y - groundHeight(s.x, s.z))
          const vVert = -s.vy
          const hints = driftHint(s.vx, s.vz, s.x, s.z, timeToGround(agl, s.vy))
          setHud({
            agl,
            vVert,
            vHoriz: Math.hypot(s.vx, s.vz),
            fuel: s.fuel,
            dist: Math.hypot(s.x, s.z),
            slope: groundSlopeDeg(s.x, s.z),
            hint: hints.length
              ? [...new Set(hints.map((h) => h.text))].join(' · ')
              : 'Drift steady ✓',
            // BRAKE when falling too fast and the ground is closer than the
            // stopping distance plus a 20 m margin — steady red, never flashing.
            // Threshold 3.0 (not the 3.5 SAFE limit) leaves margin for
            // discrete-step overshoot and rising terrain: a player braking
            // exactly when lit must still land SAFE.
            brake: vVert > 3.0 && agl < (vVert * vVert) / (2 * NET_BRAKE) + 20,
          })
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [phase, terrain])

  // Keyboard input (hold to thrust; R restarts; Enter starts)
  useEffect(() => {
    const down = (e) => {
      if (e.repeat) return
      const k = e.key.toLowerCase()
      if (k === ' ' || k === 'arrowup') inputRef.current.main = 1
      if (k === 'w') inputRef.current.forward = true
      if (k === 'arrowleft' || k === 'a') inputRef.current.left = true
      if (k === 'arrowright' || k === 'd') inputRef.current.right = true
      if (k === 'arrowdown' || k === 's') inputRef.current.back = true
      if (k === 'enter' && phase === 'intro') startDescent()
      if (k === 'r' && phase === 'done') startDescent()
      if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault()
    }
    const up = (e) => {
      const k = e.key.toLowerCase()
      if (k === ' ' || k === 'arrowup') inputRef.current.main = 0
      if (k === 'w') inputRef.current.forward = false
      if (k === 'arrowleft' || k === 'a') inputRef.current.left = false
      if (k === 'arrowright' || k === 'd') inputRef.current.right = false
      if (k === 'arrowdown' || k === 's') inputRef.current.back = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [phase])

  function startDescent() {
    const s = initialState()
    s.y = groundHeight(s.x, s.z) + 950 // absolute elevation
    simRef.current = s
    setResult(null)
    trauma.current = 0
    setPhase('flying')
  }

  const meta = getMeta()

  return (
    <div className="app">
      <div className="canvas-wrap">
        {terrain && ortho ? (
          <Canvas
            dpr={[1, 2]}
            camera={{ fov: 55, near: 1, far: 30000, position: [4200, 2600, 0] }}
            gl={{ antialias: true, powerPreference: 'high-performance' }}
            onCreated={({ gl }) => {
              gl.toneMapping = THREE.ACESFilmicToneMapping
              gl.toneMappingExposure = 1.05
            }}
          >
            <color attach="background" args={['#1a0f08']} />
            <fogExp2 attach="fog" args={['#c98a5a', 0.000045]} />
            <ambientLight intensity={0.35} color="#d8b48f" />
            <directionalLight
              position={[4000, 2500, -2000]}
              intensity={2.4}
              color="#ffd9a0"
            />
            <Suspense fallback={null}>
              <TerrainMesh heights={terrain.heights} orthoUrl={ortho} />
              <TargetRing groundY={toMeshY(groundHeight(0, 0))} />
              <TargetBeacon groundY={toMeshY(groundHeight(0, 0))} />
            </Suspense>
            {phase !== 'intro' && <Lander simRef={simRef} inputRef={inputRef} />}
            <Dust burst={burst} />
            <CameraRig
              phase={phase}
              simRef={simRef}
              trauma={trauma}
              reducedMotion={reducedMotion}
            />
            <EffectComposer>
              <Bloom intensity={0.35} luminanceThreshold={0.75} luminanceSmoothing={0.2} mipmapBlur />
              <Vignette darkness={0.55} offset={0.25} />
            </EffectComposer>
          </Canvas>
        ) : (
          <div className="loading">
            {loadError ? (
              <p>Terrain failed to load: {loadError}</p>
            ) : (
              <p>Loading real Jezero terrain…</p>
            )}
          </div>
        )}
      </div>

      {/* HUD */}
      <header className="hud-top">
        <div>
          <h1>LAND JEZERO</h1>
          <p className="sub">Jezero Crater, Mars · 18.44°N 77.45°E · HiRISE 1 m DTM</p>
        </div>
        <div className="perf" title="Frames per second / worst frame in the last second">
          {perf.fps} FPS · {perf.ms} ms
        </div>
      </header>

      {phase === 'flying' && (
        <div className="telemetry" role="status" aria-live="off">
          <div className={cellCls(hud.vVert, 3.5, 8)}>
            <span>VERT SPEED</span>
            <strong>{hud.vVert.toFixed(1)} m/s ↓</strong>
          </div>
          <div className={cellCls(hud.vHoriz, 2.5, 8)}>
            <span>HORIZ SPEED</span>
            <strong>{hud.vHoriz.toFixed(1)} m/s</strong>
          </div>
          <div>
            <span>ALTITUDE</span>
            <strong>{hud.agl.toFixed(0)} m</strong>
          </div>
          <div className={cellCls(hud.dist, 150, 300)}>
            <span>DIST TO TARGET</span>
            <strong>{hud.dist.toFixed(0)} m</strong>
          </div>
          <div className={cellCls(hud.slope, 12, 25)}>
            <span>SLOPE BELOW</span>
            <strong>{hud.slope.toFixed(1)}°</strong>
          </div>
          <div className={`fuel ${hud.fuel <= 15 ? 'bad' : hud.fuel <= 30 ? 'warn' : 'ok'}`}>
            <span>FUEL</span>
            <div className="fuelbar">
              <div style={{ '--fuel': hud.fuel / 100 }} />
            </div>
            <strong>{hud.fuel.toFixed(0)}%</strong>
          </div>
          <div className="drift">
            <span>DRIFT</span>
            <strong>{hud.hint}</strong>
          </div>
          <div className={`brake${hud.brake ? ' on' : ''}`}>
            <span>BRAKE</span>
            <strong>{hud.brake ? 'HOLD THRUST' : '—'}</strong>
          </div>
        </div>
      )}

      {/* Intro overlay */}
      {phase === 'intro' && terrain && (
        <div className="overlay intro">
          <p className="kicker">NASA SPACE APPS CHALLENGE 2026 · CHALLENGE #11</p>
          <h2>
            Land on the <em>real</em> Mars.
          </h2>
          <p>
            This is Jezero Crater as NASA's HiRISE camera measured it — the same 1-metre
            terrain data Perseverance's landing team used. Fly the lander down, kill your
            speed, and touch down inside the gold ring at Octavia E. Butler Landing.
          </p>
          <p className="envelope">
            Land gently: under 3.5 m/s down, under 2.5 m/s sideways, inside 150 m of the ring.
          </p>
          <button className="cta" onClick={startDescent} autoFocus>
            Begin descent ↓
          </button>
          <p className="keys">
            <kbd>Space</kbd> main thruster · <kbd>W</kbd> forward · <kbd>←</kbd> <kbd>→</kbd> steer ·{' '}
            <kbd>↓</kbd> back · touch buttons work too
          </p>
        </div>
      )}

      {/* Touch controls */}
      {phase === 'flying' && (
        <div className="touch">
          <button
            aria-label="Steer left"
            onPointerDown={() => (inputRef.current.left = true)}
            onPointerUp={() => (inputRef.current.left = false)}
            onPointerLeave={() => (inputRef.current.left = false)}
          >
            ◀
          </button>
          <button
            className="thrust"
            aria-label="Hold to fire main thruster"
            onPointerDown={() => (inputRef.current.main = 1)}
            onPointerUp={() => (inputRef.current.main = 0)}
            onPointerLeave={() => (inputRef.current.main = 0)}
          >
            ▲ THRUST
          </button>
          <button
            aria-label="Steer right"
            onPointerDown={() => (inputRef.current.right = true)}
            onPointerUp={() => (inputRef.current.right = false)}
            onPointerLeave={() => (inputRef.current.right = false)}
          >
            ▶
          </button>
        </div>
      )}

      {/* Verdict */}
      {phase === 'done' && result && (
        <div className="overlay verdict" role="dialog" aria-label="Landing result">
          <p className="kicker">
            {result.verdict === 'safe' ? '✓ TOUCHDOWN' : result.verdict === 'hard' ? 'HARD LANDING' : '✕ CRASHED'}
          </p>
          <h2>
            {result.verdict === 'safe'
              ? 'SAFE — you landed on Mars.'
              : result.verdict === 'hard'
                ? 'You survived. Barely.'
                : 'The lander did not survive.'}
          </h2>
          <dl>
            <div>
              <dt>Distance from target</dt>
              <dd>{result.dist.toFixed(0)} m</dd>
            </div>
            <div>
              <dt>Ground slope</dt>
              <dd>{result.slope.toFixed(1)}°</dd>
            </div>
            <div>
              <dt>Vertical speed</dt>
              <dd>{result.impact.vVert.toFixed(1)} m/s</dd>
            </div>
            <div>
              <dt>Horizontal speed</dt>
              <dd>{result.impact.vHoriz.toFixed(1)} m/s</dd>
            </div>
            <div>
              <dt>Fuel left</dt>
              <dd>{result.impact.fuel.toFixed(0)}%</dd>
            </div>
            <div>
              <dt>Landing score</dt>
              <dd>{result.score} / 100</dd>
            </div>
          </dl>
          {result.reasons.length > 0 && (
            <p className="reasons">{result.reasons.join(' · ')}</p>
          )}
          <button className="cta" onClick={startDescent} autoFocus>
            Fly again ↺
          </button>
          <p className="keys">
            Terrain: USGS HiRISE DTM, 1 m/posting · heights ×2.5 for visibility — scoring uses true elevations
          </p>
        </div>
      )}

      <footer className="credit">
        Terrain: NASA / JPL / University of Arizona HiRISE, USGS Astrogeology Mars 2020 TRN DTM mosaic
        (DOI 10.5066/P9REJ9JN) · Target: Octavia E. Butler Landing, 18.44°N 77.45°E
      </footer>
    </div>
  )
}

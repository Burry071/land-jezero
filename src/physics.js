// Pure arcade flight model + touchdown scoring. No DOM, no three.js —
// unit-tested in tests/physics.test.mjs.

export const MARS_G = 3.71 // m/s^2
export const MAIN_THRUST = 8.0 // m/s^2 at full throttle
export const LATERAL_THRUST = 3.0 // m/s^2 per axis
export const FUEL_BURN_MAIN = 5.0 // % per second at full main thrust
export const FUEL_BURN_LATERAL = 1.5 // % per second per lateral axis

// Safe-landing envelope (Perseverance-class margins, simplified for the game)
export const SAFE = { vVert: 3.5, vHoriz: 2.5, slopeDeg: 12, distM: 150 }
export const CRASH = { vVert: 8, slopeDeg: 25 }

export function initialState() {
  // Start 650 m east of target, 950 m above ground, drifting toward it.
  return {
    x: 650,
    y: 950, // altitude ABOVE GROUND at start position (added to ground height by caller)
    z: 300,
    vx: -26,
    vy: -14,
    vz: -10,
    fuel: 100,
    status: 'flying', // flying | safe | hard | crashed
    time: 0,
  }
}

/**
 * One fixed step. `ground(x, z)` returns true ground elevation (m).
 * `input` = { main: 0..1, left, right, forward, back: booleans }.
 * Returns a NEW state object (no mutation — easy to test / rewind).
 */
export function step(s, input, dt, ground) {
  if (s.status !== 'flying') return s
  const main = s.fuel > 0 ? Math.max(0, Math.min(1, input.main || 0)) : 0
  const lat = s.fuel > 0
  const ax = (lat && input.left ? -LATERAL_THRUST : 0) + (lat && input.right ? LATERAL_THRUST : 0)
  const az = (lat && input.forward ? -LATERAL_THRUST : 0) + (lat && input.back ? LATERAL_THRUST : 0)
  const ay = main * MAIN_THRUST - MARS_G

  let fuel = s.fuel
  if (main > 0) fuel -= FUEL_BURN_MAIN * main * dt
  if (input.left || input.right) fuel -= FUEL_BURN_LATERAL * dt
  if (input.forward || input.back) fuel -= FUEL_BURN_LATERAL * dt
  fuel = Math.max(0, fuel)

  const vx = s.vx + ax * dt
  const vy = s.vy + ay * dt
  const vz = s.vz + az * dt
  const x = s.x + vx * dt
  const y = s.y + vy * dt
  const z = s.z + vz * dt

  const next = { ...s, x, y, z, vx, vy, vz, fuel, time: s.time + dt }

  // Touchdown: y is altitude above local ground at the new position.
  const g = ground(x, z)
  const agl = y - g
  if (agl <= 0) {
    next.y = g
    const vVert = -vy // positive = downward speed at impact
    const vHoriz = Math.hypot(vx, vz)
    next.impact = { vVert, vHoriz, x, z, fuel }
    next.status = 'landed' // scored by the caller with slope + distance
  }
  return next
}

/**
 * Score a touchdown. `slopeDeg` = true ground slope at the touchdown point,
 * `distM` = distance from the target in metres.
 * Returns { verdict: 'safe'|'hard'|'crashed', score: 0..100, reasons: string[] }.
 */
export function scoreTouchdown(impact, slopeDeg, distM) {
  const reasons = []
  const { vVert, vHoriz } = impact
  let verdict = 'safe'
  if (vVert > CRASH.vVert || slopeDeg > CRASH.slopeDeg) verdict = 'crashed'
  else if (
    vVert > SAFE.vVert ||
    vHoriz > SAFE.vHoriz ||
    slopeDeg > SAFE.slopeDeg ||
    distM > SAFE.distM
  ) {
    verdict = 'hard'
  }
  if (vVert > SAFE.vVert) reasons.push(`vertical speed ${vVert.toFixed(1)} m/s — too fast`)
  if (vHoriz > SAFE.vHoriz) reasons.push(`horizontal speed ${vHoriz.toFixed(1)} m/s — drifting`)
  if (slopeDeg > SAFE.slopeDeg) reasons.push(`slope ${slopeDeg.toFixed(1)}° — too steep`)
  if (distM > SAFE.distM) reasons.push(`${distM.toFixed(0)} m from target`)

  // Score: 100 at perfect, decays with each error; crash caps at 12.
  const clamp01 = (v) => Math.max(0, Math.min(1, v))
  const sV = clamp01(1 - Math.max(0, vVert - 1) / (CRASH.vVert - 1))
  const sH = clamp01(1 - Math.max(0, vHoriz - 0.5) / (CRASH.vVert - 0.5))
  const sS = clamp01(1 - Math.max(0, slopeDeg - 3) / (CRASH.slopeDeg - 3))
  const sD = clamp01(1 - distM / 600)
  const sF = impact.fuel / 100
  let score = Math.round(100 * (0.35 * sV + 0.2 * sH + 0.2 * sS + 0.15 * sD + 0.1 * sF))
  if (verdict === 'crashed') score = Math.min(score, 12)
  if (verdict === 'safe' && reasons.length === 0) score = Math.max(score, 85)
  return { verdict, score, reasons }
}

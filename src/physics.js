// Pure arcade flight model + touchdown scoring. No DOM, no three.js —
// unit-tested in tests/physics.test.mjs.

export const MARS_G = 3.71 // m/s^2
export const MAIN_THRUST = 8.0 // m/s^2 at full throttle
export const LATERAL_THRUST = 6.0 // m/s^2 per axis
export const FUEL_BURN_MAIN = 2.0 // % per second at full main thrust
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
    vx: -18,
    vy: -10,
    vz: -12,
    fuel: 100,
    status: 'flying', // flying | safe | hard | crashed
    time: 0,
  }
}

/**
 * Seconds until touchdown from this altitude (`agl` m) falling at `vy`
 * (m/s, negative = down), assuming the only sane vertical policy: free-fall
 * until the braking zone, then full thrust while still falling too fast.
 * Pure forward simulation of the vertical dynamics, no lateral motion.
 */
export function timeToGround(agl, vy) {
  let y = agl
  let v = vy
  let t = 0
  const dt = 1 / 60
  while (y > 0 && t < 300) {
    const stopDist = (v * v - 3.5 * 3.5) / (2 * (MAIN_THRUST - MARS_G))
    const inBrakeZone = y <= Math.max(40, stopDist * 1.1)
    const main = inBrakeZone && v < -3.5 ? 1 : inBrakeZone && v < -3.0 ? 0.464 : 0
    v += (main * MAIN_THRUST - MARS_G) * dt
    y += v * dt
    t += dt
  }
  return t
}

// Drift deadband: below this per-axis speed the drift is safe to ignore
// (two axes at the deadband stay under the SAFE.vHoriz envelope).
export const DRIFT_DEADBAND = 1.5 // m/s per axis

/**
 * Pure drift cue. The start is 650 m east of the target, so the opening
 * drift is not a mistake to kill — it is the ride to the target, and at
 * the opening speeds it is too slow a ride: the lander must speed up
 * before it can brake. A pure velocity-only cue ("kill all drift now")
 * would strand the lander ~600 m out, so this helper takes position and
 * time-to-ground (`tGo`, seconds — see timeToGround) and tells the
 * player, per axis: speed up, ride, brake now, or come back after
 * drifting past the target.
 *
 * Screen directions assume the chase camera in scene.jsx, which sits +x/+z
 * of the lander and looks back at it: -x reads as screen-left, +x as
 * screen-right, -z as away from the viewer (up-screen), +z as toward it.
 * Stopping distance for an axis is v^2 / (2 * LATERAL_THRUST); braking
 * starts 15 m before that, so the lander stops ~15 m short of the target.
 *
 * Keys: -x thrust is ←/A, +x thrust is →/D, +z thrust is ↓/S ("back"),
 * -z thrust is W ("forward"). W is bound to forward only since the
 * steering fix; Space/↑ stay main thrust.
 *
 * The z axis is deliberately quieter than x: the lander starts at z=300
 * (target z=0), so -z drift IS the approach and is never flagged while
 * z > 0. It only speaks when |vz| must be killed near touchdown (brake
 * range) or the lander is drifting away / overshooting (z < 0 or +z
 * drift) — following a cue that flagged the approach would fight it.
 * Returns one entry per axis that needs a cue; [] when steady.
 */
export function driftHint(vx, vz, x, z, tGo) {
  const hints = []
  const stop = (v) => (v * v) / (2 * LATERAL_THRUST)
  // negKey accelerates in the -v direction, posKey in the +v direction.
  // For x: '←' is -x thrust, '→' is +x thrust. For z: 'W' is -z thrust
  // (forward), '↓' is +z thrust (back). onlyBrake (z) suppresses the
  // speed-up and glide cues, so the approach is never flagged — see doc.
  const axis = (name, v, pos, negKey, posKey, onlyBrake) => {
    if (Math.abs(v) <= DRIFT_DEADBAND) return
    const toward = (pos > 0 && v < 0) || (pos < 0 && v > 0)
    const dist = Math.abs(pos)
    // Speed needed to reach the braking point in time: the last |v|/6 s
    // of the flight are spent braking, not travelling. (A plain dist/tGo
    // overstates the speed needed early and makes the cue demand more
    // speed all flight — the lander then arrives too fast to stop.)
    const tBrake = Math.abs(v) / LATERAL_THRUST
    const required = (dist - stop(v) - 15) / Math.max(tGo - tBrake, 1)
    const brakeKey = v < 0 ? posKey : negKey // key opposing the velocity
    const goKey = v < 0 ? negKey : posKey // key in the direction of travel
    if (!toward) {
      hints.push({ axis: name, key: brakeKey, text: brakeKey ? `Drifting away — hold ${brakeKey}` : 'Drifting away — no key fixes this' })
    } else if (dist <= stop(v) + 15 || tGo <= tBrake + 0.5) {
      hints.push({ axis: name, key: brakeKey, text: brakeKey ? `Brake now — hold ${brakeKey}` : 'Brake needed — no key fixes this' })
    } else if (!onlyBrake && Math.abs(v) < 0.8 * required) {
      hints.push({ axis: name, key: goKey, text: goKey ? `Too slow to reach target — hold ${goKey}` : 'Too slow to reach target — no key speeds this up' })
    } else if (!onlyBrake) {
      hints.push({ axis: name, key: null, text: 'Gliding to target — hold nothing' })
    }
  }
  axis('x', vx, x, '←', '→', false)
  axis('z', vz, z, 'W', '↓', true)
  return hints
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

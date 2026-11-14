// Failing-first checks for the flight model (run: npm test).
// Node built-in test runner, no dependencies.
import test from 'node:test'
import assert from 'node:assert/strict'
import { step, scoreTouchdown, initialState, driftHint, timeToGround, MARS_G, MAIN_THRUST, LATERAL_THRUST, FUEL_BURN_MAIN } from '../src/physics.js'

const flat = () => 0

test('free fall accelerates at Mars gravity', () => {
  let s = { ...initialState(), x: 0, y: 500, z: 0, vx: 0, vy: 0, vz: 0, fuel: 100, status: 'flying', time: 0 }
  s = step(s, {}, 1, flat)
  assert.ok(Math.abs(s.vy + MARS_G) < 1e-9, `vy should be -${MARS_G}, got ${s.vy}`)
})

test('full main thrust climbs (TWR > 1)', () => {
  let s = { ...initialState(), x: 0, y: 500, z: 0, vx: 0, vy: 0, vz: 0, fuel: 100, status: 'flying', time: 0 }
  s = step(s, { main: 1 }, 1, flat)
  assert.ok(s.vy > 0, `vy should be positive under full thrust, got ${s.vy}`)
})

test('no fuel means no thrust', () => {
  let s = { ...initialState(), x: 0, y: 500, z: 0, vx: 0, vy: 0, vz: 0, fuel: 0, status: 'flying', time: 0 }
  s = step(s, { main: 1, left: true }, 1, flat)
  assert.equal(s.vx, 0)
  assert.ok(Math.abs(s.vy + MARS_G) < 1e-9)
})

test('touchdown is detected and stops the sim', () => {
  let s = { ...initialState(), x: 0, y: 2, z: 0, vx: 0, vy: -5, vz: 0, fuel: 100, status: 'flying', time: 0 }
  s = step(s, {}, 0.5, flat)
  assert.equal(s.status, 'landed')
  assert.equal(s.y, 0)
  assert.ok(s.impact.vVert > 0)
})

test('gentle touchdown on flat ground near target scores safe', () => {
  const r = scoreTouchdown({ vVert: 2.0, vHoriz: 1.0, fuel: 40 }, 4, 30)
  assert.equal(r.verdict, 'safe')
  assert.ok(r.score >= 85, `score ${r.score}`)
})

test('fast vertical touchdown crashes', () => {
  const r = scoreTouchdown({ vVert: 12, vHoriz: 1, fuel: 40 }, 4, 30)
  assert.equal(r.verdict, 'crashed')
  assert.ok(r.score <= 12)
})

test('steep slope crashes even at low speed', () => {
  const r = scoreTouchdown({ vVert: 2, vHoriz: 1, fuel: 40 }, 30, 10)
  assert.equal(r.verdict, 'crashed')
})

test('far from target but gentle is a hard landing, not a crash', () => {
  const r = scoreTouchdown({ vVert: 2, vHoriz: 1, fuel: 40 }, 4, 500)
  assert.equal(r.verdict, 'hard')
})

// Steering fix (2026-11-14): lateral thrust 6.0, main fuel burn 2.0.
test('lateral thrust is 6.0 m/s^2', () => {
  assert.equal(LATERAL_THRUST, 6.0)
  let s = { ...initialState(), x: 0, y: 500, z: 0, vx: 0, vy: 0, vz: 0, fuel: 100, status: 'flying', time: 0 }
  s = step(s, { left: true }, 1, flat)
  assert.equal(s.vx, -6)
})

test('main fuel burn is 2.0 %/s', () => {
  assert.equal(FUEL_BURN_MAIN, 2.0)
  let s = { ...initialState(), x: 0, y: 500, z: 0, vx: 0, vy: 0, vz: 0, fuel: 100, status: 'flying', time: 0 }
  s = step(s, { main: 1 }, 1, flat)
  assert.equal(s.fuel, 98)
})

test('timeToGround at the start is ~29 s', () => {
  const t = timeToGround(950, -10)
  assert.ok(t > 20 && t < 35, `tGo ${t}`)
})

// Drift cue: opening state — x is too slow a ride (hold ←), the -z approach is NOT flagged.
test('driftHint at opening: speed up x, stay silent on the z approach', () => {
  const tGo = timeToGround(950, -10)
  const hints = driftHint(-18, -12, 650, 300, tGo)
  assert.equal(hints.length, 1)
  assert.equal(hints[0].axis, 'x')
  assert.equal(hints[0].key, '←')
  assert.match(hints[0].text, /Too slow/)
})

test('driftHint braking near the target names the opposing key', () => {
  const xb = driftHint(-18, -12, 40, 300, 3).find((h) => h.axis === 'x')
  assert.equal(xb.key, '→')
  assert.match(xb.text, /Brake now/)
  const zb = driftHint(-18, -12, 650, 20, 3).find((h) => h.axis === 'z')
  assert.equal(zb.key, '↓')
  assert.match(zb.text, /Brake now/)
})

test('driftHint flags overshoot and +z drift with the correcting key', () => {
  const over = driftHint(0, -12, 0, -50, 20)
  assert.equal(over[0].axis, 'z')
  assert.equal(over[0].key, '↓')
  assert.match(over[0].text, /Drifting away/)
  const away = driftHint(0, 5, 0, 100, 20)
  assert.equal(away[0].axis, 'z')
  assert.equal(away[0].key, 'W') // W (forward) is bound since the steering fix
})

test('driftHint is silent when steady and when the z approach is merely slow', () => {
  assert.deepEqual(driftHint(0, 0, 100, 100, 20), [])
  assert.deepEqual(driftHint(0, -3, 0, 300, 25), [])
})

// Winnability: a controller that follows the on-screen hint (lateral) and
// brakes only in the braking zone (the BRAKE cue's zone) must land SAFE.
test('hint-following controller lands SAFE with score >= 85', () => {
  const NET = MAIN_THRUST - MARS_G
  let s = initialState()
  const dt = 1 / 60
  let guard = 0
  while (s.status === 'flying' && guard++ < 60 * 120) {
    const agl = s.y
    const tGo = timeToGround(agl, s.vy)
    const input = { main: 0, left: false, right: false, forward: false, back: false }
    for (const h of driftHint(s.vx, s.vz, s.x, s.z, tGo)) {
      if (h.key === '←') input.left = true
      if (h.key === '→') input.right = true
      if (h.key === 'W') input.forward = true
      if (h.key === '↓') input.back = true
    }
    const stopDist = (s.vy * s.vy - 3.5 * 3.5) / (2 * NET)
    if (agl <= Math.max(40, stopDist * 1.1)) {
      if (s.vy < -3.5) input.main = 1
      else if (s.vy < -3.0) input.main = 0.464
    }
    s = step(s, input, dt, flat)
  }
  assert.equal(s.status, 'landed')
  const dist = Math.hypot(s.impact.x, s.impact.z)
  const r = scoreTouchdown(s.impact, 0, dist)
  assert.equal(r.verdict, 'safe', `verdict ${r.verdict}, score ${r.score}, dist ${dist.toFixed(0)}m`)
  assert.ok(r.score >= 85, `score ${r.score}`)
  assert.ok(s.fuel > 0, `fuel ${s.fuel}`)
})

// Failing-first checks for the flight model (run: npm test).
// Node built-in test runner, no dependencies.
import test from 'node:test'
import assert from 'node:assert/strict'
import { step, scoreTouchdown, initialState, MARS_G } from '../src/physics.js'

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

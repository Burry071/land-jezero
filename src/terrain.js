// Terrain data: real HiRISE DTM of Jezero Crater, USGS Mars 2020 TRN mosaic.
// Assets: public/terrain/jezero-height.png.b64 (base64 text of the 256x256
// RGB PNG encoding 16-bit elevation as R=high byte, G=low byte — canvas
// getImageData is 8-bit/channel, so a 16-bit PNG would silently lose the
// low byte) + jezero-meta.json with the min/max scale +
// jezero-ortho.jpg.b64 (base64 text of the 1024x1024 ortho). The .b64 files
// are what ships (GitHub MCP can only push UTF-8 text); the binaries are
// the source of truth and are kept alongside them.
// Heights here are TRUE elevations in metres; the 3D mesh exaggerates them
// (HEIGHT_EXAG) for visibility only — physics and slope scoring use true values.

export const GRID = 256
export const WINDOW_M = 6000 // 6 x 6 km window
export const HEIGHT_EXAG = 2.5 // visual only; scoring uses true elevations

let heights = null // Float32Array(GRID*GRID), metres, row-major (row = -z north)
let meta = null

/** Decode a base64 text payload into a Blob. The terrain assets ship as
 *  .b64 text files (the GitHub MCP connector can only push UTF-8 text),
 *  so the binary is reconstructed client-side; the .png/.jpg originals
 *  remain the source of truth in the repo. */
function b64ToBlob(b64, mime) {
  const bin = atob(b64.replace(/\s/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

export async function loadTerrain() {
  if (heights) return { heights, meta }
  const [metaRes, b64] = await Promise.all([
    fetch('./terrain/jezero-meta.json').then((r) => r.json()),
    fetch('./terrain/jezero-height.png.b64').then((r) => r.text()),
  ])
  meta = metaRes
  const bmp = await createImageBitmap(b64ToBlob(b64, 'image/png'))
  const cv = document.createElement('canvas')
  cv.width = GRID
  cv.height = GRID
  const ctx = cv.getContext('2d')
  ctx.drawImage(bmp, 0, 0)
  const data = ctx.getImageData(0, 0, GRID, GRID).data
  // 16-bit elevation is stored as R=high byte, G=low byte (see extract_terrain.py).
  heights = new Float32Array(GRID * GRID)
  const span = meta.elev_max_m - meta.elev_min_m
  for (let i = 0; i < GRID * GRID; i++) {
    const q = (data[i * 4] << 8) | data[i * 4 + 1]
    heights[i] = meta.elev_min_m + (q / 65535) * span
  }
  return { heights, meta }
}

export function getMeta() {
  return meta
}

/** Ortho texture as a data: URL, decoded from the .b64 text asset.
 *  THREE's TextureLoader accepts data: URLs, so this feeds the existing
 *  useTexture(orthoUrl) path unchanged. */
let orthoUrl = null
export async function loadOrthoUrl() {
  if (orthoUrl) return orthoUrl
  const b64 = await fetch('./terrain/jezero-ortho.jpg.b64').then((r) => r.text())
  orthoUrl = `data:image/jpeg;base64,${b64.replace(/\s/g, '')}`
  return orthoUrl
}

/** Mesh-space Y for a true elevation: mesh exaggerates relief for visibility. */
export function toMeshY(elev) {
  return (elev - meta.elev_min_m) * HEIGHT_EXAG
}

// World coords: x = east (m), z = south (m), origin = window centre.
// Landing target (Octavia E. Butler Landing) is at the window centre.
export function worldToGrid(x, z) {
  const u = ((x + WINDOW_M / 2) / WINDOW_M) * (GRID - 1)
  const v = ((z + WINDOW_M / 2) / WINDOW_M) * (GRID - 1)
  return [u, v]
}

function bilinear(u, v) {
  const x0 = Math.max(0, Math.min(GRID - 2, Math.floor(u)))
  const z0 = Math.max(0, Math.min(GRID - 2, Math.floor(v)))
  const fx = Math.max(0, Math.min(1, u - x0))
  const fz = Math.max(0, Math.min(1, v - z0))
  const i = (r, c) => heights[r * GRID + c]
  const a = i(z0, x0)
  const b = i(z0, x0 + 1)
  const c = i(z0 + 1, x0)
  const d = i(z0 + 1, x0 + 1)
  return a * (1 - fx) * (1 - fz) + b * fx * (1 - fz) + c * (1 - fx) * fz + d * fx * fz
}

/** True ground elevation (m) under world point (x, z). */
export function groundHeight(x, z) {
  if (!heights) return 0
  const [u, v] = worldToGrid(x, z)
  return bilinear(u, v)
}

/** True slope (degrees) at world point, from central differences over ~47 m. */
export function groundSlopeDeg(x, z) {
  const d = WINDOW_M / (GRID - 1) // ~23.4 m per sample
  const gx = (groundHeight(x + d, z) - groundHeight(x - d, z)) / (2 * d)
  const gz = (groundHeight(x, z + d) - groundHeight(x, z - d)) / (2 * d)
  return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI
}

/** Grid-space (row, col) of the landing target (window centre). */
export function targetGrid() {
  return [GRID / 2, GRID / 2]
}

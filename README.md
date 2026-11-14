# LAND JEZERO — Land on Real Mars

**NASA Space Apps Challenge 2026 · Challenge #11: Interplanetary Survival Guide: Martian Map**
· Multan Local Event · Team: Fahad Irshad (solo)

Fly a lander onto the real surface of Jezero Crater, Mars. The terrain is the
actual 1-metre HiRISE digital terrain model that Perseverance's landing team
used — every ridge and slope under your spacecraft was measured by a spacecraft
in orbit. Fire the thrusters, kill your speed, and touch down inside the gold
ring at **Octavia E. Butler Landing (18.44°N, 77.45°E)**.

## Play it

```sh
npm install
npm run dev        # local dev server
npm run build      # static production build in dist/
npm run preview    # serve the production build locally
npm test           # physics unit tests (8 checks)
```

No backend, no keys, no accounts. The whole game is a static site.

## How it works

- **Terrain (real data):** USGS Astrogeology **Mars 2020 Terrain Relative
  Navigation HiRISE DTM mosaic**, 1 m/posting, MOLA-aligned
  (DOI [10.5066/P9REJ9JN](https://doi.org/10.5066/P9REJ9JN);
  Fergason et al. 2020, LPSC). A 6 × 6 km window around the landing site was
  downsampled to a 256 × 256 heightmap (`public/terrain/jezero-height.png.b64`,
  16-bit elevation packed as R=high/G=low byte) by `tools/extract_terrain.py`.
  The terrain texture is the real HiRISE orthoimage ESP_045994_1985
  (0.25 m/px, tinted with a Mars palette since it is a single grayscale
  band), downsampled to 1024 × 1024. The ortho strip does not cover the
  eastern 16.1% of the window; those pixels are filled with a hillshade of
  the same DTM, tone-matched to the ortho (recorded in the meta JSON as
  `ortho_nodata_filled_pct`).
- **Terrain assets:** the heightmap and orthoimage ship as single-line
  base64 text files (`jezero-height.png.b64`, `jezero-ortho.jpg.b64`) and
  are decoded in the browser at load time (`atob` → Blob → image) — the
  same bytes as the original PNG/JPG, verified by round-trip decode.
- **Physics:** Mars gravity 3.71 m/s², main + lateral thrusters, fuel. Touchdown
  is scored on the **true** elevations and slopes from the DTM — vertical
  speed, horizontal speed, ground slope, distance from target, fuel left.
  Safe envelope: ≤3.5 m/s vertical, ≤2.5 m/s horizontal, slope ≤12°,
  within 150 m of target.
- **Honesty note:** mesh heights are exaggerated ×2.5 for visibility (the real
  relief is ~200 m over 6 km — nearly flat on screen). Physics and scoring
  always use true elevations.
- **Controls:** `Space` / `↑` main thruster (hold), `W` forward, `←` `→` steer,
  `↓` back, `R` retry, `Enter` start — plus on-screen touch buttons (hold to thrust).
  The HUD shows a live drift cue (which key kills your drift) and a BRAKE cue
  when you are falling too fast to stop in time; a gold beacon marks the target
  from high up.

## Data sources

| Data | Source | Link |
|---|---|---|
| HiRISE DTM mosaic, Jezero (1 m) | USGS Astrogeology, Mars 2020 TRN | https://astrogeology.usgs.gov/search/map/Mars/Mars2020/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40 |
| HiRISE orthoimage ESP_045994_1985 | USGS Astrogeology, same mosaic | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/ |
| Perseverance landing site | NASA / JPL | Octavia E. Butler Landing, 18.4446°N 77.4509°E |

## Performance

- Single terrain draw call (128×128 mesh from the 256 grid), one 1024²
  texture, DPR capped at 2, bloom kept subtle. An in-app meter (top right)
  shows live FPS and worst frame time.
- `prefers-reduced-motion` is respected: no camera shake, no dust burst,
  camera snaps instead of lerping.

## License

MIT — see `LICENSE`.

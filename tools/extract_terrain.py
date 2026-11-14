"""Extract a 6x6 km Jezero window around Perseverance's landing site from the
USGS Mars 2020 TRN HiRISE DTM (Jezero_C + Jezero_E tiles, 1 m/posting, merged
so the C tile's nodata gaps are filled by E), plus the matching orthoimage.
Run with the geo venv python: /tmp/geo-venv/bin/python tools/extract_terrain.py
Source: https://astrogeology.usgs.gov/search/map/Mars/Mars2020/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40
DOI: 10.5066/P9REJ9JN (Fergason et al. 2020)."""
import json, os
import numpy as np
import rasterio
from rasterio.env import Env
from rasterio.windows import from_bounds
from rasterio.enums import Resampling
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "..", "public", "terrain")
BASE = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/"
ORTHO_URL = BASE + "ESP_045994_1985_Edited_affine_25cm_Eqc_latTs0_lon0.tif"

DEG_M = 59274.6975
LAND_LON, LAND_LAT = 77.4509, 18.4446
HALF = 3000.0

cx, cy = LAND_LON * DEG_M, LAND_LAT * DEG_M
win_bounds = (cx - HALF, cy - HALF, cx + HALF, cy + HALF)


def read_window(path, bands, shape, resampling=Resampling.bilinear):
    with rasterio.open(path) as ds:
        win = from_bounds(*win_bounds, transform=ds.transform)
        return ds.read(bands, window=win, out_shape=shape, resampling=resampling), ds.nodata


tiles = [
    os.path.join(DATA, "jezero_C_dtm.tif"),
    os.path.join(DATA, "jezero_E_dtm.tif"),
]
# C tile is in /tmp from the earlier download; E tile is in tools/data.
if not os.path.exists(tiles[0]):
    tiles[0] = "/tmp/jezero_C_dtm.tif"

# Prefer the single-source full mosaic when it is present and complete:
# one source means no C/E stitch seam at all.
mosaic = os.path.join(DATA, "jezero_mosaic_dtm.tif")
h = None
single_source = False
if os.path.exists(mosaic):
    try:
        arr, nd = read_window(mosaic, 1, (256, 256))
        arr = np.where((arr == nd) | (arr < -10000), np.nan, arr)
        if np.isnan(arr).sum() == 0:
            h = arr
            single_source = True
            print(f"jezero_mosaic_dtm.tif: single source, valid 100%, "
                  f"elev range: {np.nanmin(h):.1f}..{np.nanmax(h):.1f} m")
        else:
            print(f"mosaic has {np.isnan(arr).sum()} nodata px — falling back to C+E merge")
    except Exception as e:
        print(f"mosaic read failed ({str(e)[:120]}) — falling back to C+E merge")

if h is None:
  for t in tiles:
    arr, nd = read_window(t, 1, (256, 256))
    arr = np.where((arr == nd) | (arr < -10000), np.nan, arr)
    if h is None:
        h = arr
        print(f"{os.path.basename(t)}: valid {(~np.isnan(arr)).mean()*100:.1f}%")
    else:
        before = np.isnan(h).sum()
        h = np.where(np.isnan(h), arr, h)
        print(f"{os.path.basename(t)}: filled {before - np.isnan(h).sum()} nodata px, "
              f"remaining nodata {np.isnan(h).sum()}")
    print(f"  elev valid range: {np.nanmin(h):.1f}..{np.nanmax(h):.1f} m")

# Fill any leftover holes by iterative neighbour averaging (small gaps only).
for _ in range(200):
    missing = np.isnan(h)
    if not missing.any():
        break
    filled = np.nanmean(np.stack([
        np.roll(h, 1, 0), np.roll(h, -1, 0), np.roll(h, 1, 1), np.roll(h, -1, 1)]), axis=0)
    h = np.where(missing, filled, h)
print("nodata after fill:", int(np.isnan(h).sum()))

# Light smoothing: a separable binomial blur (~2 px = ~47 m). With the
# single-source mosaic there is no stitch seam; the blur only takes the
# edge off the 256-grid quantisation. Real features at game scale survive.
def _blur5(a):
    k = np.array([1, 4, 6, 4, 1], dtype=np.float32) / 16.0
    p = np.pad(a, ((2, 2), (0, 0)), mode='edge')
    out = np.zeros_like(a)
    for i, w in enumerate(k):
        out += w * p[i:i + a.shape[0], :]
    p = np.pad(out, ((0, 0), (2, 2)), mode='edge')
    out2 = np.zeros_like(a)
    for i, w in enumerate(k):
        out2 += w * p[:, i:i + a.shape[1]]
    return out2

hmin, hmax = float(np.nanmin(h)), float(np.nanmax(h))
q = ((h - hmin) / (hmax - hmin) * 65535).astype(np.float32)
q = _blur5(_blur5(q)).astype(np.uint16)
h = hmin + q / 65535 * (hmax - hmin)
hmin, hmax = float(h.min()), float(h.max())
# Browser-safe 16-bit encoding: canvas getImageData() is 8-bit per channel,
# so store the height as R=high byte, G=low byte in an 8-bit RGB PNG
# (terrain.js decodes (R<<8)|G). Do NOT save as a 16-bit PNG — browsers
# would silently drop the low byte.
rgb = np.zeros((256, 256, 3), dtype=np.uint8)
rgb[..., 0] = (q >> 8).astype(np.uint8)
rgb[..., 1] = (q & 0xFF).astype(np.uint8)
Image.fromarray(rgb, mode="RGB").save(os.path.join(OUT, "jezero-height.png"))
print("saved jezero-height.png 256x256, elev %.1f..%.1f m (relief %.1f m)" % (hmin, hmax, hmax - hmin))

# --- ortho texture, same window, 1024x1024 ---
# The ESP_045994 ortho is single-band grayscale (red band). We keep the real
# albedo and tint it with a Mars palette in Python (dark basalt -> light dust).
# Prefer the local file (range-reads over /vsicurl/ truncate on this link);
# fall back to the remote URL with one retry.
ortho_local = os.path.join(DATA, "ESP_045994_ortho.tif")
ortho_sources = [ortho_local] if os.path.exists(ortho_local) else []
ortho_sources.append("/vsicurl/" + ORTHO_URL)
ortho_ok = False
nodata_frac = 0.0
for attempt, src in enumerate(ortho_sources, 1):
    try:
        with Env(GDAL_CURL_CA_BUNDLE="/run/hatch/egress-tls/ca-bundle.pem"):
            arr, _ = read_window(src, [1], (1024, 1024))
        g = arr[0].astype(np.float32) / 255.0
        # The ortho strip does not cover the whole 6x6 km window: its eastern
        # edge is nodata (value 0, ~10% of the window). Fill those pixels with
        # a hillshade of the same real DTM, feathered at the boundary, so the
        # texture has no black wedge. Hillshade: sun from NW, 35 deg.
        nodata_mask = (arr[0] == 0)
        nodata_frac = float(nodata_mask.mean())
        if nodata_mask.mean() > 0.001:
            gy, gx = np.gradient(h, 6000 / 256)
            az, alt = np.radians(315.0), np.radians(35.0)
            slope = np.arctan(np.hypot(gx, gy))
            aspect = np.arctan2(-gy, gx)
            hs = (np.sin(alt) * np.cos(slope)
                  + np.cos(alt) * np.sin(slope) * np.cos(az - aspect))
            hs = np.asarray(Image.fromarray(hs.astype(np.float32)).resize((1024, 1024), Image.BILINEAR))
            lo, hi = np.percentile(hs, [2, 98])
            hs_n = np.clip((hs - lo) / (hi - lo), 0, 1)
            # feather the mask so the fill edge does not read as a hard line
            from PIL import ImageFilter as _IF
            m = np.asarray(Image.fromarray((nodata_mask.astype(np.float32) * 255).astype(np.uint8), mode='L')
                           .filter(_IF.GaussianBlur(radius=6)).resize((1024, 1024), Image.BILINEAR)) / 255.0
            # Match the fill's tone to the real ortho: same mean brightness as
            # valid ortho pixels, relief contrast kept subtle (±0.3 * spread).
            om = float(g[~nodata_mask].mean())
            fill = np.clip(om + (hs_n - float(hs_n[m > 0.5].mean())) * 0.3, 0.05, 0.95)
            g = g * (1 - m) + fill * m
            print(f"ortho: filled {nodata_mask.mean()*100:.1f}% nodata with DTM hillshade (ortho mean {om:.2f})")
        # Mars palette stops (brightness -> RGB): shadowed basalt to bright dust
        stops = np.array([[0.16, 0.08, 0.05], [0.42, 0.24, 0.13],
                          [0.62, 0.38, 0.22], [0.78, 0.55, 0.36],
                          [0.92, 0.74, 0.55]], dtype=np.float32)
        pos = np.array([0.0, 0.3, 0.55, 0.8, 1.0])
        rgb = np.stack([np.interp(g, pos, stops[:, c]) for c in range(3)], axis=2)
        Image.fromarray((rgb * 255).astype(np.uint8), mode="RGB").save(
            os.path.join(OUT, "jezero-ortho.jpg"), quality=88)
        print("saved jezero-ortho.jpg 1024x1024 (grayscale ortho + Mars tint)")
        ortho_ok = True
        break
    except Exception as e:
        print(f"ORTHO attempt {attempt} FAILED:", str(e)[:160])

meta = {
    "source": ("USGS Astrogeology, Mars 2020 Terrain Relative Navigation HiRISE DTM Mosaic "
               "(full mosaic file, single source)" if h is not None and single_source
               else "USGS Astrogeology, Mars 2020 Terrain Relative Navigation HiRISE DTM Mosaic "
                    "(Jezero_C + Jezero_E tiles)"),
    "source_url": "https://astrogeology.usgs.gov/search/map/Mars/Mars2020/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40",
    "doi": "10.5066/P9REJ9JN",
    "citation": "Fergason et al. 2020, Mars 2020 Terrain Relative Navigation Flight Product Generation (LPSC 2020)",
    "ortho_source": "HiRISE ESP_045994_1985 orthoimage (same USGS mosaic, 0.25 m/px, downsampled to ~5.9 m/px)" if ortho_ok else None,
    "ortho_available": ortho_ok,
    "ortho_nodata_filled_pct": round(float(nodata_frac * 100), 1) if ortho_ok else None,
    "resolution_m_per_post": 1.0,
    "window_m": 6000,
    "grid": 256,
    "meters_per_sample": 6000 / 256,
    "center_lon_lat": [LAND_LON, LAND_LAT],
    "target_name": "Octavia E. Butler Landing (Perseverance landing site)",
    "bounds_lon_lat": [LAND_LON - HALF / DEG_M, LAND_LAT - HALF / DEG_M,
                       LAND_LON + HALF / DEG_M, LAND_LAT + HALF / DEG_M],
    "elev_min_m": hmin, "elev_max_m": hmax,
    "elev_reference": "MOLA topography, Delta geoid (as delivered)",
}
with open(os.path.join(OUT, "jezero-meta.json"), "w") as f:
    json.dump(meta, f, indent=2)
print("saved jezero-meta.json; ortho_ok =", ortho_ok)

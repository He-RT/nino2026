#!/usr/bin/env python3
"""Fetch NOAA OISST v2.1 daily SST data and compute ENSO region anomalies.

Primary sources:
  - NOAA NCEI HTTPS daily NetCDF-4 archive (authoritative + preliminary NRT)
  - NOAA AWS Open Data S3 mirror (fast historical finalized archive backfill/gap-fill)

Maintains:
  - data/oisst_daily_sst.csv      (raw daily cosine-weighted SST per region)
  - public/data/enso-daily.json   (1991-2020 daily-baseline anomalies by ENSO year)
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT_DIR = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT_DIR / "data" / "oisst_daily_sst.csv"
JSON_PATH = ROOT_DIR / "public" / "data" / "enso-daily.json"

NCEI_BASE = "https://www.ncei.noaa.gov/data/sea-surface-temperature-optimum-interpolation/v2.1/access/avhrr"
S3_BASE = "https://noaa-cdr-sea-surface-temp-optimum-interpolation-pds.s3.amazonaws.com/data/v2.1/avhrr"

ARCHIVE_START = date(1981, 9, 1)
CLIM_START_YEAR = 1991
CLIM_END_YEAR = 2020
FEATURED_SEASONS = ["1982-83", "1997-98", "2015-16", "2023-24"]

FILE_PATTERN = re.compile(r"oisst-avhrr-v02r01\.(\d{8})(_preliminary)?\.nc")

REGIONS = {
    "nino3": {
        "key": "nino3",
        "title": "Niño 3 逐日海温距平",
        "shortName": "Niño 3",
        "boundsLabel": "5°S–5°N、150°W–90°W",
        "latBounds": (-5.0, 5.0),
        "lonBounds": (210.0, 270.0),
        "defaultYMin": -3,
        "defaultYMax": 5,
        "unitYVal": 1,
    },
    "nino12": {
        "key": "nino12",
        "title": "Niño 1+2 逐日海温距平",
        "shortName": "Niño 1+2",
        "boundsLabel": "10°S–0°、90°W–80°W",
        "latBounds": (-10.0, 0.0),
        "lonBounds": (270.0, 280.0),
        "defaultYMin": -3,
        "defaultYMax": 7,
        "unitYVal": 2,
    },
    "nino34": {
        "key": "nino34",
        "title": "Niño 3.4 逐日海温距平",
        "shortName": "Niño 3.4",
        "boundsLabel": "5°S–5°N、170°W–120°W",
        "latBounds": (-5.0, 5.0),
        "lonBounds": (190.0, 240.0),
        "defaultYMin": -3,
        "defaultYMax": 4,
        "unitYVal": 1,
    },
}

_thread_local = threading.local()
_grid_lock = threading.Lock()
_grid_cache: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]] | None = None


def get_session():
    """Return a thread-local pooled requests.Session."""
    import requests
    from requests.adapters import HTTPAdapter

    sess = getattr(_thread_local, "session", None)
    if sess is None:
        sess = requests.Session()
        adapter = HTTPAdapter(pool_connections=20, pool_maxsize=20)
        sess.mount("https://", adapter)
        sess.mount("http://", adapter)
        _thread_local.session = sess
    return sess


def http_get_with_retry(
    url: str, timeout: int = 30, max_retries: int = 3, allow_404: bool = False
) -> bytes | None:
    """Perform HTTP GET with exponential backoff retries."""
    sess = get_session()
    last_err: Exception | None = None
    for attempt in range(max_retries):
        try:
            resp = sess.get(url, timeout=timeout)
            if allow_404 and resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.content
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if attempt < max_retries - 1:
                time.sleep(2 ** (attempt + 1))
    assert last_err is not None
    raise last_err


def list_ncei_month(ym: str) -> dict[str, tuple[str, str]]:
    """List OISST daily NetCDF-4 files in an NCEI YYYYMM directory.

    Returns mapping date_str -> (filename, status), preferring final over preliminary.
    """
    url = f"{NCEI_BASE}/{ym}/"
    raw = http_get_with_retry(url, timeout=30, allow_404=True)
    if raw is None:
        return {}
    html = raw.decode("utf-8", errors="replace")
    found: dict[str, tuple[str, str]] = {}
    for match in FILE_PATTERN.finditer(html):
        ymd, prelim = match.group(1), match.group(2)
        d_str = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}"
        filename = match.group(0)
        status = "preliminary" if prelim else "final"
        prev = found.get(d_str)
        if prev is None or (prev[1] == "preliminary" and status == "final"):
            found[d_str] = (filename, status)
    return found


def discover_ncei_catalog(extra_months: set[str]) -> dict[str, tuple[str, str]]:
    """Inspect recent NCEI monthly directories (plus any month with existing preliminary rows)."""
    today_utc = datetime.now(timezone.utc).date()
    months: set[str] = set(extra_months)
    # Cover current month and previous two months to handle month boundaries cleanly.
    cursor = today_utc.replace(day=15)
    for _ in range(3):
        months.add(cursor.strftime("%Y%m"))
        cursor = (cursor.replace(day=1) - timedelta(days=1)).replace(day=15)

    catalog: dict[str, tuple[str, str]] = {}
    for ym in sorted(months):
        catalog.update(list_ncei_month(ym))
    if not catalog:
        raise RuntimeError("Could not discover any recent OISST files from NOAA NCEI.")
    return catalog


def get_region_slices(lat: np.ndarray, lon: np.ndarray) -> dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """Cache index masks and cosine-latitude weights for the static 0.25-deg OISST grid."""
    global _grid_cache  # noqa: PLW0603
    if _grid_cache is not None:
        return _grid_cache
    with _grid_lock:
        if _grid_cache is not None:
            return _grid_cache
        lat_w = np.cos(np.deg2rad(lat.astype(np.float64)))
        cache: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}
        for key, cfg in REGIONS.items():
            la0, la1 = cfg["latBounds"]
            lo0, lo1 = cfg["lonBounds"]
            lm = (lat >= la0) & (lat <= la1)
            om = (lon >= lo0) & (lon <= lo1)
            cache[key] = (lm, om, lat_w[lm][:, None])
        _grid_cache = cache
        return _grid_cache


def parse_oisst_netcdf4(payload: bytes) -> tuple[float, float, float]:
    """Parse one daily NetCDF-4/HDF5 OISST file and return cosine-weighted (nino3, nino12, nino34) SST."""
    import h5py

    with h5py.File(io.BytesIO(payload), "r") as f:
        lat = f["lat"][:]
        lon = f["lon"][:]
        ds = f["sst"]
        fill = float(np.ravel(ds.attrs["_FillValue"])[0])
        scale = float(np.ravel(ds.attrs["scale_factor"])[0])
        offset = float(np.ravel(ds.attrs["add_offset"])[0])
        raw = ds[0, 0, :, :].astype(np.float64)

    valid = (raw != fill) & np.isfinite(raw)
    sst = raw * scale + offset
    valid &= (sst >= -3.0) & (sst <= 45.0)

    slices = get_region_slices(lat, lon)
    means: dict[str, float] = {}
    for key, (lm, om, w_lat) in slices.items():
        sub_sst = sst[np.ix_(lm, om)]
        sub_valid = valid[np.ix_(lm, om)]
        w = w_lat * sub_valid
        w_sum = float(w.sum())
        if w_sum <= 0.0:
            raise ValueError(f"Zero valid ocean cells in {key}")
        means[key] = float((np.where(sub_valid, sub_sst, 0.0) * w).sum() / w_sum)

    return means["nino3"], means["nino12"], means["nino34"]


def fetch_single_day(
    d_str: str,
    recent_catalog: dict[str, tuple[str, str]],
) -> dict[str, float | str]:
    """Fetch and compute daily Niño SSTs for one ISO date from NCEI or AWS S3."""
    ym = d_str[:4] + d_str[5:7]
    ymd = d_str.replace("-", "")
    default_name = f"oisst-avhrr-v02r01.{ymd}.nc"

    if d_str in recent_catalog:
        filename, status = recent_catalog[d_str]
        url = f"{NCEI_BASE}/{ym}/{filename}"
        payload = http_get_with_retry(url, timeout=30, max_retries=3)
        assert payload is not None
    else:
        # Historical finalized dates: prefer AWS S3 mirror, fallback to NCEI HTTPS on 404/error.
        s3_url = f"{S3_BASE}/{ym}/{default_name}"
        payload = None
        status = "final"
        try:
            payload = http_get_with_retry(s3_url, timeout=25, max_retries=2, allow_404=True)
        except Exception:  # noqa: BLE001
            payload = None

        if payload is None:
            ncei_url = f"{NCEI_BASE}/{ym}/{default_name}"
            payload = http_get_with_retry(ncei_url, timeout=30, max_retries=3, allow_404=True)
            if payload is None:
                prelim_name = f"oisst-avhrr-v02r01.{ymd}_preliminary.nc"
                payload = http_get_with_retry(
                    f"{NCEI_BASE}/{ym}/{prelim_name}", timeout=30, max_retries=3
                )
                status = "preliminary"

    assert payload is not None
    n3, n12, n34 = parse_oisst_netcdf4(payload)
    return {
        "date": d_str,
        "nino3_sst": n3,
        "nino12_sst": n12,
        "nino34_sst": n34,
        "status": status,
    }


def load_csv(path: Path) -> dict[str, dict[str, float | str]]:
    """Load existing daily SST CSV keyed by ISO date string."""
    records: dict[str, dict[str, float | str]] = {}
    if not path.exists():
        return records
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            d_str = row["date"]
            records[d_str] = {
                "date": d_str,
                "nino3_sst": float(row["nino3_sst"]),
                "nino12_sst": float(row["nino12_sst"]),
                "nino34_sst": float(row["nino34_sst"]),
                "status": row["status"],
            }
    return records


def save_csv(path: Path, records: dict[str, dict[str, float | str]]) -> None:
    """Write sorted daily SST CSV."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["date", "nino3_sst", "nino12_sst", "nino34_sst", "status"])
        for d_str in sorted(records):
            r = records[d_str]
            writer.writerow(
                [
                    d_str,
                    f"{float(r['nino3_sst']):.4f}",
                    f"{float(r['nino12_sst']):.4f}",
                    f"{float(r['nino34_sst']):.4f}",
                    r["status"],
                ]
            )


def select_target_dates(
    records: dict[str, dict[str, float | str]],
    recent_catalog: dict[str, tuple[str, str]],
    latest_ncei_date: date,
    backfill: bool,
) -> list[str]:
    """Determine which dates must be downloaded (all missing + preliminary/upgraded trailing window)."""
    all_possible: list[str] = []
    cur = ARCHIVE_START
    while cur <= latest_ncei_date:
        all_possible.append(cur.isoformat())
        cur += timedelta(days=1)

    if backfill or not records:
        return all_possible

    targets: set[str] = set()
    # 1. Self-heal any missing dates across 1981-09-01 .. latest_ncei_date
    for d_str in all_possible:
        if d_str not in records:
            targets.add(d_str)

    # 2. Refresh all preliminary rows and any trailing 25-day window needing upgrade/revision
    trailing_start = max(ARCHIVE_START, latest_ncei_date - timedelta(days=25))
    trailing_needs_refresh = False
    for d_str, rec in records.items():
        if rec["status"] == "preliminary":
            targets.add(d_str)
            if date.fromisoformat(d_str) >= trailing_start:
                trailing_needs_refresh = True
        elif d_str in recent_catalog and recent_catalog[d_str][1] != rec["status"]:
            targets.add(d_str)
            if date.fromisoformat(d_str) >= trailing_start:
                trailing_needs_refresh = True

    if trailing_needs_refresh:
        cur = trailing_start
        while cur <= latest_ncei_date:
            d_str = cur.isoformat()
            if d_str not in records or records[d_str]["status"] != "final":
                targets.add(d_str)
            cur += timedelta(days=1)

    return sorted(targets)


def fetch_dates(
    target_dates: list[str],
    recent_catalog: dict[str, tuple[str, str]],
) -> dict[str, dict[str, float | str]]:
    """Download target dates concurrently (polite concurrency for NCEI, faster for S3)."""
    if not target_dates:
        return {}

    ncei_only = sum(1 for d in target_dates if d in recent_catalog)
    s3_count = len(target_dates) - ncei_only
    max_workers = 12 if s3_count > 30 else 4

    print(
        f"Fetching {len(target_dates)} days "
        f"({s3_count} historical S3/NCEI + {ncei_only} recent NCEI, workers={max_workers})..."
    )

    fetched: dict[str, dict[str, float | str]] = {}
    failed: list[tuple[str, str]] = []
    done = 0
    total = len(target_dates)

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        fut_map = {
            executor.submit(fetch_single_day, d_str, recent_catalog): d_str
            for d_str in target_dates
        }
        for fut in as_completed(fut_map):
            d_str = fut_map[fut]
            done += 1
            try:
                fetched[d_str] = fut.result()
            except Exception as exc:  # noqa: BLE001
                failed.append((d_str, str(exc)))
                print(f"  [error] {d_str}: {exc}", file=sys.stderr)
            if done % 100 == 0 or done == total:
                print(f"  progress: {done}/{total} days fetched")

    if failed:
        preview = ", ".join(f"{d} ({err})" for d, err in failed[:5])
        raise RuntimeError(f"{len(failed)} day(s) failed to download: {preview}")
    return fetched


def enso_season_and_index(d: date) -> tuple[str, int] | None:
    """Map calendar date to ENSO cycle season ('YYYY-YY') and 0..364 index (Jun 1 = 0).

    Skips Feb 29 so every calendar month aligns cleanly across leap and non-leap years.
    """
    if d.month == 2 and d.day == 29:
        return None
    if d.month >= 6:
        season = f"{d.year}-{(d.year + 1) % 100:02d}"
        ref_date = date(2001, d.month, d.day)
    else:
        season = f"{d.year - 1}-{d.year % 100:02d}"
        ref_date = date(2002, d.month, d.day)
    day_index = (ref_date - date(2001, 6, 1)).days
    return season, day_index


def build_enso_json(records: dict[str, dict[str, float | str]]) -> dict:
    """Compute 1991-2020 daily climatology, anomalies, rankings, and frontend JSON payload."""
    sorted_dates = sorted(records)
    region_keys = list(REGIONS.keys())

    # 1. Compute 1991-2020 calendar-day (MM-DD) climatology per region.
    clim_buckets: dict[str, dict[str, list[float]]] = {k: {} for k in region_keys}
    for d_str in sorted_dates:
        yr = int(d_str[:4])
        if CLIM_START_YEAR <= yr <= CLIM_END_YEAR:
            mmdd = d_str[5:]
            rec = records[d_str]
            for k in region_keys:
                clim_buckets[k].setdefault(mmdd, []).append(float(rec[f"{k}_sst"]))

    climatology: dict[str, dict[str, float]] = {
        k: {mmdd: sum(vals) / len(vals) for mmdd, vals in clim_buckets[k].items()}
        for k in region_keys
    }

    # 2. Organize anomalies into 365-slot ENSO seasonal arrays.
    seasons_set: set[str] = set()
    parsed_entries: list[tuple[str, date, str, int, dict[str, float], str]] = []
    for d_str in sorted_dates:
        d = date.fromisoformat(d_str)
        mapped = enso_season_and_index(d)
        if mapped is None:
            continue
        season, day_idx = mapped
        seasons_set.add(season)
        rec = records[d_str]
        mmdd = d_str[5:]
        anoms = {
            k: round(float(rec[f"{k}_sst"]) - climatology[k][mmdd], 3)
            for k in region_keys
        }
        parsed_entries.append((d_str, d, season, day_idx, anoms, str(rec["status"])))

    seasons = sorted(seasons_set)
    current_season = seasons[-1]

    series_data: dict[str, dict[str, list[float | None]]] = {
        k: {s: [None] * 365 for s in seasons} for k in region_keys
    }
    date_lookup: dict[str, list[str | None]] = {s: [None] * 365 for s in seasons}
    current_status: list[str | None] = [None] * 365
    latest_day_idx = 0

    for d_str, _d, season, day_idx, anoms, status in parsed_entries:
        for k in region_keys:
            series_data[k][season][day_idx] = anoms[k]
        date_lookup[season][day_idx] = d_str
        if season == current_season:
            current_status[day_idx] = "f" if status == "final" else "p"
            if day_idx > latest_day_idx:
                latest_day_idx = day_idx

    # Trim current season arrays to end cleanly at latest_day_idx
    for k in region_keys:
        series_data[k][current_season] = series_data[k][current_season][: latest_day_idx + 1]
    current_status = current_status[: latest_day_idx + 1]

    latest_d_str = sorted_dates[-1]
    latest_rec = records[latest_d_str]
    latest_mmdd = latest_d_str[5:]

    # 3. Compute rankings and peak comparisons per region
    regions_payload: dict[str, dict] = {}
    for k, cfg in REGIONS.items():
        cur_arr = series_data[k][current_season]
        latest_anom = round(float(latest_rec[f"{k}_sst"]) - climatology[k][latest_mmdd], 3)

        prev_idx = len(sorted_dates) - 2
        prev_rec = records[sorted_dates[prev_idx]]
        prev_anom = round(float(prev_rec[f"{k}_sst"]) - climatology[k][sorted_dates[prev_idx][5:]], 3)
        prev_delta = round(latest_anom - prev_anom, 3)

        peer_vals = [
            series_data[k][s][latest_day_idx]
            for s in seasons
            if latest_day_idx < len(series_data[k][s]) and series_data[k][s][latest_day_idx] is not None
        ]
        cur_plot_val = cur_arr[latest_day_idx] if cur_arr[latest_day_idx] is not None else latest_anom
        rank = 1 + sum(1 for v in peer_vals if v > cur_plot_val)

        valid_cur = [(idx, v) for idx, v in enumerate(cur_arr) if v is not None]
        peak_idx, peak_val = max(valid_cur, key=lambda item: item[1])
        season_peak = {
            "date": date_lookup[current_season][peak_idx],
            "anomaly": peak_val,
        }

        featured_peaks: dict[str, dict] = {}
        for fs in FEATURED_SEASONS:
            if fs in series_data[k]:
                valid_fs = [(idx, v) for idx, v in enumerate(series_data[k][fs]) if v is not None]
                if valid_fs:
                    fs_idx, fs_val = max(valid_fs, key=lambda item: item[1])
                    featured_peaks[fs] = {
                        "date": date_lookup[fs][fs_idx],
                        "anomaly": fs_val,
                    }

        regions_payload[k] = {
            "key": cfg["key"],
            "title": cfg["title"],
            "shortName": cfg["shortName"],
            "boundsLabel": cfg["boundsLabel"],
            "defaultYMin": cfg["defaultYMin"],
            "defaultYMax": cfg["defaultYMax"],
            "unitYVal": cfg["unitYVal"],
            "latest": {
                "date": latest_d_str,
                "dayIndex": latest_day_idx,
                "anomaly": latest_anom,
                "sst": round(float(latest_rec[f"{k}_sst"]), 2),
                "status": latest_rec["status"],
                "rank": rank,
                "totalYears": len(peer_vals),
                "prevDayDelta": prev_delta,
            },
            "seasonPeak": season_peak,
            "featuredPeaks": featured_peaks,
            "series": series_data[k],
        }

    return {
        "meta": {
            "source": "NOAA OISST v2.1",
            "baseline": "1991-2020",
            "startDate": sorted_dates[0],
            "latestDate": latest_d_str,
            "latestStatus": latest_rec["status"],
            "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "currentSeason": current_season,
            "featuredSeasons": FEATURED_SEASONS,
            "seasons": seasons,
            "currentSeasonStatus": current_status,
        },
        "regions": regions_payload,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Update NOAA OISST v2.1 daily ENSO dataset.")
    parser.add_argument(
        "--backfill",
        action="store_true",
        help="Re-download full 1981-09 to present archive instead of incremental/gap-fill update.",
    )
    parser.add_argument(
        "--rebuild-only",
        action="store_true",
        help="Rebuild public/data/enso-daily.json from local data/oisst_daily_sst.csv without network fetches.",
    )
    args = parser.parse_args()

    records = {} if args.backfill else load_csv(CSV_PATH)
    if args.rebuild_only:
        if not records:
            raise RuntimeError(f"Cannot rebuild without existing {CSV_PATH}")
    else:
        prelim_months = {
            d[:4] + d[5:7] for d, rec in records.items() if rec["status"] == "preliminary"
        }

        recent_catalog = discover_ncei_catalog(prelim_months)
        latest_ncei_str = max(recent_catalog)
        latest_ncei_date = date.fromisoformat(latest_ncei_str)
        print(
            f"NCEI latest available date: {latest_ncei_str} ({recent_catalog[latest_ncei_str][1]}) | "
            f"existing CSV rows: {len(records)}"
        )

        target_dates = select_target_dates(records, recent_catalog, latest_ncei_date, args.backfill)
        if target_dates:
            fetched = fetch_dates(target_dates, recent_catalog)
            records.update(fetched)
            save_csv(CSV_PATH, records)
        else:
            print("All dates up to date; CSV unchanged.")

    payload = build_enso_json(records)
    JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    with JSON_PATH.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    meta = payload["meta"]
    print(f"\nCSV rows: {len(records)} ({meta['startDate']} -> {meta['latestDate']})")
    print(
        f"Generated {JSON_PATH.relative_to(ROOT_DIR)} ({JSON_PATH.stat().st_size / 1024:.1f} KB) | "
        f"latest: {meta['latestDate']} ({meta['latestStatus']})"
    )
    for key in ("nino3", "nino12", "nino34"):
        lt = payload["regions"][key]["latest"]
        print(
            f"  {key:6s}: {lt['anomaly']:+.2f} °C ({lt['anomaly']:+.3f} °C, "
            f"SST {lt['sst']:.2f} °C, rank #{lt['rank']}/{lt['totalYears']})"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

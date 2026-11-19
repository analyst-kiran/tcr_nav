"""Shared helpers: fetch NAVs from AMFI, classify schemes, read/write the NAV store.

Store layout (all under data/):
  nav/<YYYY>/<YYYY-MM>.parquet   columns: code (int32), date (date), nav (float64)
  schemes.csv          one row per tracked scheme (Regular plan, Growth option, open-ended)
  state.json           last update info
"""
from __future__ import annotations

import io
import json
import re
import time
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
NAV_DIR = DATA / "nav"
PROXY_DIR = DATA / "proxy"          # NAVs of the ETFs / funds that track benchmarks
BENCH_MAP = DATA / "benchmark_map.json"
SCHEMES_CSV = DATA / "schemes.csv"
STATE_JSON = DATA / "state.json"

AMFI_LATEST = "https://portal.amfiindia.com/spages/NAVAll.txt"
AMFI_HISTORY = "https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt={a}&todt={b}"
MFAPI = "https://api.mfapi.in/mf/{code}"

UA = {"User-Agent": "Mozilla/5.0 (tcr-nav updater)"}
STALE_DAYS = 45  # a scheme with no NAV for this long is treated as closed/merged and dropped


def log(*a):
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


# ── HTTP ──────────────────────────────────────────────────────────────────────
def http_get(url: str, timeout: int = 300, tries: int = 4) -> str:
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", errors="replace")
        except Exception as e:  # network hiccup / AMFI slow
            last = e
            wait = 5 * 2 ** i
            log(f"  fetch failed ({e}); retry in {wait}s")
            time.sleep(wait)
    raise RuntimeError(f"giving up on {url}: {last}")


# ── AMFI parsing ──────────────────────────────────────────────────────────────
def parse_amfi(text: str) -> pd.DataFrame:
    """Parse either NAVAll.txt or the NAV history report into one table.

    NAVAll:  Code;ISIN1;ISIN2;Scheme Name;Plan;Option;NAV;Date
    History: Code;NAV Name;Plan;Option;ISIN1;ISIN2;NAV;Date
    Section lines ("Open Ended Schemes(Equity Scheme - Mid Cap Fund)") and AMC lines
    sit between data rows.
    """
    rows, sect, amc, layout = [], "", "", None
    for ln in io.StringIO(text):
        ln = ln.strip()
        if not ln:
            continue
        p = [x.strip() for x in ln.split(";")]
        if len(p) < 8:
            if re.match(r"(open|close)\s*ended|interval", ln, re.I):
                sect = ln
            else:
                amc = ln
            continue
        if p[0].lower() == "scheme code":
            layout = "history" if p[1].lower().startswith("nav name") else "latest"
            continue
        if not p[0].isdigit():
            continue
        if layout == "history":
            name, plan, opt = p[1], p[2], p[3]
        else:
            name, plan, opt = p[3], p[4], p[5]
        rows.append((int(p[0]), name, plan, opt, p[6], p[7], sect, amc))
    df = pd.DataFrame(rows, columns=["code", "name", "plan", "option", "nav", "date", "section", "amc"])
    df["nav"] = pd.to_numeric(df["nav"].str.replace(",", ""), errors="coerce")
    df["date"] = pd.to_datetime(df["date"], format="%d-%b-%Y", errors="coerce").dt.date
    df = df.dropna(subset=["nav", "date"])
    df = df[df["nav"] > 0]
    return df


_INCOME = r"idcw|dividend(?! ?yield)|payout|reinvest|income distribution|bonus"
_LEGACY = r"unclaimed|segregat|eco plan|institutional|retail|discontinued|super inst|premium plan|p f option|defined mat"


def is_regular_growth(df: pd.DataFrame) -> pd.Series:
    """True for open-ended, Regular plan, Growth option, non-ETF schemes."""
    name = df["name"].str.lower()
    plan = df["plan"].str.lower()
    opt = df["option"].str.lower()
    sect = df["section"].str.lower()
    open_ended = sect.str.startswith("open")
    etf = sect.str.contains("etf") | name.str.contains(r"\betf\b") & ~name.str.contains(r"fof|fund of fund")
    direct = plan.str.contains("direct") | name.str.contains(r"\bdirect\b|\bdir\b")
    income = name.str.contains(_INCOME) | opt.str.contains(_INCOME)
    legacy = name.str.contains(_LEGACY) | opt.str.contains(_LEGACY)
    return open_ended & ~etf & ~direct & ~income & ~legacy


def category_of(section: str) -> str:
    m = re.search(r"\(\s*(.*?)\s*\)\s*$", section or "")
    return m.group(1) if m else ""


# ── Fetching ──────────────────────────────────────────────────────────────────
def fetch_history(a: date, b: date, chunk_days: int = 7) -> pd.DataFrame:
    """All schemes' NAVs between a and b (inclusive) from AMFI's history report."""
    parts, cur = [], a
    while cur <= b:
        end = min(cur + timedelta(days=chunk_days - 1), b)
        url = AMFI_HISTORY.format(a=cur.strftime("%d-%b-%Y"), b=end.strftime("%d-%b-%Y"))
        log(f"AMFI history {cur} → {end}")
        parts.append(parse_amfi(http_get(url, timeout=400)))
        cur = end + timedelta(days=1)
    return pd.concat(parts, ignore_index=True) if parts else parse_amfi("")


def fetch_latest() -> pd.DataFrame:
    log("AMFI NAVAll.txt")
    return parse_amfi(http_get(AMFI_LATEST, timeout=120))


def fetch_mfapi(code: int, since: date | None = None) -> pd.DataFrame:
    js = json.loads(http_get(MFAPI.format(code=code), timeout=60, tries=2))
    d = pd.DataFrame(js.get("data", []))
    if d.empty:
        return pd.DataFrame(columns=["code", "date", "nav"])
    d["date"] = pd.to_datetime(d["date"], format="%d-%m-%Y").dt.date
    d["nav"] = pd.to_numeric(d["nav"], errors="coerce")
    d["code"] = code
    if since:
        d = d[d["date"] > since]
    return d[["code", "date", "nav"]]


# ── Store ─────────────────────────────────────────────────────────────────────
def _month_files(years=None, root=None):
    files = sorted((root or NAV_DIR).glob("*/*.parquet"))
    if years is not None:
        ys = {int(y) for y in years}
        files = [f for f in files if int(f.parent.name) in ys]
    return files


def load_store(years: list[int] | None = None, root=None) -> pd.DataFrame:
    files = _month_files(years, root)
    if not files:
        return pd.DataFrame({"code": pd.Series(dtype="int32"), "date": pd.Series(dtype="object"),
                             "nav": pd.Series(dtype="float64")})
    df = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
    df["date"] = pd.to_datetime(df["date"]).dt.date
    return df


def write_months(df: pd.DataFrame, months: set[str] | None = None, root=None):
    """Write rows into data/nav/<YYYY>/<YYYY-MM>.parquet, replacing those month files.
    Monthly files keep each day's git commit small (only the current month changes)."""
    df = df.copy()
    df["date"] = pd.to_datetime(df["date"])
    df["code"] = df["code"].astype("int32")
    df = df.drop_duplicates(["code", "date"], keep="last").sort_values(["code", "date"])
    for ym, g in df.groupby(df["date"].dt.strftime("%Y-%m")):
        if months is not None and ym not in months:
            continue
        d = (root or NAV_DIR) / ym[:4]
        d.mkdir(parents=True, exist_ok=True)
        g = g.assign(date=g["date"].dt.date)[["code", "date", "nav"]]
        tmp = d / f"{ym}.parquet.tmp"
        g.to_parquet(tmp, index=False, compression="zstd")
        tmp.replace(d / f"{ym}.parquet")


def load_schemes() -> pd.DataFrame:
    if SCHEMES_CSV.exists():
        return pd.read_csv(SCHEMES_CSV, dtype={"code": "int64"})
    return pd.DataFrame(columns=["code", "name", "amc", "category", "plan", "option", "last_seen"])


def merge_schemes(old: pd.DataFrame, fresh: pd.DataFrame) -> pd.DataFrame:
    """fresh = parsed AMFI rows already filtered to Regular-Growth."""
    f = fresh.sort_values("date").drop_duplicates("code", keep="last")
    f = pd.DataFrame({
        "code": f["code"].astype("int64"), "name": f["name"], "amc": f["amc"],
        "category": f["section"].map(category_of), "plan": f["plan"], "option": f["option"],
        "last_seen": f["date"].astype(str),
    })
    out = pd.concat([old, f], ignore_index=True).drop_duplicates("code", keep="last")
    # AMFI history report has no AMC line in some layouts; keep a previously known AMC
    if not old.empty:
        known = old.set_index("code")["amc"].to_dict()
        out["amc"] = [a if isinstance(a, str) and a else known.get(c, "") for c, a in zip(out["code"], out["amc"])]
    return out.sort_values("code").reset_index(drop=True)


def save_state(**kw):
    s = json.loads(STATE_JSON.read_text()) if STATE_JSON.exists() else {}
    s.update(kw)
    STATE_JSON.write_text(json.dumps(s, indent=2, default=str))


def proxy_codes() -> set[int]:
    if not BENCH_MAP.exists():
        return set()
    m = json.loads(BENCH_MAP.read_text())["benchmarks"]
    return {int(c) for v in m.values() for _, c in v["recipe"]} | {int(c) for v in m.values() for c in v.get("history", [])}


def unsplit(s: pd.Series) -> pd.Series:
    """Undo unit splits/consolidations (one-day NAV jumps of ×1/k or ×k), common in ETFs."""
    s = s[s > 0].sort_index().copy()
    r = s / s.shift()
    for d, x in r[(r < 0.7) | (r > 1.5)].items():
        for k in (2, 4, 5, 10, 20, 25, 50, 100):
            hit = next((f for f in (1 / k, k) if abs(x / f - 1) < 0.04), None)
            if hit:
                s[s.index < d] *= hit
                break
    return s

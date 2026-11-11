"""Choose, for every benchmark row in the vendor exports, the AMFI-listed tracker(s) used to
roll it between the vendor's exact month-end levels, and write data/benchmark_map.json.

  python scripts/build_bench_map.py <trailing.xlsx ...> --cy <calendar.xlsx ...>

Run locally when the vendor adds benchmarks; the vendor files are NOT stored in this repo.
Only index names and AMFI codes go into the output.

Method: the vendor's level + trailing/calendar returns imply ~15 true index levels. Each
candidate (an ETF on the same index, a composite, or a Direct index fund as last resort) is
scored on how well its NAV ratio reproduces the move between consecutive true levels over the
last ~13 months; the lowest error wins.
"""
from __future__ import annotations

import argparse
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

import navlib as L

IST = timezone(timedelta(hours=5, minutes=30))
OUT = L.DATA / "benchmark_map.json"


# ── vendor files → true index levels ──────────────────────────────────────────
def read_vendor(paths):
    fr = [pd.read_excel(p, header=3) for p in paths]
    d = pd.concat(fr).drop_duplicates("SCHEME NAME").set_index("SCHEME NAME")
    d.columns = [str(c).replace(".0", "") for c in d.columns]
    return d


def vendor_asof(tr):
    d = pd.to_datetime(tr["NAV DATE"].dropna().astype(str), dayfirst=True, errors="coerce").max()
    return (d - pd.Timedelta(days=1)) if d.day == 1 else d  # "01/11" exports are as of month-end


TR_P = [("30 DAYS", dict(days=30), 0), ("3 MONTHS", dict(months=3), 0), ("6 MONTHS", dict(months=6), 0),
        ("1 YEAR", dict(years=1), 0), ("2 YEARS", dict(years=2), 0), ("3 YEARS", dict(years=3), 1),
        ("4 YEARS", dict(years=4), 1), ("5 YEARS", dict(years=5), 1), ("7 YEARS", dict(years=7), 1),
        ("10 YEARS", dict(years=10), 1)]


def anchors(name, tr, cy, M):
    v = tr.loc[name]
    lv = float(v["NAV"])
    pts = {M: lv}
    for k, off, long in TR_P:
        r = v.get(k)
        if r is None or pd.isna(r):
            continue
        d = M - pd.DateOffset(**off) + (pd.Timedelta(days=1) if long else pd.Timedelta(0))
        pts[d] = lv / ((1 + r / 100) ** (((M - d).days + 1) / 365) if long else (1 + r / 100))
    if cy is not None and name in cy.index:
        c = cy.loc[name]
        r = c.get(str(M.year))
        if r is not None and pd.notna(r):
            x = lv / (1 + r / 100)
            pts[pd.Timestamp(M.year, 1, 1)] = x
            for y in range(M.year - 1, M.year - 12, -1):
                r = c.get(str(y))
                if r is None or pd.isna(r):
                    break
                x = x / (1 + r / 100)
                pts[pd.Timestamp(y, 1, 1)] = x
    return pd.Series(pts).sort_index()


# ── candidate trackers ────────────────────────────────────────────────────────
def unsplit(s: pd.Series) -> pd.Series:
    """Undo unit splits/consolidations (one-day jumps of ×1/k or ×k)."""
    s = s[s > 0].sort_index().copy()
    r = s / s.shift()
    for d, x in r[(r < 0.7) | (r > 1.5)].items():
        for k in (2, 4, 5, 10, 20, 25, 50, 100):
            hit = next((f for f in (1 / k, k) if abs(x / f - 1) < 0.04), None)
            if hit:
                s[s.index < d] *= hit
                break
    return s


def bkey(b):
    s = b.lower().replace("&", "and")
    s = re.sub(r"^nse\s+", "", s)
    s = re.sub(r"\btri\b|total return index|\bindex\b|\(inr\)", "", s)
    if s.strip().startswith("sensex"):
        s = "bse " + s
    return re.sub(r"[^a-z0-9]", "", s)


def fkey(n):
    s = n.lower().replace("&", "and").replace("s and p", "sandp")
    m = re.search(r"\b(nifty|bse|sensex|sandp|nyse|nasdaq|msci)", s)
    if not m:
        return None
    s = s[m.start():]
    s = re.split(r"\betf\b|exchange traded|\bindex fund\b|\bfund\b|\bbees\b| - |\(", s)[0]
    s = re.sub(r"\bindex\b", "", s)
    if s.strip().startswith("sensex"):
        s = "bse " + s
    return re.sub(r"[^a-z0-9]", "", s)


def candidates_universe(recent: pd.DataFrame):
    n = recent["name"].str.lower()
    sect = recent["section"].str.lower()
    direct = recent["plan"].str.contains("Direct", case=False) | n.str.contains(r"\bdirect\b")
    growthish = ~n.str.contains(r"idcw|dividend(?! ?yield)|bonus|payout")
    etf = recent[sect.str.contains("etf") & ~n.str.contains("fof|fund of fund")]
    idx = recent[sect.str.contains("index funds") & direct & growthish]
    legs = recent[sect.str.contains("arbitrage|gilt|short duration|corporate bond|liquid fund|overnight")
                  & direct & n.str.contains("growth") & growthish]
    legs = legs.groupby("section").head(8)
    return etf, idx, legs


def blend(parts):
    idx = pd.DatetimeIndex(sorted(set().union(*[s.index for _, s in parts])))
    r = sum(w * s.reindex(idx).ffill().pct_change().fillna(0) for w, s in parts)
    r = r[r.index >= max(s.index[0] for _, s in parts)]
    return (1 + r).cumprod()


def on(s, d):
    s = s[:d]
    return s.iloc[-1] if len(s) else np.nan


def score(series, P, ws):
    e = []
    for a, b in ws:
        ea, eb = on(series, a), on(series, b)
        if not (ea > 0 and eb > 0):
            return None
        e.append(((eb / ea) / (P[b] / P[a]) - 1) * 100)
    return np.array(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tr", nargs="+")
    ap.add_argument("--cy", nargs="*", default=[])
    a = ap.parse_args()
    tr = read_vendor(a.tr)
    cy = read_vendor(a.cy) if a.cy else None
    M = vendor_asof(tr)
    bench = tr[tr["CORPUS"].isna() & ~tr.index.str.contains(r"\(G\)|\bFund\b|FoF", case=False)]
    L.log(f"{len(bench)} benchmark rows, vendor as-of {M.date()}")

    today = datetime.now(IST).date()
    recent = L.fetch_history(today - timedelta(days=10), today).sort_values("date").drop_duplicates("code", keep="last")
    etf, idx, legs = candidates_universe(recent)
    pool = pd.concat([etf.assign(kind="etf"), idx.assign(kind="indexfund"), legs.assign(kind="leg")])
    L.log(f"downloading {len(pool)} candidate histories")
    with ThreadPoolExecutor(8) as ex:
        hist = dict(zip(pool["code"], ex.map(lambda c: _safe(L.fetch_mfapi, int(c)), pool["code"])))
    S = {c: unsplit(h.assign(date=pd.to_datetime(h["date"])).set_index("date")["nav"]) for c, h in hist.items()
         if h is not None and len(h)}
    NAME = pool.set_index("code")["name"].to_dict()
    KIND = pool.set_index("code")["kind"].to_dict()
    EK = {c: fkey(NAME[c]) for c in S if KIND[c] == "etf"}
    IK = {c: fkey(NAME[c]) for c in S if KIND[c] == "indexfund"}
    by_key = lambda pool_, k: [c for c, kk in pool_.items() if kk == k]
    n50 = next(iter(by_key(EK, "nifty50")), None)
    n100 = next(iter(by_key(EK, "nifty100")), None)
    m150 = next(iter(by_key(EK, "niftymidcap150")), None)
    n200 = next(iter(by_key(EK, "nifty200")), None)
    debt = [c for c in S if KIND[c] == "leg" and re.search(r"gilt|short|corporate", NAME[c], re.I)] + \
           [c for c in EK if re.search(r"gilt|g-sec|gsec|sdl|bharat bond", NAME[c], re.I)]
    arb = [c for c in S if KIND[c] == "leg" and "arbitrage" in NAME[c].lower()]
    liquid = [c for c in EK if re.search(r"liquid|1d rate", NAME[c], re.I)][:3]
    gold = [c for c in EK if re.search(r"\bgold\b", NAME[c], re.I)][:3]

    def comps(b):
        m = re.match(r"Hybrid (\d+) Debt\+(\d+) Equity", b)
        if m and n50 and "Commodities" not in b:
            wd, we = int(m.group(1)) / 100, int(m.group(2)) / 100
            return [[[we, n50], [wd, d]] for d in debt]
        if b.startswith("NSE Nifty Large Midcap 250") and n100 and m150:
            return [[[0.5, n100], [0.5, m150]]]
        if re.match(r"NSE Nifty 50 Arbitrage( TRI)?$", b):
            return [[[1.0, c]] for c in arb]
        if b == "Nifty 50 Arbitrage (75%) + Nifty 50 (25%)" and n50:
            return [[[0.75, c], [0.25, n50]] for c in arb]
        g = {"65% Nifty 50+20% Nifty 1D Rate+15% of Gold": n50, "65% Nifty 200 TRI+20% NIFTY 1D Rate+15% Gold": n200}
        if b in g and g[b]:
            return [[[0.65, g[b]], [0.2, l], [0.15, au]] for l in liquid for au in gold]
        if b == "1/3 NIFTY+1/3 Nifty 1D Rate+1/3 Gold" and n50:
            return [[[1 / 3, n50], [1 / 3, l], [1 / 3, au]] for l in liquid for au in gold]
        return []

    out, rows = {}, []
    for b in bench.index:
        try:
            P = anchors(b, tr, cy, M)
        except Exception:
            continue
        P13 = P[P.index >= M - pd.DateOffset(months=13)]
        ws = list(zip(P13.index[:-1], P13.index[1:]))
        if len(ws) < 2:
            continue
        k = bkey(b)
        tries = [("etf", [[1.0, c]]) for c in by_key(EK, k)] + [("composite", r) for r in comps(b)]
        best = None
        for kind, recipe in tries + [("indexfund", [[1.0, c]]) for c in by_key(IK, k)]:
            if kind == "indexfund" and best is not None:
                break  # index funds only when nothing else fits
            ser = S[recipe[0][1]] if len(recipe) == 1 else blend([(w, S[c]) for w, c in recipe])
            e = score(ser, P, ws)
            if e is None:
                continue
            per30 = float(np.mean([abs(x) * 30 / (bb - aa).days for x, (aa, bb) in zip(e, ws)]))
            if best is None or per30 < best[0]:
                best = (per30, kind, recipe)
        if best is None:
            rows.append((b, "none", "", None))
            continue
        per30, kind, recipe = best
        # Older trackers of the same index (ETFs first, then Direct index funds), used only to extend
        # the series back in time; the vendor's exact levels keep their fees from creeping in.
        hist = []
        if len(recipe) == 1:
            used = recipe[0][1]
            same = [c for c in by_key(EK, k) + by_key(IK, k) if c != used and c in S]
            hist = sorted(same, key=lambda c: S[c].index[0])
            hist = [int(c) for c in hist if S[c].index[0] < S[used].index[0]][:2]  # the two oldest are enough
        out[b] = {"kind": kind, "recipe": [[round(w, 6), int(c)] for w, c in recipe], "history": hist,
                  "proxy": " + ".join(f"{w:.0%} {NAME[c]}" if len(recipe) > 1 else NAME[c] for w, c in recipe),
                  "test_err_pct_per_30d": round(per30, 4)}
        rows.append((b, kind, out[b]["proxy"], round(per30, 4)))

    OUT.write_text(json.dumps({"built": str(today), "vendor_asof": str(M.date()), "benchmarks": out}, indent=1))
    r = pd.DataFrame(rows, columns=["benchmark", "method", "proxy", "err_pct_per_30d"])
    L.log(f"mapped {len(out)} of {len(r)} benchmarks → {OUT}")
    print(r.groupby("method").size().to_string())


def _safe(f, *a):
    try:
        return f(*a)
    except Exception:
        return None


if __name__ == "__main__":
    main()

"""Compute TCR's NAV-based numbers for every tracked scheme and publish docs/nav_data.js.

Conventions (match the monthly vendor exports TCR was built on):
  * NAV on a date = last NAV published on or before that date.
  * 30 DAYS / 3 / 6 MONTHS = absolute % return; 1 YEAR and longer = CAGR %.
  * Calendar year = year-end NAV / previous year-end NAV - 1 (current year = YTD).
  * Monthly = month-end to month-end (feeds TCR's upside/downside capture).
  * Risk (3 years, monthly returns): STANDARD DEV annualised, MEAN annualised,
    SHARP RATIO / SORTINO RATIO with a fixed risk-free rate (RF below).
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd

import navlib as L

IST = timezone(timedelta(hours=5, minutes=30))
OUT_JS = L.ROOT / "docs" / "nav_data.js"

TRAILING = [("30 DAYS", dict(days=30)), ("3 MONTHS", dict(months=3)), ("6 MONTHS", dict(months=6)),
            ("1 YEAR", dict(years=1)), ("2 YEARS", dict(years=2)), ("3 YEARS", dict(years=3)),
            ("4 YEARS", dict(years=4)), ("5 YEARS", dict(years=5)), ("7 YEARS", dict(years=7)),
            ("10 YEARS", dict(years=10))]
CY_YEARS = 10           # current year (YTD) + 9 full years back... TCR shows 2017-2026
MONTHS_KEPT = 120
RF = 0.065              # annual risk-free rate for Sharpe / Sortino


def r2(x):
    return None if x is None or not np.isfinite(x) else round(float(x), 2)


def nav_on(s: pd.Series, d: pd.Timestamp):
    """s: NAV series indexed by Timestamp (sorted). Last NAV on/before d, or None if d predates the series."""
    i = s.index.searchsorted(d, side="right") - 1
    return None if i < 0 else float(s.iloc[i])


def metrics(s: pd.Series, asof: pd.Timestamp) -> dict:
    """asof = the report date shared by all schemes (latest NAV date in the data)."""
    s = s[:asof]
    end = float(s.iloc[-1])
    first = s.index[0]
    out = {}
    for label, off in TRAILING:
        long = off.get("years", 0) >= 3
        # Vendor convention (verified against the monthly exports): up to 2 years the start is
        # exactly one period back; from 3 years on it is one period back + 1 day, annualised
        # over the inclusive day count.
        start_d = asof - pd.DateOffset(**off) + (pd.Timedelta(days=1) if long else pd.Timedelta(0))
        if start_d < first:
            out[label] = None
            continue
        st = nav_on(s, start_d)
        if not st:
            out[label] = None
            continue
        if long:
            days = (asof - start_d).days + 1
            out[label] = r2(((end / st) ** (365 / days) - 1) * 100)
        elif "years" in off:
            out[label] = r2(((end / st) ** (1 / off["years"]) - 1) * 100)
        else:
            out[label] = r2((end / st - 1) * 100)

    # Calendar year: NAV on/before 1 Jan of the year → NAV on/before 31 Dec (current year: as-of)
    cy = {}
    for y in range(asof.year - CY_YEARS + 1, asof.year + 1):
        jan1 = pd.Timestamp(y, 1, 1)
        if jan1 < first:
            continue
        a = nav_on(s, jan1)
        b = end if y == asof.year else nav_on(s, pd.Timestamp(y, 12, 31))
        if a and b:
            cy[str(y)] = r2((b / a - 1) * 100)

    me = s.resample("ME").last().dropna()
    mret = me.pct_change().dropna()
    # the current, unfinished month is not a full month
    if len(mret) and mret.index[-1].to_period("M") == asof.to_period("M"):
        mret = mret.iloc[:-1]
    mo = {k.strftime("%Y-%m"): r2(v * 100) for k, v in mret.iloc[-MONTHS_KEPT:].items()}

    risk = {}
    m3 = mret.iloc[-36:]
    if len(m3) >= 36:
        sd = m3.std(ddof=1) * math.sqrt(12)
        mean = m3.mean() * 12
        down = m3[m3 < RF / 12] - RF / 12
        dd = math.sqrt((down ** 2).sum() / len(m3)) * math.sqrt(12)
        risk = {"STANDARD DEV": r2(sd * 100), "MEAN": r2(mean * 100),
                "SHARP RATIO": r2((mean - RF) / sd) if sd else None,
                "SORTINO RATIO": r2((mean - RF) / dd) if dd else None}
    # Reference NAVs on the 1st and last day of recent months: TCR matches its vendor rows
    # (which carry a NAV and a NAV date) to AMFI codes with these.
    pt = {}
    for k in range(0, 4):
        mstart = (asof - pd.DateOffset(months=k)).replace(day=1)
        for d in (mstart, mstart + pd.offsets.MonthEnd(0)):
            if first <= d <= asof:
                pt[d.strftime("%Y-%m-%d")] = nav_on(s, d)
    return {"tr": out, "cy": cy, "risk": risk, "pt": pt}


def main():
    schemes = L.load_schemes()
    today = datetime.now(IST).date()
    years = list(range(today.year - 11, today.year + 1))
    st = L.load_store(years)
    st = st[st["code"].isin(set(schemes["code"]))]
    st["date"] = pd.to_datetime(st["date"])
    per_day = st.groupby("date").size()
    asof_all = per_day[per_day >= 0.5 * per_day.tail(10).max()].index.max()  # last fully published day
    meta = schemes.set_index("code")
    out = {}
    for code, g in st.sort_values("date").groupby("code"):
        s = g.set_index("date")["nav"]
        last_d = s[:asof_all].index[-1] if s.index[0] <= asof_all else None
        if last_d is None or (asof_all - last_d).days > 10:
            continue  # no recent NAV
        m = metrics(s, asof_all)
        r = meta.loc[code]
        out[str(code)] = {"name": r["name"], "amc": r["amc"], "category": r["category"],
                          "nav": float(s[:asof_all].iloc[-1]), "nav_date": last_d.strftime("%Y-%m-%d"), **m}
    payload = {"generated": datetime.now(IST).isoformat(timespec="seconds"),
               "latest_nav_date": asof_all.strftime("%Y-%m-%d"),
               "source": "AMFI (portal.amfiindia.com)", "rf": RF,
               "count": len(out), "schemes": out}
    OUT_JS.parent.mkdir(parents=True, exist_ok=True)
    js = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    OUT_JS.write_text("window.TCR_NAV=" + js + ";\n", encoding="utf-8")
    L.log(f"published {len(out)} schemes, latest NAV {payload['latest_nav_date']}, "
          f"{OUT_JS.stat().st_size/1e6:.1f} MB")


if __name__ == "__main__":
    main()

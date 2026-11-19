"""Daily updater: fetch every NAV published since the last stored date, append, recompute.

Run:  python scripts/update.py
Safe to run any number of times. It re-reads the last few days (late NAVs, revisions) and
catches up any number of missed days in one go.

Sources (both official AMFI):
  * NAV history report: every scheme, any date range; carries the full scheme name, so it is
    the only source used to decide what is Regular + Growth. Lags about a day.
  * NAVAll.txt: the newest day. Used only for NAVs of schemes already classified.
  * mfapi.in: per-scheme fallback if the history report is down and days were missed.
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone

import pandas as pd

import navlib as L

IST = timezone(timedelta(hours=5, minutes=30))
OVERLAP_DAYS = 5


def main() -> int:
    today = datetime.now(IST).date()
    schemes = L.load_schemes()
    store = L.load_store([today.year - 1, today.year])
    last = max(store["date"]) if len(store) else today - timedelta(days=30)
    start = last - timedelta(days=OVERLAP_DAYS)
    L.log(f"last stored NAV date {last}; fetching {start} → {today}")

    hist = latest = None
    try:
        hist = L.fetch_history(start, today)
    except Exception as e:
        L.log(f"AMFI history report failed: {e}")
    try:
        latest = L.fetch_latest()
    except Exception as e:
        L.log(f"AMFI NAVAll.txt failed: {e}")
    parts, sources = [], []
    if hist is None and latest is None:
        L.log("both AMFI sources failed; fetching every scheme from mfapi.in instead")
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=8) as ex:
            def one(c):
                try:
                    return L.fetch_mfapi(int(c), since=start)
                except Exception:
                    return None
            got = [g for g in ex.map(one, sorted(schemes["code"])) if g is not None and len(g)]
        if not got:
            L.log("mfapi.in failed too; will try again next run")
            return 1
        mf = pd.concat(got, ignore_index=True)
        parts.append(mf)
        sources.append("mfapi")
        seen = mf.groupby("code")["date"].max().astype(str)
        schemes["last_seen"] = [max(str(ls), seen.get(c, "")) for c, ls in zip(schemes["code"], schemes["last_seen"])]

    rg = hist[L.is_regular_growth(hist)] if hist is not None else hist
    if rg is not None:
        schemes = L.merge_schemes(schemes, rg)        # also picks up newly launched schemes
        parts.append(rg[["code", "date", "nav"]])
        sources.append("amfi-history")
    known = set(schemes["code"])
    if latest is not None:
        lat = latest[latest["code"].isin(known) & (latest["date"] >= today - timedelta(days=10))]
        parts.append(lat[["code", "date", "nav"]])
        sources.append("amfi-latest")
        seen = lat.groupby("code")["date"].max().astype(str)
        schemes["last_seen"] = [max(str(ls), seen.get(c, "")) for c, ls in zip(schemes["code"], schemes["last_seen"])]

        # History report down and more than one day missed → backfill per scheme from mfapi.in
        if hist is None and len(lat):
            missed = pd.bdate_range(last + timedelta(days=1), max(lat["date"]) - timedelta(days=1))
            if len(missed):
                L.log(f"{len(missed)} business day(s) missing; backfilling from mfapi.in")
                for c in sorted(known):
                    try:
                        parts.append(L.fetch_mfapi(int(c), since=last))
                    except Exception as e:
                        L.log(f"  mfapi {c}: {e}")
                sources.append("mfapi")
    new = pd.concat(parts, ignore_index=True)
    source = "+".join(sources)

    # Drop schemes that stopped publishing (closed / merged)
    newest = max(pd.to_datetime(schemes["last_seen"])).date()
    stale_cut = newest - timedelta(days=L.STALE_DAYS)
    dropped = schemes[pd.to_datetime(schemes["last_seen"]).dt.date < stale_cut]
    schemes = schemes[~schemes["code"].isin(dropped["code"])]
    if len(dropped):
        L.log(f"dropping {len(dropped)} scheme(s) with no NAV for {L.STALE_DAYS}+ days: "
              + ", ".join(dropped["name"].head(5)) + ("…" if len(dropped) > 5 else ""))

    keep = set(schemes["code"])
    new = new[new["code"].isin(keep)]
    touched = {d.strftime("%Y-%m") for d in new["date"]}
    if len(dropped):  # prune their rows from every month file
        full = L.load_store()
        full = full[full["code"].isin(keep)]
        L.write_months(pd.concat([full, new], ignore_index=True))
    else:
        base = L.load_store(sorted({int(m[:4]) for m in touched}))
        L.write_months(pd.concat([base, new], ignore_index=True), touched)

    schemes.to_csv(L.SCHEMES_CSV, index=False)

    # Benchmark trackers (ETFs etc.): same AMFI pull, codes from data/benchmark_map.json
    import seed_proxies
    seed_proxies.main()
    pc = L.proxy_codes()
    if pc:
        src = [x for x in (hist, latest) if x is not None]
        px = pd.concat(src, ignore_index=True) if src else None
        if px is not None and len(px):
            px = px[px["code"].isin(pc)][["code", "date", "nav"]]
            pm = {d.strftime("%Y-%m") for d in px["date"]}
            if pm:
                base_px = L.load_store(sorted({int(m[:4]) for m in pm}), root=L.PROXY_DIR)
                L.write_months(pd.concat([base_px, px], ignore_index=True), pm, root=L.PROXY_DIR)
                L.log(f"trackers: {px['code'].nunique()} of {len(pc)} updated")

    after = L.load_store([today.year])
    latest_d = max(after["date"]) if len(after) else last
    L.save_state(updated_at=datetime.now(IST).isoformat(timespec="seconds"),
                 latest_nav_date=str(latest_d), source=source,
                 schemes=len(schemes), rows_fetched=int(len(new)))
    L.log(f"done: latest NAV date {latest_d}, {len(schemes)} schemes, {len(new)} rows via {source}")

    import compute
    compute.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())

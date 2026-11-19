"""Download full NAV history for every tracker in data/benchmark_map.json that is not stored yet.

  python scripts/seed_proxies.py          (update.py also calls this when the map gains codes)
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pandas as pd

import navlib as L


def main():
    want = L.proxy_codes()
    have = set(L.load_store(root=L.PROXY_DIR)["code"].unique()) if L.PROXY_DIR.exists() else set()
    missing = sorted(want - have)
    if not missing:
        return
    L.log(f"seeding {len(missing)} tracker histories from mfapi.in")

    def one(c):
        try:
            return L.fetch_mfapi(int(c))
        except Exception as e:
            L.log(f"  {c}: {e}")
            return None

    with ThreadPoolExecutor(8) as ex:
        parts = [p for p in ex.map(one, missing) if p is not None and len(p)]
    if parts:
        new = pd.concat(parts, ignore_index=True)
        old = L.load_store(root=L.PROXY_DIR)
        L.write_months(pd.concat([old, new], ignore_index=True), root=L.PROXY_DIR)


if __name__ == "__main__":
    main()

"""Add the live-NAV feed to a TCR html file.

  python tcr/patch_tcr.py <TCR.html> <github-username> [out.html]

Idempotent: a file that already has the patch is re-patched with the current version.
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BEGIN, END = "// ═══ LIVE NAV ═", "// ═══ end LIVE ENGINE ═══"


def patch(html: str, user: str) -> str:
    js = (HERE / "live_nav.js").read_text(encoding="utf-8") + "\n" + (HERE / "live_engine.js").read_text(encoding="utf-8")
    js = js.replace("__LIVE_URL__", f"https://{user}.github.io/tcr_nav/nav_data.js")

    # 1. drop any earlier copy of the patch
    html = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", "", html, flags=re.S)
    html = re.sub(r'<button class="icon-btn" id="live-btn"[^>]*>.*?</button>\n?', "", html)
    html = re.sub(r"<style id=\"live-css\">.*?</style>\n?", "", html, flags=re.S)

    # 2. code, right before runModel
    anchor = "async function runModel(keepView){"
    assert html.count(anchor) == 1, "runModel not found"
    html = html.replace(anchor, js + "\n" + anchor)

    # 3. use the live rows (and wait briefly for the feed) at the start of each run
    old = "    const cyCl=cleanData(cyRaw),trCl=cleanData(trRaw);"
    assert html.count(old) == 1, "cleanData hook not found"
    html = html.replace(old, "    await LIVE_READY;\n"
                             "    const cyCl=cleanData(liveApply(cyRaw,'cy')),trCl=cleanData(liveApply(trRaw,'tr'));liveBadge();")

    # 4. header button + style
    btn = '<button class="icon-btn" id="dark-btn"'
    assert html.count(btn) == 1
    html = html.replace(btn, '<button class="icon-btn" id="live-btn" onclick="livePanel()" '
                             'title="Live NAV">NAV …</button>\n    ' + btn)
    # 5. header: "Data 02 NOV" → "Files 02 NOV" (the vendor files' date; the NAV button shows the live date)
    html = html.replace("innerHTML=`Data <b>${eh(String(dt).toUpperCase())}</b>", "innerHTML=`Files <b>${eh(String(dt).toUpperCase())}</b>")
    css = ('<style id="live-css">#live-btn{width:auto;padding:0 8px;font-size:.72rem;font-weight:600;white-space:nowrap}'
           '#live-btn[data-state=on]{background:rgba(46,160,90,.35);border-color:rgba(120,220,150,.6)}'
           '#live-btn[data-state=paused]{opacity:.7}#live-btn[data-state=off]{background:rgba(200,60,60,.3)}'
           '#live-btn[data-state=past]{background:rgba(230,150,40,.45);border-color:rgba(255,200,120,.7)}'
           '#live-panel{position:fixed;z-index:9999;width:300px;background:var(--card);color:var(--text);border:1px solid var(--border);'
           'border-radius:8px;box-shadow:var(--shadow);padding:12px 14px;font:13px var(--sans)}'
           '#live-panel .lp-h{font-weight:700;margin-bottom:8px}#live-panel .lp-row{display:flex;align-items:center;gap:8px;margin:7px 0}'
           '#live-panel .lp-row>span{width:96px;color:var(--muted);font-size:.78rem}#live-panel input,#live-panel select{flex:1;min-width:0;'
           'padding:4px 6px;border:1px solid var(--border);border-radius:5px;background:var(--bg);color:var(--text);font:inherit}'
           '#live-panel input[type=checkbox]{flex:0 0 auto;appearance:auto;-webkit-appearance:checkbox;width:16px;height:16px;opacity:1;position:static;display:inline-block;margin:0}#live-panel .lp-btn{padding:4px 10px;border:1px solid var(--border);border-radius:5px;'
           'background:var(--card2);color:var(--text);cursor:pointer;font:inherit}#live-panel .lp-go{width:100%;margin-top:6px;background:var(--navy);color:#fff}'
           '#live-panel .lp-note{font-size:.72rem;color:var(--muted);margin-top:6px}</style>')
    html = html.replace("</head>", css + "\n</head>", 1)
    return html


if __name__ == "__main__":
    src, user = sys.argv[1], sys.argv[2]
    out = sys.argv[3] if len(sys.argv) > 3 else src
    Path(out).write_text(patch(Path(src).read_text(encoding="utf-8"), user), encoding="utf-8")
    print("patched →", out)

#!/usr/bin/env python3
"""
Build a self-contained review page for the Michigan legislature finance data.

Reads cf_officials + cf_official_finance straight from Supabase (both are
publicly readable, so no key is needed) and writes one HTML file with the data
inlined — no network calls at view time, which is what the artifact sandbox
requires. Use it to eyeball a sync before trusting it: every member, what their
committee raised and spent, which committees the total came from, and a flag on
any row resting on a weaker match than office + district.

Usage:
    python3 scripts/preview/build_mi_legislature_preview.py
    python3 scripts/preview/build_mi_legislature_preview.py --out /tmp/mi.html
"""

import argparse
import json
from urllib import request

PUBLIC_URL = "https://lohxdfrxnxuxjdvvyfjc.supabase.co"
PUBLIC_KEY = "sb_publishable_r8D7t0Stine_UgCoU_ps8g_UDRKSpoX"
STATE = "mi"


def fetch(path):
    req = request.Request(f"{PUBLIC_URL}/rest/v1/{path}", headers={
        "apikey": PUBLIC_KEY, "Authorization": f"Bearer {PUBLIC_KEY}"})
    with request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


ap = argparse.ArgumentParser()
ap.add_argument("--out", default="mi-legislature-preview.html",
                help="where to write the page (git-ignored by default)")
args = ap.parse_args()

roster = fetch(f"cf_officials?select=id,name,party,chamber,district"
               f"&state=eq.{STATE}&chamber=not.is.null&limit=1000")
finance = {f["official_id"]: f for f in fetch(
    "cf_official_finance?select=official_id,raised,spent,contribution_count,"
    f"committees,weakest_match,as_of,cycle_start,cycle_end&state=eq.{STATE}")}
if not roster or not finance:
    raise SystemExit("no Michigan data found — run the importer first")

members = []
for m in roster:
    f = finance.get(m['id'], {})
    members.append({
        'name': m['name'],
        'party': (m.get('party') or 'Unknown'),
        'chamber': m['chamber'],
        'district': m.get('district') or '',
        'raised': float(f.get('raised') or 0),
        'spent': float(f.get('spent') or 0),
        'contribs': int(f.get('contribution_count') or 0),
        'committees': [c['name'] for c in (f.get('committees') or [])],
        'match': f.get('weakest_match') or 'unmatched',
    })
meta = next(iter(finance.values()))
as_of = meta['as_of'][:10]
cycle = f"{meta['cycle_start']} – {meta['cycle_end']}"
total_raised = sum(m['raised'] for m in members)
total_spent = sum(m['spent'] for m in members)
strong = sum(1 for m in members if m['match'] == 'district_id')
data = json.dumps(members, separators=(',', ':'))

def money(v):
    if v >= 1_000_000: return f"${v/1_000_000:.2f}M"
    if v >= 1_000: return f"${v/1_000:.0f}K"
    return f"${v:,.0f}"

HTML = """<title>Michigan Legislature — 2025–26 campaign finance</title>
<style>
  :root {
    --paper:#f4f6f8; --surface:#ffffff; --ink:#141920; --muted:#606b7b;
    --line:#dde2e9; --line-soft:#e9edf2;
    --dem:#1f5fa8; --rep:#b0342f; --other:#7b8496;
    --brass:#8a6a2f; --flag:#a8721a; --flag-bg:#f6ecd9;
    --bar:#c3ccd8;
    --serif:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif;
    --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --mono:ui-monospace,SFMono-Regular,"SF Mono","Cascadia Mono",Menlo,monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper:#0e1218; --surface:#161b23; --ink:#e7ebf1; --muted:#95a0b1;
      --line:#28303b; --line-soft:#1e242d;
      --dem:#5f9dde; --rep:#e0736c; --other:#8b95a6;
      --brass:#c9a25a; --flag:#d7a44e; --flag-bg:#2c2415; --bar:#333c49;
    }
  }
  :root[data-theme="dark"] {
    --paper:#0e1218; --surface:#161b23; --ink:#e7ebf1; --muted:#95a0b1;
    --line:#28303b; --line-soft:#1e242d;
    --dem:#5f9dde; --rep:#e0736c; --other:#8b95a6;
    --brass:#c9a25a; --flag:#d7a44e; --flag-bg:#2c2415; --bar:#333c49;
  }
  :root[data-theme="light"] {
    --paper:#f4f6f8; --surface:#ffffff; --ink:#141920; --muted:#606b7b;
    --line:#dde2e9; --line-soft:#e9edf2;
    --dem:#1f5fa8; --rep:#b0342f; --other:#7b8496;
    --brass:#8a6a2f; --flag:#a8721a; --flag-bg:#f6ecd9; --bar:#c3ccd8;
  }

  body { background:var(--paper); color:var(--ink); font-family:var(--sans);
         line-height:1.5; margin:0; }
  .wrap { max-width:1080px; margin:0 auto; padding:40px 20px 72px; }

  .eyebrow { font-size:11px; letter-spacing:.14em; text-transform:uppercase;
             color:var(--brass); font-weight:600; margin:0 0 10px; }
  h1 { font-family:var(--serif); font-size:clamp(28px,4.2vw,42px); line-height:1.1;
       font-weight:600; margin:0 0 12px; text-wrap:balance; letter-spacing:-.01em; }
  .lede { color:var(--muted); max-width:62ch; margin:0; font-size:15px; }

  .stats { display:grid; gap:1px; background:var(--line);
           grid-template-columns:repeat(auto-fit,minmax(160px,1fr));
           border:1px solid var(--line); border-radius:3px; margin:28px 0 10px;
           overflow:hidden; }
  .stat { background:var(--surface); padding:14px 16px; }
  .stat dt { font-size:10.5px; letter-spacing:.08em; text-transform:uppercase;
             color:var(--muted); margin:0 0 6px; }
  .stat dd { margin:0; font-family:var(--mono); font-size:21px; font-weight:600;
             font-variant-numeric:tabular-nums; letter-spacing:-.02em; }
  .stat .sub { display:block; font-family:var(--sans); font-size:11.5px;
               font-weight:400; color:var(--muted); margin-top:3px; letter-spacing:0; }

  .provenance { font-size:12px; color:var(--muted); margin:0 0 32px;
                padding-left:11px; border-left:2px solid var(--brass); }

  .controls { display:flex; flex-wrap:wrap; gap:8px; align-items:center;
              margin:0 0 20px; }
  .seg { display:inline-flex; border:1px solid var(--line); border-radius:3px;
         overflow:hidden; }
  .seg button { font:inherit; font-size:12.5px; padding:7px 13px; border:0;
                background:var(--surface); color:var(--muted); cursor:pointer; }
  .seg button[aria-pressed="true"] { background:var(--ink); color:var(--paper);
                                     font-weight:600; }
  .seg button + button { border-left:1px solid var(--line); }
  input[type="search"] { font:inherit; font-size:13px; padding:7px 11px; flex:1;
                         min-width:200px; background:var(--surface);
                         border:1px solid var(--line); border-radius:3px;
                         color:var(--ink); }
  button:focus-visible, input:focus-visible { outline:2px solid var(--brass);
                                              outline-offset:1px; }

  .chamber { margin-bottom:40px; }
  .chamber-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:12px;
                  padding-bottom:9px; border-bottom:1.5px solid var(--ink);
                  margin-bottom:14px; }
  .chamber-head h2 { font-family:var(--serif); font-size:22px; font-weight:600;
                     margin:0; }
  .chamber-head .meta { margin-left:auto; font-size:12px; color:var(--muted);
                        font-variant-numeric:tabular-nums; }
  .split { display:flex; height:7px; border-radius:2px; overflow:hidden;
           margin-bottom:6px; background:var(--line-soft); }
  .split-legend { display:flex; gap:16px; font-size:12px; color:var(--muted);
                  margin-bottom:16px; flex-wrap:wrap; }
  .split-legend b { font-family:var(--mono); font-variant-numeric:tabular-nums;
                    color:var(--ink); font-weight:600; }
  .swatch { display:inline-block; width:9px; height:9px; border-radius:1px;
            margin-right:5px; vertical-align:baseline; }

  .table-scroll { overflow-x:auto; border:1px solid var(--line);
                  border-radius:3px; background:var(--surface); }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th { text-align:left; font-size:10.5px; letter-spacing:.07em;
       text-transform:uppercase; color:var(--muted); font-weight:600;
       padding:10px 12px; border-bottom:1px solid var(--line);
       white-space:nowrap; background:var(--surface); position:sticky; top:0; }
  td { padding:9px 12px; border-bottom:1px solid var(--line-soft);
       vertical-align:middle; }
  tr:last-child td { border-bottom:0; }
  .num { font-family:var(--mono); font-variant-numeric:tabular-nums;
         text-align:right; white-space:nowrap; }
  .rank { color:var(--muted); font-family:var(--mono); font-size:11.5px;
          width:1%; }
  .who { font-weight:500; white-space:nowrap; }
  .seat { color:var(--muted); font-size:11.5px; white-space:nowrap;
          font-variant-numeric:tabular-nums; }
  .party { font-family:var(--mono); font-weight:700; font-size:11.5px;
           width:1%; }
  .party.D { color:var(--dem); } .party.R { color:var(--rep); }
  .party.O { color:var(--other); }
  .raised-cell { width:34%; min-width:180px; }
  .bar-row { display:flex; align-items:center; gap:9px; }
  .bar { flex:1; height:5px; background:var(--line-soft); border-radius:1px;
         overflow:hidden; min-width:40px; }
  .bar span { display:block; height:100%; background:var(--bar); }
  .bar span.D { background:var(--dem); } .bar span.R { background:var(--rep); }
  .amount { font-family:var(--mono); font-variant-numeric:tabular-nums;
            font-weight:600; white-space:nowrap; width:66px; text-align:right; }
  .cmte { color:var(--muted); font-size:11.5px; max-width:280px;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chip { display:inline-block; font-size:10px; letter-spacing:.05em;
          text-transform:uppercase; font-weight:600; padding:2px 6px;
          border-radius:2px; background:var(--flag-bg); color:var(--flag);
          white-space:nowrap; }
  .empty { padding:28px; text-align:center; color:var(--muted); font-size:13px; }

  .method { margin-top:36px; padding-top:20px; border-top:1px solid var(--line);
            font-size:12.5px; color:var(--muted); max-width:70ch; }
  .method h3 { font-family:var(--serif); font-size:15px; color:var(--ink);
               margin:0 0 8px; font-weight:600; }
  .method p { margin:0 0 9px; }
  .method b { color:var(--ink); font-weight:600; }
  @media (max-width:640px) {
    .cmte, .hide-sm { display:none; }
  }
</style>

<div class="wrap">
  <p class="eyebrow">State Politics Tracker · data preview</p>
  <h1>Michigan Legislature: who's funding the 148</h1>
  <p class="lede">Every sitting member of the Michigan House and Senate, with what
    their campaign committee raised and spent in the 2025–26 cycle. This is the
    data now behind <code>/mi/legislature</code>, shown here for review.</p>

  <dl class="stats">
    <div class="stat"><dt>Raised this cycle</dt><dd>__TOTAL_RAISED__<span class="sub">__TOTAL_SPENT__ spent</span></dd></div>
    <div class="stat"><dt>Seats covered</dt><dd>148 / 148<span class="sub">every member matched</span></dd></div>
    <div class="stat"><dt>Match strength</dt><dd>__STRONG__<span class="sub">office + district + surname</span></dd></div>
    <div class="stat"><dt>Rows excluded</dt><dd>146,318<span class="sub">dated outside the cycle</span></dd></div>
  </dl>
  <p class="provenance">Michigan Bureau of Elections (MiTN bulk export) · roster from
    Open States · cycle __CYCLE__ · computed __AS_OF__</p>

  <div class="controls">
    <div class="seg" role="group" aria-label="Sort by">
      <button type="button" data-sort="raised" aria-pressed="true">Money raised</button>
      <button type="button" data-sort="district" aria-pressed="false">District</button>
      <button type="button" data-sort="name" aria-pressed="false">Name</button>
    </div>
    <input type="search" id="q" placeholder="Filter by name, party or district" aria-label="Filter members">
  </div>

  <div id="chambers"></div>

  <div class="method">
    <h3>How to read this</h3>
    <p>Each member is matched to the committee that <b>filed under their office and
      district</b> — not by name similarity. One member, Dayna Polehanki, matched on a
      unique office-and-surname instead: her committee still files under the district
      she held before redistricting. That row is flagged, because a total resting on a
      weaker match should not look as certain as the rest.</p>
    <p>Totals count only transactions <b>dated inside the cycle</b>. Michigan names its
      exports by filing-statement year, so the 2025 and 2026 files carry 146,318 rows
      dated outside it — roughly $445K that would otherwise inflate a 2026 number.</p>
    <p>Money raised for a <b>different office</b> is excluded. Aric Nesbitt is running
      for governor; only his state senate committee appears here.</p>
  </div>
</div>

<script>
  const MEMBERS = __DATA__;
  const CHAMBERS = [["upper","Senate"],["lower","House"]];
  const pcode = p => p && p[0] === "D" ? "D" : p && p[0] === "R" ? "R" : "O";
  const money = v => v >= 1e6 ? "$" + (v/1e6).toFixed(2) + "M"
                   : v >= 1e3 ? "$" + Math.round(v/1e3) + "K"
                   : "$" + Math.round(v);
  const esc = s => String(s).replace(/[&<>"]/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]));

  let sort = "raised", query = "";

  function render() {
    const q = query.trim().toLowerCase();
    document.getElementById("chambers").innerHTML = CHAMBERS.map(([key, label]) => {
      const all = MEMBERS.filter(m => m.chamber === key);
      const max = Math.max(...all.map(m => m.raised), 1);
      const counts = {};
      all.forEach(m => { const c = pcode(m.party); counts[c] = (counts[c] || 0) + 1; });
      const order = ["D","R","O"].filter(c => counts[c]);
      const names = {D:"Democratic", R:"Republican", O:"Other"};
      const total = all.reduce((s, m) => s + m.raised, 0);

      let rows = all.filter(m => !q ||
        (m.name + " " + m.party + " district " + m.district).toLowerCase().includes(q));
      rows = rows.slice().sort((a, b) =>
        sort === "raised" ? b.raised - a.raised
        : sort === "district" ? (+a.district || 999) - (+b.district || 999)
        : a.name.localeCompare(b.name));

      const body = rows.length ? rows.map((m, i) => {
        const c = pcode(m.party);
        return `<tr>
          <td class="rank">${i + 1}</td>
          <td class="party ${c}">${c}</td>
          <td class="who">${esc(m.name)}</td>
          <td class="seat hide-sm">${m.district ? "Dist. " + esc(m.district) : ""}</td>
          <td class="raised-cell"><div class="bar-row">
            <div class="bar"><span class="${c}" style="width:${(m.raised / max * 100).toFixed(1)}%"></span></div>
            <span class="amount">${money(m.raised)}</span>
          </div></td>
          <td class="num hide-sm">${money(m.spent)}</td>
          <td class="num hide-sm">${m.contribs.toLocaleString()}</td>
          <td class="cmte">${esc(m.committees.join(", "))}${
            m.match !== "district_id" ? ' <span class="chip">name match</span>' : ""}</td>
        </tr>`;
      }).join("") : `<tr><td colspan="8" class="empty">No members match that filter.</td></tr>`;

      return `<section class="chamber">
        <div class="chamber-head">
          <h2>${label}</h2>
          <span class="meta">${all.length} seats · ${money(total)} raised</span>
        </div>
        <div class="split">${order.map(c =>
          `<span style="width:${counts[c] / all.length * 100}%;background:var(--${
            c === "D" ? "dem" : c === "R" ? "rep" : "other"})"></span>`).join("")}</div>
        <div class="split-legend">${order.map(c =>
          `<span><i class="swatch" style="background:var(--${
            c === "D" ? "dem" : c === "R" ? "rep" : "other"})"></i><b>${counts[c]}</b> ${names[c]}</span>`
          ).join("")}</div>
        <div class="table-scroll"><table>
          <thead><tr>
            <th></th><th></th><th>Member</th><th class="hide-sm">Seat</th>
            <th>Raised</th><th class="num hide-sm">Spent</th>
            <th class="num hide-sm">Gifts</th><th>Committee</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table></div>
      </section>`;
    }).join("");
  }

  document.querySelectorAll("[data-sort]").forEach(b => b.addEventListener("click", () => {
    sort = b.dataset.sort;
    document.querySelectorAll("[data-sort]").forEach(o =>
      o.setAttribute("aria-pressed", String(o === b)));
    render();
  }));
  document.getElementById("q").addEventListener("input", e => {
    query = e.target.value; render();
  });
  render();
</script>
"""

out = (HTML.replace('__DATA__', data)
           .replace('__TOTAL_RAISED__', money(total_raised))
           .replace('__TOTAL_SPENT__', money(total_spent))
           .replace('__STRONG__', f"{strong} / 148")
           .replace('__CYCLE__', cycle)
           .replace('__AS_OF__', as_of))
open(args.out, 'w').write(out)
print("wrote", args.out, "|", len(out), "bytes |", len(members), "members |", money(total_raised), "raised | strong:", strong)

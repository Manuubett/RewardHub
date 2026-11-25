// Admin "Daily batch" tab: compare each BTN with Monetag's numbers for the same day, then approve the whole day at once.
// Wired into app.js with createAdminBatch({...}). All real work (timing, cap, crediting) happens on the server.
// Reads a Monetag statistics export (CSV). Handles ; or , separators, skips the blank-date "total" line,
// and uses a Zone column when the export has one (group the export by Zone and Date for a per-BTN comparison).
export function parseStatsCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return null;
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const cut = l => l.split(sep).map(x => x.trim().replace(/^"|"$/g, ''));
  const head = cut(lines[0]).map(h => h.toLowerCase()), col = re => head.findIndex(h => re.test(h));
  const iD = col(/^(date|day)/), iI = col(/impression/), iR = col(/profit|revenue|earning/), iZ = col(/zone/);
  if (iD < 0 || iI < 0 || iR < 0) return null;
  const rows = lines.slice(1).map(cut).filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c[iD] || ''))
    .map(c => ({ date: c[iD], zone: iZ >= 0 ? c[iZ] : '', imp: Number(c[iI]) || 0, usd: Number(c[iR]) || 0 }));
  return rows.length ? { rows, hasZone: iZ >= 0 } : null;
}

export function createAdminBatch({ $, app, esc, pts, kes, note, err, call }) {
  const PTS_PER_KES = 10;   // keep in sync with app.js and server.js
  const n0 = v => { v = Number(v || 0); return v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) < 10 && v % 1 ? 2 : 0 }); };   // small money amounts keep 2 decimals
  const num = el => { const v = el?.value; return v === '' || v == null ? null : Number(v); };

  const html = () => `<h1>Daily batch</h1>
    <p class="mute">Approve one finished day at once. Only tasks where the user stayed on the partner page long enough are included. First compare each BTN with Monetag's statistics for the <b>same day</b>, using the zone or link of that BTN.</p>
    <div class="rvbar"><input type="date" id="bday" aria-label="Day"><button id="bload" type="button">Load day</button></div>
    <div id="bbox"><p class="mute">Loading…</p></div>`;

  function draw(box, r) {
    const st = r.stats || { rate: '', stats: {} }, shown = r.btns.filter(b => b.claimed || b.unverified), hidden = r.btns.length - shown.length;
    const totalPayable = r.users.reduce((t, u) => t + u.payable, 0), totClaimed = r.btns.reduce((t, b) => t + b.claimed, 0), totPts = r.btns.reduce((t, b) => t + b.claimedPoints, 0), tot = st.stats?._total || {};
    box.innerHTML = `${r.truncated ? note('This day has a very large number of activities. Totals may be incomplete and approval is blocked.') : ''}
      <p class="mute">Day <b>${esc(r.day)}</b> in ${esc(r.tz)} (covers ${esc(new Date(r.startMs).toLocaleString())} to ${esc(new Date(r.endMs).toLocaleString())} your time).
        Daily cap: ${pts(r.cap)} per user. Already approved by batch for this day: ${pts(r.doneBatchPoints)}.</p>
      <div class="row" style="margin:.6rem 0"><label>USD to KES rate<input id="brate" type="number" step="0.01" min="0" value="${esc(st.rate ?? '')}" style="width:8rem"></label>
        <label>Flag when claims ÷ impressions is above<input id="bwarn" type="number" step="0.05" min="0" value="${esc(r.warn)}" style="width:8rem"></label></div>
      <div class="card" style="margin:.6rem 0"><b>Monetag numbers for this day</b>
        <p class="mute" style="margin:.2rem 0 .6rem">Upload your Monetag CSV export to fill them in, or type them. With a Zone column the rows below are filled per BTN; without one, only the day total is filled.</p>
        <div class="row"><input type="file" id="bfile" accept=".csv,.txt,text/csv" aria-label="Monetag CSV file" style="max-width:20rem">
          <label>Day total impressions<input id="btimp" type="number" min="0" step="1" value="${esc(tot.impressions ?? '')}" style="width:8rem"></label>
          <label>Day total revenue (USD)<input id="btusd" type="number" min="0" step="0.001" value="${esc(tot.revenueUsd ?? '')}" style="width:8rem"></label></div><div id="bnote"></div></div>
      <div class="scroll"><table id="btab"><tr><th>Task</th><th>Zone / link ID</th><th>Claimed</th><th>Points</th><th>Not verified</th>
        <th>Monetag impressions</th><th>Monetag revenue (USD)</th><th>Claims ÷ impressions</th><th>Cost vs revenue (KES)</th><th>Approve %</th></tr>
        ${shown.map(b => { const s = st.stats?.[b.id] || {}; return `<tr data-id="${esc(b.id)}" data-zone="${esc(b.zone)}" data-claimed="${b.claimed}" data-points="${b.claimedPoints}">
          <td><b>${esc(b.code)}</b><div class="mute">${esc(b.title)}</div></td><td>${esc(b.zone) || '<span class="mute">not set</span>'}</td><td>${n0(b.claimed)}</td><td>${n0(b.claimedPoints)}</td><td>${n0(b.unverified)}</td>
          <td><input class="imp" type="number" min="0" step="1" value="${esc(s.impressions ?? '')}" style="width:7rem;margin:0" aria-label="Impressions for ${esc(b.code)}"></td>
          <td><input class="usd" type="number" min="0" step="0.01" value="${esc(s.revenueUsd ?? '')}" style="width:6.5rem;margin:0" aria-label="Revenue USD for ${esc(b.code)}"></td>
          <td class="ratio">—</td><td class="money">—</td>
          <td><input class="pc" type="number" min="0" max="100" step="5" value="100" style="width:5rem;margin:0" aria-label="Approve percent for ${esc(b.code)}"></td></tr>`; }).join('') || '<tr><td colspan=10>No claimed tasks for this day.</td></tr>'}
        <tr id="btot"><td colspan="2"><b>Total</b></td><td>${n0(totClaimed)}</td><td>${n0(totPts)}</td><td></td><td></td><td></td><td class="tratio">—</td><td class="money"></td><td></td></tr></table></div>
      ${hidden ? `<p class="mute">${hidden} other task${hidden > 1 ? 's' : ''} had no activity this day.</p>` : ''}
      <p class="mute">Flags only warn you. Nothing is held automatically. To hold a BTN, set its Approve % to 0, or lower it to approve only part of each user's tasks (oldest first). Held tasks stay in the Review tab.</p>
      <h2>Users</h2><div class="scroll"><table><tr><th>Include</th><th>User</th><th>Waiting tasks</th><th>Waiting points</th><th>Will receive (before your %)</th><th>Note</th></tr>
        ${r.users.map(u => `<tr><td><input type="checkbox" data-u="${esc(u.uid)}" ${u.reason ? 'disabled' : 'checked'} aria-label="Include ${esc(u.name)}"></td><td>${esc(u.name || u.uid)}</td><td>${n0(u.open)}</td><td>${n0(u.openPoints)}</td>
          <td>${n0(u.payable)}</td><td>${u.reason ? `<span class="mute">Left out: ${esc(u.reason)}</span>` : u.openPoints > u.payable ? '<span class="mute">Capped</span>' : ''}</td></tr>`).join('') || '<tr><td colspan=6>No tasks waiting for this day.</td></tr>'}</table></div>
      <p class="mute">Up to <b>${pts(totalPayable)}</b> (≈ ${kes(totalPayable / PTS_PER_KES)}) would be credited, before your Approve % settings.</p>
      <div class="acts"><button id="bsave" type="button" class="alt">Save Monetag numbers</button><button id="bapprove" type="button" class="gold" ${r.truncated || !totalPayable ? 'disabled' : ''}>Approve batch</button></div>`;

    const recalc = () => {
      const rate = num($('#brate')), warn = num($('#bwarn')) ?? 1; let cost = 0, rev = 0, anyRev = false;
      box.querySelectorAll('#btab tr[data-id]').forEach(tr => {
        const claimed = +tr.dataset.claimed, c = +tr.dataset.points / PTS_PER_KES, imp = num(tr.querySelector('.imp')), usd = num(tr.querySelector('.usd')), ratio = tr.querySelector('.ratio'), money = tr.querySelector('.money');
        cost += c;
        if (imp) { const x = claimed / imp; ratio.textContent = x.toFixed(2) + (x > warn ? ' ⚠' : ''); ratio.className = 'ratio ' + (x > warn ? 'rejected' : 'approved'); } else { ratio.textContent = '—'; ratio.className = 'ratio'; }
        if (usd != null && rate) { const v = usd * rate; rev += v; anyRev = true; money.textContent = `${n0(c)} vs ${n0(v)}${c > v ? ' ⚠ loss' : ''}`; money.className = 'money ' + (c > v ? 'rejected' : 'approved'); }
        else { money.textContent = n0(c) + ' paid'; money.className = 'money'; }
      });
      const tImp = num($('#btimp')), tUsd = num($('#btusd')); let sumImp = 0; box.querySelectorAll('#btab tr[data-id] .imp').forEach(i => { sumImp += Number(i.value) || 0; });
      const imps = tImp != null ? tImp : (sumImp || null), revKes = anyRev ? rev : (tUsd != null && rate ? tUsd * rate : null), tr = $('#btot .tratio');
      if (imps) { const x = totClaimed / imps; tr.textContent = x.toFixed(2) + (x > warn ? ' ⚠' : ''); tr.className = 'tratio ' + (x > warn ? 'rejected' : 'approved'); } else { tr.textContent = '—'; tr.className = 'tratio'; }
      $('#btot .money').textContent = revKes != null ? `${n0(cost)} vs ${n0(revKes)}${cost > revKes ? ' ⚠ loss' : ''}` : `${n0(cost)} paid`;
    };
    box.oninput = recalc; recalc();
  }

  const bind = () => {
    const box = $('#bbox'); if (!box) return;
    let cur = null;
    const load = async day => {
      box.innerHTML = '<p class="mute">Analysing…</p>';
      try { cur = await call('adminBatchPreview')({ day }); $('#bday').value = cur.day; draw(box, cur); wire(); }
      catch (x) { box.innerHTML = note(err(x)); }
    };
    const stats = () => { const s = {}; box.querySelectorAll('#btab tr[data-id]').forEach(tr => {
      const imp = num(tr.querySelector('.imp')), usd = num(tr.querySelector('.usd')); if (imp != null || usd != null) s[tr.dataset.id] = { impressions: imp, revenueUsd: usd }; }); return s; };
    const save = () => { const s = stats(), ti = num($('#btimp')), tu = num($('#btusd')); if (ti != null || tu != null) s._total = { impressions: ti, revenueUsd: tu };
      return call('adminSaveBatchStats')({ day: cur.day, rate: $('#brate').value, stats: s }); };
    function wire() {
      $('#bfile')?.addEventListener('change', async e => {
        const f = e.target.files[0], msg = $('#bnote'); if (!f) return;
        const p = parseStatsCsv(await f.text());
        if (!p) { msg.innerHTML = note('Could not read this file. It needs Date, Impressions and Profit (or Revenue) columns.'); return; }
        const dates = p.rows.map(r => r.date).sort(), rows = p.rows.filter(r => r.date === cur.day);
        if (!rows.length) { msg.innerHTML = note(`This file has no row for ${cur.day}. It covers ${dates[0]} to ${dates[dates.length - 1]}.`); return; }
        if (p.hasZone) {
          let hit = 0; const miss = [], trs = [...box.querySelectorAll('#btab tr[data-id]')];
          rows.forEach(r => { const tr = trs.find(t => t.dataset.zone && t.dataset.zone === r.zone); if (tr) { tr.querySelector('.imp').value = r.imp; tr.querySelector('.usd').value = r.usd; hit++; } else miss.push(r.zone); });
          msg.innerHTML = note(`Filled ${hit} BTN row${hit === 1 ? '' : 's'} from the file.` + (miss.length ? ` No BTN has this zone ID in its "Provider zone / reference" field: ${miss.join(', ')}.` : ''));
        } else {
          const r = rows.reduce((a, x) => ({ imp: a.imp + x.imp, usd: a.usd + x.usd }), { imp: 0, usd: 0 });
          $('#btimp').value = r.imp; $('#btusd').value = r.usd;
          msg.innerHTML = note('Filled the day total. This file has no Zone column, so it cannot be split per BTN. Export again grouped by Zone and Date for that.');
        }
        box.oninput();
      });
      $('#bsave')?.addEventListener('click', async () => { const b = $('#bsave'); b.disabled = true; try { await save(); b.textContent = 'Saved ✓'; } catch (x) { alert(err(x)); } setTimeout(() => { b.disabled = false; b.textContent = 'Save Monetag numbers'; }, 1500); });
      $('#bapprove')?.addEventListener('click', async () => {
        const percent = {}; box.querySelectorAll('#btab tr[data-id]').forEach(tr => { percent[tr.dataset.id] = Number(tr.querySelector('.pc').value); });
        const skipUsers = [...box.querySelectorAll('input[data-u]')].filter(i => !i.checked && !i.disabled).map(i => i.dataset.u);
        if (!confirm(`Approve the batch for ${cur.day}? Points are credited to users now and this cannot be undone from this screen.`)) return;
        const b = $('#bapprove'); b.disabled = true; b.textContent = 'Approving…';
        try {
          await save().catch(() => {});   // keep a record of the Monetag numbers used
          const o = await call('adminApproveBatch')({ day: cur.day, percent, skipUsers });
          await load(cur.day); box.insertAdjacentHTML('afterbegin', note(`Done: ${o.users} user${o.users === 1 ? '' : 's'}, ${o.tasks} task${o.tasks === 1 ? '' : 's'}, ${o.points.toLocaleString()} points credited.`));
        } catch (x) { b.disabled = false; b.textContent = 'Approve batch'; alert(err(x)); }
      });
    }
    $('#bload').onclick = () => load($('#bday').value);
    load('');
  };

  return { html, bind };
}

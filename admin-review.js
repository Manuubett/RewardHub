// admin-review.js: Review tab. Groups waiting activities per user, search by name, filters, sorting,
// one-click approve (no notes), "Approve all" for ONE user at a time, and checkboxes to REJECT many activities at once.
export function createAdminReview(c) {
  const { $, app, esc, pts, when, stat, call, err } = c;
  const S = { q: '', f: 'all', sort: 'count' };          // kept between page reloads
  let all = [], decided = [], busy = false;
  const sel = new Set();                                 // ids of the activities ticked for rejection (kept while you search, filter and sort)
  const secs = a => a?.createdAt?.seconds || 0, isNew = a => secs(a) > Date.now() / 1000 - 86400;
  const sumPts = l => l.reduce((s, a) => s + (+a.rewardPoints || 0), 0);
  const OKNOTE = 'Approved by admin', NONOTE = 'Rejected by admin';   // automatic notes, nothing to type
  const BULK_MAX = 300;     // activities per bulk request (keep in sync with MAX in admin-bulk.js)
  const REJECT_MAX = 200;   // activities per "Reject selected" request (keep in sync with the 200 limit in admin-extras.js)
  // Quick reasons for rejecting. The user can read the reason in their History page, so keep the wording neutral.
  const REASONS = ['Left the partner page too early', 'Partner did not confirm the activity', 'Duplicate or suspicious activity', 'Task requirements were not followed'];
  const nameOf = u => u?.name || u?.fullName || u?.email || u?.phone || 'Unnamed user';

  if (!document.getElementById('rvsel-css')) document.head.insertAdjacentHTML('beforeend', `<style id="rvsel-css">
    .rvselbar{position:sticky;bottom:0;z-index:6;display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin:.8rem 0;padding:.7rem .9rem;background:var(--card);border:1px solid var(--bad);border-radius:var(--r,12px);box-shadow:0 -6px 18px rgba(0,0,0,.12)}
    .rvselbar[hidden]{display:none}.rvselbar b{white-space:nowrap}.rvselbar input[type=text]{flex:1 1 220px;margin:0;min-width:0}
    tr.rvsel-on td{background:color-mix(in srgb,var(--bad) 9%,transparent)}
    .rvsl{display:inline-flex;align-items:center;gap:.4rem;cursor:pointer;font-weight:600}</style>`);

  function build(users, items) {
    const by = {}; items.forEach(a => (by[a.uid] ||= []).push(a));
    all = Object.entries(by).map(([uid, list]) => {
      const u = users.find(x => x.id === uid) || {}; list.sort((a, b) => secs(b) - secs(a));
      return { uid, name: nameOf(u), phone: String(u.phone || ''), email: String(u.email || ''), list };
    });
    const live = new Set(items.map(a => a.id)); [...sel].forEach(id => live.has(id) || sel.delete(id));   // forget ticks for tasks that are gone
  }
  const filt = a => S.f === 'all' || (S.f === 'confirmed' && a.status === 'pending_review') || (S.f === 'unconfirmed' && a.status === 'started') || (S.f === 'new' && isNew(a));
  function visible() {
    const q = S.q.trim().toLowerCase(), q2 = q.replace(/^0/, '254');
    const gs = all.map(g => ({ ...g, items: g.list.filter(filt) })).filter(g => g.items.length &&
      (!q || [g.name, g.email].some(v => v.toLowerCase().includes(q)) || g.phone.includes(q) || g.phone.includes(q2)));
    const by = { count: (a, b) => b.items.length - a.items.length, name: (a, b) => a.name.localeCompare(b.name), newest: (a, b) => secs(b.items[0]) - secs(a.items[0]),
      points: (a, b) => sumPts(b.items) - sumPts(a.items), oldest: (a, b) => secs(a.items.at(-1)) - secs(b.items.at(-1)) };
    return gs.sort(by[S.sort] || by.count);
  }
  const selItems = () => all.flatMap(g => g.list).filter(a => sel.has(a.id));
  // Every row shows the user's name too, so you always see who you are approving.
  const item = (a, name) => `<tr class="${sel.has(a.id) ? 'rvsel-on' : ''}"><td><input type="checkbox" data-sel="${esc(a.id)}" ${sel.has(a.id) ? 'checked' : ''} aria-label="Select this activity for rejection"></td>
    <td><b>${esc(name)}</b></td><td>${when(a.createdAt)}${isNew(a) ? ' <span class="tag">New</span>' : ''}</td><td>${esc(a.opportunityCode)}</td><td>${pts(a.rewardPoints)}</td><td>${stat(a.status)}</td>
    <td>${a.providerEventId ? 'Confirmed' : 'Not confirmed'}</td><td class="nw"><button data-ra="${esc(a.id)}" data-dec="approve">Approve</button> <button class="bad" data-ra="${esc(a.id)}" data-dec="reject">Reject</button></td></tr>`;
  const group = (g, open) => {
    const conf = g.items.filter(a => a.status === 'pending_review').length, unc = g.items.length - conf, id = esc(g.uid);
    return `<div class="card rvg"><div class="rvh"><div><div class="rvname">${esc(g.name)} <span class="badge">${g.items.length}</span> ${g.items.some(isNew) ? '<span class="tag">New</span>' : ''}</div>
      <div class="mute">${esc(g.phone)}${g.email ? ' · ' + esc(g.email) : ''}</div><div class="mute">${pts(sumPts(g.items))} waiting · oldest ${when(g.items.at(-1).createdAt)}</div></div>
      <div class="acts"><label class="rvsl"><input type="checkbox" data-selgroup="${id}"> Select all</label>${conf && unc ? `<button class="alt" data-all="${id}" data-scope="confirmed">Approve confirmed (${conf})</button>` : ''}<button class="gold" data-all="${id}" data-scope="all">Approve all (${g.items.length})</button></div></div>
      <details ${open ? 'open' : ''}><summary class="mute">Show activities</summary><div class="scroll"><table><tr><th></th><th>User</th><th>When</th><th>Code</th><th>Points</th><th>Status</th><th>Partner</th><th></th></tr>${g.items.map(a => item(a, g.name)).join('')}</table></div></details></div>`;
  };
  const list = () => { const v = visible(); return v.length ? v.map(g => group(g, v.length <= 3)).join('') : '<p class="mute">Nothing waiting for these filters.</p>'; };
  const stats = () => { const all2 = all.flatMap(g => g.list); return `<div class="grid"><div class="card"><div class="mute">Users waiting</div><div class="big">${all.length}</div></div>
    <div class="card"><div class="mute">Activities waiting</div><div class="big">${all2.length}</div></div><div class="card"><div class="mute">Points waiting</div><div class="big">${pts(sumPts(all2))}</div></div></div>`; };
  const chips = () => [['all', 'All waiting'], ['new', 'New (24h)'], ['confirmed', 'Partner confirmed'], ['unconfirmed', 'Not confirmed']].map(([k, l]) => {
    const n = all.flatMap(g => g.list).filter(a => k === 'all' || (k === 'confirmed' && a.status === 'pending_review') || (k === 'unconfirmed' && a.status === 'started') || (k === 'new' && isNew(a))).length;
    return `<button class="alt ${S.f === k ? 'on' : ''}" data-f="${k}">${l} (${n})</button>`; }).join('');

  function html(users, items, recent) {
    build(users, items);
    decided = (recent || []).map(a => `<tr><td><b>${esc(nameOf(users.find(u => u.id === a.uid)))}</b></td><td>${when(a.createdAt)}</td><td>${esc(a.opportunityCode)}</td><td>${pts(a.rewardPoints)}</td><td>${stat(a.status)}</td></tr>`);
    const sorts = [['count', 'Most requests'], ['name', 'Name A to Z'], ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['points', 'Most points']];
    const names = [...new Set(all.map(g => g.name))].sort();
    return `<h1>Review</h1><div id="rvstats">${stats()}</div>
      <div class="rvbar"><input id="rvq" type="search" list="rvnames" placeholder="Search user by name or phone" value="${esc(S.q)}" aria-label="Search users" autocomplete="off">
      <datalist id="rvnames">${names.map(n => `<option value="${esc(n)}"></option>`).join('')}</datalist>
      <select id="rvs" aria-label="Sort">${sorts.map(([k, l]) => `<option value="${k}" ${S.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="chips" id="rvf">${chips()}</div>
      <label class="rvsl" style="margin:.2rem 0 .4rem"><input type="checkbox" id="rvall"> Select all shown (<span id="rvalln">0</span>) to reject</label>
      <div id="rvlist">${list()}</div>
      <div class="rvselbar" id="rvsel" hidden role="region" aria-label="Reject selected activities"><b id="rvcount"></b>
        <select id="rvpick" aria-label="Quick reason"><option value="">Pick a reason…</option>${REASONS.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}<option value="__other">Other (type your own)</option></select>
        <input type="text" id="rvreason" value="" maxlength="500" required aria-label="Reason for rejecting all selected" placeholder="One reason for all selected (required)">
        <button class="bad" id="rvrej" type="button">Reject selected</button><button class="alt" id="rvclr" type="button">Clear</button>
        <div class="mute" style="flex:1 1 100%;font-size:.8rem">This one reason is saved on every selected activity. The user can read it in their History.</div></div>
      <h2>Recently decided</h2><div class="scroll"><table><tr><th>User</th><th>When</th><th>Code</th><th>Points</th><th>Status</th></tr>${decided.slice(0, 50).join('') || '<tr><td colspan=5>None yet.</td></tr>'}</table></div>`;
  }
  // Keeps every checkbox, the "N selected" bar and the select-all boxes in step with the `sel` set.
  function syncSel() {
    const bar = $('#rvsel'); if (!bar) return;
    const items = selItems(), vis = visible();
    bar.hidden = !items.length;
    if (items.length) { const u = new Set(items.map(a => a.uid)).size; $('#rvcount').textContent = `${items.length} selected · ${pts(sumPts(items))} · ${u} user${u === 1 ? '' : 's'}`; }
    app.querySelectorAll('[data-selgroup]').forEach(cb => {
      const g = vis.find(x => x.uid === cb.dataset.selgroup), n = g ? g.items.filter(a => sel.has(a.id)).length : 0;
      cb.checked = !!g && n > 0 && n === g.items.length; cb.indeterminate = !!g && n > 0 && n < g.items.length;
    });
    const ca = $('#rvall'), flat = vis.flatMap(g => g.items), n = flat.filter(a => sel.has(a.id)).length;
    if (ca) { ca.checked = flat.length > 0 && n === flat.length; ca.indeterminate = n > 0 && n < flat.length; $('#rvalln').textContent = flat.length; }
  }
  const render = () => { const L = $('#rvlist'); if (L) L.innerHTML = list(); syncSel(); };
  function paint() {
    $('#rvstats') && ($('#rvstats').innerHTML = stats()); $('#rvf') && ($('#rvf').innerHTML = chips()); render();
    const bd = app.querySelector('.side a[href="#/admin/review"] .badge'), n = all.reduce((s, g) => s + g.list.length, 0);
    if (bd) n ? bd.textContent = n : bd.remove();
  }
  function drop(ids) { const s = new Set(ids); ids.forEach(id => sel.delete(id)); all.forEach(g => g.list = g.list.filter(a => !s.has(a.id))); all = all.filter(g => g.list.length); paint(); }
  async function single(b) {
    if (busy) return; const dec = b.dataset.dec; if (dec === 'reject' && !confirm('Reject this activity?')) return;
    busy = true; b.disabled = true;
    try { await call('adminReviewActivity')({ attemptId: b.dataset.ra, decision: dec, note: dec === 'approve' ? OKNOTE : NONOTE }); drop([b.dataset.ra]); }
    catch (x) { b.disabled = false; alert(err(x)); } finally { busy = false; }
  }
  // "Approve all" sends the whole batch to the server in ONE request per 300 activities (was: one request per activity).
  async function bulk(b) {
    if (busy) return; const g = all.find(x => x.uid === b.dataset.all); if (!g) return;
    const items = g.list.filter(a => b.dataset.scope === 'all' || a.status === 'pending_review'), unc = items.filter(a => a.status !== 'pending_review').length;
    if (!items.length || !confirm(`Approve ${items.length} activities (${sumPts(items)} pts) for ${g.name} only?` + (unc ? `\n\n${unc} of them have no partner confirmation yet.` : ''))) return;
    busy = true; b.closest('.rvg').querySelectorAll('button').forEach(x => x.disabled = true);
    let approved = 0, skipped = 0, failMsg = '';
    for (let i = 0; i < items.length; i += BULK_MAX) {
      const part = items.slice(i, i + BULK_MAX); b.textContent = `Approving ${Math.min(i + BULK_MAX, items.length)}/${items.length}…`;
      try {
        const r = await call('adminReviewBulk')({ uid: g.uid, attemptIds: part.map(a => a.id), note: OKNOTE });
        approved += r.approved || 0; skipped += r.skipped || 0; drop(r.approvedIds || []);
      } catch (x) { failMsg = err(x); break; }
    }
    busy = false; paint();
    if (failMsg || skipped) alert(`${approved} approved` + (skipped ? `, ${skipped} skipped (already handled)` : '') + (failMsg ? `.\nStopped: ${failMsg}` : '.'));
  }
  // "Reject selected": one request per 200 ticked activities. The screen only removes what the server says it rejected.
  async function rejectSel() {
    if (busy) return; const items = selItems(); if (!items.length) return;
    const reason = ($('#rvreason').value || '').trim();
    if (reason.length < 3) { alert('Add one reason for the selected activities first (pick one or type your own, at least 3 characters).'); $('#rvreason').focus(); return; }
    const users = new Set(items.map(a => a.uid)).size;
    if (!confirm(`Reject ${items.length} activit${items.length === 1 ? 'y' : 'ies'} (${sumPts(items)} pts) from ${users} user${users === 1 ? '' : 's'}?\n\nReason: ${reason}\n\nThis cannot be undone from this screen.`)) return;
    busy = true; const b = $('#rvrej'), clr = $('#rvclr'); b.disabled = clr.disabled = true;
    let rejected = 0, skipped = 0, failMsg = '';
    for (let i = 0; i < items.length; i += REJECT_MAX) {
      const part = items.slice(i, i + REJECT_MAX); b.textContent = `Rejecting ${Math.min(i + REJECT_MAX, items.length)}/${items.length}…`;
      try {
        const r = await call('adminRejectMany')({ attemptIds: part.map(a => a.id), note: reason });
        rejected += r.rejected || 0; skipped += r.skipped || 0; drop(r.rejectedIds || []);
      } catch (x) { failMsg = err(x); break; }
    }
    busy = false; const b2 = $('#rvrej'), c2 = $('#rvclr'); if (b2) { b2.disabled = false; b2.textContent = 'Reject selected'; } if (c2) c2.disabled = false;
    if (!failMsg) { $('#rvreason').value = ''; $('#rvpick').value = ''; }   // the next batch needs a fresh reason
    paint();
    if (failMsg || skipped) alert(`${rejected} rejected` + (skipped ? `, ${skipped} skipped (already handled, or your own account)` : '') + (failMsg ? `.\nStopped: ${failMsg}` : '.'));
  }
  function bind() {
    const L = $('#rvlist'); if (!L) return; let t;
    L.onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.ra) single(b); else if (b.dataset.all) bulk(b); };
    L.onchange = e => {   // ticking boxes
      const cb = e.target;
      if (cb.dataset.sel) { cb.checked ? sel.add(cb.dataset.sel) : sel.delete(cb.dataset.sel); cb.closest('tr')?.classList.toggle('rvsel-on', cb.checked); }
      else if (cb.dataset.selgroup) {
        const g = visible().find(x => x.uid === cb.dataset.selgroup); if (!g) return;
        g.items.forEach(a => cb.checked ? sel.add(a.id) : sel.delete(a.id));
        cb.closest('.rvg').querySelectorAll('[data-sel]').forEach(x => { x.checked = cb.checked; x.closest('tr')?.classList.toggle('rvsel-on', cb.checked); });
      } else return;
      syncSel();
    };
    $('#rvall').onchange = e => { const on = e.target.checked; visible().forEach(g => g.items.forEach(a => on ? sel.add(a.id) : sel.delete(a.id))); render(); };
    $('#rvpick').onchange = e => { const v = e.target.value, r = $('#rvreason'); r.value = v === '__other' ? '' : v; if (v) r.focus(); };
    $('#rvrej').onclick = rejectSel;
    $('#rvclr').onclick = () => { sel.clear(); render(); };
    $('#rvq').oninput = e => { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value; render(); }, 150); };
    $('#rvs').onchange = e => { S.sort = e.target.value; render(); };
    $('#rvf').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; S.f = b.dataset.f; $('#rvf').innerHTML = chips(); render(); };
    syncSel();
  }
  return { html, bind };
}

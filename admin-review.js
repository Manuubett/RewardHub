// admin-review.js: Review tab. Groups waiting activities per user, search by name, filters, sorting,
// one-click approve (no notes) and "Approve all" for ONE user at a time.
export function createAdminReview(c) {
  const { $, app, esc, pts, when, stat, call, err } = c;
  const S = { q: '', f: 'all', sort: 'count' };          // kept between page reloads
  let all = [], decided = [], busy = false;
  const secs = a => a?.createdAt?.seconds || 0, isNew = a => secs(a) > Date.now() / 1000 - 86400;
  const sumPts = l => l.reduce((s, a) => s + (+a.rewardPoints || 0), 0);
  const OKNOTE = 'Approved by admin', NONOTE = 'Rejected by admin';   // automatic notes, nothing to type
  const nameOf = u => u?.name || u?.fullName || u?.email || u?.phone || 'Unnamed user';

  function build(users, items) {
    const by = {}; items.forEach(a => (by[a.uid] ||= []).push(a));
    all = Object.entries(by).map(([uid, list]) => {
      const u = users.find(x => x.id === uid) || {}; list.sort((a, b) => secs(b) - secs(a));
      return { uid, name: nameOf(u), phone: String(u.phone || ''), email: String(u.email || ''), list };
    });
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
  // Every row shows the user's name too, so you always see who you are approving.
  const item = (a, name) => `<tr><td><b>${esc(name)}</b></td><td>${when(a.createdAt)}${isNew(a) ? ' <span class="tag">New</span>' : ''}</td><td>${esc(a.opportunityCode)}</td><td>${pts(a.rewardPoints)}</td><td>${stat(a.status)}</td>
    <td>${a.providerEventId ? 'Confirmed' : 'Not confirmed'}</td><td class="nw"><button data-ra="${esc(a.id)}" data-dec="approve">Approve</button> <button class="bad" data-ra="${esc(a.id)}" data-dec="reject">Reject</button></td></tr>`;
  const group = (g, open) => {
    const conf = g.items.filter(a => a.status === 'pending_review').length, unc = g.items.length - conf, id = esc(g.uid);
    return `<div class="card rvg"><div class="rvh"><div><div class="rvname">${esc(g.name)} <span class="badge">${g.items.length}</span> ${g.items.some(isNew) ? '<span class="tag">New</span>' : ''}</div>
      <div class="mute">${esc(g.phone)}${g.email ? ' ﹞ ' + esc(g.email) : ''}</div><div class="mute">${pts(sumPts(g.items))} waiting ﹞ oldest ${when(g.items.at(-1).createdAt)}</div></div>
      <div class="acts">${conf && unc ? `<button class="alt" data-all="${id}" data-scope="confirmed">Approve confirmed (${conf})</button>` : ''}<button class="gold" data-all="${id}" data-scope="all">Approve all (${g.items.length})</button></div></div>
      <details ${open ? 'open' : ''}><summary class="mute">Show activities</summary><div class="scroll"><table><tr><th>User</th><th>When</th><th>Code</th><th>Points</th><th>Status</th><th>Partner</th><th></th></tr>${g.items.map(a => item(a, g.name)).join('')}</table></div></details></div>`;
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
    const sorts = [['count', 'Most requests'], ['name', 'Name A每Z'], ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['points', 'Most points']];
    const names = [...new Set(all.map(g => g.name))].sort();
    return `<h1>Review</h1><div id="rvstats">${stats()}</div>
      <div class="rvbar"><input id="rvq" type="search" list="rvnames" placeholder="Search user by name or phone" value="${esc(S.q)}" aria-label="Search users" autocomplete="off">
      <datalist id="rvnames">${names.map(n => `<option value="${esc(n)}"></option>`).join('')}</datalist>
      <select id="rvs" aria-label="Sort">${sorts.map(([k, l]) => `<option value="${k}" ${S.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="chips" id="rvf">${chips()}</div><div id="rvlist">${list()}</div>
      <h2>Recently decided</h2><div class="scroll"><table><tr><th>User</th><th>When</th><th>Code</th><th>Points</th><th>Status</th></tr>${decided.slice(0, 50).join('') || '<tr><td colspan=5>None yet.</td></tr>'}</table></div>`;
  }
  function paint() {
    $('#rvstats') && ($('#rvstats').innerHTML = stats()); $('#rvf') && ($('#rvf').innerHTML = chips()); $('#rvlist') && ($('#rvlist').innerHTML = list());
    const bd = app.querySelector('.side a[href="#/admin/review"] .badge'), n = all.reduce((s, g) => s + g.list.length, 0);
    if (bd) n ? bd.textContent = n : bd.remove();
  }
  function drop(ids) { const s = new Set(ids); all.forEach(g => g.list = g.list.filter(a => !s.has(a.id))); all = all.filter(g => g.list.length); paint(); }
  async function single(b) {
    if (busy) return; const dec = b.dataset.dec; if (dec === 'reject' && !confirm('Reject this activity?')) return;
    busy = true; b.disabled = true;
    try { await call('adminReviewActivity')({ attemptId: b.dataset.ra, decision: dec, note: dec === 'approve' ? OKNOTE : NONOTE }); drop([b.dataset.ra]); }
    catch (x) { b.disabled = false; alert(err(x)); } finally { busy = false; }
  }
  async function bulk(b) {
    if (busy) return; const g = all.find(x => x.uid === b.dataset.all); if (!g) return;
    const items = g.list.filter(a => b.dataset.scope === 'all' || a.status === 'pending_review'), unc = items.filter(a => a.status !== 'pending_review').length;
    if (!items.length || !confirm(`Approve ${items.length} activities (${sumPts(items)} pts) for ${g.name} only?` + (unc ? `\n\n${unc} of them have no partner confirmation yet.` : ''))) return;
    busy = true; b.closest('.rvg').querySelectorAll('button').forEach(x => x.disabled = true); const done = [], fail = [];
    for (let i = 0; i < items.length; i++) {
      b.textContent = `Approving ${i + 1}/${items.length}＃`;
      try { await call('adminReviewActivity')({ attemptId: items[i].id, decision: 'approve', note: OKNOTE }); done.push(items[i].id); } catch (x) { fail.push(err(x)); }
    }
    busy = false; drop(done); if (fail.length) alert(`${done.length} approved, ${fail.length} failed:\n` + [...new Set(fail)].join('\n'));
  }
  function bind() {
    const L = $('#rvlist'); if (!L) return; let t;
    L.onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.ra) single(b); else if (b.dataset.all) bulk(b); };
    $('#rvq').oninput = e => { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value; $('#rvlist').innerHTML = list(); }, 150); };
    $('#rvs').onchange = e => { S.sort = e.target.value; $('#rvlist').innerHTML = list(); };
    $('#rvf').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; S.f = b.dataset.f; $('#rvf').innerHTML = chips(); $('#rvlist').innerHTML = list(); };
  }
  return { html, bind };
}

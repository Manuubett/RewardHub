// user-ui.js: Earn page (with progress bars and moving cards), Opportunity page and a redesigned Dashboard.
// Wired into app.js with createUserUI({...}). The browser only DISPLAYS timers; the server still enforces cooldowns.
export function createUserUI(c) {
  const { $, app, esc, pts, ptsVal, ptsKes, kes, note, err, call, rows, byDate, when, stat, availKes, MIN_PAY,
    RATE_NOTE, db, collection, query, where, getDoc, doc, getUser, getProfile, route } = c;

  // ---------- helpers ----------
  let timer = null;
  const stop = () => clearInterval(timer);
  const left = ms => { const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h}h ${m}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`; };
  const dur = x => (+x.cooldownMinutes || 30) * 60000;
  const pct = (until, d) => Math.min(100, Math.max(0, (1 - (until - Date.now()) / d) * 100));
  const barHtml = (until, d, hide) => `<div class="bar" role="progressbar" aria-label="Timer progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct(until, d))}" ${hide ? 'hidden' : ''}><i style="width:${pct(until, d).toFixed(1)}%"></i></div>`;

  // ---------- Daily goal and streak (display only; Nairobi days) ----------
  const DAILY_GOAL = 5, NAIROBI_MS = 3 * 3600e3;
  const dayKey = ms => new Date(ms + NAIROBI_MS).toISOString().slice(0, 10);
  function progress(attempts) {
    const ok = attempts.filter(x => ['approved', 'pending_review'].includes(x.status) && x.createdAt?.seconds && !ADULT_CODES.includes(x.opportunityCode));
    const days = new Set(ok.map(x => dayKey(x.createdAt.seconds * 1000)));
    const today = dayKey(Date.now());
    const todayN = ok.filter(x => dayKey(x.createdAt.seconds * 1000) === today).length;
    let streak = 0, t = Date.now();
    if (!days.has(dayKey(t))) t -= 864e5;            // today not done yet: streak is still alive from yesterday
    while (days.has(dayKey(t))) { streak++; t -= 864e5; }
    return { todayN, streak, doneToday: days.has(today) };
  }
  const ring = (n, goal) => { const C = 2 * Math.PI * 34, f = Math.min(1, n / goal);
    return `<svg class="ring" viewBox="0 0 80 80" role="img" aria-label="${Math.min(n, goal)} of ${goal} tasks today">
      <circle cx="40" cy="40" r="34" class="ring-bg"/><circle cx="40" cy="40" r="34" class="ring-fg" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - f)).toFixed(1)}" transform="rotate(-90 40 40)"/>
      <text x="40" y="46" text-anchor="middle" class="ring-t">${Math.min(n, goal)}/${goal}</text></svg>`; };

  // Updates every [data-until] label and its progress bar once per second. When an element marked data-live
  // reaches zero, onDone() is called (used to move cards back to "Available now").
  function countdowns(onDone) {
    stop(); const els = [...app.querySelectorAll('[data-until]')]; if (!els.length) return;
    const tick = () => {
      let done = false;
      els.forEach(el => {
        const until = +el.dataset.until, ms = until - Date.now(), d = +el.dataset.dur || 0;
        el.textContent = ms > 0 ? (el.dataset.label || 'Available again in ') + left(ms) : (el.dataset.ready || 'Available now');
        const b = d ? el.closest('.card,.cdrow')?.querySelector('.bar') : null;
        if (b) { const p = pct(until, d); b.hidden = ms <= 0; b.firstElementChild.style.width = p + '%'; b.setAttribute('aria-valuenow', Math.round(p)); }
        if (ms <= 0) { $('#go')?.removeAttribute('disabled'); if (el.dataset.live) { delete el.dataset.live; done = true; } }
      });
      if (done && onDone) { stop(); onDone(); }
    };
    tick(); timer = setInterval(tick, 1000);
  }

  // ---------- Task rule shown wherever a user can start a task ----------
  const WAIT_RULE = `<div class="rule" role="note"><b>Important: let the task load fully</b><ol>
    <li>After you tap <b>Start task</b>, stay on the sponsored page until it has <b>fully loaded</b>. Do not close it or go back early.</li>
    <li>Only then come back to SemaRewards to begin another task.</li>
    <li>If you leave before it has loaded, the partner may not record your activity and <b>your points will not be approved</b>.</li></ol></div>`;
  const ADULT_NOTICE = `<div class="rule adult" role="note"><b>Adult content notice (18+)</b>
    <p style="margin:.3rem 0 0">Sponsored tasks come from third-party partners, and <b>some may show adult or mature content, mostly in Tasks 15 to 20 (BTN015 to BTN020)</b>. If you are not interested in that kind of content, <b>skip Tasks 15 to 20</b> and choose another task. Only continue if you are 18 or older and comfortable with it. SemaRewards does not control partner content.</p></div>`;
  const ADULT_CODES = Array.from({ length: 6 }, (_, i) => 'BTN0' + (15 + i));   // Tasks 15 to 20 (BTN015 to BTN020) may show adult content
  const adultTag = code => ADULT_CODES.includes(code) ? ' <span class="tag warn">May contain adult content (18+)</span>' : '';
  const COMMUNITY_URL = 'https://chat.whatsapp.com/D95xOhXKYqk6j6r0PHK7Ik?s=cl&p=a&iam=2';
  const COMMUNITY = `<a class="card refcard" href="${esc(COMMUNITY_URL)}" target="_blank" rel="noopener noreferrer"><div><b>Join our WhatsApp community</b><div class="mute">Chat with other members and get updates from SemaRewards.</div></div><span class="btn gold">Join on WhatsApp</span></a>`;
  const TASK_OPENED = 'Task opened in a new tab. Wait until the page has fully loaded, then come back here to start another task. If you leave early, your points will not be approved.';

  // ---------- Earn ----------
  let E = { opps: [], passed: new Set(), until: {}, moved: null };

  // ---------- Visit-time check: the SERVER measures the time; this page only says "I'm back" ----------
  const GATE_ON = true, FREE_TASKS = 1;   // keep in sync with VISIT_GATE=on and VISIT_FREE_TASKS on the server
  const lockedIds = () => {
    if (!GATE_ON) return new Set();
    const ch = E.opps.filter(x => !ADULT_CODES.includes(x.code)), done = ch.filter(x => E.passed.has(x.id)).length;
    return new Set(ch.filter((x, i) => i >= FREE_TASKS + done).map(x => x.id));
  };
  const lockCard = x => `<div class="card opp locked"><div><span class="tag">${esc(x.code)}</span> <span class="mute">${esc(x.provider)}</span></div><b>${esc(x.title)}</b>
    <div class="mute">🔒 Locked. Pass a task you have unlocked to open this one.</div></div>`;
  const WAIT_BOX = `<div class="msg" role="status">⏱ Visit started. Stay on the partner page until it has loaded, then come back here.
    <p class="acts"><button id="vcheck" type="button" class="alt">I'm back: check my visit</button></p></div>`;
  const retryBox = t => `<div class="msg" role="status"><b>${esc(t)}</b><p class="acts"><button id="vretry" type="button">Try again</button></p></div>`;
  const say = h => { const el = $('#em') || $('#m'); if (el) el.innerHTML = h; else app.insertAdjacentHTML('afterbegin', h);
    $('#vretry')?.addEventListener('click', retryVisit); $('#vcheck')?.addEventListener('click', checkReturn); };
  const loadV = () => { try { return JSON.parse(sessionStorage.rh_visit || 'null'); } catch { return null; } };
  const showWaiting = () => say(note(TASK_OPENED) + WAIT_BOX);
  async function beginVisit(id, url) {
    try { await call('startVisit')({ opportunityId: id }); } catch (e) { console.error('startVisit', e); return; }
    sessionStorage.rh_visit = JSON.stringify({ id, url, t: Date.now() });
  }
  async function retryVisit() {
    const p = loadV(); if (!p) return;
    const w = window.open('about:blank', '_blank');
    try { await beginVisit(p.id, p.url); if (w) { w.opener = null; w.location.href = p.url; } showWaiting(); }
    catch (x) { w?.close(); say(note(err(x))); }
  }
  let checking = false;
  async function checkReturn() {
    const p = loadV(); if (!p || checking || Date.now() - p.t < 3000) return;   // ignore the tab flicker right after opening the link
    checking = true;
    try {
      const r = await call('completeVisit')({ opportunityId: p.id });
      if (r.result === 'none') { sessionStorage.removeItem('rh_visit'); return; }
      if (r.result === 'passed') {
        sessionStorage.removeItem('rh_visit');
        if (location.hash.startsWith('#/earn')) await route();   // repaint so the next task unlocks
        say(note('Time requirement met! You can continue.'));
      } else say(retryBox(r.result === 'too_fast' ? 'Too fast! Please try again.' : 'Time exceeded. Please try again, or contact Support for a review.'));
    } catch (x) { say(note(err(x))); } finally { checking = false; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkReturn(); });
  window.addEventListener('pageshow', checkReturn);

  const readyCard = x => `<div class="card opp" data-oid="${esc(x.id)}"><div><span class="tag">${esc(x.code)}</span>${adultTag(x.code)} <span class="mute">${esc(x.provider)}</span></div>
    <b>${esc(x.title)}</b><div class="big">${ptsVal(x.rewardPoints)}</div>
    <div class="mute">After partner confirmation and review · repeat every ${esc(x.cooldownMinutes)} min</div>
    <p class="acts"><button data-start="${esc(x.id)}">Start task</button><a class="btn alt" href="#/opportunity/${esc(x.id)}">Details</a></p></div>`;
  const coolCard = x => { const u = E.until[x.id], d = dur(x); return `<div class="card opp cool ${E.moved === x.id ? 'pop' : ''}">
    <div><span class="tag">${esc(x.code)}</span>${adultTag(x.code)} <span class="mute">${esc(x.provider)}</span></div><b>${esc(x.title)}</b>
    <div class="mute">${pts(x.rewardPoints)} · timer running</div>${barHtml(u, d)}
    <div class="mute" data-until="${u}" data-dur="${d}" data-live="1"></div>
    <p class="acts"><a class="btn alt" href="#/opportunity/${esc(x.id)}">Details</a></p></div>`; };
  const earnBox = () => {
    const now = Date.now(), isCool = x => (E.until[x.id] || 0) > now;
    const cool = E.opps.filter(isCool).sort((a, b) => E.until[a.id] - E.until[b.id]), lock = lockedIds(), ready = E.opps.filter(x => !isCool(x) && !lock.has(x.id)), locked = E.opps.filter(x => lock.has(x.id));
    return `<h2>Available now <span class="badge">${ready.length}</span></h2>` +
      (ready.length ? `<div class="grid">${ready.map(readyCard).join('')}</div>` : note(cool.length ? 'You have started everything that is available. The next one unlocks when its timer below finishes.' : 'No opportunities right now. Check back soon.')) +
      (cool.length ? `<h2>Waiting for timer <span class="badge">${cool.length}</span></h2><div class="grid">${cool.map(coolCard).join('')}</div>` : '') +
      (locked.length ? `<h2>Locked <span class="badge">${locked.length}</span></h2><div class="grid">${locked.map(lockCard).join('')}</div>` : '');
  };
  function paintEarn() { const b = $('#earnbox'); if (!b) return; b.innerHTML = earnBox(); E.moved = null; wireEarn(); countdowns(paintEarn); }
  function wireEarn() { app.querySelectorAll('[data-start]').forEach(b => b.onclick = () => startOpp(b.dataset.start, b)); }
  async function startOpp(id, btn) {
    if (btn.disabled) return; btn.disabled = true; const label = btn.textContent; btn.textContent = 'Starting…';
    const w = window.open('about:blank', '_blank');   // opened first so mobile pop-up blockers allow it
    const em = $('#em');
    try {
      const r = await call('startOpportunity')({ opportunityId: id });
      if (w) { w.opener = null; await beginVisit(id, r.url); w.location.href = r.url; showWaiting(); }
      else em.innerHTML = `<div class="msg"><a href="${esc(r.url)}" target="_blank" rel="noopener">Pop-up blocked: tap here to open your task</a></div>`;
      E.until[id] = r.cooldownUntilMs; E.moved = id;
      btn.closest('.card')?.classList.add('leave');          // fade the card out, then it reappears in "Waiting for timer"
      await new Promise(res => setTimeout(res, 240)); paintEarn();
    } catch (x) {
      w?.close(); btn.disabled = false; btn.textContent = label;
      if (x.data?.cooldownUntilMs) { E.until[id] = x.data.cooldownUntilMs; paintEarn(); }
      em.innerHTML = note(err(x));
    }
  }
  const earn = async () => {
    const user = getUser();
    const [opps, cds, camps, vis] = await Promise.all([rows(query(collection(db, 'opportunities'), where('active', '==', true))),
      rows(query(collection(db, 'cooldowns'), where('uid', '==', user.uid))), rows(query(collection(db, 'campaigns'), where('active', '==', true))),
      rows(query(collection(db, 'visits'), where('uid', '==', user.uid), where('passed', '==', true))).catch(() => [])]);
    opps.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    E = { opps, passed: new Set(vis.map(v => v.opportunityId)), until: Object.fromEntries(cds.map(x => [x.opportunityId, x.cooldownUntil?.toMillis?.() || 0])), moved: null };
    return `<h1>Opportunities</h1>${RATE_NOTE}${WAIT_RULE}${ADULT_NOTICE}<div id="em"></div><div id="earnbox">${earnBox()}</div>${COMMUNITY}` +
      (camps.length ? `<h2>Cash tasks (KES)</h2><div class="grid">${camps.map(x => `<div class="card"><b>${esc(x.title)}</b>
      <div class="big">${kes(x.reward)}</div><div class="mute">${x.type === 'cpc' ? 'Paid for a valid click' : 'Paid on completed action'}</div>
      <p><a class="btn" href="#/task/${x.id}">View details</a></p></div>`).join('')}</div>` : '');
  };
  const bindEarn = () => { wireEarn(); countdowns(paintEarn); };

  // ---------- Opportunity details ----------
  const opportunity = async id => {
    const user = getUser();
    const o = await getDoc(doc(db, 'opportunities', id)); if (!o.exists() || !o.data().active) return note('This opportunity is not available.');
    const x = o.data(), cd = await getDoc(doc(db, 'cooldowns', `${user.uid}_${id}`)), until = cd.exists() ? cd.data().cooldownUntil?.toMillis?.() || 0 : 0, d = dur(x);
    return `<h1>${esc(x.title)}</h1><div class="card"><span class="tag">${esc(x.code)}</span>${adultTag(x.code)} <span class="mute">${esc(x.provider)}</span>
    <div class="big">${ptsVal(x.rewardPoints)}</div><h2>Requirements</h2><p style="white-space:pre-wrap">${esc(x.requirements)}</p>
    <p class="mute">Points are added only after the partner confirms your activity and SemaAfrica approves it. Opening the link on its own does not earn points. You can repeat this every ${esc(x.cooldownMinutes)} minutes.</p>
    ${WAIT_RULE}${ADULT_NOTICE}
    ${barHtml(until, d, until <= Date.now())}<p class="mute" id="cd" data-until="${until}" data-dur="${d}"></p>
    <button id="go" ${until > Date.now() ? 'disabled' : ''}>Open sponsored task</button><div id="m"></div></div>`;
  };
  const bindOpportunity = id => {
    const b = $('#go'); if (!b) return; countdowns();
    const setUntil = ms => { $('#cd').dataset.until = ms; b.disabled = ms > Date.now(); countdowns(); };
    const msg = t => { $('#m').innerHTML = note(t); };
    b.onclick = async () => {
      b.disabled = true; const w = window.open('about:blank', '_blank');
      try {
        const r = await call('startOpportunity')({ opportunityId: id });
        if (w) { w.opener = null; await beginVisit(id, r.url); w.location.href = r.url; showWaiting(); }
        else $('#m').innerHTML = `<div class="msg"><a href="${esc(r.url)}" target="_blank" rel="noopener">Pop-up blocked: tap here to open your task</a></div>`;
        setUntil(r.cooldownUntilMs);
      } catch (x) { w?.close(); b.disabled = false; if (x.data?.cooldownUntilMs) setUntil(x.data.cooldownUntilMs); msg(err(x)); }
    };
  };

  // ---------- Refer & Earn ----------
  // Rule: the referrer gets REF_BONUS points when the friend reaches REF_TARGET approved points. The SERVER awards it; this page only displays it.
  const REF_BONUS = 50, REF_TARGET = 100;
  const mask = n => { const p = String(n || '').trim().split(/\s+/).filter(Boolean); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : (p[0] || 'Friend'); };
  const REF_TXT = { signed_up: 'Joined', qualified: 'Bonus paid', rejected: 'Not eligible' };
  const referrals = async () => {
    const user = getUser(), profile = getProfile();
    if (!profile) return note('Setting up your account…');
    let list = null;
    try { list = (await rows(query(collection(db, 'referrals'), where('referrerUid', '==', user.uid)))).sort(byDate); } catch (e) { console.error('referrals', e); }
    let code = profile.referralCode || '';
    if (!code) { try { code = (await call('getReferralCode')()).code || ''; } catch (e) { console.error('referral code', e); } }   // older accounts get their code here
    const link = code ? `${location.origin}${location.pathname}?ref=${encodeURIComponent(code)}` : '';
    const share = `Join SemaRewards, a side hustle for Kenyans. Earn points and redeem them to M-Pesa: ${link}`;
    const paid = list ? list.filter(r => r.status === 'qualified').length : 0, joined = list ? list.filter(r => r.status !== 'rejected').length : 0;
    return `<h1>Refer &amp; Earn</h1>
    <div class="hero-card"><div><div class="hc-label">Your reward</div><div class="hc-big">${pts(REF_BONUS)}</div>
      <div class="hc-sub">for every friend who reaches ${pts(REF_TARGET)} · ≈ ${ptsKes(REF_BONUS)}</div></div>
      <div class="hc-side">${code ? `<div class="hc-sub">Your invite link</div><input id="reflink" readonly value="${esc(link)}" aria-label="Your invite link">
        <div class="acts"><button class="gold" id="refcopy" type="button">Copy link</button><a class="btn gold" href="https://wa.me/?text=${encodeURIComponent(share)}" target="_blank" rel="noopener">Share on WhatsApp</a></div>`
        : '<div class="hc-sub">Your invite code is being created. Refresh in a moment.</div>'}</div></div>
    <div class="grid kpis">${[['Friends joined', joined], ['Bonuses earned', paid], ['Points earned', pts(paid * REF_BONUS)]].map(([l, v]) => `<div class="card kpi"><div class="mute">${l}</div><div class="kv">${v}</div></div>`).join('')}</div>
    <h2>How it works</h2><ol class="steps"><li><b>Share your link</b><br><span class="mute">Send it to friends in Kenya.</span></li>
      <li><b>They join and earn</b><br><span class="mute">They sign up with your link and complete activities.</span></li>
      <li><b>You get ${pts(REF_BONUS)}</b><br><span class="mute">When they reach ${pts(REF_TARGET)} approved points.</span></li></ol>
    <h2>Your friends</h2>${list === null ? note('Your referral list is not available right now. Try again later.') :
      `<div class="card feed">${list.map(r => { const fp = Math.min(REF_TARGET, +r.friendPoints || 0), pc = fp / REF_TARGET * 100;
        return `<div class="frow"><div style="flex:1;min-width:0"><b>${esc(mask(r.friendName))}</b> <span class="mute">${when(r.createdAt)}</span>
        ${r.status === 'signed_up' ? `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${REF_TARGET}" aria-valuenow="${fp}"><i style="width:${pc.toFixed(1)}%"></i></div><div class="mute">${fp} / ${REF_TARGET} pts</div>` : ''}</div>
        <div class="fr"><span class="${r.status === 'qualified' ? 'approved' : r.status === 'rejected' ? 'rejected' : 'pending'}">${esc(REF_TXT[r.status] || r.status)}</span>${r.status === 'qualified' ? `<br>+${pts(REF_BONUS)}` : ''}</div></div>`; }).join('') ||
        '<p class="mute" style="margin:0">No friends yet. Share your link to get started.</p>'}</div>`}
    <p class="mute">Only friends who sign up with your link count. The bonus is paid once per friend, after they reach ${pts(REF_TARGET)} approved points. Accounts using the same device or phone as yours are not eligible.</p>`;
  };
  const bindReferrals = () => {
    const b = $('#refcopy'); if (!b) return;
    b.onclick = async () => { const i = $('#reflink'); try { await navigator.clipboard.writeText(i.value); } catch { i.select(); document.execCommand?.('copy'); } b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = 'Copy link'; }, 2000); };
  };

  // ---------- Dashboard ----------
  const dashboard = async () => {
    const user = getUser(), profile = getProfile();
    if (!profile) return note('Setting up your account…');
    const [a, t, opps, cds] = await Promise.all([
      rows(query(collection(db, 'activityAttempts'), where('uid', '==', user.uid))), rows(query(collection(db, 'tasks'), where('uid', '==', user.uid))),
      rows(query(collection(db, 'opportunities'), where('active', '==', true))).catch(() => []),
      rows(query(collection(db, 'cooldowns'), where('uid', '==', user.uid))).catch(() => [])]);
    const n = s => a.filter(x => x.status === s).length, m = s => t.filter(x => x.status === s).length;
    const legacy = profile.totalEarned || profile.approved || profile.pending || t.length;
    const until = Object.fromEntries(cds.map(x => [x.opportunityId, x.cooldownUntil?.toMillis?.() || 0])), now = Date.now();
    const cool = opps.filter(o => (until[o.id] || 0) > now).sort((x, y) => until[x.id] - until[y.id]), ready = opps.length - cool.length;
    const h = new Date().getHours(), hi = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const avail = availKes(profile), can = avail >= MIN_PAY, pp = Math.min(100, avail / MIN_PAY * 100);
    const recent = [...a].sort(byDate).slice(0, 5);
    const P = progress(a), left5 = Math.max(0, DAILY_GOAL - P.todayN);
    const toPayPts = Math.max(0, (MIN_PAY - avail) * 10);   // 10 pts = KES 1 (same as PTS_PER_KES in app.js)
    const goalCard = `<div class="card goal">${ring(P.todayN, DAILY_GOAL)}
      <div><b>${left5 ? `${left5} more task${left5 > 1 ? 's' : ''} to hit today's goal` : "Today's goal complete 🎉"}</b>
      <div class="mute">${P.streak ? `🔥 ${P.streak}-day streak${P.doneToday ? '' : ' · finish a task today to keep it'}` : 'Finish a task today to start a streak'}</div>
      ${can ? '' : `<div class="mute">${pts(toPayPts)} to your first payment request</div>`}
      <div class="mute" style="font-size:.8rem">Only partner-confirmed tasks count. Tasks 15 to 20 are not part of the goal.</div></div></div>`;
    const kp = (l, v, sub) => `<div class="card kpi"><div class="mute">${l}</div><div class="kv">${v}</div>${sub ? `<div class="mute">${sub}</div>` : ''}</div>`;
    return `<div class="dash-top"><div><div class="mute">${hi}</div><h1 style="margin:.1em 0">${esc((profile.name || 'there').split(' ')[0])}</h1></div>
      <a class="btn gold" href="#/earn">Find an opportunity</a></div>
    ${profile.status !== 'active' ? note('Your account is under review. Contact Support.') : ''}
    <div class="hero-card"><div><div class="hc-label">Approved balance</div><div class="hc-big">${pts(profile.approvedPoints)}</div><div class="hc-sub">≈ ${ptsKes(profile.approvedPoints)} · ${RATE_NOTE.match(/<b>(.*?)<\/b>/)?.[1] || ''}</div></div>
      <div class="hc-side">${can ? `<div class="hc-sub">${kes(avail)} ready to withdraw</div><a class="btn gold" href="#/withdraw">Request payment</a>`
        : `<div class="hc-sub">${kes(avail)} of ${kes(MIN_PAY)} needed to request payment</div><div class="bar on-dark" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pp)}"><i style="width:${pp.toFixed(1)}%"></i></div>`}</div></div>
    ${goalCard}
    <div class="grid kpis">${kp('Pending points', pts(profile.pendingPoints), '≈ ' + ptsKes(profile.pendingPoints))}${kp('Lifetime earned', pts(profile.lifetimePointsEarned), '≈ ' + ptsKes(profile.lifetimePointsEarned))}
      ${kp('Approved activities', n('approved'))}${kp('Awaiting review', n('pending_review'))}${kp('Rejected', n('rejected') + n('reversed'))}</div>
    <a class="card refcard" href="#/referrals"><div><b>Invite friends, earn ${pts(REF_BONUS)}</b><div class="mute">For every friend who reaches ${pts(REF_TARGET)} approved points</div></div><span class="btn gold">Refer &amp; Earn</span></a>
    ${COMMUNITY}
    <h2>Activity timers</h2><div class="card"><div class="tline"><span><b>${ready}</b> ready now · <b>${cool.length}</b> running</span><a href="#/earn">Go to opportunities →</a></div>
      ${cool.map(x => { const d = dur(x); return `<div class="cdrow"><div class="cdh"><span><span class="tag">${esc(x.code)}</span> ${esc(x.title)}</span>
        <span class="mute" data-until="${until[x.id]}" data-dur="${d}" data-live="1" data-label="Ready in "></span></div>${barHtml(until[x.id], d)}</div>`; }).join('') || '<p class="mute" style="margin:.8rem 0 0">No timers running. Start an opportunity to begin earning.</p>'}</div>
    <h2>Recent activity <a href="#/history" class="mute" style="float:right;font-size:.9rem;font-weight:600">View all</a></h2>
    <div class="card feed">${recent.map(x => `<div class="frow"><div><b>${esc(x.opportunityCode)}</b> · ${esc(x.opportunityTitle)}<div class="mute">${when(x.createdAt)}</div></div>
      <div class="fr">${pts(x.rewardPoints)}<br>${stat(x.status)}</div></div>`).join('') || '<p class="mute" style="margin:0">No activity yet. Start your first opportunity.</p>'}</div>
    ${legacy ? `<h2>Cash balance (earlier tasks)</h2><div class="grid"><div class="card"><div class="mute">Available</div><div class="big">${kes(profile.approved)}</div></div>
    <div class="card"><div class="mute">Pending partner confirmation</div><div class="big">${kes(profile.pending)}</div></div>
    <div class="card"><div class="mute">Total earned</div><div class="big">${kes(profile.totalEarned)}</div></div>
    <div class="card"><div class="mute">Tasks approved / pending / reversed</div><div class="big">${m('approved')} / ${m('pending')} / ${m('reversed')}</div></div></div>` : ''}`;
  };
  const bindDashboard = () => countdowns(route);   // when a timer ends, reload the dashboard so "ready now" updates

  return { earn, bindEarn, opportunity, bindOpportunity, dashboard, bindDashboard, referrals, bindReferrals, stop, countdowns, WAIT_RULE, ADULT_NOTICE, COMMUNITY };
}

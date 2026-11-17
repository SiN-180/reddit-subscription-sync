// ==UserScript==
// @name         Reddit Subscription & Saved Sync
// @namespace    local.reddit-sync
// @version      0.2.0
// @description  Compare and sync subscriptions and saved posts between your own Reddit accounts, with a preview first. Runs inside your logged-in session: no passwords, cookies or API keys.
// @license      MIT
// @homepageURL  https://github.com/SiN-180/reddit-subscription-sync
// @downloadURL  https://github.com/SiN-180/reddit-subscription-sync/raw/main/reddit-subscription-sync.user.js
// @updateURL    https://github.com/SiN-180/reddit-subscription-sync/raw/main/reddit-subscription-sync.user.js
// @match        https://old.reddit.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  var VERSION = 1;
  var STORE_KEY = 'rss_snapshots_v1';
  var TEST = typeof globalThis.__RSS_TEST__ !== 'undefined';

  // ---------------------------------------------------------------- helpers
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var lc = function (s) { return String(s || '').toLowerCase(); };
  var SUB_RE = /^[A-Za-z0-9_]{1,30}$/;
  var FULLNAME_RE = /^t[135]_[a-z0-9]{1,12}$/;

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString('en-GB'); } catch (e) { return String(iso); }
  }

  // ---------------------------------------------------------------- storage
  // localStorage on old.reddit.com is shared by every account you log into in
  // this browser, so a snapshot taken on one account is visible on the next.
  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveStore(obj) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  // Never trust a file: keep only well-formed entries.
  function sanitiseSnapshot(raw) {
    if (!raw || typeof raw !== 'object' || raw.tool !== 'reddit-subscription-sync') {
      throw new Error('That file is not a snapshot made by this script.');
    }
    if (!Array.isArray(raw.subs) || !Array.isArray(raw.saved)) throw new Error('Snapshot is missing its lists.');
    var username = String(raw.username || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    if (!username) throw new Error('Snapshot has no username.');
    var subs = [];
    raw.subs.forEach(function (s) {
      if (s && SUB_RE.test(String(s.name))) {
        subs.push({
          name: String(s.name),
          fullname: FULLNAME_RE.test(String(s.fullname || '')) ? String(s.fullname) : '',
          nsfw: !!s.nsfw, type: String(s.type || '').slice(0, 20), subscribers: Number(s.subscribers) || 0
        });
      }
    });
    var saved = [];
    raw.saved.forEach(function (s) {
      if (s && FULLNAME_RE.test(String(s.fullname))) {
        saved.push({
          fullname: String(s.fullname), kind: String(s.kind || '').slice(0, 3),
          title: String(s.title || '').slice(0, 300), subreddit: String(s.subreddit || '').slice(0, 40),
          author: String(s.author || '').slice(0, 40), permalink: String(s.permalink || '').slice(0, 400),
          snippet: String(s.snippet || '').slice(0, 200)
        });
      }
    });
    return { tool: 'reddit-subscription-sync', version: VERSION, username: username,
             takenAt: String(raw.takenAt || new Date().toISOString()), subs: subs, saved: saved };
  }

  // ---------------------------------------------------------------- Reddit access
  var pace = { last: 0, delay: 1100, onWait: null, shouldStop: null };

  // Waits out a Reddit rate limit, calling onWait(secondsLeft, isFirstCall) every second.
  // If Stop is pressed meanwhile it throws, so the run ends without hammering Reddit.
  async function rateWait(secs) {
    var end = Date.now() + secs * 1000;
    if (pace.onWait) pace.onWait(Math.ceil(secs), true);
    while (Date.now() < end) {
      if (pace.shouldStop && pace.shouldStop()) { var err = new Error('Stopped while waiting'); err.stopped = true; throw err; }
      if (pace.onWait) pace.onWait(Math.ceil((end - Date.now()) / 1000), false);
      await sleep(Math.max(0, Math.min(1000, end - Date.now())));
    }
  }

  async function politeFetch(url, opts, tries) {
    tries = tries || 4;
    for (var i = 0; i < tries; i++) {
      var wait = pace.last + pace.delay - Date.now();
      if (wait > 0) await sleep(wait);
      pace.last = Date.now();
      var res;
      try { res = await fetch(url, opts); }
      catch (e) { if (i === tries - 1) throw e; await sleep(2000 * (i + 1)); continue; }
      var remaining = parseFloat(res.headers.get('x-ratelimit-remaining'));
      var reset = parseFloat(res.headers.get('x-ratelimit-reset'));
      if (res.status === 429) {
        var ra = parseFloat(res.headers.get('retry-after'));
        var secs = (ra > 0 ? ra : (reset > 0 ? reset : 30)) + 1;
        await rateWait(secs);
        continue;
      }
      if (!isNaN(remaining) && remaining <= 2 && reset > 0) {
        await rateWait(reset + 1);
      }
      return res;
    }
    throw new Error('Reddit kept rate limiting the requests. Wait a few minutes and run Compare again.');
  }

  async function getSession() {
    var res = await fetch('/api/me.json', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Could not read your session (HTTP ' + res.status + ').');
    var j = await res.json();
    var d = j && j.data;
    if (!d || !d.name) throw new Error('You are not logged in. Log in on old.reddit.com first.');
    var modhash = d.modhash || '';
    if (!modhash && typeof window !== 'undefined' && window.r && window.r.config) modhash = window.r.config.modhash || '';
    if (!modhash) throw new Error('Reddit did not give a session token (modhash). Reload the page and try again.');
    return { name: d.name, modhash: modhash };
  }

  async function fetchListing(path, onPage) {
    var out = [], after = null, guard = 0;
    do {
      var url = path + (path.indexOf('?') >= 0 ? '&' : '?') + 'limit=100&raw_json=1' +
                (after ? '&after=' + encodeURIComponent(after) : '');
      var res = await politeFetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('Reddit returned HTTP ' + res.status + ' for ' + path);
      var j = await res.json();
      var kids = (j && j.data && j.data.children) || [];
      kids.forEach(function (k) { out.push(k); });
      after = (j && j.data && j.data.after) || null;
      if (onPage) onPage(out.length);
    } while (after && ++guard < 60);
    return out;
  }

  async function readSubs(onPage) {
    var kids = await fetchListing('/subreddits/mine/subscriber.json', onPage);
    var seen = {}, subs = [];
    kids.forEach(function (k) {
      var d = k.data || {};
      if (!d.display_name) return;
      var key = lc(d.display_name);
      if (seen[key]) return;
      seen[key] = true;
      subs.push({ name: d.display_name, fullname: d.name || '', nsfw: !!d.over18,
                  type: d.subreddit_type || '', subscribers: d.subscribers || 0 });
    });
    subs.sort(function (a, b) { return lc(a.name).localeCompare(lc(b.name)); });
    return subs;
  }

  // Newest-saved first, as Reddit returns it. Reddit only exposes about the latest 1000.
  async function readSaved(username, onPage) {
    var kids = await fetchListing('/user/' + encodeURIComponent(username) + '/saved.json', onPage);
    var seen = {}, saved = [];
    kids.forEach(function (k) {
      var d = k.data || {};
      var fullname = d.name || ((k.kind || '') + '_' + (d.id || ''));
      if (!FULLNAME_RE.test(fullname) || seen[fullname]) return;
      seen[fullname] = true;
      var isComment = k.kind === 't1';
      saved.push({
        fullname: fullname, kind: k.kind || '',
        title: isComment ? (d.link_title || '') : (d.title || ''),
        subreddit: d.subreddit || '', author: d.author || '', permalink: d.permalink || '',
        snippet: isComment ? String(d.body || '').slice(0, 140) : ''
      });
    });
    return saved;
  }

  // ---------------------------------------------------------------- diff
  function diffSubs(snapSubs, curSubs) {
    var cur = {}, snap = {};
    curSubs.forEach(function (s) { cur[lc(s.name)] = s; });
    snapSubs.forEach(function (s) { snap[lc(s.name)] = s; });
    return {
      toAdd: snapSubs.filter(function (s) { return !cur[lc(s.name)]; }),
      both: snapSubs.filter(function (s) { return cur[lc(s.name)]; }),
      extras: curSubs.filter(function (s) { return !snap[lc(s.name)]; })
    };
  }
  function diffSaved(snapSaved, curSaved) {
    var cur = {}, snap = {};
    curSaved.forEach(function (s) { cur[s.fullname] = s; });
    snapSaved.forEach(function (s) { snap[s.fullname] = s; });
    return {
      toSave: snapSaved.filter(function (s) { return !cur[s.fullname]; }),
      both: snapSaved.filter(function (s) { return cur[s.fullname]; }),
      extras: curSaved.filter(function (s) { return !snap[s.fullname]; })
    };
  }

  // ---------------------------------------------------------------- apply
  async function doAction(session, a) {
    var body = new URLSearchParams();
    var url;
    if (a.type === 'save') {
      url = '/api/save';
      body.set('id', a.fullname);
    } else {
      url = '/api/subscribe';
      body.set('action', a.type); // 'sub' or 'unsub'
      if (a.fullname) body.set('sr', a.fullname); else body.set('sr_name', a.name);
    }
    body.set('uh', session.modhash);
    body.set('api_type', 'json');
    var res = await politeFetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Modhash': session.modhash, Accept: 'application/json' },
      body: body.toString()
    });
    if (!res.ok) {
      var why = { 403: 'not allowed (private, banned or quarantined?)', 404: 'not found (deleted?)' }[res.status] || '';
      return { ok: false, error: 'HTTP ' + res.status + (why ? ' - ' + why : '') };
    }
    var text = await res.text();
    try {
      var j = JSON.parse(text);
      var errs = j && j.json && j.json.errors;
      if (errs && errs.length) {
        return { ok: false, error: errs.map(function (e) { return Array.isArray(e) ? e.slice(0, 2).join(' ') : String(e); }).join('; ') };
      }
    } catch (e) { /* empty or non-JSON success body */ }
    return { ok: true };
  }

  async function runActions(session, actions, hooks) {
    hooks = hooks || {};
    var out = { total: actions.length, done: 0, ok: 0, failed: [], stopped: false };
    for (var i = 0; i < actions.length; i++) {
      if (hooks.shouldStop && hooks.shouldStop()) { out.stopped = true; break; }
      var a = actions[i];
      var r;
      try { r = await doAction(session, a); }
      catch (e) {
        if (e && e.stopped) { out.stopped = true; break; }
        r = { ok: false, error: e.message || String(e) };
      }
      out.done++;
      if (r.ok) out.ok++; else out.failed.push({ label: a.label, error: r.error });
      if (hooks.onProgress) hooks.onProgress(out, a, r);
    }
    return out;
  }

  if (TEST) {
    globalThis.__RSS_CORE__ = { pace: pace, getSession: getSession, readSubs: readSubs, readSaved: readSaved,
      diffSubs: diffSubs, diffSaved: diffSaved, runActions: runActions, sanitiseSnapshot: sanitiseSnapshot,
      loadStore: loadStore, saveStore: saveStore };
    return;
  }
  if (typeof document === 'undefined' || window.top !== window.self) return;

  // ---------------------------------------------------------------- UI
  var state = { session: null, snap: null, cur: null, diff: null,
                selSub: {}, selUnsub: {}, selSave: {}, running: false, stop: false };
  var ui = {};

  function el(tag, attrs) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === false || v == null) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var kids = [].concat(arguments[i]);
      for (var j = 0; j < kids.length; j++) {
        var kid = kids[j];
        if (kid == null || kid === false) continue;
        e.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
      }
    }
    return e;
  }

  function injectStyles() {
    var css = [
      '.rss-fab{position:fixed;right:12px;bottom:12px;z-index:2147483000;background:#2a4d8f;color:#fff;border:2px solid #fff;border-radius:22px;padding:10px 16px;font:600 14px/1.2 system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)}',
      '.rss-panel{position:fixed;right:8px;bottom:60px;z-index:2147483000;width:min(620px,calc(100vw - 16px));max-height:calc(100vh - 76px);overflow:auto;background:#1b1f27;color:#f2f4f8;border:1px solid #6b7a8d;border-radius:10px;padding:0;font:14px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5)}',
      '.rss-sticky{position:sticky;top:0;z-index:5;background:#1b1f27;padding:12px 14px 8px;border-bottom:1px solid #3d4756}',
      '.rss-body{padding:2px 14px 14px}',
      '.rss-prog{width:100%;height:16px;margin:4px 0;accent-color:#F6A800}',
      '.rss-prog[hidden]{display:none}',
      '.rss-panel[hidden]{display:none}',
      '.rss-panel h2{font-size:17px;margin:0;color:#fff}',
      '.rss-panel h3{font-size:15px;margin:0 0 6px;color:#fff}',
      '.rss-panel p{margin:4px 0 8px;color:#d6dbe4}',
      '.rss-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}',
      '.rss-card{background:#252b36;border:1px solid #3d4756;border-radius:8px;padding:10px;margin:8px 0}',
      '.rss-btn{background:#3b6fd4;color:#fff;border:1px solid #8fb0f0;border-radius:6px;padding:8px 12px;min-height:36px;font:600 13px system-ui,sans-serif;cursor:pointer;margin:2px 4px 2px 0}',
      '.rss-btn.rss-alt{background:#323a48;border-color:#6b7a8d}',
      '.rss-btn.rss-warn{background:#b8441f;border-color:#f0a58c}',
      '.rss-btn[disabled]{opacity:.5;cursor:not-allowed}',
      '.rss-panel select,.rss-panel input[type=search]{background:#10141a;color:#fff;border:1px solid #6b7a8d;border-radius:6px;padding:7px;min-height:36px;font:14px system-ui,sans-serif;max-width:100%}',
      '.rss-status{background:#10141a;border-left:4px solid #F6A800;padding:6px 8px;margin:6px 0;border-radius:4px}',
      '.rss-row{display:flex;gap:8px;align-items:flex-start;padding:5px 2px;border-bottom:1px solid #323a48}',
      '.rss-row[hidden]{display:none}',
      '.rss-row input{margin-top:3px;width:18px;height:18px;flex:none}',
      '.rss-row a{color:#9ec1ff}',
      '.rss-sub{color:#aab4c3;font-size:12px}',
      '.rss-group{margin:6px 0}',
      '.rss-group>summary{cursor:pointer;font-weight:600;padding:6px 0}',
      '.rss-log{max-height:180px;overflow:auto;background:#10141a;border-radius:6px;padding:6px 8px;font:12px/1.4 ui-monospace,Consolas,monospace;white-space:pre-wrap}',
      '.rss-err{color:#ffb4a0}.rss-good{color:#9ee6b0}',
      '.rss-list{max-height:260px;overflow:auto}'
    ].join('\n');
    document.head.appendChild(el('style', { text: css }));
  }

  function setStatus(msg) { ui.status.textContent = msg; }
  function log(msg, cls) {
    var line = el('div', { class: cls || '', text: msg });
    ui.log.appendChild(line);
    while (ui.log.childNodes.length > 400) ui.log.removeChild(ui.log.firstChild);
    ui.log.scrollTop = ui.log.scrollHeight;
  }
  function downloadJSON(filename, obj) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }
  function stamp() { return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'); }
  function busy(on) {
    state.running = on;
    [].forEach.call(ui.panel.querySelectorAll('button[data-lock]'), function (b) { b.disabled = on; });
    ui.stopBtn.hidden = !on;
    if (!on) { ui.prog.hidden = true; ui.fab.textContent = 'Sub sync'; }
  }
  function showProgress(done, total) {
    ui.prog.hidden = false;
    ui.prog.max = total; ui.prog.value = done;
    ui.fab.textContent = 'Sub sync ' + done + '/' + total;
  }

  function buildUI() {
    injectStyles();
    ui.fab = el('button', { class: 'rss-fab', type: 'button', 'aria-expanded': 'false', text: 'Sub sync', onclick: toggle });
    ui.status = el('div', { class: 'rss-status', role: 'status', 'aria-live': 'polite', text: 'Ready.' });
    ui.snapList = el('div');
    ui.select = el('select', { 'aria-label': 'Snapshot to compare with' });
    ui.preview = el('div');
    ui.log = el('div', { class: 'rss-log', 'aria-label': 'Activity log' });
    ui.stopBtn = el('button', { class: 'rss-btn rss-warn', type: 'button', hidden: true, text: 'Stop',
                                onclick: function () { state.stop = true; setStatus('Stopping after the current action...'); } });
    ui.file = el('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: onImportFile });

    ui.prog = el('progress', { class: 'rss-prog', max: '100', value: '0', hidden: true, 'aria-label': 'Progress' });

    ui.panel = el('section', { class: 'rss-panel', hidden: true, role: 'dialog', 'aria-label': 'Reddit subscription and saved sync' },
      el('div', { class: 'rss-sticky' },
        el('div', { class: 'rss-head' }, el('h2', { text: 'Subscription & saved sync' }),
           el('button', { class: 'rss-btn rss-alt', type: 'button', text: 'Close', onclick: toggle })),
        ui.status, ui.prog, ui.stopBtn),
      el('div', { class: 'rss-body' },
      el('div', { class: 'rss-card' },
        el('h3', { text: '1. Snapshot an account' }),
        el('p', { text: 'Log in to the account you want to copy FROM. Press Snapshot to record its subscriptions and saved items. Do this for each account you care about (including old ones whose extra subreddits you want to keep).' }),
        el('button', { class: 'rss-btn', type: 'button', 'data-lock': '1', text: 'Snapshot this account', onclick: onSnapshot }),
        el('button', { class: 'rss-btn rss-alt', type: 'button', 'data-lock': '1', text: 'Import snapshot file', onclick: function () { ui.file.click(); } }),
        ui.file, ui.snapList),
      el('div', { class: 'rss-card' },
        el('h3', { text: '2. Compare and sync' }),
        el('p', { text: 'Log in to the account you want to UPDATE, pick the snapshot to copy from, then press Compare. Nothing changes until you press Apply.' }),
        ui.select,
        el('button', { class: 'rss-btn', type: 'button', 'data-lock': '1', text: 'Compare', onclick: onCompare })),
      ui.preview,
      el('h3', { text: 'Activity' }), ui.log));

    document.body.appendChild(ui.fab);
    document.body.appendChild(ui.panel);
    renderSnapshots();
  }

  function toggle() {
    var open = ui.panel.hidden;
    ui.panel.hidden = !open;
    ui.fab.setAttribute('aria-expanded', String(open));
    if (open) {
      getSession().then(function (s) { state.session = s; setStatus('Logged in as u/' + s.name + '.'); })
        .catch(function (e) { setStatus(e.message); });
    }
  }

  function renderSnapshots() {
    var store = loadStore();
    var keys = Object.keys(store).sort();
    ui.snapList.textContent = '';
    ui.select.textContent = '';
    if (!keys.length) {
      ui.snapList.appendChild(el('p', { class: 'rss-sub', text: 'No snapshots stored yet.' }));
      ui.select.appendChild(el('option', { value: '', text: '(no snapshots)' }));
      return;
    }
    keys.forEach(function (k) {
      var s = store[k];
      ui.snapList.appendChild(el('div', { class: 'rss-row' },
        el('div', { style: 'flex:1' },
          el('strong', { text: 'u/' + s.username }),
          el('div', { class: 'rss-sub', text: s.subs.length + ' subreddits, ' + s.saved.length + ' saved items, taken ' + fmtDate(s.takenAt) })),
        el('button', { class: 'rss-btn rss-alt', type: 'button', text: 'Download',
                       onclick: function () { downloadJSON('reddit-snapshot-' + s.username + '-' + stamp() + '.json', s); } }),
        el('button', { class: 'rss-btn rss-alt', type: 'button', text: 'Delete', 'data-lock': '1',
                       onclick: function () {
                         if (!confirm('Delete the stored snapshot of u/' + s.username + '? (This does not touch Reddit.)')) return;
                         var st = loadStore(); delete st[k]; saveStore(st); renderSnapshots();
                       } })));
      ui.select.appendChild(el('option', { value: k, text: 'u/' + s.username + ' (' + s.subs.length + ' subs, ' + s.saved.length + ' saved, ' + fmtDate(s.takenAt) + ')' }));
    });
  }

  function progressSetter(prefix) {
    return function (n) { setStatus(prefix + ' ' + n + ' items read...'); };
  }

  async function onSnapshot() {
    if (state.running) return;
    busy(true); state.stop = false;
    try {
      var s = await getSession(); state.session = s;
      setStatus('Reading subscriptions for u/' + s.name + '...');
      var subs = await readSubs(progressSetter('Subscriptions:'));
      setStatus('Reading saved items for u/' + s.name + '...');
      var saved = await readSaved(s.name, progressSetter('Saved:'));
      var snap = { tool: 'reddit-subscription-sync', version: VERSION, username: s.name,
                   takenAt: new Date().toISOString(), subs: subs, saved: saved };
      var store = loadStore(); store[lc(s.name)] = snap;
      if (!saveStore(store)) { log('Could not store the snapshot in the browser. Downloading it as a file instead.', 'rss-err'); }
      downloadJSON('reddit-snapshot-' + s.name + '-' + stamp() + '.json', snap);
      renderSnapshots();
      setStatus('Snapshot of u/' + s.name + ' saved: ' + subs.length + ' subreddits, ' + saved.length + ' saved items.');
      log('Snapshot of u/' + s.name + ': ' + subs.length + ' subs, ' + saved.length + ' saved.', 'rss-good');
      if (saved.length >= 990) log('Reddit only shows your latest ~1000 saved items, so older ones cannot be copied.', 'rss-err');
    } catch (e) { setStatus('Problem: ' + e.message); log(e.message, 'rss-err'); }
    busy(false);
  }

  function onImportFile() {
    var f = ui.file.files && ui.file.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var snap = sanitiseSnapshot(JSON.parse(String(reader.result)));
        var store = loadStore(); store[lc(snap.username)] = snap; saveStore(store);
        renderSnapshots();
        setStatus('Imported snapshot of u/' + snap.username + '.');
      } catch (e) { setStatus('Import failed: ' + e.message); log('Import failed: ' + e.message, 'rss-err'); }
      ui.file.value = '';
    };
    reader.readAsText(f);
  }

  async function onCompare() {
    if (state.running) return;
    var store = loadStore();
    var snap = store[ui.select.value];
    if (!snap) { setStatus('Pick a snapshot first (take or import one in step 1).'); return; }
    busy(true); state.stop = false;
    try {
      var s = await getSession(); state.session = s;
      setStatus('Reading the live lists for u/' + s.name + '...');
      var subs = await readSubs(progressSetter('Subscriptions:'));
      var saved = await readSaved(s.name, progressSetter('Saved:'));
      state.snap = snap; state.cur = { session: s, subs: subs, saved: saved };
      state.diff = { subs: diffSubs(snap.subs, subs), saved: diffSaved(snap.saved, saved) };
      state.selSub = {}; state.selUnsub = {}; state.selSave = {};
      state.diff.subs.toAdd.forEach(function (x) { state.selSub[lc(x.name)] = true; });
      state.diff.saved.toSave.forEach(function (x) { state.selSave[x.fullname] = true; });
      renderPreview();
      setStatus('Compared u/' + snap.username + ' (snapshot) with u/' + s.name + ' (live). Review below, then press Apply.');
    } catch (e) { setStatus('Problem: ' + e.message); log(e.message, 'rss-err'); }
    busy(false);
  }

  function countTrue(o) { return Object.keys(o).filter(function (k) { return o[k]; }).length; }

  function updateApplyLabel() {
    if (!ui.applyBtn) return;
    ui.applyBtn.textContent = 'Apply: subscribe ' + countTrue(state.selSub) + ', unsubscribe ' +
      countTrue(state.selUnsub) + ', save ' + countTrue(state.selSave);
  }

  function rowText(parts) { return lc(parts.join(' ')); }

  function checkRow(id, selMap, labelEl, subText, searchText) {
    var cb = el('input', { type: 'checkbox', 'aria-label': 'Select ' + id });
    cb.checked = !!selMap[id];
    cb.addEventListener('change', function () { selMap[id] = cb.checked; updateApplyLabel(); });
    var row = el('div', { class: 'rss-row', 'data-search': searchText }, cb,
      el('div', null, labelEl, subText ? el('div', { class: 'rss-sub', text: subText }) : null));
    row._cb = cb;
    return row;
  }
  function infoRow(labelEl, subText, searchText) {
    return el('div', { class: 'rss-row', 'data-search': searchText }, el('div', null, labelEl, subText ? el('div', { class: 'rss-sub', text: subText }) : null));
  }

  function group(title, rows, selectable, open) {
    var d = el('details', { class: 'rss-group' });
    if (open) d.setAttribute('open', '');
    d.appendChild(el('summary', { text: title + ' (' + rows.length + ')' }));
    if (!rows.length) { d.appendChild(el('p', { class: 'rss-sub', text: 'Nothing here.' })); return d; }
    if (selectable) {
      var setAll = function (v) {
        rows.forEach(function (r) { if (!r.hidden && r._cb) { r._cb.checked = v; r._cb.dispatchEvent(new Event('change')); } });
      };
      d.appendChild(el('div', null,
        el('button', { class: 'rss-btn rss-alt', type: 'button', text: 'Tick all shown', onclick: function () { setAll(true); } }),
        el('button', { class: 'rss-btn rss-alt', type: 'button', text: 'Untick all shown', onclick: function () { setAll(false); } })));
    }
    d.appendChild(el('div', { class: 'rss-list' }, rows));
    return d;
  }

  function subLink(name) {
    return el('a', { href: 'https://old.reddit.com/r/' + name, target: '_blank', rel: 'noopener noreferrer', text: 'r/' + name });
  }
  function itemLink(it) {
    var href = it.permalink && it.permalink.charAt(0) === '/' ? 'https://old.reddit.com' + it.permalink : null;
    var label = (it.kind === 't1' ? 'Comment on: ' : '') + (it.title || it.fullname);
    return href ? el('a', { href: href, target: '_blank', rel: 'noopener noreferrer', text: label }) : el('span', { text: label });
  }
  function subMeta(s) {
    var bits = [];
    if (s.nsfw) bits.push('18+');
    if (s.type && s.type !== 'public') bits.push(s.type);
    return bits.join(', ');
  }
  function savedMeta(it) {
    return ['r/' + it.subreddit, it.author ? 'by u/' + it.author : '', it.snippet].filter(Boolean).join(' - ');
  }

  function renderPreview() {
    var d = state.diff, snap = state.snap, cur = state.cur;
    ui.preview.textContent = '';
    ui.applyBtn = el('button', { class: 'rss-btn', type: 'button', 'data-lock': '1', onclick: onApply });

    var filter = el('input', { type: 'search', placeholder: 'Filter lists...', 'aria-label': 'Filter lists',
      oninput: function () {
        var q = lc(filter.value.trim());
        [].forEach.call(ui.preview.querySelectorAll('.rss-row[data-search]'), function (r) {
          r.hidden = q && r.getAttribute('data-search').indexOf(q) < 0;
        });
      } });

    var addRows = d.subs.toAdd.map(function (s) {
      return checkRow(lc(s.name), state.selSub, subLink(s.name), subMeta(s), rowText([s.name]));
    });
    var extraRows = d.subs.extras.map(function (s) {
      return checkRow(lc(s.name), state.selUnsub, subLink(s.name), subMeta(s), rowText([s.name]));
    });
    var bothRows = d.subs.both.map(function (s) { return infoRow(subLink(s.name), subMeta(s), rowText([s.name])); });

    var saveRows = d.saved.toSave.map(function (it) {
      return checkRow(it.fullname, state.selSave, itemLink(it), savedMeta(it), rowText([it.title, it.subreddit, it.snippet]));
    });
    var savedExtra = d.saved.extras.map(function (it) { return infoRow(itemLink(it), savedMeta(it), rowText([it.title, it.subreddit, it.snippet])); });
    var savedBoth = d.saved.both.map(function (it) { return infoRow(itemLink(it), savedMeta(it), rowText([it.title, it.subreddit, it.snippet])); });

    ui.preview.appendChild(el('div', { class: 'rss-card' },
      el('h3', { text: 'Preview' }),
      el('p', { text: 'Snapshot of u/' + snap.username + ' (' + fmtDate(snap.takenAt) + ') compared with the live account u/' + cur.session.name + '.' }),
      filter,
      el('h3', { text: 'Subscriptions' }),
      group('Missing here: will subscribe', addRows, true, true),
      group('Only on u/' + cur.session.name + ': KEPT unless you tick them to unsubscribe', extraRows, true, false),
      group('Already in both', bothRows, false, false),
      el('h3', { text: 'Saved items' }),
      group('Not saved here: will save (oldest first, so the order is kept)', saveRows, true, true),
      group('Only saved on u/' + cur.session.name + ': always kept', savedExtra, false, false),
      group('Already saved in both', savedBoth, false, false),
      el('p', { class: 'rss-sub', text: 'Before applying, your current lists are downloaded as a backup file. Unsubscribing is the only removal available, and only for subreddits you tick above.' }),
      ui.applyBtn));
    updateApplyLabel();
  }

  async function onApply() {
    if (state.running || !state.diff) return;
    var d = state.diff;
    var actions = [];
    d.subs.toAdd.forEach(function (s) { if (state.selSub[lc(s.name)]) actions.push({ type: 'sub', name: s.name, fullname: s.fullname, label: 'Subscribe r/' + s.name }); });
    d.subs.extras.forEach(function (s) { if (state.selUnsub[lc(s.name)]) actions.push({ type: 'unsub', name: s.name, fullname: s.fullname, label: 'Unsubscribe r/' + s.name }); });
    var toSave = d.saved.toSave.filter(function (it) { return state.selSave[it.fullname]; }).slice().reverse();
    toSave.forEach(function (it) { actions.push({ type: 'save', fullname: it.fullname, label: 'Save ' + (it.title || it.fullname).slice(0, 60) }); });
    if (!actions.length) { setStatus('Nothing is ticked, so there is nothing to apply.'); return; }

    var nSub = actions.filter(function (a) { return a.type === 'sub'; }).length;
    var nUn = actions.filter(function (a) { return a.type === 'unsub'; }).length;
    var nSave = toSave.length;
    var mins = Math.ceil(actions.length * pace.delay / 60000);
    var msg = 'On u/' + state.cur.session.name + ' this will:\n- subscribe to ' + nSub + ' subreddits\n- unsubscribe from ' + nUn + ' subreddits\n- save ' + nSave + ' items\n\nAbout ' + mins + ' minute(s). Your current lists are downloaded first as a backup. Continue?';
    if (nUn > 0) msg = 'WARNING: you ticked ' + nUn + ' subreddit(s) to UNSUBSCRIBE from.\n\n' + msg;
    if (!confirm(msg)) return;

    // Backup first, synchronously inside the click so the browser allows the download.
    downloadJSON('reddit-backup-' + state.cur.session.name + '-' + stamp() + '.json',
      { tool: 'reddit-subscription-sync', version: VERSION, username: state.cur.session.name,
        takenAt: new Date().toISOString(), subs: state.cur.subs, saved: state.cur.saved });

    busy(true); state.stop = false;
    pace.shouldStop = function () { return state.stop; };
    pace.onWait = function (left, first) {
      var mm = Math.floor(left / 60), ss = left % 60;
      setStatus('Reddit asked us to slow down. Resuming in ' + mm + ':' + (ss < 10 ? '0' : '') + ss + ' (progress ' + ui.prog.value + '/' + ui.prog.max + '). Keep this tab open.');
      if (first) log('Rate limited by Reddit: pausing for about ' + Math.ceil(left / 60) + ' minute(s). It resumes by itself.', 'rss-err');
    };
    try {
      var s = await getSession();
      if (lc(s.name) !== lc(state.cur.session.name)) {
        throw new Error('You are now logged in as u/' + s.name + ' but the preview was for u/' + state.cur.session.name + '. Press Compare again.');
      }
      log('Starting ' + actions.length + ' actions for u/' + s.name + '.');
      showProgress(0, actions.length);
      setStatus('Working: 0/' + actions.length + '. Keep this tab open.');
      ui.panel.scrollTop = 0;
      var result = await runActions(s, actions, {
        shouldStop: function () { return state.stop; },
        onProgress: function (r, a, res) {
          var left = Math.ceil((r.total - r.done) * pace.delay / 1000);
          showProgress(r.done, r.total);
          setStatus('Working: ' + r.done + '/' + r.total + ' (about ' + Math.max(1, Math.ceil(left / 60)) + ' min left). Latest: ' + a.label);
          if (r.done % 10 === 0) log('Progress: ' + r.done + '/' + r.total + ' done.');
          if (!res.ok) log('FAILED: ' + a.label + ' - ' + res.error, 'rss-err');
        }
      });
      log('Finished: ' + result.ok + ' succeeded, ' + result.failed.length + ' failed' + (result.stopped ? ' (stopped early)' : '') + '.', result.failed.length ? 'rss-err' : 'rss-good');
      setStatus('Finished: ' + result.ok + ' succeeded, ' + result.failed.length + ' failed. Refreshing the comparison...');
      busy(false);
      pace.onWait = null; pace.shouldStop = null;
      await onCompare();
      return;
    } catch (e) { setStatus('Problem: ' + e.message); log(e.message, 'rss-err'); }
    pace.onWait = null; pace.shouldStop = null;
    busy(false);
  }

  buildUI();
})();

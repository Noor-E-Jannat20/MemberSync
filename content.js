/*
 * Group Chat Sync Assistant: content script (v0.3)
 *
 *   1. Keep one or more saved lists of people (names, profile links, or both).
 *   2. Click "Check my list". The chat's member list is read from the page.
 *   3. See who is missing, who needs a double-check, who is all set, and who
 *      is in the chat but not on your list.
 *   4. Your "same person / different people" choices are remembered.
 *   5. Export the results as a text file, or step through the people to add.
 *   6. Take people out of the "Not listed" table (this only tidies the table).
 *
 * The extension never clicks anything in Messenger. You make every change.
 */
(() => {
  if (window.__gcsLoaded) return;
  window.__gcsLoaded = true;

  /* =====================================================================
   * Parsing a single reference (ID, username, link)
   * ===================================================================== */

  const RESERVED = new Set([
    't', 'messages', 'groups', 'pages', 'marketplace', 'watch', 'gaming',
    'events', 'friends', 'notifications', 'policies', 'privacy', 'login',
    'logout', 'bookmarks', 'stories', 'reel', 'photo', 'photo.php',
    'permalink.php', 'share', 'hashtag', 'ads', 'help', 'settings', 'search',
    'home.php', 'story.php', 'l.php', 'people'
  ]);

  const looksLikeUrl = (s) =>
    /^(https?:\/\/|www\.)/i.test(s) || /(^|\.)(facebook|messenger|fb)\.(com|me)\b/i.test(s);

  // Returns a normalized key (digits, or a lowercase username), or null.
  // A bare word counts as a username only if it has a digit or a dot,
  // so plain names like "Alexander" are treated as names.
  function parseRef(raw) {
    const s = String(raw || '').trim();
    if (!s || /\s/.test(s)) return null;

    if (/^\d{5,}$/.test(s)) return s;

    if (/^(https?:\/\/|(www\.|m\.)?(facebook|messenger|fb)\.com)/i.test(s)) {
      let u;
      try {
        u = new URL(/^https?:/i.test(s) ? s : 'https://' + s);
      } catch {
        return null;
      }
      const id = u.searchParams.get('id');
      if (id && /^\d{5,}$/.test(id)) return id;
      const seg = u.pathname.split('/').filter(Boolean);
      if (!seg.length) return null;
      if (seg[0] === 'people' && /^\d{5,}$/.test(seg[2] || '')) return seg[2];
      if (RESERVED.has(seg[0].toLowerCase())) return null;
      if (/^[a-z0-9.]{5,50}$/i.test(seg[0])) return seg[0].toLowerCase();
      return null;
    }

    if (/^(?=.*[0-9.])[a-z0-9.]{5,50}$/i.test(s)) return s.toLowerCase();
    return null;
  }

  /* =====================================================================
   * Names
   * ===================================================================== */

  // A letter followed by another letter or a combining mark. Marks matter:
  // in Bengali, Hindi, Thai and others, vowel signs are marks, not letters.
  const hasLetters = (s) => /\p{L}[\p{L}\p{M}]/u.test(s);

  const norm = (s) =>
    String(s || '')
      .replace(/[\u200b-\u200d\u2060\ufeff]/g, '') // zero-width joiners and spaces
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // drop Latin accents only
      .normalize('NFC')
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ') // keep letters, marks, digits
      .replace(/\s+/g, ' ')
      .trim();

  const sortedNorm = (s) => norm(s).split(' ').sort().join(' ');

  function lev(a, b) {
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
      prev = cur;
    }
    return prev[n];
  }

  // 1 = same name (ignoring case, accents, punctuation and word order).
  function similarity(a, b) {
    const na = norm(a);
    const nb = norm(b);
    if (!na || !nb) return 0;
    if (na === nb || sortedNorm(a) === sortedNorm(b)) return 1;

    const ta = na.split(' ');
    const tb = nb.split(' ');
    const [shortT, longT] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    if (shortT.length >= 2 && shortT.every((t) => longT.includes(t))) return 0.92;
    if (shortT.length === 1 && longT.includes(shortT[0])) return 0.8;

    const sa = sortedNorm(a);
    const sb = sortedNorm(b);
    const plain = 1 - lev(na, nb) / Math.max(na.length, nb.length);
    const sorted = 1 - lev(sa, sb) / Math.max(sa.length, sb.length);
    return Math.max(plain, sorted);
  }

  const MATCH_FLOOR = 0.8;

  /* =====================================================================
   * Parsing list lines
   * ===================================================================== */

  // One line becomes { key, name } or null.
  function parseEntry(line) {
    const parts = line
      .split('|')
      .map((p) => p.trim())
      .filter((p) => p && p !== '?');
    let key = null;
    let name = null;
    for (const p of parts) {
      if (looksLikeUrl(p)) {
        const k = parseRef(p);
        if (k && !key) {
          key = k;
          continue;
        }
        return null; // a link we can't use
      }
      const k = parseRef(p);
      if (k && !key) {
        key = k;
        continue;
      }
      if (!name && hasLetters(p)) name = p;
    }
    if (!key && !name) return null;
    return { key, name };
  }

  // Splits text into lines. A line like "id1, id2, id3" (every part has an
  // ID) is split further; names containing commas are left alone.
  function splitLines(text) {
    const out = [];
    for (const line of String(text).split(/\n+/)) {
      const l = line.trim();
      if (!l) continue;
      if (!l.includes('|') && /[,;]/.test(l)) {
        const parts = l.split(/[,;]+/).map((p) => p.trim()).filter(Boolean);
        const parsed = parts.map(parseEntry);
        if (parsed.length > 1 && parsed.every((e) => e && e.key)) {
          out.push(...parts);
          continue;
        }
      }
      out.push(l);
    }
    return out;
  }

  // Two chat members can share a name, so only the user's own list is
  // de-duplicated by name; members are de-duplicated by ID only.
  function parseList(text, prefix, dedupeNames = prefix === 't') {
    const entries = [];
    const bad = [];
    const seen = new Set();
    for (const line of splitLines(text)) {
      const e = parseEntry(line);
      if (!e) {
        bad.push(line);
        continue;
      }
      const dedupe = e.key || (dedupeNames ? 'n:' + norm(e.name) : null);
      if (dedupe) {
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
      }
      entries.push({ id: `${prefix}${entries.length}`, key: e.key, name: e.name });
    }
    return { entries, bad };
  }

  /* =====================================================================
   * Comparing
   * ===================================================================== */

  const pairKey = (t, m) => `${norm(t.name)}~${norm(m.name)}`;

  // decisions: { "<list name>~<chat name>": "same" | "different" }
  function compare(targetsText, membersText, decisions = {}) {
    const T = parseList(targetsText, 't');
    const M = parseList(membersText, 'm');
    const ts = T.entries;
    const ms = M.entries;
    const tDone = new Set();
    const mDone = new Set();
    const exact = [];
    const probable = [];
    const remembered = [];

    // 1. Same ID on both sides.
    const mByKey = new Map(ms.filter((m) => m.key).map((m) => [m.key, m]));
    for (const t of ts) {
      const m = t.key && mByKey.get(t.key);
      if (m) {
        exact.push({ t, m, how: 'id' });
        tDone.add(t.id);
        mDone.add(m.id);
      }
    }

    // 2. Pairs the user already confirmed as the same person.
    //    (Two people who both have IDs that differ are always different.)
    for (const t of ts) {
      if (tDone.has(t.id) || !t.name) continue;
      for (const m of ms) {
        if (mDone.has(m.id) || !m.name || (t.key && m.key)) continue;
        const pk = pairKey(t, m);
        if (decisions[pk] === 'same') {
          exact.push({ t, m, how: 'remembered', pk });
          remembered.push({ pk, t, m, decision: 'same' });
          tDone.add(t.id);
          mDone.add(m.id);
          break;
        }
      }
    }

    // 3. Names, skipping pairs the user said are different people.
    const cands = [];
    for (const t of ts) {
      if (tDone.has(t.id) || !t.name) continue;
      for (const m of ms) {
        if (mDone.has(m.id) || !m.name || (t.key && m.key)) continue;
        const s = similarity(t.name, m.name);
        if (s < MATCH_FLOOR) continue;
        const pk = pairKey(t, m);
        if (decisions[pk] === 'different') {
          remembered.push({ pk, t, m, decision: 'different' });
          continue;
        }
        cands.push({ t, m, s, pk });
      }
    }
    const tCount = new Map();
    const mCount = new Map();
    for (const c of cands) {
      tCount.set(c.t.id, (tCount.get(c.t.id) || 0) + 1);
      mCount.set(c.m.id, (mCount.get(c.m.id) || 0) + 1);
    }
    cands.sort((a, b) => b.s - a.s);
    for (const c of cands) {
      if (tDone.has(c.t.id) || mDone.has(c.m.id)) continue;
      tDone.add(c.t.id);
      mDone.add(c.m.id);
      const unique = tCount.get(c.t.id) === 1 && mCount.get(c.m.id) === 1;
      if (c.s === 1 && unique) exact.push({ t: c.t, m: c.m, how: 'name' });
      else probable.push({ t: c.t, m: c.m, score: c.s, pk: c.pk });
    }

    const unmatchedT = ts.filter((t) => !tDone.has(t.id));
    const unmatchedM = ms.filter((m) => !mDone.has(m.id));
    return {
      exact,
      probable,
      remembered,
      unmatchedT,
      unmatchedM,
      bad: T.bad,
      total: ts.length,
      memberTotal: ms.length,
      nameless: unmatchedT.filter((t) => !t.name).length,
      keylessMembers: ms.filter((m) => !m.key).length
    };
  }

  /* =====================================================================
   * Text export
   * ===================================================================== */

  function buildText(r, listName, date) {
    const who = (e) => e.name || e.key || '';
    const withId = (e) => (e.name && e.key ? `${e.name} (${e.key})` : who(e));
    const by = { id: 'matched by ID', name: 'matched by name', remembered: 'remembered choice' };
    const out = [];
    const section = (title, items) => {
      out.push('', `${title} (${items.length})`, '-'.repeat(title.length + String(items.length).length + 3));
      if (!items.length) out.push('  (nobody)');
      else out.push(...items.map((x) => '  - ' + x));
    };
    out.push(`Group Chat Sync: ${listName}`, `Date: ${date}`);
    out.push(`${r.exact.length} of ${r.total} on the list are in the chat; ${r.memberTotal} chat members compared.`);
    section('TO ADD', r.unmatchedT.map(withId));
    section('NEEDS A CHECK', r.probable.map((p) => `${who(p.t)}  ~  ${who(p.m)} (similar name)`));
    section('NOT ON LIST', r.unmatchedM.map(withId));
    section('IN CHAT', r.exact.map((x) => `${who(x.t)}${who(x.t) !== who(x.m) ? '  =  ' + who(x.m) : ''} (${by[x.how]})`));
    return out.join('\n') + '\n';
  }

  function downloadFile(filename, text) {
    const blob = new Blob(['\ufeff', text], { type: 'text/plain;charset=utf-8' }); // BOM: old Notepad reads UTF-8
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  const slug = (s) =>
    String(s || 'list')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .normalize('NFC')
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'list';

  function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /* =====================================================================
   * Reading the member list from the page
   * ===================================================================== */

  const UI_WORDS =
    /^(add|add people|remove|remove from group|admins?|group admin|you|members?|chat members|search|see all|view profile|make admin|message|close|done|cancel|settings|more|people|customize chat|chat info)$/i;

  function looksLikeName(s) {
    if (!s || s.length < 2 || s.length > 60) return false;
    if (!hasLetters(s) || UI_WORDS.test(s.trim())) return false;
    return s.trim().split(/\s+/).length <= 6;
  }

  const ROW_SEL = '[role="listitem"], [role="row"], li';
  const HEADING_RE = /^(chat members|group members|members|people|participants)(\s*[\u00b7\-:(]?\s*\d+\)?)?$/i;

  // How many person-like rows sit inside an element.
  function countRows(el) {
    let links = 0;
    for (const a of el.querySelectorAll('a[href]')) if (parseRef(a.href)) links++;
    return Math.max(links, el.querySelectorAll(ROW_SEL).length);
  }

  // From something the user clicked (or a heading), the smallest surrounding
  // element that holds at least two rows. That is the list.
  function listAround(el, minRows = 2) {
    let cur = el;
    for (let i = 0; i < 12 && cur && cur !== document.body; i++, cur = cur.parentElement) {
      if (cur.id === 'gcs-host') return null;
      if (countRows(cur) >= minRows) return cur;
    }
    return null;
  }

  const inNav = (el) => !!el.closest('[role="navigation"], [role="banner"], nav, header');

  // Finds the Members list instead of reading the whole screen:
  //   1. an area the user picked,
  //   2. an open Members dialog,
  //   3. the section under a "Chat members" / "Members" heading.
  // Returns null when none is found (the user is then asked to pick it).
  function findScope() {
    if (S.scopeEl && S.scopeEl.isConnected) return S.scopeEl;
    S.scopeEl = null;

    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((d) => countRows(d) >= 2);
    if (dialogs.length) return dialogs[dialogs.length - 1];

    let best = null;
    let bestN = 0;
    const cands = document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],span,div,button,[role="button"]');
    for (const el of cands) {
      if (el.childElementCount > 1) continue;
      const t = (el.textContent || '').trim();
      if (t.length > 30 || !HEADING_RE.test(t) || inNav(el)) continue;
      const area = listAround(el);
      if (!area) continue;
      const n = countRows(area);
      if (n > bestN) {
        best = area;
        bestN = n;
      }
    }
    return best;
  }

  // Returns { text, scope }: the members as text lines ("key | Name" or just
  // "Name") and the part of the page they were read from.
  function scrapeMembers() {
    const scope = findScope();
    if (!scope) return { text: '', scope: null };
    const lines = [];
    const seen = new Set();
    const covered = new Set();

    // Chat title, section headings and similar are not people.
    const headings = new Set(
      [...document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')]
        .map((e) => norm(e.innerText))
        .filter(Boolean)
    );
    const rowOf = (el) => el.closest('[role="listitem"], [role="row"], li') || el;
    const add = (key, name) => {
      const ek = key || 'n:' + norm(name);
      if (!ek || seen.has(ek)) return;
      seen.add(ek);
      lines.push(key ? `${key} | ${name}` : name);
    };

    // Rows with a profile link give an ID and a name.
    for (const a of scope.querySelectorAll('a[href]')) {
      const key = parseRef(a.href);
      const name = (a.innerText || a.getAttribute('aria-label') || '').trim().split('\n')[0];
      if (!key || !name) continue;
      covered.add(rowOf(a));
      add(key, name);
    }

    // Other rows give just a name.
    for (const row of scope.querySelectorAll('[role="listitem"], [role="row"], li')) {
      if (covered.has(row)) continue;
      const parts = (row.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean);
      if (!parts.length || parts.length > 4) continue; // likely a container
      if (!looksLikeName(parts[0]) || headings.has(norm(parts[0]))) continue;
      if (/^\d+\s+(members?|people|participants?)\b/i.test(parts[0])) continue;
      add(null, parts[0]);
    }
    return { text: lines.join('\n'), scope };
  }

  /* =====================================================================
   * Saved data (lists, remembered choices, settings)
   * ===================================================================== */

  const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null;
  const KEY = 'gcs_v2';
  const OLD_KEY = 'gcs_targets_v1';

  const newId = () => 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const S = {
    open: false,
    view: 'home', // home | review | queue | done
    lists: [],
    activeId: null,
    decisions: {},
    pace: true,
    renaming: false,
    confirmDelete: false,
    error: '',
    showManual: false, // only offered when the member list can't be read
    membersText: '',
    membersSnapshot: '',
    result: null,
    removed: [], // keys of chat members taken out of the "Not listed" table
    tab: 'add',
    queue: [],
    qi: 0,
    added: 0,
    skipped: 0,
    wait: 0,
    picking: false,
    scopeEl: null, // member list area picked by the user (kept while it stays on the page)
    toast: null,
    pos: { fab: null, panel: null } // dragged positions in px ({x,y}) or null for default
  };

  const activeList = () => S.lists.find((l) => l.id === S.activeId) || S.lists[0];

  function ensureList() {
    if (!S.lists.length) {
      const l = { id: newId(), name: 'My list', text: '' };
      S.lists.push(l);
      S.activeId = l.id;
    }
    if (!S.lists.some((l) => l.id === S.activeId)) S.activeId = S.lists[0].id;
  }

  function load(cb) {
    if (!store) {
      ensureList();
      return cb();
    }
    try {
      store.get([KEY, OLD_KEY], (r) => {
        const d = r && r[KEY];
        if (d && Array.isArray(d.lists)) {
          S.lists = d.lists;
          S.activeId = d.activeId;
          S.decisions = d.decisions || {};
          S.pace = d.pace !== false;
          if (d.pos) S.pos = { fab: d.pos.fab || null, panel: d.pos.panel || null };
        } else if (r && r[OLD_KEY]) {
          S.lists = [{ id: newId(), name: 'My list', text: r[OLD_KEY] }];
        }
        ensureList();
        cb();
      });
    } catch {
      ensureList();
      cb();
    }
  }

  let saveTimer;
  function persist() {
    if (!store) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        store.set({
          [KEY]: { lists: S.lists, activeId: S.activeId, decisions: S.decisions, pace: S.pace, pos: S.pos }
        });
      } catch {
        /* ignore */
      }
    }, 300);
  }

  /* =====================================================================
   * DOM helpers
   * ===================================================================== */

  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  };

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }
  const lab = (e) => e.name || e.key;
  const labFull = (e) => (e.name && e.key ? `${e.name} (${e.key})` : lab(e));
  const profileUrl = (key) =>
    /^\d+$/.test(key)
      ? `https://www.facebook.com/profile.php?id=${key}`
      : `https://www.facebook.com/${key}`;

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), 1400);
  }

  let toastTimer;
  function toast(text, undo) {
    S.toast = { text, undo };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      S.toast = null;
      render();
    }, 6000);
  }

  /* =====================================================================
   * Actions
   * ===================================================================== */

  const memberKey = (m) => m.key || 'n:' + norm(m.name);

  function recompute() {
    const r = compare(activeList().text, S.membersSnapshot, S.decisions);
    r.removedM = r.unmatchedM.filter((m) => S.removed.includes(memberKey(m)));
    r.unmatchedM = r.unmatchedM.filter((m) => !S.removed.includes(memberKey(m)));
    S.result = r;
    if (S.tab === 'check' && !S.result.probable.length) {
      S.tab = S.result.unmatchedT.length ? 'add' : 'ok';
    }
  }

  function defaultTab(r) {
    if (r.probable.length) return 'check';
    if (r.unmatchedT.length) return 'add';
    if (r.unmatchedM.length) return 'extra';
    return 'ok';
  }

  function runCompare() {
    const manual = S.showManual ? S.membersText.trim() : '';
    let text = manual;
    if (!text) {
      const got = scrapeMembers();
      text = got.text;
      if (got.scope) highlight(got.scope);
      if (!text) {
        S.error = got.scope
          ? 'I found the area but couldn\u2019t read any names in it. Scroll the Members list to load everyone, or pick the list again.'
          : 'I couldn\u2019t find the Members list on this page. Click \u201cSelect member list\u201d and then click a name inside it.';
        S.showManual = true;
        S.view = 'home';
        render();
        return;
      }
    }
    S.error = '';
    S.removed = [];
    S.membersSnapshot = text;
    S.tab = 'add';
    recompute();
    S.tab = defaultTab(S.result);
    S.toast = null;
    S.view = 'review';
    render();
  }

  function decide(p, decision) {
    const prev = S.decisions[p.pk];
    S.decisions[p.pk] = decision;
    persist();
    recompute();
    toast(
      decision === 'same'
        ? 'Got it. Same person, and I\u2019ll remember that.'
        : 'Got it. Different people, and I\u2019ll remember that.',
      () => {
        if (prev) S.decisions[p.pk] = prev;
        else delete S.decisions[p.pk];
        persist();
        recompute();
        S.tab = 'check';
        S.toast = null;
        render();
      }
    );
    render();
  }

  function forget(pk) {
    delete S.decisions[pk];
    persist();
    recompute();
    toast('Forgot that choice. I\u2019ll ask again next time.');
    render();
  }

  function exportText(btn) {
    const list = activeList();
    const name = `${slug(list.name)}-${today()}.txt`;
    downloadFile(name, buildText(S.result, list.name, today()));
    if (btn) flash(btn, 'Saved');
    else {
      toast(`Saved ${name}`);
      render();
    }
  }

  function removeMembers(ms) {
    const keys = ms.map(memberKey);
    S.removed = [...new Set([...S.removed, ...keys])];
    recompute();
    toast(`Removed ${ms.length === 1 ? lab(ms[0]) : plural(ms.length, 'person', 'people')} from this table.`, () => {
      S.removed = S.removed.filter((k) => !keys.includes(k));
      recompute();
      S.tab = 'extra';
      S.toast = null;
      render();
    });
    render();
  }

  function restoreMembers() {
    S.removed = [];
    recompute();
    toast('Everyone is back in the table.');
    render();
  }

  async function copyText(text, btn, label = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
      flash(btn, label);
    } catch {
      flash(btn, 'Copy failed');
    }
  }

  /* =====================================================================
   * Confetti (only on finishing, and not if motion is reduced)
   * ===================================================================== */

  let confettiLayer = null;
  function burst() {
    if (!confettiLayer) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const colors = ['#e11d2e', '#8b0000', '#111111', '#ffffff', '#ff4d4d'];
    confettiLayer.textContent = '';
    for (let i = 0; i < 36; i++) {
      const c = h('span', { class: 'confetti' });
      c.style.left = Math.random() * 100 + '%';
      c.style.background = colors[i % colors.length];
      c.style.animationDelay = Math.random() * 0.5 + 's';
      c.style.animationDuration = 1.6 + Math.random() * 1.2 + 's';
      c.style.setProperty('--drift', Math.round((Math.random() - 0.5) * 140) + 'px');
      confettiLayer.append(c);
    }
    setTimeout(() => confettiLayer && (confettiLayer.textContent = ''), 3500);
  }

  /* =====================================================================
   * Views
   * ===================================================================== */

  function listPicker() {
    const list = activeList();

    if (S.renaming) {
      const input = h('input', {
        class: 'text',
        type: 'text',
        value: list.name,
        maxlength: '40',
        'aria-label': 'List name',
        onkeydown: (e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') {
            S.renaming = false;
            render();
          }
        }
      });
      const save = () => {
        const v = input.value.trim();
        if (v) list.name = v.slice(0, 40);
        S.renaming = false;
        persist();
        render();
      };
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
      return h(
        'div',
        { class: 'picker' },
        input,
        h('button', { class: 'btn small primary', onclick: save }, 'Save')
      );
    }

    const select = h(
      'select',
      {
        class: 'select',
        'aria-label': 'Saved lists',
        onchange: (e) => {
          S.activeId = e.target.value;
          S.confirmDelete = false;
          persist();
          render();
        }
      },
      S.lists.map((l) => h('option', { value: l.id, selected: l.id === S.activeId }, l.name))
    );
    select.value = S.activeId;

    return h(
      'div',
      { class: 'picker' },
      select,
      h(
        'button',
        {
          class: 'btn small',
          onclick: () => {
            const l = { id: newId(), name: `List ${S.lists.length + 1}`, text: '' };
            S.lists.push(l);
            S.activeId = l.id;
            S.renaming = true;
            S.confirmDelete = false;
            persist();
            render();
          }
        },
        'New'
      ),
      h(
        'button',
        {
          class: 'btn small',
          onclick: () => {
            S.renaming = true;
            render();
          }
        },
        'Rename'
      ),
      h(
        'button',
        {
          class: 'btn small' + (S.confirmDelete ? ' danger' : ''),
          onclick: () => {
            if (!S.confirmDelete) {
              S.confirmDelete = true;
              render();
              setTimeout(() => {
                if (S.confirmDelete) {
                  S.confirmDelete = false;
                  render();
                }
              }, 3000);
              return;
            }
            S.lists = S.lists.filter((l) => l.id !== S.activeId);
            S.confirmDelete = false;
            ensureList();
            persist();
            render();
          }
        },
        S.confirmDelete ? 'Sure?' : 'Delete'
      )
    );
  }

  function areaRow() {
    if (S.picking) {
      return h(
        'div',
        { class: 'area picking' },
        h('span', {}, 'Click a name inside the Members list. Press Esc to cancel.'),
        h('button', { class: 'btn small', onclick: () => (stopPick(), render()) }, 'Cancel')
      );
    }
    const picked = S.scopeEl && S.scopeEl.isConnected;
    return h(
      'div',
      { class: 'area' },
      h('span', {}, picked ? 'Reading from: the area you picked' : 'Reading from: auto-detected Members list'),
      h('button', { class: 'btn small', onclick: startPick }, picked ? 'Pick again' : 'Select member list'),
      picked ? h('button', { class: 'btn small', onclick: () => ((S.scopeEl = null), render()) }, 'Reset') : null
    );
  }

  function viewHome() {
    const list = activeList();
    const count = () => parseList(list.text, 't').entries.length;
    const chip = h('span', { class: 'chip' }, plural(count(), 'person', 'people'));

    const textarea = h('textarea', {
      rows: 8,
      spellcheck: 'false',
      dir: 'auto',
      'aria-label': 'People to check',
      placeholder:
        'Lena Petrova\nDaniel Okafor | facebook.com/profile.php?id=100000000002\nhttps://facebook.com/some.username',
      value: list.text,
      oninput: (e) => {
        list.text = e.target.value;
        persist();
        const n = count();
        chip.textContent = plural(n, 'person', 'people');
        go.disabled = !n;
      }
    });

    const go = h(
      'button',
      { class: 'btn primary big', disabled: !count(), onclick: runCompare },
      'Check my list'
    );

    const out = [
      listPicker(),
      h(
        'div',
        { class: 'rowhead' },
        h('label', {}, 'Who should be in this chat?'),
        chip
      ),
      h(
        'p',
        { class: 'hint' },
        'One person per line: a name, a profile link, or both like Name | link. Names alone are fine.'
      ),
      textarea,
      h('p', { class: 'hint' }, 'Tip: open the chat\u2019s Members list first, so I can see who\u2019s in.'),
      areaRow()
    ];
    if (S.error) out.push(h('p', { class: 'warn' }, S.error));
    if (S.showManual) {
      out.push(
        h(
          'details',
          { open: true },
          h('summary', {}, 'Paste the members instead'),
          h('textarea', {
            rows: 5,
            spellcheck: 'false',
            dir: 'auto',
            'aria-label': 'Chat members',
            placeholder: 'One member name per line',
            value: S.membersText,
            oninput: (e) => (S.membersText = e.target.value)
          })
        )
      );
    }
    out.push(h('div', { class: 'actions' }, go));
    return out;
  }

  /* ---------- Results ---------- */

  function personRow(e, tag, extra) {
    return h(
      'li',
      { class: 'person' },
      h('span', { class: 'who' }, h('b', { dir: 'auto' }, lab(e)), e.name && e.key ? h('span', { class: 'key' }, e.key) : null),
      tag ? h('span', { class: 'tag' }, tag) : null,
      extra
    );
  }

  function pairCard(p) {
    return h(
      'li',
      { class: 'pair' },
      h(
        'div',
        { class: 'pairtxt' },
        h('div', {}, h('span', { class: 'lbl' }, 'Your list'), h('b', { dir: 'auto' }, lab(p.t))),
        h('div', {}, h('span', { class: 'lbl' }, 'In the chat'), h('b', { dir: 'auto' }, lab(p.m)))
      ),
      h(
        'div',
        { class: 'pairbtns' },
        h('button', { class: 'btn small primary', onclick: () => decide(p, 'same') }, 'Same person'),
        h('button', { class: 'btn small', onclick: () => decide(p, 'different') }, 'Different people')
      )
    );
  }

  function tabAdd(r) {
    if (!r.unmatchedT.length) {
      return h('p', { class: 'empty' }, 'Nobody\u2019s missing. Everyone on your list is in the chat.');
    }
    return [
      h('ul', { class: 'people add' }, r.unmatchedT.map((t) => personRow(t))),
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: S.pace,
          onchange: (e) => {
            S.pace = e.target.checked;
            persist();
          }
        }),
        'Take a short breather between adds'
      )
    ];
  }

  function tabCheck(r) {
    if (!r.probable.length) return h('p', { class: 'empty' }, 'Nothing to double-check.');
    return [
      h(
        'p',
        { class: 'hint' },
        'These names are close but not identical. Pick one for each. I\u2019ll remember your answer next time.'
      ),
      h('ul', { class: 'pairs' }, r.probable.map(pairCard))
    ];
  }

  function tabOk(r) {
    const how = { id: 'ID', name: 'name', remembered: 'remembered' };
    const out = [];
    if (!r.exact.length) out.push(h('p', { class: 'empty' }, 'No matches yet.'));
    else {
      out.push(
        h(
          'ul',
          { class: 'people ok' },
          r.exact.map((x) =>
            personRow(
              x.m,
              how[x.how],
              x.how === 'name' && lab(x.t) !== lab(x.m) ? h('span', { class: 'key' }, `list: ${lab(x.t)}`) : null
            )
          )
        )
      );
    }
    if (r.remembered.length) {
      out.push(
        h(
          'details',
          {},
          h('summary', {}, `Remembered choices (${r.remembered.length})`),
          h(
            'ul',
            { class: 'people' },
            r.remembered.map((x) =>
              h(
                'li',
                { class: 'person' },
                h(
                  'span',
                  { class: 'who' },
                  h('b', {}, `${lab(x.t)} ${x.decision === 'same' ? '=' : '\u2260'} ${lab(x.m)}`),
                  h('span', { class: 'key' }, x.decision === 'same' ? 'Same person' : 'Different people')
                ),
                h('button', { class: 'btn small', onclick: () => forget(x.pk) }, 'Forget')
              )
            )
          )
        )
      );
    }
    return out;
  }

  function tabExtra(r) {
    const out = [];
    if (!r.unmatchedM.length) {
      out.push(
        h(
          'p',
          { class: 'empty' },
          r.removedM.length ? 'The table is empty.' : 'Everyone in the chat is on your list.'
        )
      );
    } else {
      out.push(
        h(
          'p',
          { class: 'hint' },
          'These people are in the chat but not on this list. Remove anyone you want out of this table.'
        ),
        h(
          'ul',
          { class: 'people extra' },
          r.unmatchedM.map((m) =>
            personRow(
              m,
              null,
              h(
                'button',
                {
                  class: 'btn small rm',
                  'aria-label': `Remove ${lab(m)} from this table`,
                  onclick: () => removeMembers([m])
                },
                'Remove'
              )
            )
          )
        ),
        h(
          'div',
          { class: 'actions left' },
          h(
            'button',
            {
              class: 'btn small',
              onclick: (e) => copyText(r.unmatchedM.map(lab).join('\n'), e.target, 'Names copied')
            },
            'Copy names'
          ),
          h('button', { class: 'btn small danger', onclick: () => removeMembers(r.unmatchedM) }, 'Remove all')
        )
      );
    }
    if (r.removedM.length) {
      out.push(
        h(
          'p',
          { class: 'hint' },
          `${plural(r.removedM.length, 'person is', 'people are')} hidden. `,
          h('button', { class: 'link', onclick: restoreMembers }, 'Restore')
        )
      );
    }
    return out;
  }

  function viewReview() {
    const r = S.result;
    const pct = r.total ? Math.round((100 * r.exact.length) / r.total) : 0;
    const everyone = r.total > 0 && !r.unmatchedT.length && !r.probable.length;
    const out = [];

    out.push(
      h('p', { class: 'headline' }, everyone ? 'Everyone is in the chat \ud83c\udf89' : `${r.exact.length} of ${r.total} are in the chat`),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' },
        h('div', { class: 'fill', style: `width:${pct}%` })),
      h('p', { class: 'hint' }, `Compared with ${plural(r.memberTotal, 'chat member', 'chat members')} \u00b7 ${activeList().name}`)
    );

    if (r.bad.length) {
      out.push(
        h(
          'p',
          { class: 'warn' },
          `Skipped ${plural(r.bad.length, 'line', 'lines')} I couldn't read (links need to be profile links): ${r.bad.slice(0, 3).join(', ')}${r.bad.length > 3 ? '\u2026' : ''}`
        )
      );
    }
    if (r.nameless && r.keylessMembers) {
      out.push(
        h(
          'p',
          { class: 'warn' },
          `${plural(r.nameless, 'line', 'lines')} in your list ${r.nameless === 1 ? 'has' : 'have'} only a link or ID, and some chat members don't show an ID, so I can't match ${r.nameless === 1 ? 'it' : 'them'}. Add names, like Name | link.`
        )
      );
    }

    const tabs = [
      { id: 'add', label: 'To add', n: r.unmatchedT.length },
      { id: 'check', label: 'Check', n: r.probable.length },
      { id: 'ok', label: 'All set', n: r.exact.length },
      { id: 'extra', label: 'Not listed', n: r.unmatchedM.length }
    ];
    out.push(
      h(
        'div',
        { class: 'tabs', role: 'tablist' },
        tabs.map((t) =>
          h(
            'button',
            {
              class: `tab ${t.id}` + (S.tab === t.id ? ' on' : '') + (t.id === 'check' && t.n ? ' attn' : ''),
              role: 'tab',
              'aria-selected': String(S.tab === t.id),
              onclick: () => {
                S.tab = t.id;
                render();
              }
            },
            t.label,
            h('span', { class: 'n' }, String(t.n))
          )
        )
      )
    );

    const panels = { add: tabAdd, check: tabCheck, ok: tabOk, extra: tabExtra };
    out.push(h('div', { class: 'tabpanel', role: 'tabpanel' }, panels[S.tab](r)));

    out.push(
      h(
        'div',
        { class: 'footer' },
        h('button', { class: 'btn small', onclick: () => ((S.view = 'home'), render()) }, 'Edit list'),
        h('button', { class: 'btn small', onclick: (e) => exportText(e.target) }, 'Download .txt'),
        r.unmatchedT.length
          ? h(
              'button',
              {
                class: 'btn primary grow',
                onclick: () => {
                  S.queue = [...r.unmatchedT];
                  S.qi = 0;
                  S.added = 0;
                  S.skipped = 0;
                  S.wait = 0;
                  S.view = 'queue';
                  render();
                }
              },
              `Start adding (${r.unmatchedT.length})`
            )
          : null
      )
    );
    return out;
  }

  /* ---------- Guided adding ---------- */

  let waitTimer = null;
  function advance(wasAdded) {
    if (wasAdded) S.added++;
    else S.skipped++;
    S.qi++;
    if (S.qi >= S.queue.length) {
      clearInterval(waitTimer);
      S.wait = 0;
      S.view = 'done';
      render();
      burst();
      return;
    }
    if (S.pace && wasAdded) {
      S.wait = 6 + Math.floor(Math.random() * 10);
      clearInterval(waitTimer);
      waitTimer = setInterval(() => {
        S.wait--;
        if (S.wait <= 0) clearInterval(waitTimer);
        render();
      }, 1000);
    }
    render();
  }

  function viewQueue() {
    const item = S.queue[S.qi];
    const waiting = S.wait > 0;
    const pct = Math.round((100 * S.qi) / S.queue.length);

    const actions = [];
    if (item.key) {
      actions.push(
        h(
          'button',
          { class: 'btn small', disabled: waiting, onclick: () => window.open(profileUrl(item.key), '_blank', 'noopener') },
          'Open profile'
        )
      );
    }
    actions.push(
      h(
        'button',
        {
          class: 'btn small',
          disabled: waiting,
          onclick: (e) => copyText(item.name || item.key, e.target)
        },
        item.name ? 'Copy name' : 'Copy ID'
      )
    );

    return [
      h('p', { class: 'headline' }, `${S.qi + 1} of ${S.queue.length}`),
      h('div', { class: 'bar' }, h('div', { class: 'fill', style: `width:${pct}%` })),
      h(
        'div',
        { class: 'card' },
        h('p', { class: 'lbl' }, 'Add to the chat'),
        h('p', { class: 'big', dir: 'auto' }, labFull(item)),
        h(
          'p',
          { class: 'hint' },
          item.key
            ? 'Open their profile to make sure it\u2019s the right person, then add them from the chat\u2019s Members panel.'
            : 'Search this name in the chat\u2019s Add people box. If several people share the name, check their photos first.'
        )
      ),
      h('div', { class: 'actions left' }, actions),
      waiting ? h('p', { class: 'wait' }, `Next one unlocks in ${S.wait}s. Stretch your fingers.`) : null,
      h(
        'div',
        { class: 'footer' },
        h('button', { class: 'btn small', onclick: () => ((S.view = 'review'), clearInterval(waitTimer), (S.wait = 0), render()) }, 'Back to results'),
        h('button', { class: 'btn', disabled: waiting, onclick: () => advance(false) }, 'Skip'),
        h('button', { class: 'btn primary grow', disabled: waiting, onclick: () => advance(true) }, 'Added them')
      )
    ];
  }

  function viewDone() {
    return [
      h('p', { class: 'headline' }, 'All done \ud83c\udf89'),
      h('p', { class: 'summary' }, `${plural(S.added, 'person', 'people')} added, ${S.skipped} skipped.`),
      h('p', { class: 'hint' }, 'Re-check to confirm the chat now matches your list.'),
      h(
        'div',
        { class: 'footer' },
        h('button', { class: 'btn small', onclick: (e) => exportText(e.target) }, 'Download .txt'),
        h('button', { class: 'btn primary grow', onclick: runCompare }, 'Re-check the chat')
      )
    ];
  }

  /* =====================================================================
   * Shell
   * ===================================================================== */

  /* ---------- Picking the member list ---------- */

  let hlBox = null;
  function showBox(el) {
    if (!hlBox) {
      hlBox = h('div', { class: 'hl' });
      shadow.append(hlBox);
    }
    if (!el) {
      hlBox.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    hlBox.setAttribute(
      'style',
      `display:block;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`
    );
  }
  function highlight(el) {
    showBox(el);
    setTimeout(() => showBox(null), 1400);
  }

  function stopPick() {
    S.picking = false;
    showBox(null);
    document.removeEventListener('mousemove', pickMove, true);
    document.removeEventListener('click', pickClick, true);
    document.removeEventListener('keydown', pickKey, true);
  }
  const inHost = (e) => (e.composedPath ? e.composedPath().includes(host) : false);
  function pickMove(e) {
    if (inHost(e)) return showBox(null);
    showBox(listAround(e.target));
  }
  function pickClick(e) {
    if (inHost(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const area = listAround(e.target);
    stopPick();
    if (area) {
      S.scopeEl = area;
      S.error = '';
      highlight(area);
      toast('Got it. I\u2019ll read names from that area only.');
    } else {
      S.error = 'That doesn\u2019t look like a list of people. Try clicking a member\u2019s name.';
    }
    render();
  }
  function pickKey(e) {
    if (e.key === 'Escape') {
      stopPick();
      render();
    }
  }
  function startPick() {
    S.picking = true;
    document.addEventListener('mousemove', pickMove, true);
    document.addEventListener('click', pickClick, true);
    document.addEventListener('keydown', pickKey, true);
    render();
  }

  /* ---------- Dragging ---------- */

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  const FAB_H = 44;

  function fabStyle() {
    const f = S.pos.fab;
    if (!f) return null;
    const x = clamp(f.x, 0, window.innerWidth - 60);
    const y = clamp(f.y, 0, window.innerHeight - FAB_H);
    return `left:${x}px;top:${y}px;bottom:auto`;
  }

  function panelStyle() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const p = S.pos.panel;
    if (p) {
      const x = clamp(p.x, 0, vw - 120);
      const y = clamp(p.y, 0, vh - 120);
      return `left:${x}px;top:${y}px;bottom:auto;max-height:${Math.max(160, vh - y - 8)}px`;
    }
    const f = S.pos.fab;
    if (!f) return null;
    const x = clamp(f.x, 8, vw - 408);
    const fy = clamp(f.y, 0, vh - FAB_H);
    if (fy > vh / 2) {
      return `left:${x}px;top:auto;bottom:${vh - fy + 8}px;max-height:${Math.max(160, Math.min(700, fy - 16))}px`;
    }
    const top = fy + FAB_H + 8;
    return `left:${x}px;top:${top}px;bottom:auto;max-height:${Math.max(160, vh - top - 8)}px`;
  }

  // Moves an element with the pointer. Uses window listeners so a re-render
  // (timers, toasts) in the middle of a drag doesn't drop it.
  function startDrag(e, find, kind) {
    if (e.button != null && e.button !== 0) return;
    const el = find();
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true;
      const cur = find();
      if (!cur) return;
      const w = cur.offsetWidth;
      const hgt = cur.offsetHeight;
      const x = clamp(ev.clientX - dx, 0, window.innerWidth - Math.min(w, 120));
      const y = clamp(ev.clientY - dy, 0, window.innerHeight - Math.min(hgt, kind === 'fab' ? FAB_H : 80));
      S.pos[kind] = { x, y };
      cur.setAttribute('style', kind === 'fab' ? fabStyle() : panelStyle());
      ev.preventDefault();
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      if (moved) {
        persist();
        render();
      } else if (kind === 'fab') {
        S.open = !S.open;
        render();
      }
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    e.preventDefault();
  }

  const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.root{--ink:#111;--mut:#5f5a5c;--line:#e8dcdd;--bg:#fff;--soft:#faf5f5;--pri:#d10f1f;--onpri:#fff;--deep:#7a0010;
--add:#b00d1b;--addbg:#fde8ea;--chk:#7a0a14;--chkbg:#f3eaea;--ext:#333;--extbg:#ececec;--bad:#b00020;--badbg:#fde8ea;
--headbg:#111;--headink:#fff;
color-scheme:light dark;
font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink)}
@media (prefers-color-scheme:dark){.root{--ink:#f5f5f5;--mut:#a8a0a2;--line:#3a2326;--bg:#0b0b0c;--soft:#161214;--pri:#ff2b3d;--onpri:#fff;--deep:#8b0000;
--add:#ff7480;--addbg:#2a1014;--chk:#ffb3ba;--chkbg:#231315;--ext:#cfcfcf;--extbg:#1d1d1f;--bad:#ff8a94;--badbg:#2e1015;--headbg:#000;--headink:#fff}}
.fab{position:fixed;left:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:9px;isolation:isolate;border:0;
background:#050505;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;
color:#fff;font:inherit;font-weight:700;letter-spacing:.01em;padding:11px 20px 11px 16px;border-radius:999px;cursor:pointer;
box-shadow:0 0 18px rgba(255,30,45,.45),0 0 42px rgba(139,0,0,.45)}
.fab::before{content:"";width:9px;height:9px;border-radius:50%;background:#ff2b3d;box-shadow:0 0 8px 2px rgba(255,43,61,.9)}
.fab .ring{position:absolute;inset:0;border-radius:inherit;padding:2px;overflow:hidden;pointer-events:none;z-index:-1;
-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;
mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0)}
.fab .ring::before{content:"";position:absolute;left:50%;top:50%;width:360px;height:360px;margin:-180px 0 0 -180px;
background:conic-gradient(from 0deg,#3a0000 0deg,#ff1a2b 35deg,#ff7a70 50deg,#ff1a2b 65deg,#7a0010 110deg,#2a0000 170deg,
#8b0000 200deg,#ff1a2b 235deg,#ffb0a8 250deg,#ff1a2b 265deg,#7a0010 310deg,#3a0000 360deg)}
.fab:hover{box-shadow:0 0 24px rgba(255,30,45,.7),0 0 56px rgba(139,0,0,.6)}
.fab:active,.btn:active{transform:translateY(1px)}
:focus-visible{outline:2px solid var(--pri);outline-offset:2px}
.panel{position:fixed;left:16px;bottom:64px;z-index:2147483647;width:400px;max-width:calc(100vw - 32px);max-height:min(700px,calc(100vh - 84px));display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line);border-radius:18px;box-shadow:0 12px 40px rgba(0,0,0,.4);overflow:hidden}
.head{cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--headbg);color:var(--headink);border-bottom:3px solid var(--pri);font-weight:800;font-size:15px}
.x{border:0;background:none;color:#ddd;font-size:22px;line-height:1;cursor:pointer;padding:0 4px;border-radius:6px}
.body{padding:14px 16px 16px;overflow:auto;position:relative}
label{display:block;font-weight:700;margin:0}
.rowhead{display:flex;align-items:center;justify-content:space-between;margin:14px 0 2px;gap:8px}
.chip{background:var(--soft);color:var(--pri);font-weight:700;font-size:12px;padding:2px 10px;border-radius:999px}
textarea,.text,.select{width:100%;font:inherit;color:var(--ink);background:var(--soft);border:1.5px solid var(--line);border-radius:10px;padding:9px 10px}
textarea{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;resize:vertical}
.picker{display:flex;gap:6px;align-items:center}
.picker .select,.picker .text{flex:1;min-width:0;padding:6px 8px}
.hint{color:var(--mut);font-size:12.5px;margin:3px 0 7px}
.warn{background:var(--badbg);color:var(--bad);padding:7px 10px;border-radius:10px;font-size:12.5px;margin:8px 0}
.headline{font-size:19px;font-weight:800;margin:0 0 8px;letter-spacing:-.01em}
.summary{font-weight:700;margin:0 0 4px}
.bar{height:10px;border-radius:999px;background:var(--soft);border:1px solid var(--line);overflow:hidden}
.fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--deep),var(--pri));min-width:4px}
.tabs{display:flex;gap:4px;margin:12px 0 10px;background:var(--soft);padding:4px;border-radius:12px}
.tab{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;font:inherit;font-weight:700;font-size:12.5px;color:var(--mut);background:none;border:0;border-radius:9px;padding:6px 4px;cursor:pointer;white-space:nowrap}
.tab .n{font-size:11px;background:var(--line);color:var(--ink);border-radius:999px;padding:0 6px;min-width:18px}
.tab.on{background:var(--bg);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.25);border-bottom:2px solid var(--pri)}
.tab.on.add .n{background:var(--addbg);color:var(--add)}
.tab.on.check .n,.tab.attn .n{background:var(--chkbg);color:var(--chk)}
.tab.on.extra .n{background:var(--extbg);color:var(--ext)}
.tabpanel{max-height:300px;overflow:auto;padding-right:2px}
.people,.pairs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.person{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;background:var(--soft);border-left:4px solid var(--line)}
.people.add .person{border-left-color:var(--add);background:var(--addbg)}
.people.ok .person{border-left-color:var(--pri)}
.people.extra .person{border-left-color:var(--ink)}
.area{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:8px 0 0;font-size:12.5px;color:var(--mut)}
.area span{flex:1;min-width:150px}
.area.picking{color:var(--ink);font-weight:700;background:var(--soft);border:1.5px dashed var(--pri);border-radius:10px;padding:7px 10px}
.hl{position:fixed;z-index:2147483646;pointer-events:none;display:none;border:2px solid #ff2b3d;background:rgba(255,43,61,.12);border-radius:6px;box-shadow:0 0 14px rgba(255,43,61,.6)}
.btn.rm{padding:3px 10px;font-size:12px}
.btn.rm:hover,.btn.danger:hover{background:var(--pri);border-color:var(--pri);color:#fff}
.link{font:inherit;font-weight:700;background:none;border:0;padding:0;color:var(--pri);text-decoration:underline;cursor:pointer}
.who{flex:1;min-width:0;display:flex;flex-direction:column}
.who b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.key{font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{font-size:11.5px;font-weight:700;color:var(--mut);background:var(--bg);border-radius:999px;padding:1px 8px}
.pair{padding:10px;border-radius:12px;background:var(--chkbg);border-left:4px solid var(--chk)}
.pairtxt{display:flex;flex-direction:column;gap:3px}
.pairtxt>div{display:flex;gap:8px;align-items:baseline}
.lbl{font-size:12px;font-weight:700;color:var(--mut);min-width:68px}
.pairbtns{display:flex;gap:6px;margin-top:8px}
.card{border:1.5px solid var(--line);background:var(--soft);border-radius:14px;padding:6px 14px 10px;margin:12px 0 4px}
.big{font-size:19px;font-weight:800;margin:0 0 6px;word-break:break-word}
.empty{color:var(--mut);margin:6px 2px}
.check{display:flex;gap:8px;align-items:center;font-weight:400;margin:10px 0 0}
.wait{color:var(--mut);margin:8px 0 0}
details{margin-top:12px}
summary{cursor:pointer;font-weight:700;color:var(--mut)}
details .people{margin-top:8px}
.toast{position:absolute;left:12px;right:12px;bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--ink);color:var(--bg);padding:9px 12px;border-radius:12px;font-size:13px;box-shadow:0 6px 18px rgba(0,0,0,.3)}
.toast button{font:inherit;font-weight:800;background:none;border:0;color:inherit;text-decoration:underline;cursor:pointer}
.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.actions.left{justify-content:flex-start;margin-top:10px}
.footer{display:flex;gap:8px;margin-top:14px;align-items:center}
.grow{flex:1}
.btn{font:inherit;font-weight:700;border:1.5px solid var(--line);background:var(--bg);color:var(--ink);border-radius:999px;padding:8px 16px;cursor:pointer}
.btn.small{padding:5px 12px;font-size:12.5px}
.btn.big{width:100%;padding:11px 16px;font-size:15px}
.btn.primary{background:var(--pri);border-color:var(--pri);color:var(--onpri)}
.btn.primary:hover:not([disabled]){background:var(--deep);border-color:var(--deep)}
.btn.danger{border-color:var(--bad);color:var(--bad)}
.btn[disabled]{opacity:.45;cursor:not-allowed}
.confetti-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden}
.confetti{position:absolute;top:-12px;width:8px;height:12px;border-radius:2px;animation:fall linear forwards}
@keyframes fall{to{transform:translate(var(--drift),110vh) rotate(720deg);opacity:.9}}
@media (prefers-reduced-motion:no-preference){
  .fill{animation:grow .7s ease-out}
  @keyframes grow{from{width:0}}
  .panel{animation:pop .16s ease-out}
  .fab .ring::before{animation:spin 2.6s linear infinite}
  .fab{animation:flicker 3.2s ease-in-out infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes flicker{0%,100%{filter:brightness(1)}8%{filter:brightness(1.25)}12%{filter:brightness(.95)}45%{filter:brightness(1.1)}52%{filter:brightness(1.3)}56%{filter:brightness(1)}}
  @keyframes pop{from{opacity:0;transform:translateY(8px) scale(.98)}}
}
`;

  const host = h('div', { id: 'gcs-host' });
  const shadow = host.attachShadow({ mode: 'open' });
  const root = h('div', { class: 'root' });
  confettiLayer = h('div', { class: 'root confetti-layer', 'aria-hidden': 'true' });
  shadow.append(h('style', {}, CSS), root, confettiLayer);
  document.documentElement.append(host);

  const TITLES = {
    home: 'Group chat sync',
    review: 'Here\u2019s how it looks',
    queue: 'Adding people',
    done: 'Nice work'
  };

  let lastView = null;
  function render() {
    const oldBody = root.querySelector('.body');
    const keepScroll = oldBody && lastView === S.view ? oldBody.scrollTop : 0;
    lastView = S.view;
    root.textContent = '';
    root.append(
      h(
        'button',
        {
          class: 'fab',
          style: fabStyle(),
          title: 'Click to open. Drag to move.',
          'aria-expanded': String(S.open),
          onpointerdown: (e) => startDrag(e, () => root.querySelector('.fab'), 'fab'),
          onclick: (e) => {
            // Mouse and touch are handled by the pointer events; this is for the keyboard.
            if (e.detail !== 0) return;
            S.open = !S.open;
            render();
          }
        },
        h('span', { class: 'ring', 'aria-hidden': 'true' }),
        'Sync members'
      )
    );
    if (!S.open) return;

    const views = { home: viewHome, review: viewReview, queue: viewQueue, done: viewDone };
    const body = h('div', { class: 'body' }, views[S.view]());
    const panel = h(
      'section',
      { class: 'panel', role: 'dialog', 'aria-label': 'Group chat sync', style: panelStyle() },
      h(
        'div',
        {
          class: 'head',
          title: 'Drag to move',
          onpointerdown: (e) => {
            if (e.target.closest && e.target.closest('.x')) return;
            startDrag(e, () => root.querySelector('.panel'), 'panel');
          }
        },
        TITLES[S.view],
        h('button', { class: 'x', 'aria-label': 'Close', onclick: () => ((S.open = false), render()) }, '\u00d7')
      ),
      body
    );
    if (S.toast) {
      const t = S.toast;
      panel.append(
        h(
          'div',
          { class: 'toast', role: 'status' },
          h('span', {}, t.text),
          t.undo ? h('button', { onclick: t.undo }, 'Undo') : null
        )
      );
    }
    root.append(panel);
    body.scrollTop = keepScroll;
  }

  window.addEventListener('resize', () => {
    if (S.pos.fab || S.pos.panel) render();
  });

  load(render);

  // Exposed for tests and the demo page.
  window.__gcs = { parseRef, parseEntry, parseList, similarity, compare, buildText, slug };
})();

/*
 * Group Chat Sync Assistant: content script (v0.3)
 *
 *   1. Keep one or more saved lists of people (names, profile links, or both).
 *   2. Click "Check my list". The chat's member list is read from the page.
 *   3. See who is missing, who needs a double-check, who is all set, and who
 *      is in the chat but not on your list.
 *   4. Your "same person / different people" choices are remembered.
 *   5. Export the results as CSV, or step through the people to add.
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

  const hasLetters = (s) => /\p{L}{2,}/u.test(s);

  const norm = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
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
   * CSV
   * ===================================================================== */

  function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formulas
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildRows(r) {
    const who = (e) => e.name || e.key || '';
    const by = { id: 'ID', name: 'Name', remembered: 'Remembered choice' };
    const rows = [['Status', 'List entry', 'ID or username', 'Chat member', 'Matched by']];
    for (const t of r.unmatchedT) rows.push(['To add', who(t), t.key || '', '', '']);
    for (const p of r.probable) rows.push(['Needs a check', who(p.t), p.t.key || '', who(p.m), 'Similar name']);
    for (const m of r.unmatchedM) rows.push(['Not on list', '', m.key || '', who(m), '']);
    for (const x of r.exact) rows.push(['In chat', who(x.t), x.t.key || '', who(x.m), by[x.how]]);
    return rows;
  }

  const toCsv = (rows) => '\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');

  function downloadFile(filename, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
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
      .replace(/[^a-zA-Z0-9]+/g, '-')
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

  // Returns the members as text lines ("key | Name" or just "Name").
  function scrapeMembers() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    const scope = dialogs.length ? dialogs[dialogs.length - 1] : document.body;
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
    return lines.join('\n');
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
    tab: 'add',
    queue: [],
    qi: 0,
    added: 0,
    skipped: 0,
    wait: 0,
    toast: null
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
          [KEY]: { lists: S.lists, activeId: S.activeId, decisions: S.decisions, pace: S.pace }
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

  function recompute() {
    S.result = compare(activeList().text, S.membersSnapshot, S.decisions);
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
    const text = manual || scrapeMembers();
    if (!text) {
      S.error =
        'I couldn\u2019t see any chat members. Open the chat\u2019s Members list, scroll to the bottom, and try again.';
      S.showManual = true;
      S.view = 'home';
      render();
      return;
    }
    S.error = '';
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

  function exportCsv(btn) {
    const name = `${slug(activeList().name)}-${today()}.csv`;
    downloadFile(name, toCsv(buildRows(S.result)));
    if (btn) flash(btn, 'Saved');
    else {
      toast(`Saved ${name}`);
      render();
    }
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
    const colors = ['#5b3df5', '#14a37f', '#f0a202', '#e5484d', '#2f9be8'];
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

  function viewHome() {
    const list = activeList();
    const count = () => parseList(list.text, 't').entries.length;
    const chip = h('span', { class: 'chip' }, plural(count(), 'person', 'people'));

    const textarea = h('textarea', {
      rows: 8,
      spellcheck: 'false',
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
      h('p', { class: 'hint' }, 'Tip: open the chat\u2019s Members list first, so I can see who\u2019s in.')
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
      h('span', { class: 'who' }, h('b', {}, lab(e)), e.name && e.key ? h('span', { class: 'key' }, e.key) : null),
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
        h('div', {}, h('span', { class: 'lbl' }, 'Your list'), h('b', {}, lab(p.t))),
        h('div', {}, h('span', { class: 'lbl' }, 'In the chat'), h('b', {}, lab(p.m)))
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
    if (!r.unmatchedM.length) return h('p', { class: 'empty' }, 'Everyone in the chat is on your list.');
    return [
      h(
        'p',
        { class: 'hint' },
        'These people are in the chat but not on this list. Handy when you tidy up by hand.'
      ),
      h('ul', { class: 'people extra' }, r.unmatchedM.map((m) => personRow(m))),
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
        )
      )
    ];
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
        h('button', { class: 'btn small', onclick: (e) => exportCsv(e.target) }, 'Export CSV'),
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
        h('p', { class: 'big' }, labFull(item)),
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
        h('button', { class: 'btn small', onclick: (e) => exportCsv(e.target) }, 'Export CSV'),
        h('button', { class: 'btn primary grow', onclick: runCompare }, 'Re-check the chat')
      )
    ];
  }

  /* =====================================================================
   * Shell
   * ===================================================================== */

  const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.root{--ink:#1f2340;--mut:#656a85;--line:#e2def5;--bg:#fff;--soft:#f4f2ff;--pri:#5b3df5;--onpri:#fff;
--add:#0f8a6a;--addbg:#e0f5ee;--chk:#9a6400;--chkbg:#fff1cf;--ext:#4a5070;--extbg:#eceef7;--bad:#c62f35;--badbg:#fde8e8;
color-scheme:light dark;
font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink)}
@media (prefers-color-scheme:dark){.root{--ink:#eceeff;--mut:#a3a8c8;--line:#383c68;--bg:#1b1d33;--soft:#25284a;--pri:#8f7bff;--onpri:#12142a;
--add:#6fdcb8;--addbg:#16382f;--chk:#ffcf66;--chkbg:#3d3213;--ext:#b9bfe0;--extbg:#2b2f55;--bad:#ff9a9f;--badbg:#42202a}}
.fab{position:fixed;left:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:8px;border:2px solid var(--pri);background:var(--bg);color:var(--ink);font:inherit;font-weight:700;padding:9px 16px 9px 12px;border-radius:999px;cursor:pointer;box-shadow:0 4px 14px rgba(40,30,120,.25)}
.fab::before{content:"";width:10px;height:10px;border-radius:50%;background:var(--pri)}
.fab:active,.btn:active{transform:translateY(1px)}
:focus-visible{outline:2px solid var(--pri);outline-offset:2px}
.panel{position:fixed;left:16px;bottom:64px;z-index:2147483647;width:400px;max-width:calc(100vw - 32px);max-height:min(700px,calc(100vh - 84px));display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line);border-radius:18px;box-shadow:0 12px 40px rgba(30,20,100,.3);overflow:hidden}
.head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--soft);border-bottom:1px solid var(--line);font-weight:800;font-size:15px}
.x{border:0;background:none;color:var(--mut);font-size:22px;line-height:1;cursor:pointer;padding:0 4px;border-radius:6px}
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
.fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--pri),var(--add));min-width:4px}
.tabs{display:flex;gap:4px;margin:12px 0 10px;background:var(--soft);padding:4px;border-radius:12px}
.tab{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;font:inherit;font-weight:700;font-size:12.5px;color:var(--mut);background:none;border:0;border-radius:9px;padding:6px 4px;cursor:pointer;white-space:nowrap}
.tab .n{font-size:11px;background:var(--line);color:var(--ink);border-radius:999px;padding:0 6px;min-width:18px}
.tab.on{background:var(--bg);color:var(--ink);box-shadow:0 1px 3px rgba(30,20,100,.18)}
.tab.on.add .n{background:var(--addbg);color:var(--add)}
.tab.on.check .n,.tab.attn .n{background:var(--chkbg);color:var(--chk)}
.tab.on.extra .n{background:var(--extbg);color:var(--ext)}
.tabpanel{max-height:300px;overflow:auto;padding-right:2px}
.people,.pairs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.person{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;background:var(--soft);border-left:4px solid var(--line)}
.people.add .person{border-left-color:var(--add);background:var(--addbg)}
.people.ok .person{border-left-color:var(--pri)}
.people.extra .person{border-left-color:var(--ext)}
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
.btn.danger{border-color:var(--bad);color:var(--bad)}
.btn[disabled]{opacity:.45;cursor:not-allowed}
.confetti-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden}
.confetti{position:absolute;top:-12px;width:8px;height:12px;border-radius:2px;animation:fall linear forwards}
@keyframes fall{to{transform:translate(var(--drift),110vh) rotate(720deg);opacity:.9}}
@media (prefers-reduced-motion:no-preference){
  .fill{animation:grow .7s ease-out}
  @keyframes grow{from{width:0}}
  .panel{animation:pop .16s ease-out}
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
          'aria-expanded': String(S.open),
          onclick: () => {
            S.open = !S.open;
            render();
          }
        },
        'Sync members'
      )
    );
    if (!S.open) return;

    const views = { home: viewHome, review: viewReview, queue: viewQueue, done: viewDone };
    const body = h('div', { class: 'body' }, views[S.view]());
    const panel = h(
      'section',
      { class: 'panel', role: 'dialog', 'aria-label': 'Group chat sync' },
      h(
        'div',
        { class: 'head' },
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

  load(render);

  // Exposed for tests and the demo page.
  window.__gcs = { parseRef, parseEntry, parseList, similarity, compare, buildRows, toCsv, csvCell, slug };
})();

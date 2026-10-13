// Run: node test.js   (tests the pure logic only)
global.window = { addEventListener() {}, innerWidth: 1000, innerHeight: 800 };
global.document = {
  documentElement: { append() {} },
  createElement() { return { attachShadow() { return { append() {} }; }, append() {}, setAttribute() {}, addEventListener() {}, nodeType: 1, textContent: '', querySelector() { return null; } }; },
  querySelectorAll() { return []; },
  createTextNode(t) { return { nodeType: 3, t }; }
};
require('./content.js');
const { parseRef, parseEntry, similarity, compare, buildText, slug } = window.__gcs;
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, JSON.stringify(a), JSON.stringify(b)); process.exitCode = 1; } else console.log('ok  ', m); };
const names = (arr, side) => arr.map((x) => (x[side] || x).name || (x[side] || x).key);

// parseRef
eq(parseRef('100012345678901'), '100012345678901', 'numeric id');
eq(parseRef('https://www.facebook.com/profile.php?id=100012345678901&ref=x'), '100012345678901', 'profile.php url');
eq(parseRef('facebook.com/Some.User'), 'some.user', 'username url, lowercased');
eq(parseRef('https://www.facebook.com/people/Jane-Doe/100012345678901/'), '100012345678901', 'people url');
eq(parseRef('https://www.messenger.com/t/123456789'), null, 'messenger thread url rejected');
eq(parseRef('lena.petrova'), 'lena.petrova', 'bare username with dot');
eq(parseRef('Alexander'), null, 'plain word is a name, not a username');

// parseEntry
eq(parseEntry('Lena Petrova'), { key: null, name: 'Lena Petrova' }, 'name only');
eq(parseEntry('Daniel Okafor | facebook.com/profile.php?id=100000000002'), { key: '100000000002', name: 'Daniel Okafor' }, 'name | link');
eq(parseEntry('https://fb.me/abc'), null, 'unsupported short link rejected');

// similarity
eq(similarity('Tomás Rivera', 'Tomas Rivera'), 1, 'accents ignored');
eq(similarity('Petrova Lena', 'Lena Petrova'), 1, 'word order ignored');
eq(similarity('Priya Nair', 'Random Person') < 0.8, true, 'unrelated names stay apart');

// compare
const targets = ['100000000001 | Amina Rahman', 'lena petrova', 'Tomas Rivera', 'Daniel Okafor | facebook.com/profile.php?id=100000000002', 'Priya Nair', 'Jon Smith', 'Sam Lee | 100000000050'].join('\n');
const members = ['100000000001 | Amina Rahman', 'Lena Petrova', 'Tomás Rivera', '100000000002 | Daniel Okafor', 'Random Person', 'John Smith', '100000000051 | Sam Lee'].join('\n');
const r = compare(targets, members);
eq(r.exact.map((x) => x.how + ':' + x.m.name).sort(), ['id:Amina Rahman', 'id:Daniel Okafor', 'name:Lena Petrova', 'name:Tomás Rivera'], 'exact matches (id and name)');
eq(r.probable.map((p) => p.t.name + '~' + p.m.name), ['Jon Smith~John Smith'], 'close names flagged to check');
eq(r.probable[0].pk, 'jon smith~john smith', 'pair key is normalized names');
eq(names(r.unmatchedT, 't').sort(), ['Priya Nair', 'Sam Lee'], 'to add (different IDs are different people)');
eq(names(r.unmatchedM, 'm').sort(), ['Random Person', 'Sam Lee'], 'not on list');

// remembered decisions
const same = compare(targets, members, { 'jon smith~john smith': 'same' });
eq(same.probable.length, 0, 'remembered "same" removes the question');
eq(same.exact.filter((x) => x.how === 'remembered').map((x) => x.t.name), ['Jon Smith'], 'remembered "same" counts as matched');
eq(same.remembered.map((x) => x.decision), ['same'], 'remembered list reports it');
const diff = compare(targets, members, { 'jon smith~john smith': 'different' });
eq(diff.probable.length, 0, 'remembered "different" removes the question');
eq(names(diff.unmatchedT, 't').includes('Jon Smith'), true, 'remembered "different" puts them in to-add');
eq(names(diff.unmatchedM, 'm').includes('John Smith'), true, 'remembered "different" puts the member in not-on-list');
const alias = compare('Bob Chen', 'Robert Chen', { 'bob chen~robert chen': 'same' });
eq([alias.exact.length, alias.unmatchedT.length], [1, 0], 'remembered "same" works for nicknames with low similarity');
const bothIds = compare('Sam Lee | 100000000050', 'Sam Lee | 100000000051', { 'sam lee~sam lee': 'same' });
eq(bothIds.exact.length, 0, 'different IDs are never merged, even by a remembered choice');

// ambiguity
const amb = compare('John Smith', 'John Smith\nJohn  smith!');
eq([amb.exact.length, amb.probable.length], [0, 1], 'duplicate names go to "check", not auto-matched');

// warning counters
const w = compare('100000000001\n100000000002', 'Amina Rahman\nDaniel Okafor');
eq([w.nameless, w.keylessMembers], [2, 2], 'link-only entries flagged when members have no IDs');

// text export
const txt = buildText(r, 'Volunteers', '2026-10-14');
eq(txt.startsWith('Group Chat Sync: Volunteers\nDate: 2026-10-14'), true, 'text header');
eq(['TO ADD (2)', 'NEEDS A CHECK (1)', 'NOT ON LIST (2)', 'IN CHAT (4)'].every((x) => txt.includes(x)), true, 'text has all four sections with counts');
eq(txt.includes('  - Priya Nair') && txt.includes('  - Random Person'), true, 'text lists people');
eq(buildText(compare('A Person', 'A Person'), 'x', 'd').includes('TO ADD (0)\n----------\n  (nobody)'), true, 'empty section says nobody');
eq(slug('Class of 2024 – Volunteers!'), 'class-of-2024-volunteers', 'file name slug');

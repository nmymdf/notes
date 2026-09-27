// Unit tests for the sync merge rules: node test/sync-merge.test.js
const assert = require('assert');
const { mergeData } = require('../src/renderer/sync-merge.js');

const note = (id, rev, extra = {}) => ({ id, title: id, html: `<div>${id}</div>`, text: id, folderId: null, rev, updatedAt: rev, createdAt: 1, deletedAt: null, ...extra });
const data = (notes = [], folders = [], tombstones = {}) => ({ notes, folders, tombstones });
const ids = (d) => d.notes.map((n) => n.id).sort();
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('PASS', name); };

test('identical data → nothing changes', () => {
  const m = mergeData(data([note('a', 10)]), data([note('a', 10)]));
  assert.deepStrictEqual(ids(m.data), ['a']);
  assert.strictEqual(m.toLocal + m.toRemote, 0);
});

test('only on one side → copied to the other', () => {
  const m = mergeData(data([note('a', 10)]), data([note('b', 20)]));
  assert.deepStrictEqual(ids(m.data), ['a', 'b']);
  assert.strictEqual(m.toLocal, 1);
  assert.strictEqual(m.toRemote, 1);
});

test('newer version wins (remote newer)', () => {
  const m = mergeData(data([note('a', 10)]), data([note('a', 20, { html: 'new' })]), { lastSync: 15 });
  assert.strictEqual(m.data.notes[0].html, 'new');
  assert.strictEqual(m.conflicts, 0, 'only remote changed since last sync → no conflict copy');
  assert.strictEqual(m.toLocal, 1);
});

test('both changed content since last sync → newer wins, older goes to trash', () => {
  const m = mergeData(data([note('a', 30, { html: 'phone' })]), data([note('a', 20, { html: 'pc' })]), { lastSync: 15, now: 99 });
  const live = m.data.notes.filter((n) => !n.deletedAt);
  const trash = m.data.notes.filter((n) => n.deletedAt);
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0].html, 'phone');
  assert.strictEqual(trash.length, 1);
  assert.strictEqual(trash[0].html, 'pc');
  assert.notStrictEqual(trash[0].id, 'a');
  assert.strictEqual(m.conflicts, 1);
});

test('both changed only metadata (color) → newer wins, no trash copy', () => {
  const m = mergeData(data([note('a', 30, { color: 'red' })]), data([note('a', 20, { color: 'green' })]), { lastSync: 15 });
  assert.strictEqual(m.data.notes.length, 1);
  assert.strictEqual(m.data.notes[0].color, 'red');
});

test('first sync (lastSync 0) with different content → conflict copy kept', () => {
  const m = mergeData(data([note('a', 30, { html: 'x' })]), data([note('a', 20, { html: 'y' })]));
  assert.strictEqual(m.data.notes.length, 2);
});

test('trashed on one side (newer) → trashed on both', () => {
  const m = mergeData(data([note('a', 10)]), data([note('a', 20, { deletedAt: 20 })]), { lastSync: 15 });
  assert.strictEqual(m.data.notes[0].deletedAt, 20);
});

test('permanently deleted (tombstone newer) → removed', () => {
  const m = mergeData(data([note('a', 10)]), data([], [], { a: 20 }), { lastSync: 15, now: 100 });
  assert.deepStrictEqual(ids(m.data), []);
  assert.strictEqual(m.data.tombstones.a, 20);
  assert.strictEqual(m.toLocal, 1);
});

test('edited after the other side deleted it → edit wins', () => {
  const m = mergeData(data([note('a', 30)]), data([], [], { a: 20 }), { now: 100 });
  assert.deepStrictEqual(ids(m.data), ['a']);
});

test('moved back out of the vault (tombstone older than note) → kept', () => {
  const m = mergeData(data([note('a', 50)], [], { a: 40 }), data([note('a', 10)], [], {}), { now: 100 });
  assert.deepStrictEqual(ids(m.data), ['a']);
});

test('folders merge; notes in a removed folder become uncategorised', () => {
  const f = (id, rev, parentId = null) => ({ id, name: id, parentId, rev, createdAt: 1 });
  const m = mergeData(
    data([note('a', 10, { folderId: 'F' })], [f('F', 10), f('S', 10, 'F')]),
    data([note('a', 10, { folderId: 'F' })], [f('S', 10, 'F')], { F: 20 }),
    { lastSync: 15, now: 100 },
  );
  assert.deepStrictEqual(m.data.folders.map((x) => x.id), ['S']);
  assert.strictEqual(m.data.folders[0].parentId, null, 'orphan subfolder becomes top level');
  assert.strictEqual(m.data.notes[0].folderId, null);
});

test('inputs are not mutated', () => {
  const local = data([note('a', 10, { folderId: 'gone' })]);
  const snapshot = JSON.stringify(local);
  mergeData(local, data());
  assert.strictEqual(JSON.stringify(local), snapshot);
});

test('old tombstones are forgotten after a year', () => {
  const now = 400 * 86400000;
  const m = mergeData(data([], [], { old: 1, recent: now - 1000 }), data(), { now });
  assert.deepStrictEqual(Object.keys(m.data.tombstones), ['recent']);
});

console.log(`\n${passed} tests passed`);

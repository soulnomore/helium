// Run with node --test devutils/tests/tab_folders.test.mjs.
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../resources/tab_folders/worker.js', import.meta.url), 'utf8');

function storageArea() {
  const data = {};
  return {
    async get(keys) {
      if (typeof keys === 'string') return structuredClone({[keys]: data[keys]});
      return structuredClone({...keys, ...data});
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
  };
}

function browser(tabs, local = storageArea()) {
  const events = {};
  for (const name of ['onCreated', 'onUpdated', 'onAttached', 'onDetached', 'onMoved', 'onRemoved', 'onReplaced']) {
    events[name] = {addListener(callback) { this.callback = callback; }};
  }
  const session = storageArea();
  let listener;
  const panel = 'chrome-extension://test/panel.html';
  const chrome = {
    tabs: {...events, async query({windowId}) { return tabs.filter(t => !windowId || t.windowId === windowId); }},
    windows: {
      async get(id) { return {id, type: 'normal'}; },
      async getAll() {
        return [...new Set(tabs.map(t => t.windowId))].map(id => ({id, tabs: tabs.filter(t => t.windowId === id)}));
      },
    },
    storage: {local, session},
    sidePanel: {setPanelBehavior() {}},
    runtime: {
      id: 'test',
      getURL: () => panel,
      onMessage: {addListener(cb) { listener = cb; }},
    },
  };
  vm.runInNewContext(source, {chrome, crypto: webcrypto, TextEncoder, URL});
  function send(op, fields) {
    return new Promise((resolve, reject) => {
      listener({op, windowId: 1, ...fields}, {id: 'test', url: panel}, reply => {
        if (reply.error) reject(Error(reply.error));
        else resolve(reply.value);
      });
    });
  }
  return {send, events, local};
}

test('restore keeps navigated, duplicate and closed saved tabs distinct', async () => {
  const home = 'https://example.test/home';
  const article = 'https://example.test/article';
  const closed = 'https://example.test/closed';
  const tabs = [home, home, home, closed, closed].map((url, index) => ({
    id: index + 10, windowId: 1, index, url, title: 'Page',
  }));
  const initial = browser(tabs);
  const parent = await initial.send('create', {title: 'Reading'});
  for (const tabId of [10, 12, 13]) await initial.send('save', {tabId, parent});
  const {bindings} = await initial.send('snapshot');
  tabs[0].url = article;
  initial.events.onUpdated.callback(10, {url: article}, tabs[0]);
  tabs.splice(3, 1);
  tabs[3].index = 3;
  await initial.events.onRemoved.callback(13, {windowId: 1, isWindowClosing: false});
  await initial.send('snapshot');

  // Chromium gives the restored tabs and window new session IDs.
  const next = browser(tabs.map(t => ({...t, windowId: 2, id: t.id + 100})), initial.local);
  const after = await next.send('snapshot', {windowId: 2});
  assert.equal(after.bindings[110], bindings[10]);
  assert.equal(after.bindings[111], undefined);
  assert.equal(after.bindings[112], bindings[12]);
  assert.equal(after.bindings[114], undefined);
  assert.equal(after.nodes.find(n => n.id === bindings[10]).url, home);
  assert.equal(after.nodes.find(n => n.id === bindings[13]).parent, parent);
});

test('moving and unpacking nested folders preserves order and rejects cycles', async () => {
  const {send} = browser([]);
  const first = await send('create', {title: 'First'});
  const last = await send('create', {title: 'Last'});
  const parent = await send('create', {title: 'Parent', before: last});
  const child = await send('create', {title: 'Child', parent});
  await assert.rejects(send('move', {id: parent, parent: child}), /contain itself/);
  await send('unpack', {id: parent});
  const {nodes} = await send('snapshot');
  assert.deepEqual(Array.from(nodes, n => n.id), [first, child, last]);
  assert.ok(nodes.every(n => n.parent === null));
});

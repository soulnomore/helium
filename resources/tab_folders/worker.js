// Folder order and home URLs live in the profile. Live tab IDs are scoped to
// the browser session and may be reused after a restart.
const treeKey = 'folderTree';
const bindingKey = 'folderTabs';
let pending = Promise.resolve();

function serialize(fn) {
  const result = pending.then(fn);
  pending = result.catch(() => {});
  return result;
}

chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true});

function homeUrl(tab) {
  const url = tab.pendingUrl || tab.url;
  if (!url) return null;
  const parsed = new URL(url);
  if (['http:', 'https:', 'file:'].includes(parsed.protocol) ||
      url === 'about:blank' || /^(chrome|helium):\/\/newtab\/?$/.test(url)) {
    return url;
  }
  return null;
}

// Store only a digest of the last live URL. The saved home URL stays intact
// when a tab navigates, and closed saved rows have no restoration record.
const restoreKey = 'restoreSlots';
async function urlDigest(tab) {
  const bytes = new TextEncoder().encode(tab.pendingUrl || tab.url || '');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readSlots() {
  return (await chrome.storage.local.get({[restoreKey]: {}}))[restoreKey];
}

async function windowSlots(windowId, bindings) {
  const slots = {};
  const tabs = await chrome.tabs.query({windowId});
  for (const tab of tabs) {
    if (bindings[tab.id] && !tab.incognito) {
      slots[tab.id] = {node: bindings[tab.id], windowId, index: tab.index, url: await urlDigest(tab)};
    }
  }
  return slots;
}

async function remember(windowId, bindings, nodes) {
  const slots = await readSlots();
  const ids = nodes && new Set(nodes.map(n => n.id));
  for (const [id, slot] of Object.entries(slots)) {
    if (slot.windowId === windowId || (ids && !ids.has(slot.node))) delete slots[id];
  }
  Object.assign(slots, await windowSlots(windowId, bindings));
  await chrome.storage.local.set({[restoreKey]: slots});
}

async function getBindings(nodes) {
  const stored = await chrome.storage.session.get(bindingKey);
  if (stored[bindingKey]) return stored[bindingKey];
  const bindings = {};
  const slots = Object.values(await readSlots()).filter(s => nodes.some(n => n.id === s.node));
  if (slots.length) {
    const windows = await chrome.windows.getAll({populate: true, windowTypes: ['normal']});
    const matches = [];
    for (const win of windows.filter(w => !w.incognito)) {
      const digests = await Promise.all(win.tabs.map(urlDigest));
      for (const old of new Set(slots.map(s => s.windowId))) {
        const pairs = [];
        for (const slot of slots.filter(s => s.windowId === old)) {
          // Equal URLs can belong to different tabs. Use their saved positions
          // and leave ambiguous matches alone.
          const same = win.tabs.filter((tab, i) => digests[i] === slot.url);
          const atIndex = same.find(tab => tab.index === slot.index);
          const tab = atIndex || (same.length === 1 ? same[0] : null);
          if (tab) pairs.push({tab, slot, exact: Boolean(atIndex)});
        }
        if (pairs.length) matches.push({old, win, pairs,
          score: pairs.reduce((sum, p) => sum + (p.exact ? 3 : 1), 0)});
      }
    }
    // Pair windows one-to-one, starting with the strongest match. Within a
    // window, exact positions take precedence over URL-only matches.
    const oldWindows = new Set();
    const newWindows = new Set();
    for (const match of matches.sort((a, b) => b.score - a.score)) {
      if (oldWindows.has(match.old) || newWindows.has(match.win.id)) continue;
      for (const {tab, slot} of match.pairs.sort((a, b) => b.exact - a.exact)) {
        bindings[tab.id] ??= slot.node;
      }
      oldWindows.add(match.old);
      newWindows.add(match.win.id);
    }
    const restored = {};
    for (const id of newWindows) Object.assign(restored, await windowSlots(id, bindings));
    await chrome.storage.local.set({[restoreKey]: restored});
  }
  await chrome.storage.session.set({[bindingKey]: bindings});
  return bindings;
}

async function handle(request) {
  const {op, id, windowId} = request;
  if (!Number.isInteger(windowId)) throw Error('The browser window is unavailable.');
  const win = await chrome.windows.get(windowId);
  if (win.incognito || win.type !== 'normal') throw Error('Open folders in a regular window.');

  const stored = await chrome.storage.local.get({[treeKey]: []});
  const nodes = stored[treeKey];
  const bindings = await getBindings(nodes);
  const tabs = await chrome.tabs.query({windowId});
  const lookup = id => nodes.find(n => n.id === id);
  const node = lookup(id);
  const live = tabs.find(t => bindings[t.id] === id && node);
  if (op === 'snapshot') {
    const local = Object.fromEntries(tabs.filter(t => bindings[t.id]).map(t => [t.id, bindings[t.id]]));
    return {nodes, bindings: local, tabs: tabs.map(({id, active, title, url, favIconUrl, pinned}) =>
      ({id, active, title, url, favIconUrl, pinned}))};
  }

  const parentId = request.parent ?? null;
  const parent = lookup(parentId);
  function insert(item) {
    if (parentId !== null && (!parent || parent.url)) throw Error('The destination folder has moved.');
    for (let p = parent; p; p = lookup(p.parent)) {
      if (p.id === item.id) throw Error('A folder cannot contain itself.');
    }
    if (request.before === item.id) return;
    const before = lookup(request.before);
    if (request.before && (!before || before.parent !== parentId)) {
      throw Error('The destination has changed.');
    }
    const old = nodes.indexOf(item);
    if (old !== -1) nodes.splice(old, 1);
    item.parent = parentId;
    nodes.splice(before ? nodes.indexOf(before) : nodes.length, 0, item);
    if (parent) parent.collapsed = false;
  }
  function title() {
    const value = request.title?.trim();
    if (!value) throw Error('Enter a name.');
    return value;
  }
  function currentTab() {
    const tab = tabs.find(t => t.id === request.tabId);
    if (!tab) throw Error('This tab is no longer in this window.');
    return tab;
  }
  async function activate() {
    if (live) return chrome.tabs.update(live.id, {active: true});
    const tab = await chrome.tabs.create({windowId, url: node.url, active: true});
    bindings[tab.id] = id;
    return tab;
  }
  function forget() {
    nodes.splice(nodes.indexOf(node), 1);
    for (const [tabId, saved] of Object.entries(bindings)) {
      if (saved === id) delete bindings[tabId];
    }
  }

  if (!['create', 'save', 'activate', 'close', 'reorder'].includes(op) && !node) {
    throw Error('This item has already been removed.');
  }
  let result;
  let treeChanged = true;
  switch (op) {
    case 'create': {
      result = crypto.randomUUID();
      insert({id: result, title: title(), collapsed: false});
      break;
    }
    case 'save': {
      const tab = currentTab();
      const existing = lookup(bindings[tab.id]);
      if (existing) {
        insert(existing);
      } else {
        const url = homeUrl(tab);
        if (!url) throw Error('This page cannot be saved in a folder.');
        const item = {id: crypto.randomUUID(), title: tab.title || url, url};
        insert(item);
        bindings[tab.id] = item.id;
      }
      break;
    }
    case 'move': insert(node); break;
    case 'rename': node.title = title(); break;
    case 'toggle':
      if (node.url) throw Error('Choose a folder.');
      node.collapsed = !node.collapsed;
      break;
    case 'unpack': {
      if (node.url) throw Error('Choose a folder.');
      const children = nodes.filter(n => n.parent === id);
      let index = nodes.indexOf(node);
      for (const child of children) {
        const previous = nodes.indexOf(child);
        nodes.splice(previous, 1);
        if (previous < index) index--;
        child.parent = node.parent;
        nodes.splice(index++, 0, child);
      }
      forget();
      break;
    }
    case 'open':
      if (!node.url) throw Error('Choose a saved tab.');
      await activate();
      treeChanged = false;
      break;
    case 'release':
      if (!node.url) throw Error('Choose a saved tab.');
      await activate();
      forget();
      break;
    case 'remove':
      if (!node.url) throw Error('Unpack the folder first.');
      forget();
      break;
    case 'activate': await chrome.tabs.update(currentTab().id, {active: true}); return;
    case 'close': await chrome.tabs.remove(currentTab().id); return;
    case 'reorder': {
      const source = currentTab();
      const target = tabs.find(t => t.id === request.targetId);
      if (!target || target.pinned !== source.pinned) throw Error('Choose a tab in the same pinned section.');
      const index = target.index + Number(Boolean(request.after)) - Number(source.index < target.index);
      await chrome.tabs.move(source.id, {windowId, index});
      return;
    }
    default: throw Error('Unknown folder action.');
  }
  if (treeChanged) await chrome.storage.local.set({[treeKey]: nodes});
  await chrome.storage.session.set({[bindingKey]: bindings});
  await remember(windowId, bindings, nodes);
  return result;
}

chrome.runtime.onMessage.addListener((request, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url?.split('?')[0] !== chrome.runtime.getURL('panel.html')) {
    return false;
  }
  serialize(() => handle(request)).then(value => reply({value}), e => reply({error: e.message}));
  return true;
});

async function trackWindow(windowId) {
  const data = await chrome.storage.session.get(bindingKey);
  if (!data[bindingKey] || !Object.keys(data[bindingKey]).length) return;
  await remember(windowId, data[bindingKey]);
}

chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.url && !tab.incognito) serialize(async () => {
    const bindings = (await chrome.storage.session.get(bindingKey))[bindingKey];
    if (bindings?.[id]) await remember(tab.windowId, bindings);
  });
});
chrome.tabs.onCreated.addListener(tab => {
  if (!tab.incognito) serialize(() => trackWindow(tab.windowId));
});
chrome.tabs.onMoved.addListener((id, info) => serialize(() => trackWindow(info.windowId)));
chrome.tabs.onDetached.addListener((id, info) => serialize(() => trackWindow(info.oldWindowId)));
chrome.tabs.onAttached.addListener((id, info) => serialize(async () => {
  const bindings = (await chrome.storage.session.get(bindingKey))[bindingKey];
  if (!bindings) return;
  // A saved row may already be open in the destination window. Keep the
  // arriving tab visible as an ordinary tab in that case.
  const others = await chrome.tabs.query({windowId: info.newWindowId});
  if (bindings[id] && others.some(t => t.id !== id && bindings[t.id] === bindings[id])) {
    delete bindings[id];
    await chrome.storage.session.set({[bindingKey]: bindings});
  }
  await remember(info.newWindowId, bindings);
}));
chrome.tabs.onRemoved.addListener((id, info) => serialize(async () => {
  const bindings = (await chrome.storage.session.get(bindingKey))[bindingKey];
  if (!bindings) return;
  if (bindings[id]) {
    delete bindings[id];
    await chrome.storage.session.set({[bindingKey]: bindings});
  }
  // Chrome closes tabs one by one at shutdown. Keep the final open positions
  // for session restore, including tabs that close early in that sequence.
  if (!info.isWindowClosing) await remember(info.windowId, bindings);
}));
chrome.tabs.onReplaced.addListener((added, removed) => serialize(async () => {
  const bindings = (await chrome.storage.session.get(bindingKey))[bindingKey];
  if (!bindings?.[removed]) return;
  bindings[added] = bindings[removed];
  delete bindings[removed];
  await chrome.storage.session.set({[bindingKey]: bindings});
  const tab = await chrome.tabs.get(added);
  await remember(tab.windowId, bindings);
}));

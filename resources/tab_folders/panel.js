const $ = selector => document.querySelector(selector);
const folders = $('#folders');
const tabsList = $('#tabs');
const menu = $('#menu');
const moveDialog = $('#move-dialog');
let data = {nodes: [], tabs: [], bindings: {}};
let edit = null;
let drag = null;
let menuRow = null;
let moveItem = null;
let generation = 0;
let errorTimer;

const windowId = (await chrome.windows.getCurrent()).id;

async function call(op, fields = {}) {
  const reply = await chrome.runtime.sendMessage({...fields, op, windowId});
  if (!reply || reply.error) throw Error(reply?.error || 'The folder service is unavailable.');
  return reply.value;
}

function report(error) {
  const status = $('#status');
  status.textContent = error.message;
  status.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { status.hidden = true; }, 4500);
}

async function act(op, fields) {
  try {
    const result = await call(op, fields);
    await refresh();
    return result;
  } catch (error) {
    report(error);
  }
}

async function refresh() {
  const request = ++generation;
  try {
    const next = await call('snapshot');
    if (request !== generation) return;
    data = next;
    if (!edit && !drag && menu.hidden && !moveDialog.open) render();
  } catch (error) {
    report(error);
  }
}

function icon(name, style = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  svg.setAttribute('class', style);
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', '#' + name);
  svg.append(use);
  return svg;
}

function button(glyph, name, callback) {
  const el = document.createElement('button');
  el.className = 'icon-button';
  el.title = name;
  el.setAttribute('aria-label', name);
  el.append(icon(glyph));
  el.onclick = event => { event.stopPropagation(); callback(el); };
  return el;
}

function favicon(url) {
  if (!url || !/^https?:/i.test(url)) return icon('globe', 'glyph');
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  const cached = new URL(chrome.runtime.getURL('/_favicon/'));
  cached.searchParams.set('pageUrl', url);
  cached.searchParams.set('size', '16');
  img.src = cached.href;
  img.onerror = () => img.replaceWith(icon('globe', 'glyph'));
  return img;
}

function children(parent) { return data.nodes.filter(n => n.parent === parent); }
function lookup(id) { return data.nodes.find(n => n.id === id); }
function rowById(id) { return document.querySelector('.row[data-id="' + CSS.escape(String(id)) + '"]'); }
function attached(id) { return data.tabs.find(t => data.bindings[t.id] === id); }

function hasAncestor(id, parent) {
  for (let n = lookup(id); n; n = lookup(n.parent)) if (n.id === parent) return true;
  return false;
}

function bindRow(item, kind, depth, live) {
  const row = document.createElement('div');
  row.setAttribute('role', 'treeitem');
  row.tabIndex = 0;
  row.className = 'row';
  row.dataset.kind = kind;
  row.dataset.id = item.id;
  row.style.setProperty('--depth', depth);
  row.setAttribute('aria-level', depth + 1);
  row.setAttribute('aria-label', item.title || item.url || 'New tab');
  row.draggable = true;
  const folder = kind === 'folder';
  if (folder) {
    row.setAttribute('aria-expanded', !item.collapsed);
    row.append(icon('next', 'chevron'), icon(item.collapsed ? 'folder' : 'folder-open', 'glyph'));
    const active = data.tabs.find(t => t.active);
    row.classList.toggle('has-active', Boolean(item.collapsed && active && hasAncestor(data.bindings[active.id], item.id)));
  } else {
    row.setAttribute('aria-selected', Boolean(live?.active));
    row.classList.toggle('active', Boolean(live?.active));
    row.append(favicon(live?.url || item.url));
  }
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = item.title || item.url || 'New tab';
  row.title = folder ? item.title : (live?.url || item.url || '');
  row.append(title);
  if (live) row.append(button('close', 'Close tab', () => act('close', {tabId: live.id})));
  row.append(button('more', 'More options', el => {
    const rect = el.getBoundingClientRect();
    showMenu(row, rect.right, rect.bottom);
  }));
  row.onclick = () => {
    row.focus();
    if (folder) act('toggle', {id: item.id});
    else if (kind === 'saved') act('open', {id: item.id});
    else act('activate', {tabId: item.id});
  };
  row.oncontextmenu = event => { event.preventDefault(); showMenu(row, event.clientX, event.clientY); };
  return row;
}

function render() {
  const previous = document.activeElement.closest('.row')?.dataset.id;
  folders.replaceChildren();
  tabsList.replaceChildren();
  function branch(parent, depth, container) {
    for (const node of children(parent)) {
      const row = bindRow(node, node.url ? 'saved' : 'folder', depth, attached(node.id));
      container.append(row);
      if (!node.url && !node.collapsed) {
        const group = document.createElement('div');
        group.id = 'children-' + node.id;
        group.setAttribute('role', 'group');
        row.setAttribute('aria-owns', group.id);
        container.append(group);
        branch(node.id, depth + 1, group);
      }
    }
  }
  branch(null, 0, folders);
  for (const tab of data.tabs) {
    if (!lookup(data.bindings[tab.id])) tabsList.append(bindRow(tab, 'tab', 0, tab));
  }
  $('#empty').hidden = Boolean(data.nodes.length);
  if (previous) rowById(previous)?.focus({preventScroll: true});
}

function startEdit(parent, item = null) {
  if (edit) return;
  const row = item ? rowById(item.id) : document.createElement('div');
  const input = document.createElement('input');
  input.className = 'editor';
  input.setAttribute('aria-label', item ? 'Rename' : 'Folder name');
  input.placeholder = 'Folder name';
  input.value = item?.title || '';
  if (item) {
    row.replaceChildren(icon(item.url ? 'globe' : 'folder', 'glyph'), input);
  } else {
    const parentRow = parent && rowById(parent);
    if (parentRow) parentRow.after(row);
    else folders.append(row);
    row.className = 'row';
    const depth = parentRow ? Number(parentRow.getAttribute('aria-level')) : 0;
    row.style.setProperty('--depth', depth);
    row.append(icon('folder', 'glyph'), input);
  }
  edit = input;
  row.onclick = null;
  row.draggable = false;
  $('#empty').hidden = true;
  async function finish(commit) {
    if (edit !== input) return;
    edit = null;
    const title = input.value.trim();
    render();
    if (commit && title) {
      const newId = await act(item ? 'rename' : 'create', {parent, id: item?.id, title});
      rowById(item?.id || newId)?.focus();
    } else if (item || parent) {
      rowById(item?.id || parent)?.focus();
    } else {
      $('#new-folder').focus();
    }
  }
  input.onblur = () => finish(true);
  input.onkeydown = event => {
    event.stopPropagation();
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault();
      finish(event.key === 'Enter');
    }
  };
  input.focus();
  input.select();
}

function closeMenu() {
  menu.hidden = true;
  menuRow?.classList.remove('menu-open');
  menuRow = null;
}

function chooseMove(row) {
  moveItem = {...row.dataset};
  const select = $('#destination');
  select.replaceChildren(new Option('Top level', ''));
  function options(parent, prefix) {
    for (const folder of children(parent).filter(n => !n.url && n.id !== moveItem.id)) {
      const path = prefix + folder.title;
      select.add(new Option(path, folder.id));
      options(folder.id, path + ' / ');
    }
  }
  options(null, '');
  select.value = lookup(moveItem.id)?.parent || '';
  moveDialog.showModal();
}

moveDialog.onclose = () => {
  if (moveDialog.returnValue === 'move' && moveItem) {
    moveTo(moveItem, $('#destination').value || null);
  }
  moveItem = null;
  render();
};

function showMenu(row, x, y) {
  closeMenu();
  const {kind, id} = row.dataset;
  const node = lookup(id);
  menuRow = row;
  row.classList.add('menu-open');
  menu.replaceChildren();
  function option(name, fn) {
    const el = document.createElement('button');
    el.textContent = name;
    el.setAttribute('role', 'menuitem');
    el.onclick = () => { closeMenu(); row.focus(); fn(); };
    menu.append(el);
  }
  if (kind === 'folder') option('New subfolder', () => startEdit(id));
  if (node) option('Rename', () => startEdit(node.parent, node));
  option('Move to…', () => chooseMove(row));
  if (kind === 'saved') {
    option('Move to open tabs', () => act('release', {id}));
    option('Remove saved tab', () => act('remove', {id}));
  }
  if (kind === 'folder') option(children(id).length ? 'Unpack folder' : 'Delete folder', () => act('unpack', {id}));
  if (kind === 'tab') option('Close tab', () => act('close', {tabId: Number(id)}));
  menu.hidden = false;
  menu.style.left = Math.max(2, Math.min(x, innerWidth - menu.offsetWidth - 2)) + 'px';
  menu.style.top = Math.max(2, Math.min(y, innerHeight - menu.offsetHeight - 2)) + 'px';
  menu.firstElementChild.focus();
}

document.addEventListener('pointerdown', event => {
  if (!menu.hidden && !menu.contains(event.target)) closeMenu();
});
menu.onkeydown = event => {
  const items = [...menu.children];
  const index = items.indexOf(document.activeElement);
  if (event.key === 'Escape' || event.key === 'Tab') {
    const row = menuRow;
    closeMenu();
    row?.focus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  }
};
document.addEventListener('keydown', event => {
  const row = event.target.closest('.row');
  if (!row || event.target !== row || edit) return;
  const {kind, id} = row.dataset;
  const node = lookup(id);
  const rows = [...document.querySelectorAll('.row')];
  const index = rows.indexOf(row);
  switch (event.key) {
    case 'ArrowDown': rows[index + 1]?.focus(); break;
    case 'ArrowUp': rows[index - 1]?.focus(); break;
    case 'Home': rows[0].focus(); break;
    case 'End': rows.at(-1).focus(); break;
    case 'ArrowLeft':
      if (kind === 'folder' && !node.collapsed) act('toggle', {id});
      else if (node?.parent) rowById(node.parent)?.focus();
      break;
    case 'ArrowRight':
      if (kind === 'folder' && node.collapsed) act('toggle', {id});
      else if (kind === 'folder' && children(id).length) rowById(children(id)[0].id)?.focus();
      break;
    case ' ': case 'Enter': row.click(); break;
    case 'F2': if (node) startEdit(node.parent, node); break;
    case 'ContextMenu': {
      const rect = row.getBoundingClientRect();
      showMenu(row, rect.left + 10, rect.bottom);
      break;
    }
    default: return;
  }
  event.preventDefault();
});

function moveTo(source, parent, before = null) {
  return source.kind === 'tab'
      ? act('save', {tabId: Number(source.id), parent, before})
      : act('move', {id: source.id, parent, before});
}

function dropTarget(event) {
  if (!drag) return null;
  const row = event.target.closest('.row');
  if (row && row.dataset.id === drag.id) return null;
  if ($('#open').contains(event.target)) {
    if (drag.kind === 'saved') return {el: $('#open'), css: 'drop-inside', run: () => act('release', {id: drag.id})};
    if (row && drag.kind === 'tab') {
      const rect = row.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      return {el: row, css: after ? 'drop-after' : 'drop-before',
        run: () => act('reorder', {tabId: Number(drag.id), targetId: Number(row.dataset.id), after})};
    }
    return null;
  }
  if (!row && !event.target.closest('#folders, header, #empty')) return null;
  if (!row) return {el: folders, css: 'drop-inside', run: () => moveTo(drag, null)};
  const node = lookup(row.dataset.id);
  if (!node || hasAncestor(node.id, drag.id)) return null;
  const rect = row.getBoundingClientRect();
  const fraction = (event.clientY - rect.top) / rect.height;
  if (!node.url && fraction > .22 && fraction < .78) {
    return {el: row, css: 'drop-inside', run: () => moveTo(drag, node.id)};
  }
  const after = fraction >= .5;
  const peers = children(node.parent);
  const before = after ? peers[peers.indexOf(node) + 1]?.id : node.id;
  return {el: row, css: after ? 'drop-after' : 'drop-before', run: () => moveTo(drag, node.parent, before)};
}

function clearDrop() {
  document.querySelectorAll('.drop-before,.drop-after,.drop-inside').forEach(el =>
    el.classList.remove('drop-before', 'drop-after', 'drop-inside'));
}
document.addEventListener('dragstart', event => {
  const row = event.target.closest('.row');
  if (!row?.dataset.id || edit) return;
  drag = {...row.dataset};
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-helium-tab-folder', drag.id);
});
document.addEventListener('dragover', event => {
  clearDrop();
  const target = dropTarget(event);
  if (!target) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  target.el.classList.add(target.css);
});
document.addEventListener('drop', event => {
  const target = dropTarget(event);
  if (target) {
    event.preventDefault();
    target.run();
  }
  clearDrop();
  drag = null;
});
document.addEventListener('dragend', () => { clearDrop(); drag = null; render(); });

$('#new-folder').onclick = () => startEdit(null);
let scheduled = false;
function scheduleRefresh() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => { scheduled = false; refresh(); }, 20);
}
for (const event of [chrome.tabs.onActivated, chrome.tabs.onCreated, chrome.tabs.onUpdated,
  chrome.tabs.onMoved, chrome.tabs.onRemoved, chrome.tabs.onAttached, chrome.tabs.onDetached,
  chrome.tabs.onReplaced, chrome.storage.onChanged]) event.addListener(scheduleRefresh);
await refresh();

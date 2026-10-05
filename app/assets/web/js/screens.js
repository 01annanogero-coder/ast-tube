// Screens. Each screen function gets (screenEl, params) and may return a
// cleanup function. The router (app.js) creates/caches the screen elements.
'use strict';

// ================================================================ cards

function videoCard(v, extra = {}) {
  const badge = v.live ? '<span class="badge live">LIVE</span>' : v.duration > 0 ? `<span class="badge">${duration(v.duration)}</span>` : '';
  const prog = progressBar(v.id, extra.progress);
  const c = el(`<article class="vcard" data-id="${esc(v.id)}">
    <a class="thumb" href="#/watch/${esc(v.id)}"><img src="${esc(v.thumb)}" loading="lazy" alt="" referrerpolicy="no-referrer">${badge}${prog}</a>
    <div class="vcard-info">
      <a class="vcard-av" ${v.channelId ? `href="#/channel/${esc(v.channelId)}"` : ''}>${avatar(v.channelAvatar, v.channel, 36)}</a>
      <a class="vcard-text" href="#/watch/${esc(v.id)}">
        <h3>${esc(v.title)}</h3>
        <p>${[v.channel ? esc(v.channel) + (v.verified ? icon('verified', 13, 'vf') : '') : '', dot(views(v.views, v.live), ago(v.published))].filter(Boolean).join(' <i class="sep">•</i> ')}</p>
      </a>
      <button class="icon-btn vcard-more" aria-label="More">${icon('more', 20)}</button>
    </div>
  </article>`);
  c.querySelector('.vcard-more').onclick = () => itemMenu(v, extra);
  return c;
}

// Compact row (history, playlists, related on wide screens): thumbnail left, text right.
function videoRow(v, extra = {}) {
  const badge = v.live ? '<span class="badge live">LIVE</span>' : v.duration > 0 ? `<span class="badge">${duration(v.duration)}</span>` : '';
  const prog = progressBar(v.id, extra.progress);
  const href = `#/${v.type === 'short' ? 'shorts' : 'watch'}/${esc(v.id)}${extra.list ? `?list=${esc(extra.list)}` : ''}`;
  const r = el(`<article class="vrow" data-id="${esc(v.id)}">
    ${extra.num ? `<span class="vrow-num">${extra.num}</span>` : ''}
    <a class="thumb" href="${href}"><img src="${esc(v.thumb)}" loading="lazy" alt="" referrerpolicy="no-referrer">${badge}${prog}</a>
    <a class="vrow-text" href="${href}">
      <h3>${esc(v.title)}</h3>
      <p>${esc(v.channel || '')}</p>
      <p>${dot(views(v.views, v.live) || v.viewsText, extra.when || ago(v.published))}</p>
    </a>
    <button class="icon-btn vcard-more" aria-label="More">${icon('more', 20)}</button>
  </article>`);
  r.querySelector('.vcard-more').onclick = () => itemMenu(v, extra);
  return r;
}

function shortCard(s) {
  return el(`<a class="scard" href="#/shorts/${esc(s.id)}">
    <img src="${esc(s.thumb)}" loading="lazy" alt="" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/${esc(s.id)}/hqdefault.jpg'">
    <div class="scard-text"><h4>${esc(s.title)}</h4>${s.viewsText ? `<p>${esc(s.viewsText)}</p>` : ''}</div>
  </a>`);
}

function channelCard(c) {
  return el(`<a class="ccard" href="#/channel/${esc(c.id)}">
    ${avatar(c.avatar, c.name, 84)}
    <div><h3>${esc(c.name)}${c.verified ? icon('verified', 14, 'vf') : ''}</h3>
    <p>${c.subs >= 0 ? `${compact(c.subs)} subscribers` : ''}</p>
    ${c.description ? `<p class="ccard-desc">${esc(c.description)}</p>` : ''}</div>
  </a>`);
}

// Playlists and series (e.g. a tutorial course). Thumbnail plays it in order; the text opens the overview.
function playlistCard(p) {
  const c = el(`<article class="vcard mcard pcard">
    <a class="thumb mthumb" href="#/play/${esc(p.id)}"><img src="${esc(p.thumb || '')}" loading="lazy" alt="" referrerpolicy="no-referrer">
      <span class="badge mix-badge">${icon('list', 14)} ${p.count >= 0 ? `${p.count} videos` : 'Playlist'}</span></a>
    <div class="vcard-info">
      <a class="vcard-text" href="#/playlist/${esc(p.id)}"><h3>${esc(p.title)}</h3><p>${esc(p.channel || '')} <i class="sep">•</i> Playlist</p></a>
      <button class="icon-btn vcard-more" aria-label="More">${icon('moreH', 20)}</button>
    </div>
  </article>`);
  c.querySelector('.vcard-more').onclick = () => menuSheet([
    { icon: 'play', label: 'Play all', run: () => go(`#/play/${p.id}`) },
    { icon: 'refresh', label: 'Shuffle', run: () => go(`#/play/${p.id}/shuffle`) },
    { icon: 'list', label: 'View all videos', run: () => go(`#/playlist/${p.id}`) },
    { icon: 'external', label: 'Open on YouTube', run: () => window.open(`https://www.youtube.com/playlist?list=${p.id}`, '_blank') },
  ]);
  return c;
}

// YouTube "Mix": an endless playlist around a song. Stacked look, like YouTube's.
const mixHref = (m) => `#/watch/${encodeURIComponent(m.seed)}?list=${encodeURIComponent(m.id)}`;
function mixCard(m) {
  const c = el(`<article class="vcard mcard">
    <a class="thumb mthumb" href="${mixHref(m)}"><img src="${esc(m.thumb)}" loading="lazy" alt="" referrerpolicy="no-referrer">
      <span class="badge mix-badge">${icon('live', 14)} Mix</span></a>
    <div class="vcard-info">
      <a class="vcard-text" href="${mixHref(m)}"><h3>Mix - ${esc(m.title)}</h3><p>${esc(m.subtitle || 'YouTube')}</p></a>
      <button class="icon-btn vcard-more" aria-label="More">${icon('moreH', 20)}</button>
    </div>
  </article>`);
  c.querySelector('.vcard-more').onclick = () => menuSheet([
    { icon: 'play', label: 'Play Mix', run: () => go(mixHref(m)) },
    { icon: 'external', label: 'Open on YouTube', run: () => window.open(`https://www.youtube.com/watch?v=${m.seed}&list=${m.id}`, '_blank') },
  ]);
  return c;
}

function anyCard(it) {
  if (it.type === 'video') return videoCard(it);
  if (it.type === 'mix') return mixCard(it);
  if (it.type === 'channel') return channelCard(it);
  if (it.type === 'playlist') return playlistCard(it);
  if (it.type === 'short') return shortCard(it);
  return null;
}

function shortsShelf(list) {
  const s = el(`<section class="shelf">
    <h2 class="shelf-head"><span class="shelf-ic">${icon('shorts', 20)}</span>Shorts</h2>
    <div class="shelf-row"></div>
  </section>`);
  const row = s.querySelector('.shelf-row');
  for (const it of list) row.appendChild(shortCard(it));
  return s;
}

function itemMenu(v, extra = {}) {
  const url = ytUrl(v.id);
  const actions = [
    { icon: 'share', label: 'Share', run: () => share(v.title, url) },
    ...(v.type === 'video' && !v.live ? [{ icon: 'download', label: 'Download', run: () => downloadSheet(v) }] : []),
    { icon: 'link', label: 'Copy link', run: () => copy(url) },
    { icon: 'external', label: 'Open on YouTube', run: () => window.open(url, '_blank') },
  ];
  if (v.channelId) actions.unshift({ icon: 'compass', label: `Go to ${v.channel || 'channel'}`, run: () => go(`#/channel/${v.channelId}`) });
  if (extra.onRemove) actions.push({ icon: 'trash', label: 'Remove from history', run: extra.onRemove });
  menuSheet(actions);
}

function skeletonCards(n = 3) {
  const f = document.createDocumentFragment();
  for (let i = 0; i < n; i++) f.appendChild(el('<div class="skel-card"><div class="skel skel-thumb"></div><div class="skel-row"><div class="skel skel-av"></div><div class="skel-lines"><div class="skel skel-line"></div><div class="skel skel-line half"></div></div></div></div>'));
  return f;
}

// A paged list: fills `list` from loader(next) -> {items, next} with infinite scroll.
function pagedList(screen, list, loader, render, { onFirst } = {}) {
  let next = null, first = true;
  const sentinel = el('<div class="sentinel"></div>');
  list.after(sentinel);
  list.appendChild(skeletonCards(first ? 3 : 1));
  async function load() {
    try {
      const data = await loader(next);
      if (first) { list.innerHTML = ''; if (onFirst) onFirst(data); }
      first = false;
      remember(data.items);
      for (const it of data.items || []) { const c = render(it); if (c) list.appendChild(c); }
      if (!list.children.length) list.appendChild(el('<p class="empty">Nothing here yet.</p>'));
      next = data.next;
      return !!next;
    } catch (e) {
      if (first) list.innerHTML = '';
      const retry = () => { stop = infinite(screen, sentinel.isConnected ? sentinel : (list.after(sentinel), sentinel), load); };
      list.appendChild(errorCard(e.message, retry));
      return false;
    }
  }
  let stop = infinite(screen, sentinel, load);
  return () => stop();
}

// After pull-to-refresh, the first page skips the server's cache (once).
function fresh(screen) {
  if (!screen.dataset.fresh) return '';
  delete screen.dataset.fresh;
  return 'fresh=1';
}

// ================================================================ home / chips

const CHIPS = [
  ['all', 'All', 'compass'], ['music', 'Music', 'music'], ['gaming', 'Gaming', 'gaming'],
  ['movies', 'Movies', 'movies'], ['podcasts', 'Podcasts', 'podcasts'], ['live', 'Live', 'live'],
];

function homeScreen(screen, { chip = 'all' }) {
  screen.innerHTML = `
    <header class="topbar">
      <a href="#/" class="topbar-logo">${logo(28)}</a>
      <span class="grow"></span>
      <a class="icon-btn" href="#/search" aria-label="Search">${icon('search', 25)}</a>
    </header>
    <nav class="chips">${CHIPS.map(([id, label, ic]) => `<a class="chip${id === chip ? ' active' : ''}" href="${id === 'all' ? '#/' : `#/chip/${id}`}">${icon(ic, 18)}<span>${label}</span></a>`).join('')}</nav>
    <div class="feed"></div>`;
  const active = screen.querySelector('.chip.active');
  if (active) active.scrollIntoView({ inline: 'center', block: 'nearest' });
  const feed = screen.querySelector('.feed');
  // Offline: Home can't fetch anything new; point at what still plays.
  if (isOffline()) {
    feed.appendChild(errorCard('', () => screen.dispatchEvent(new Event('reload'))));
    return null;
  }
  if (chip === 'all') {
    let placedShelf = false;
    return pagedList(screen, feed, (next) => api(`/api/home${next ? `?next=${encodeURIComponent(next)}` : `?${fresh(screen)}`}`), (it) => anyCard(it), {
      onFirst(data) {
        remember(data.shorts);
        if (data.shorts && data.shorts.length && !placedShelf) {
          placedShelf = true;
          // After the first video, like YouTube.
          const obs = new MutationObserver(() => {
            if (feed.children.length >= 1) { obs.disconnect(); feed.children[0].after(shortsShelf(data.shorts)); }
          });
          obs.observe(feed, { childList: true });
        }
      },
    });
  }
  return pagedList(screen, feed, (next) => api(`/api/feed/${chip}${next ? `?next=${encodeURIComponent(next)}` : `?${fresh(screen)}`}`), (it) => anyCard(it));
}

// ================================================================ search

const FILTERS = [['all', 'All'], ['videos', 'Videos'], ['channels', 'Channels'], ['playlists', 'Playlists']];

function searchScreen(screen, { q = '', f = 'all' }) {
  screen.innerHTML = `
    <header class="topbar searchbar">
      <button class="icon-btn" data-back aria-label="Back">${icon('back')}</button>
      <form class="search-form" autocomplete="off">
        <input type="search" name="q" placeholder="Search YouTube" enterkeyhint="search" value="${esc(q)}">
        <button type="button" class="icon-btn search-clear${q ? '' : ' hidden'}" aria-label="Clear">${icon('close', 20)}</button>
      </form>
      <button class="icon-btn search-go" aria-label="Search">${icon('search')}</button>
    </header>
    <div class="suggest hidden"></div>
    <div class="results"></div>`;
  const form = screen.querySelector('form');
  const input = form.q;
  const clear = screen.querySelector('.search-clear');
  const box = screen.querySelector('.suggest');
  const results = screen.querySelector('.results');

  const submit = (text) => {
    text = (text || '').trim();
    if (!text) return;
    input.blur();
    go(`#/search?q=${encodeURIComponent(text)}`);
  };
  form.onsubmit = (e) => { e.preventDefault(); submit(input.value); };
  screen.querySelector('.search-go').onclick = () => submit(input.value);
  clear.onclick = () => { input.value = ''; clear.classList.add('hidden'); input.focus(); showSuggest(''); };

  let lastQ = null;
  const showSuggest = debounce(async (text) => {
    lastQ = text;
    if (!text.trim()) { box.innerHTML = ''; box.classList.add('hidden'); results.classList.remove('hidden'); return; }
    let list = [];
    try { list = await api(`/api/suggest?q=${encodeURIComponent(text)}`); } catch (e) { return; }
    if (lastQ !== text) return;
    box.innerHTML = '';
    for (const s of list) {
      const row = el(`<div class="suggest-row">${icon('search', 20)}<span></span><button class="icon-btn" aria-label="Use">${icon('arrowUpLeft', 20)}</button></div>`);
      row.querySelector('span').textContent = s;
      row.onclick = () => submit(s);
      row.querySelector('button').onclick = (e) => { e.stopPropagation(); input.value = `${s} `; input.focus(); showSuggest(input.value); };
      box.appendChild(row);
    }
    box.classList.toggle('hidden', !list.length || document.activeElement !== input);
    results.classList.toggle('hidden', !!list.length && document.activeElement === input);
  }, 200);
  input.oninput = () => { clear.classList.toggle('hidden', !input.value); showSuggest(input.value); };
  input.onfocus = () => { if (input.value && input.value !== q) showSuggest(input.value); };

  if (!q) {
    results.innerHTML = `<div class="empty-state">${icon('search', 48)}<p>Search for videos, channels and playlists</p></div>`;
    setTimeout(() => input.focus(), 50);
    return null;
  }
  const chips = el(`<nav class="chips small">${FILTERS.map(([id, label]) => `<a class="chip${id === f ? ' active' : ''}" href="#/search?q=${encodeURIComponent(q)}${id === 'all' ? '' : `&f=${id}`}">${label}</a>`).join('')}</nav>`);
  results.appendChild(chips);
  const list = el('<div class="feed"></div>');
  results.appendChild(list);
  return pagedList(screen, list, async (next) => {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&filter=${f}${next ? `&next=${encodeURIComponent(next)}` : `&${fresh(screen)}`}`);
    if (!next && data.corrected) list.before(el(`<p class="corrected">Showing results for <a href="#/search?q=${encodeURIComponent(data.corrected)}">${esc(data.corrected)}</a></p>`));
    // Shorts in search results: collect them into one shelf.
    const shorts = (data.items || []).filter((i) => i.type === 'short');
    if (shorts.length) { remember(shorts); list.appendChild(shortsShelf(shorts)); }
    return { ...data, items: (data.items || []).filter((i) => i.type !== 'short') };
  }, (it) => anyCard(it));
}

// ================================================================ sheets used by the watch page and Shorts

function descriptionSheet(v, player) {
  const s = openSheet({ title: 'Description', height: '78vh' });
  s.body.innerHTML = `
    <h2 class="desc-title">${esc(v.title)}</h2>
    <div class="desc-stats">
      ${v.likes >= 0 ? `<div><b>${compact(v.likes)}</b><span>Likes</span></div>` : ''}
      <div><b>${v.views >= 0 ? Number(v.views).toLocaleString() : '—'}</b><span>Views</span></div>
      <div><b>${esc(v.uploadDate ? new Date(v.uploadDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : (v.published || '—'))}</b><span>${esc(v.published || '')}</span></div>
    </div>
    ${v.chapters.length ? `<h3 class="desc-sub">Chapters</h3><div class="chapters">${v.chapters.map((c) => `<a href="#" class="ts chapter" data-t="${c.start}"><b>${duration(c.start)}</b> ${esc(c.title)}</a>`).join('')}</div>` : ''}
    <div class="desc-text">${linkify(v.description || 'No description.', true)}</div>`;
  s.body.addEventListener('click', (e) => {
    const t = e.target.closest('.ts');
    if (!t) return;
    e.preventDefault();
    player.seek(Number(t.dataset.t));
    s.close();
  });
}

function commentsSheet(id, player) {
  const s = openSheet({ title: 'Comments', height: '75vh' });
  const list = el('<div class="comments"></div>');
  s.body.appendChild(list);
  const scroller = s.body;
  let next = null;
  const sentinel = el('<div class="sentinel"></div>');
  list.after(sentinel);
  list.appendChild(spinner());
  infinite(scroller, sentinel, async () => {
    try {
      const c = await api(`/api/comments/${encodeURIComponent(id)}${next ? `?next=${encodeURIComponent(next)}` : ''}`);
      list.querySelectorAll('.spinner-row').forEach((x) => x.remove());
      if (c.disabled) { list.appendChild(el('<p class="empty">Comments are turned off.</p>')); return false; }
      for (const cm of c.items) {
        const row = el(`<div class="comment">
          ${avatar(cm.avatar, cm.author, 32)}
          <div class="cm-body">
            <p class="cm-head">${cm.pinned ? '<span class="cm-pin">Pinned</span>' : ''}<b class="${cm.byUploader ? 'cm-owner' : ''}">${esc(cm.author)}</b> <i class="sep">•</i> ${esc(cm.published || '')}</p>
            <p class="cm-text">${linkify(cm.text, true)}</p>
            <p class="cm-foot">${icon('thumbUp', 15)} ${cm.likes > 0 ? compact(cm.likes) : ''}${cm.replies > 0 ? `<span class="cm-replies">${cm.replies} ${cm.replies === 1 ? 'reply' : 'replies'}</span>` : ''}</p>
          </div>
        </div>`);
        list.appendChild(row);
      }
      if (!list.children.length) list.appendChild(el('<p class="empty">No comments yet.</p>'));
      next = c.next;
      return !!next;
    } catch (e) {
      list.querySelectorAll('.spinner-row').forEach((x) => x.remove());
      list.appendChild(el(`<p class="empty">${esc(e.message)}</p>`));
      return false;
    }
  });
  list.addEventListener('click', (e) => {
    const t = e.target.closest('.ts');
    if (!t || !player) return;
    e.preventDefault();
    player.seek(Number(t.dataset.t));
    s.close();
  });
}

// ================================================================ channel

const TAB_LABELS = { videos: 'Videos', shorts: 'Shorts', live: 'Live', playlists: 'Playlists' };

function channelScreen(screen, { id, tab = 'videos' }) {
  screen.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" data-back aria-label="Back">${icon('back')}</button>
      <h1 class="topbar-title"></h1>
      <a class="icon-btn" href="#/search" aria-label="Search">${icon('search')}</a>
    </header>
    <div class="channel-head"><div class="skel skel-banner"></div></div>
    <div class="channel-list"></div>`;
  const head = screen.querySelector('.channel-head');
  const list = screen.querySelector('.channel-list');
  return pagedList(screen, list, (next) => api(`/api/channel/${encodeURIComponent(id)}?tab=${tab}${next ? `&next=${encodeURIComponent(next)}` : ''}`), (it) => {
    if (it.type === 'short') return shortCard(it);
    return anyCard(it);
  }, {
    onFirst(c) {
      screen.querySelector('.topbar-title').textContent = c.name;
      head.innerHTML = `
        ${c.banner ? `<div class="banner"><img src="${esc(c.banner)}" alt="" referrerpolicy="no-referrer"></div>` : ''}
        <div class="ch-info">
          ${avatar(c.avatar, c.name, 72)}
          <div>
            <h2>${esc(c.name)}${c.verified ? icon('verified', 16, 'vf') : ''}</h2>
            <p>${dot(c.handle, c.subs >= 0 ? `${compact(c.subs)} subscribers` : '')}</p>
          </div>
        </div>
        ${c.description ? `<p class="ch-desc">${esc(c.description)}</p>` : ''}
        <nav class="tabs">${(c.tabs || []).map((t) => `<a class="tab${t === c.tab ? ' active' : ''}" href="#/channel/${esc(id)}/${t}">${TAB_LABELS[t] || t}</a>`).join('')}</nav>`;
      const d = head.querySelector('.ch-desc');
      if (d) d.onclick = () => d.classList.toggle('open');
      list.className = `channel-list tab-${c.tab}`;
    },
  });
}

// ================================================================ playlist

function playlistScreen(screen, { id }) {
  screen.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" data-back aria-label="Back">${icon('back')}</button>
      <h1 class="topbar-title">Playlist</h1>
    </header>
    <div class="pl-head"></div>
    <div class="pl-list"></div>`;
  const list = screen.querySelector('.pl-list');
  let n = 0;
  return pagedList(screen, list, (next) => api(`/api/playlist/${encodeURIComponent(id)}${next ? `?next=${encodeURIComponent(next)}` : ''}`), (it) => (it.type === 'video' ? videoRow(it, { list: id, num: ++n }) : anyCard(it)), {
    onFirst(p) {
      screen.querySelector('.topbar-title').textContent = p.title;
      screen.querySelector('.pl-head').innerHTML = `
        <div class="pl-card">
          ${p.thumb ? `<img src="${esc(p.thumb)}" alt="" referrerpolicy="no-referrer">` : ''}
          <h2>${esc(p.title)}</h2>
          <p>${dot(p.channel, p.count >= 0 ? `${p.count} videos` : '')}</p>
          ${p.items && p.items[0] ? `<div class="pl-buttons">
            <a class="pill pill-accent" href="#/watch/${esc(p.items[0].id)}?list=${esc(id)}">${icon('play', 16)} Play all</a>
            <a class="pill" href="#/play/${esc(id)}/shuffle">${icon('refresh', 16)} Shuffle</a></div>` : ''}
        </div>`;
    },
  });
}

// ================================================================ settings

const QUALITIES = ['auto', '1080', '720', '480', '360', '240'];
const qualityName = (q) => (q === 'auto' ? 'Auto' : `${q}p`);

function settingsScreen(screen) {
  screen.innerHTML = `
    <header class="topbar"><h1 class="topbar-title">Settings</h1></header>
    <h2 class="set-group">Your data</h2>
    <div class="set-card">
      <a class="set-row" href="#/history">${icon('history')}<div><b>Watch history</b><span class="hist-count">Stored only on this phone</span></div>${icon('chevronRight', 20)}</a>
      <button class="set-row clear-hist">${icon('trash')}<div><b>Clear watch history</b><span>Home goes back to general recommendations</span></div></button>
    </div>
    <h2 class="set-group">Offline</h2>
    <div class="set-card">
      <a class="set-row" href="#/downloads">${icon('download')}<div><b>Downloads</b><span class="dl-count">Videos saved for watching without internet</span></div>${icon('chevronRight', 20)}</a>
      <button class="set-row clear-shorts">${icon('shorts')}<div><b>Offline Shorts</b><span class="shorts-count">Shorts you watch are kept so they play without internet</span></div>${icon('trash', 20)}</button>
    </div>
    <h2 class="set-group">Playback</h2>
    <div class="set-card">
      <label class="set-row">${icon('play')}<div><b>Autoplay</b><span>Play the next video when one ends</span></div><input type="checkbox" class="switch" data-key="autoplay"></label>
      <label class="set-row">${icon('podcasts')}<div><b>Background play</b><span>Keep listening when you leave the app or lock the screen</span></div><input type="checkbox" class="switch" data-key="background"></label>
      <button class="set-row set-quality">${icon('quality')}<div><b>Preferred quality</b><span class="q-value"></span></div>${icon('chevronRight', 20)}</button>
    </div>
    <h2 class="set-group">About</h2>
    <div class="set-card set-about">
      <div class="about-logo">${logo(30)}</div>
      <p>Version ${esc(appVersion || '?')}. A watch-only YouTube app: no account, no ads, no tracking. Your watch history never leaves this phone.</p>
      <p>AST Tube owns none of the videos it shows; they belong to their creators on YouTube. Not affiliated with YouTube or Google. Powered by NewPipeExtractor.</p>
    </div>`;
  for (const sw of screen.querySelectorAll('.switch')) {
    sw.checked = !!settings[sw.dataset.key];
    sw.onchange = () => saveSetting(sw.dataset.key, sw.checked);
  }
  const qv = screen.querySelector('.q-value');
  qv.textContent = qualityName(settings.quality);
  screen.querySelector('.set-quality').onclick = () => {
    const s = openSheet({ title: 'Preferred quality', cls: 'menu-sheet' });
    for (const q of QUALITIES) {
      const b = el(`<button class="menu-item">${q === settings.quality ? icon('check', 22) : '<span class="ic-space"></span>'}<span>${qualityName(q)}</span></button>`);
      b.onclick = () => { s.close(); saveSetting('quality', q); qv.textContent = qualityName(q); };
      s.body.appendChild(b);
    }
  };
  screen.querySelector('.clear-hist').onclick = () => confirmSheet('Clear all watch history? Home will go back to general recommendations.', 'Clear all', async () => {
    await api('/api/history', { method: 'DELETE' }).catch(() => {}); watched.clear();
    toast('History cleared');
    refreshCount();
  });
  const refreshCount = () => api('/api/history').then((h) => {
    screen.querySelector('.hist-count').textContent = h.items.length ? `${h.items.length} video${h.items.length === 1 ? '' : 's'} · stored only on this phone` : 'Stored only on this phone';
  }).catch(() => {});
  refreshCount();
  const refreshOffline = () => api('/api/offline').then((o) => {
    const n = o.downloads.filter((d) => d.status === 'done').length;
    screen.querySelector('.dl-count').textContent = o.downloads.length ? `${n} video${n === 1 ? '' : 's'} · ${size(o.downloadsBytes)}` : 'Videos saved for watching without internet';
    screen.querySelector('.shorts-count').textContent = `${o.shorts.count} saved · ${size(o.shorts.bytes)} of ${size(o.shorts.limit)} · tap to clear`;
  }).catch(() => {});
  screen.querySelector('.clear-shorts').onclick = () => confirmSheet('Delete all saved Shorts? New ones are saved again as you watch.', 'Delete', async () => {
    await api('/api/offline/shorts', { method: 'DELETE' }).catch(() => {});
    toast('Saved Shorts deleted');
    refreshOffline();
  });
  refreshOffline();
  return null;
}

// ================================================================ downloads

function downloadsScreen(screen) {
  screen.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" data-back aria-label="Back">${icon('back')}</button>
      <h1 class="topbar-title">Downloads</h1>
    </header>
    <p class="hist-note dl-summary">Saved inside AST Tube on this phone. They play without internet.</p>
    <div class="dl-list"></div>`;
  const list = screen.querySelector('.dl-list');
  let timer = 0, alive = true;

  async function render() {
    clearTimeout(timer);
    let o;
    try { o = await api('/api/offline'); } catch (e) {
      list.innerHTML = '';
      list.appendChild(errorCard(e.message, render));
      return;
    }
    if (!alive) return;
    const done = o.downloads.filter((d) => d.status === 'done');
    screen.querySelector('.dl-summary').textContent = o.downloads.length
      ? `${done.length} video${done.length === 1 ? '' : 's'} · ${size(o.downloadsBytes)} · saved only on this phone, play without internet`
      : 'Saved inside AST Tube on this phone. They play without internet.';
    list.innerHTML = '';
    if (!o.downloads.length) {
      list.innerHTML = `<div class="empty-state">${icon('download', 48)}<p>Videos you download show up here.<br>Tap <b>Download</b> under any video.</p>
        ${o.shorts.count ? `<a class="pill pill-accent" href="#/shorts">${icon('shorts', 18)} ${o.shorts.count} saved Shorts</a>` : ''}</div>`;
      return;
    }
    for (const d of o.downloads) {
      const v = d.item || {};
      const pct = Math.floor((d.progress || 0) * 100);
      const status = d.status === 'done' ? `${d.height}p · ${size(d.bytes)}`
        : d.status === 'downloading' ? `Downloading ${pct}% · ${size(d.bytes)}`
        : d.status === 'queued' ? 'Waiting to download…'
        : `Failed: ${d.error || 'unknown error'}`;
      const row = el(`<article class="vrow dl-row ${d.status}" data-id="${esc(d.id)}">
        <a class="thumb" ${d.status === 'done' ? `href="#/watch/${esc(d.id)}"` : ''}><img src="${esc(v.thumb || `https://i.ytimg.com/vi/${d.id}/hqdefault.jpg`)}" alt="" referrerpolicy="no-referrer">
          ${v.duration > 0 ? `<span class="badge">${duration(v.duration)}</span>` : ''}
          ${d.status !== 'done' ? `<div class="thumb-prog"><i style="width:${Math.max(3, pct)}%"></i></div>` : progressBar(d.id)}</a>
        <a class="vrow-text" ${d.status === 'done' ? `href="#/watch/${esc(d.id)}"` : ''}>
          <h3>${esc(v.title || d.id)}</h3>
          <p>${esc(v.channel || '')}</p>
          <p class="dl-status">${d.status === 'done' ? icon('downloaded', 14) : ''} ${esc(status)}</p>
        </a>
        <button class="icon-btn vcard-more" aria-label="More">${icon('more', 20)}</button>
      </article>`);
      row.querySelector('.vcard-more').onclick = () => menuSheet([
        ...(d.status === 'failed' ? [{ icon: 'refresh', label: 'Retry', run: () => post(`/api/offline/${d.id}/retry`, {}).then(render) }] : []),
        ...(d.status === 'done' ? [{ icon: 'play', label: 'Play', run: () => go(`#/watch/${d.id}`) }] : []),
        { icon: 'trash', label: d.status === 'done' ? 'Delete download' : 'Cancel download', run: async () => { await api(`/api/offline/${d.id}`, { method: 'DELETE' }).catch(() => {}); render(); } },
      ]);
      list.appendChild(row);
    }
    // Watch progress while something is downloading.
    if (o.downloads.some((d) => d.status === 'downloading' || d.status === 'queued')) timer = setTimeout(render, 1500);
  }
  render();
  return () => { alive = false; clearTimeout(timer); };
}

// ================================================================ history

function historyScreen(screen) {
  screen.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" data-back aria-label="Back">${icon('back')}</button>
      <h1 class="topbar-title">History</h1>
      <span class="grow"></span>
      <button class="pill small clear-all">${icon('trash', 16)} Clear all</button>
    </header>
    <p class="hist-note">Your watch history stays on this phone. It is used to pick videos for Home.</p>
    <div class="history"></div>`;
  const box = screen.querySelector('.history');
  const clearBtn = screen.querySelector('.clear-all');

  async function render() {
    box.innerHTML = '';
    box.appendChild(spinner());
    let items;
    try { items = (await api('/api/history')).items; } catch (e) { box.innerHTML = ''; box.appendChild(errorCard(e.message, render)); return; }
    box.innerHTML = '';
    clearBtn.classList.toggle('hidden', !items.length);
    if (!items.length) {
      box.innerHTML = `<div class="empty-state">${icon('history', 48)}<p>Videos you watch will show up here.</p><a class="pill pill-accent" href="#/">Browse Home</a></div>`;
      return;
    }
    remember(items);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const group = (t) => (t >= today ? 'Today' : t >= today - 864e5 ? 'Yesterday' : t >= today - 6 * 864e5 ? 'This week' : t >= today - 30 * 864e5 ? 'This month' : 'Older');
    let current = '';
    for (const h of items) {
      const g = group(h.watchedAt);
      if (g !== current) { current = g; box.appendChild(el(`<h2 class="hist-group">${g}</h2>`)); }
      const remove = async () => {
        await api(`/api/history/${encodeURIComponent(h.id)}`, { method: 'DELETE' }).catch(() => {}); watched.delete(h.id);
        row.classList.add('gone');
        setTimeout(render, 200);
      };
      const progress = h.duration > 0 ? h.position / h.duration : null;
      const row = videoRow(h, { progress, onRemove: remove });
      swipeToRemove(row, remove);
      box.appendChild(row);
    }
  }
  clearBtn.onclick = () => confirmSheet('Clear all watch history? Home will go back to general recommendations.', 'Clear all', async () => {
    await api('/api/history', { method: 'DELETE' }).catch(() => {}); watched.clear();
    toast('History cleared');
    render();
  });
  render();
  return null;
}

// Swipe a row left to remove it.
function swipeToRemove(row, onRemove) {
  let x0 = 0, y0 = 0, dx = 0, active = false;
  row.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; active = true; row.style.transition = 'none'; }, { passive: true });
  row.addEventListener('touchmove', (e) => {
    if (!active) return;
    dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;
    if (Math.abs(dy) > Math.abs(dx)) { active = false; row.style.transform = ''; return; }
    if (dx < 0) row.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  row.addEventListener('touchend', () => {
    row.style.transition = '';
    if (active && dx < -row.offsetWidth * 0.4) { row.style.transform = 'translateX(-110%)'; onRemove(); }
    else row.style.transform = '';
    active = false;
  });
}

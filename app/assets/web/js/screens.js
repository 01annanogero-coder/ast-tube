// Screens. Each screen function gets (screenEl, params) and may return a
// cleanup function. The router (app.js) creates/caches the screen elements.
'use strict';

// ================================================================ cards

function videoCard(v, extra = {}) {
  const badge = v.live ? '<span class="badge live">LIVE</span>' : v.duration > 0 ? `<span class="badge">${duration(v.duration)}</span>` : '';
  const prog = progressBar(v.id, extra.progress);
  const c = el(`<article class="vcard" data-id="${esc(v.id)}" data-channel="${esc(v.channelId || '')}">
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

// A channel post: text, photos (one, or a swipeable set with a "1/10" counter), a poll or a
// shared video. Read-only; post comments are only on YouTube (signed in), so the count links there.
function postCard(p) {
  let imgs = p.images || [];
  const url = `https://www.youtube.com/post/${p.id}`;
  const c = el(`<article class="post" data-id="${esc(p.id)}" data-channel="${esc(p.channelId || '')}">
    <div class="post-head">
      <a class="post-author" ${p.channelId ? `href="#/channel/${esc(p.channelId)}"` : ''}>${avatar(p.avatar, p.channel, 36)}
        <span><b>${esc(p.channel)}</b><em>${esc(p.published || '')}</em></span></a>
      <button class="icon-btn vcard-more" aria-label="More">${icon('more', 20)}</button>
    </div>
    ${p.text ? `<p class="post-text">${linkify(p.text)}</p>` : ''}
    ${imgs.length ? `<div class="post-images${imgs.length > 1 ? ' multi' : ''}"><div class="post-strip">${imgs.map((u, i) => `<img src="${esc(u)}" data-i="${i}" loading="lazy" alt="" referrerpolicy="no-referrer">`).join('')}</div>${imgs.length > 1 || p.more ? `<span class="post-count">1/${p.more ? '…' : imgs.length}</span>` : ''}</div>` : ''}
    ${p.poll ? `<div class="post-poll">${p.poll.choices.map((ch) => `<div class="poll-choice">${esc(ch)}</div>`).join('')}<p>${esc(p.poll.votes)}</p></div>` : ''}
    <div class="post-foot">
      <span class="pill small">${icon('thumbUp', 16)} ${esc(p.likes || '0')}</span>
      <a class="pill small" href="${esc(url)}" target="_blank" rel="noopener">${icon('comment', 16)} ${esc(p.comments || '0')}</a>
      <button class="pill small post-share">${icon('share', 16)}</button>
    </div>
  </article>`);
  if (p.video) c.querySelector('.post-foot').before(videoRow(p.video));
  const text = c.querySelector('.post-text');
  if (text) text.onclick = (e) => { if (!e.target.closest('a')) text.classList.toggle('open'); };
  const strip = c.querySelector('.post-strip');
  // A multi-photo post arrives with only its first photo: fetch the rest once it's on screen.
  if (strip && p.more && p.detail) {
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      api(`/api/postimages?p=${encodeURIComponent(p.detail)}`).then((all) => {
        if (!all || all.length <= 1) { const n = c.querySelector('.post-count'); if (n) n.remove(); return; }
        imgs = all;
        strip.innerHTML = all.map((u, i) => `<img src="${esc(u)}" data-i="${i}" loading="lazy" alt="" referrerpolicy="no-referrer">`).join('');
        c.querySelector('.post-images').classList.add('multi');
        c.querySelector('.post-count').textContent = `1/${all.length}`;
      }).catch(() => {});
    }, { rootMargin: '400px' });
    io.observe(c);
  }
  if (strip) {
    const count = c.querySelector('.post-count');
    if (count) strip.addEventListener('scroll', () => { if (imgs.length > 1) count.textContent = `${Math.round(strip.scrollLeft / strip.clientWidth) + 1}/${imgs.length}`; }, { passive: true });
    strip.onclick = (e) => { const im = e.target.closest('img'); if (im) imageViewer(imgs, Number(im.dataset.i)); };
  }
  c.querySelector('.post-share').onclick = () => share(p.text ? p.text.slice(0, 80) : p.channel, url);
  c.querySelector('.vcard-more').onclick = () => menuSheet([
    { icon: 'external', label: 'Open on YouTube', run: () => window.open(url, '_blank') },
    { icon: 'link', label: 'Copy link', run: () => copy(url) },
    ...(p.channelId ? [{ icon: 'trash', label: `Don't recommend ${p.channel || 'this channel'}`, run: () => notInterested({ channel: { channelId: p.channelId, channel: p.channel } }) }] : []),
  ]);
  return c;
}

// Full-screen photos: swipe between them; Back or ✕ closes.
function imageViewer(imgs, start) {
  const v = el(`<div class="img-viewer">
    <div class="img-strip">${imgs.map((u) => `<div class="img-page"><img src="${esc(u.replace(/=s\d+-/, '=s2048-'))}" alt="" referrerpolicy="no-referrer"></div>`).join('')}</div>
    <button class="icon-btn img-close" aria-label="Close">${icon('close')}</button>
    ${imgs.length > 1 ? `<span class="img-count">${start + 1}/${imgs.length}</span>` : ''}
  </div>`);
  document.body.appendChild(v);
  const strip = v.querySelector('.img-strip');
  requestAnimationFrame(() => { strip.scrollLeft = start * strip.clientWidth; v.classList.add('open'); });
  const count = v.querySelector('.img-count');
  if (count) strip.addEventListener('scroll', () => { count.textContent = `${Math.round(strip.scrollLeft / strip.clientWidth) + 1}/${imgs.length}`; }, { passive: true });
  // Registered like a sheet, so Android Back closes it.
  const api = { el: v, close() { const i = sheets.indexOf(api); if (i >= 0) sheets.splice(i, 1); v.remove(); } };
  sheets.push(api);
  v.querySelector('.img-close').onclick = api.close;
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
  if (it.type === 'post') return postCard(it);
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
  // Recommendations: hide this video, or everything from its channel (not offered in History).
  else if (v.type === 'video') {
    actions.push({ icon: 'close', label: 'Not interested', run: () => notInterested({ video: v }) });
    if (v.channelId) actions.push({ icon: 'trash', label: `Don't recommend ${v.channel || 'this channel'}`, run: () => notInterested({ channel: v }) });
  }
  menuSheet(actions);
}

// Hides a video (or a whole channel) from recommendations, removes it from the screen,
// and offers Undo. Kept on the phone; editable in Settings.
async function notInterested({ video, channel }) {
  const body = video ? { video: { id: video.id } } : { channel: { id: channel.channelId, name: channel.channel || '' } };
  try { await post('/api/blocklist', body); } catch (e) { toast(e.message); return; }
  const sel = video ? `.vcard[data-id="${CSS.escape(video.id)}"]` : `.vcard[data-channel="${CSS.escape(channel.channelId)}"], .post[data-channel="${CSS.escape(channel.channelId)}"]`;
  const cards = [...document.querySelectorAll(sel)];
  cards.forEach((c) => c.classList.add('hidden'));
  undoToast(video ? 'Video hidden. We\x27ll show fewer like it.' : `You won't see ${channel.channel || 'this channel'} in recommendations.`, async () => {
    await api(`/api/blocklist?${video ? `video=${encodeURIComponent(video.id)}` : `channel=${encodeURIComponent(channel.channelId)}`}`, { method: 'DELETE' }).catch(() => {});
    cards.forEach((c) => c.classList.remove('hidden'));
  });
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

const TAB_LABELS = { videos: 'Videos', shorts: 'Shorts', live: 'Live', playlists: 'Playlists', posts: 'Posts' };

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
  // Posts come from their own endpoint; the header still comes from the channel.
  const load = (next) => {
    if (tab !== 'posts') return api(`/api/channel/${encodeURIComponent(id)}?tab=${tab}${next ? `&next=${encodeURIComponent(next)}` : ''}`);
    if (next) return api(`/api/posts/${encodeURIComponent(id)}?next=${encodeURIComponent(next)}`);
    return Promise.all([api(`/api/channel/${encodeURIComponent(id)}?tab=videos`), api(`/api/posts/${encodeURIComponent(id)}`)])
      .then(([c, p]) => ({ ...c, tab: 'posts', items: p.items, next: p.next }));
  };
  return pagedList(screen, list, load, (it) => {
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
        <nav class="tabs">${[...(c.tabs || []), 'posts'].map((t) => `<a class="tab${t === c.tab ? ' active' : ''}" href="#/channel/${esc(id)}/${t}">${TAB_LABELS[t] || t}</a>`).join('')}</nav>`;
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
      <button class="set-row hidden-recs">${icon('close')}<div><b>Hidden from recommendations</b><span class="hidden-count">Videos and channels you marked "Not interested"</span></div>${icon('chevronRight', 20)}</button>
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
    const nS = h.items.filter((i) => i.type === 'short' || i.short === true).length, nV = h.items.length - nS;
    screen.querySelector('.hist-count').textContent = h.items.length ? `${nV} video${nV === 1 ? '' : 's'} · ${nS} Short${nS === 1 ? '' : 's'} · stored only on this phone` : 'Stored only on this phone';
  }).catch(() => {});
  refreshCount();
  const refreshOffline = () => api('/api/offline').then((o) => {
    const n = o.downloads.filter((d) => d.status === 'done').length;
    screen.querySelector('.dl-count').textContent = o.downloads.length ? `${n} video${n === 1 ? '' : 's'} · ${size(o.downloadsBytes)}` : 'Videos saved for watching without internet';
    screen.querySelector('.shorts-count').textContent = `${o.shorts.fresh} new + ${o.shorts.count - o.shorts.fresh} watched saved · ${size(o.shorts.bytes)} of ${size(o.shorts.limit)} · new ones are added on Wi-Fi · tap to clear`;
  }).catch(() => {});
  screen.querySelector('.clear-shorts').onclick = () => confirmSheet('Delete all saved Shorts? New ones are saved again as you watch.', 'Delete', async () => {
    await api('/api/offline/shorts', { method: 'DELETE' }).catch(() => {});
    toast('Saved Shorts deleted');
    refreshOffline();
  });
  refreshOffline();

  // "Not interested" list: see it and undo it.
  const refreshHidden = () => api('/api/blocklist').then((b) => {
    const n = b.videos.length, c = b.channels.length;
    screen.querySelector('.hidden-count').textContent = n || c
      ? `${c} channel${c === 1 ? '' : 's'} · ${n} video${n === 1 ? '' : 's'} hidden`
      : 'Videos and channels you marked "Not interested"';
    return b;
  }).catch(() => ({ videos: [], channels: [] }));
  screen.querySelector('.hidden-recs').onclick = async () => {
    const b = await refreshHidden();
    const sh = openSheet({ title: 'Hidden from recommendations', cls: 'menu-sheet' });
    if (!b.videos.length && !b.channels.length) {
      sh.body.innerHTML = '<p class="confirm-text">Nothing hidden. Use ⋮ → "Not interested" on a video to see fewer like it.</p>';
      return;
    }
    for (const ch of b.channels) {
      const row = el(`<div class="menu-item">${icon('compass', 22)}<span></span><button class="pill small">Show again</button></div>`);
      row.querySelector('span').textContent = ch.name || ch.id;
      row.querySelector('button').onclick = async () => { await api(`/api/blocklist?channel=${encodeURIComponent(ch.id)}`, { method: 'DELETE' }).catch(() => {}); row.remove(); refreshHidden(); };
      sh.body.appendChild(row);
    }
    if (b.videos.length) sh.body.appendChild(el(`<p class="dl-note">${b.videos.length} hidden video${b.videos.length === 1 ? '' : 's'}</p>`));
    const all = el(`<button class="menu-item">${icon('refresh', 22)}<span>Show everything again</span></button>`);
    all.onclick = async () => { await api('/api/blocklist', { method: 'DELETE' }).catch(() => {}); sh.close(); toast('Recommendations reset'); refreshHidden(); };
    sh.body.appendChild(all);
  };
  refreshHidden();
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

function historyScreen(screen, { tab = 'videos' }) {
  const isShortItem = (h) => h.type === 'short' || h.short === true;
  screen.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" data-back aria-label="Back">${icon('back')}</button>
      <h1 class="topbar-title">History</h1>
      <span class="grow"></span>
      <button class="pill small clear-all">${icon('trash', 16)} Clear</button>
    </header>
    <nav class="tabs hist-tabs">
      <a class="tab${tab === 'videos' ? ' active' : ''}" data-tab="videos">Videos <span class="tab-count"></span></a>
      <a class="tab${tab === 'shorts' ? ' active' : ''}" data-tab="shorts">Shorts <span class="tab-count"></span></a>
    </nav>
    <p class="hist-note"></p>
    <div class="history"></div>`;
  const box = screen.querySelector('.history');
  const clearBtn = screen.querySelector('.clear-all');
  const note = screen.querySelector('.hist-note');
  // Switching tabs replaces the history entry, so Back still leaves the screen.
  screen.querySelectorAll('.hist-tabs .tab').forEach((t) => {
    t.onclick = () => location.replace(t.dataset.tab === 'shorts' ? '#/history/shorts' : '#/history');
  });

  async function render() {
    box.innerHTML = '';
    box.appendChild(spinner());
    let data;
    try { data = await api('/api/history'); } catch (e) { box.innerHTML = ''; box.appendChild(errorCard(e.message, render)); return; }
    const limits = data.limits || { videos: 120, shorts: 200 };
    const shorts = data.items.filter(isShortItem);
    const videos = data.items.filter((h) => !isShortItem(h));
    const [countV, countS] = screen.querySelectorAll('.tab-count');
    countV.textContent = `${videos.length}/${limits.videos}`;
    countS.textContent = `${shorts.length}/${limits.shorts}`;
    const items = tab === 'shorts' ? shorts : videos;
    note.textContent = tab === 'shorts'
      ? `Keeps your last ${limits.shorts} Shorts on this phone. They always play from the start.`
      : `Keeps your last ${limits.videos} videos on this phone, with where you stopped. Used to pick videos for Home.`;
    box.innerHTML = '';
    clearBtn.classList.toggle('hidden', !items.length);
    if (!items.length) {
      box.innerHTML = `<div class="empty-state">${icon(tab === 'shorts' ? 'shorts' : 'history', 48)}<p>${tab === 'shorts' ? 'Shorts' : 'Videos'} you watch will show up here.</p><a class="pill pill-accent" href="${tab === 'shorts' ? '#/shorts' : '#/'}">${tab === 'shorts' ? 'Watch Shorts' : 'Browse Home'}</a></div>`;
      return;
    }
    remember(items);
    const removeOne = async (h) => {
      await api(`/api/history/${encodeURIComponent(h.id)}`, { method: 'DELETE' }).catch(() => {});
      watched.delete(h.id);
      render();
    };
    if (tab === 'shorts') {
      // A grid of portrait cards, newest first; tap the corner button to remove one.
      const grid = el('<div class="hist-shorts"></div>');
      for (const h of items) {
        const card = shortCard(h);
        const x = el(`<button class="hist-x" aria-label="Remove">${icon('close', 16)}</button>`);
        x.onclick = (e) => { e.preventDefault(); e.stopPropagation(); card.classList.add('gone'); setTimeout(() => removeOne(h), 150); };
        card.appendChild(x);
        grid.appendChild(card);
      }
      box.appendChild(grid);
      return;
    }
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const group = (t) => (t >= today ? 'Today' : t >= today - 864e5 ? 'Yesterday' : t >= today - 6 * 864e5 ? 'This week' : t >= today - 30 * 864e5 ? 'This month' : 'Older');
    let current = '';
    for (const h of items) {
      const g = group(h.watchedAt);
      if (g !== current) { current = g; box.appendChild(el(`<h2 class="hist-group">${g}</h2>`)); }
      const remove = () => { row.classList.add('gone'); setTimeout(() => removeOne(h), 200); };
      const progress = h.duration > 0 ? h.position / h.duration : null;
      const row = videoRow(h, { progress, onRemove: remove });
      swipeToRemove(row, remove);
      box.appendChild(row);
    }
  }
  clearBtn.onclick = () => {
    const what = tab === 'shorts' ? 'Shorts' : 'video';
    confirmSheet(`Clear your ${what} history?${tab === 'shorts' ? '' : ' Home will go back to general recommendations.'}`, 'Clear', async () => {
      await api(`/api/history?type=${tab === 'shorts' ? 'short' : 'video'}`, { method: 'DELETE' }).catch(() => {});
      await reloadWatched(); // keeps progress bars of the other kind
      toast(`${tab === 'shorts' ? 'Shorts' : 'Video'} history cleared`);
      render();
    });
  };
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

// ─── ARTWORK HELPERS ──────────────────────────────────────────────────────
function getArt(song, large) {
  if (song.cover_xl && large) return song.cover_xl;
  if (song.cover) return large ? song.cover.replace('200x200','600x600') : song.cover;
  const raw = song.artworkUrl100 || song.artworkUrl60 || song.thumbnail || '';
  if (!raw) return '';
  return large ? raw.replace('100x100','600x600').replace('60x60','600x600') : raw;
}

// ─── UI ────────────────────────────────────────────────────────────────────
function updateActiveSongRowUI(song) {
  const sid = song ? getSongId(song) : '';
  document.querySelectorAll('.song-item.now-playing').forEach(el => {
    el.classList.remove('now-playing');
  });
  if (sid) {
    document.querySelectorAll(`.song-heart-btn[data-song-id="${sid}"]`).forEach(btn => {
      const item = btn.closest('.song-item');
      if (item) item.classList.add('now-playing');
    });
  }
}

function setNowPlayingUI(song) {
  $('p-title').textContent = song.trackName || song.title || '—';
  $('p-artist').textContent = song.artistName || song.artist || '—';
  const liked = S.liked.has(getSongId(song));
  const heartEl = $('p-heart');
  if (heartEl) heartEl.classList.toggle('liked', liked);
  const dLike = $('desktop-like-btn');
  if (dLike) dLike.classList.toggle('liked', liked);
  $('lyr-title').textContent  = song.trackName || song.title || 'Lyrics';
  $('lyr-artist').textContent = song.artistName || song.artist || '—';

  const artUrl = getArt(song, true);
  const cineArt = $('cine-art');
  const cineBg = $('cine-bg');
  const lyricBg = $('lyric-bg');
  const bg1 = $('ambient-bg-1');
  const bg2 = $('ambient-bg-2');

  if (artUrl) {
    const img = new Image();
    const applyArt = () => {
      if (S.song && getSongId(S.song) === getSongId(song)) {
        $('p-art').src = artUrl;
        const glow = $('art-glow');
        if (glow) glow.style.background = `url(${artUrl})`;
        if (cineArt) cineArt.src = artUrl;

        // Ambient crossfade
        if (bg1 && bg2) {
          const isBg1Active = bg1.classList.contains('active');
          const activeBg = isBg1Active ? bg1 : bg2;
          const inactiveBg = isBg1Active ? bg2 : bg1;
          inactiveBg.style.backgroundImage = `url(${artUrl})`;
          inactiveBg.classList.add('active');
          activeBg.classList.remove('active');
        }
        if (cineBg) cineBg.style.backgroundImage = `url(${artUrl})`;
        if (lyricBg) lyricBg.style.backgroundImage = `url(${artUrl})`;
      }
    };
    img.onload = applyArt;
    img.onerror = applyArt;
    img.src = artUrl;
  } else {
    $('p-art').src = '';
    const glow = $('art-glow');
    if (glow) glow.style.background = '';
    if (cineArt) cineArt.src = '';
    if (bg1) { bg1.style.backgroundImage = ''; bg1.classList.remove('active'); }
    if (bg2) { bg2.style.backgroundImage = ''; bg2.classList.remove('active'); }
    if (cineBg) cineBg.style.backgroundImage = '';
    if (lyricBg) lyricBg.style.backgroundImage = '';
  }

  // Update active song items in lists dynamically
  updateActiveSongRowUI(song);
}

function showMini(song) {
  const artUrl = getArt(song, false);
  if (artUrl) {
    const miniImg = new Image();
    miniImg.onload = () => {
      if (S.song && getSongId(S.song) === getSongId(song)) {
        $('m-art').src = artUrl;
      }
    };
    miniImg.onerror = () => {
      if (S.song && getSongId(S.song) === getSongId(song)) {
        $('m-art').src = artUrl;
      }
    };
    miniImg.src = artUrl;
  } else {
    $('m-art').src = '';
  }
  $('m-title').textContent  = song.trackName || song.title || '—';
  $('m-artist').textContent = song.artistName || song.artist || '—';
  $('mini').classList.add('on');
}

// ─── RENDER HELPERS ────────────────────────────────────────────────────────
function songItemHTML(song, idx, showNum) {
  const rid = reg(song);
  const sid = getSongId(song);
  const art = getArt(song, false);
  const dur = song.trackTimeMillis ? fmt(song.trackTimeMillis/1000) : (song.duration ? fmt(song.duration) : '');
  const now = S.song && getSongId(S.song) === sid;
  const liked = S.liked.has(sid);
  const heartSvg = liked
    ? `<svg class="row-heart liked" width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
    : `<svg class="row-heart" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
  return `
  <div class="song-item${now?' now-playing':''}" onclick="playSong(getSong('${rid}'))">
    ${showNum ? `<div class="track-num">${idx+1}</div>
    <div class="bars"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>` : ''}
    <img class="song-art" src="${esc(art)}" loading="lazy" onerror="this.style.opacity=.15">
    <div class="song-info">
      <div class="song-title">${esc(song.trackName||song.collectionName||song.title||'—')}</div>
      <div class="song-artist">${esc(song.artistName||song.artist||'—')}</div>
    </div>
    ${dur ? `<div class="song-dur">${dur}</div>` : ''}
    <button class="song-heart-btn${liked?' liked':''}" data-song-id="${sid}" onclick="event.stopPropagation();_toggleLikeForSong(getSong('${rid}'))" title="${liked?'Remove from Liked':'Add to Liked'}">${heartSvg}</button>
    <button class="song-menu" onclick="event.stopPropagation();openSongActions(getSong('${rid}'))">&#8942;</button>
  </div>`;
}

function renderList(el, songs, showNum) {
  if (!songs.length) { el.innerHTML = `<div class="empty"><div class="ico">🔍</div><p>Nothing here</p></div>`; return; }
  el.innerHTML = songs.map((s,i) => songItemHTML(s,i,showNum)).join('');
}

function cardHTML(song) {
  const rid = reg(song);
  const sid = getSongId(song);
  const art = getArt(song, false);
  const liked = S.liked.has(sid);
  const heartSvg = liked
    ? `<svg class="row-heart liked" width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
    : `<svg class="row-heart" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
  return `
  <div class="feed-card">
    <div class="feed-card-art" onclick="playSong(getSong('${rid}'))">
      <img src="${esc(art)}" loading="lazy" onerror="this.style.opacity=.15">
      <div class="feed-card-play">
        <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </div>
    </div>
    <div class="feed-card-title" onclick="playSong(getSong('${rid}'))">${esc(song.trackName||song.title||'—')}</div>
    <div class="feed-card-sub">${esc(song.artistName||song.artist||'—')}</div>
    <button class="feed-card-heart${liked?' liked':''}" data-song-id="${sid}" onclick="event.stopPropagation();_toggleLikeForSong(getSong('${rid}'))" title="${liked?'Remove from Liked':'Add to Liked'}">${heartSvg}</button>
    <button class="feed-card-menu" onclick="event.stopPropagation();openSongActions(getSong('${rid}'))" title="More options">&#8942;</button>
  </div>`;}

function renderCards(el, songs) {
  if (!songs || !songs.length) return;
  el.innerHTML = songs.map(s => cardHTML(s)).join('');
}
// ─── DYNAMIC BACKGROUND ──────────────────────────────────────────────────────
function bgColor(imgURL) {
  if (!imgURL) return;
  const img = new Image(); img.crossOrigin='anonymous'; img.src = imgURL;
  img.onload = () => {
    try {
      const c = document.createElement('canvas'); c.width=c.height=10;
      const ctx = c.getContext('2d');
      ctx.drawImage(img,0,0,10,10);
      const d = ctx.getImageData(0,0,10,10).data;
      let r=0,g=0,b=0, n=d.length/4;
      for(let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2];}
      r=Math.round(r/n); g=Math.round(g/n); b=Math.round(b/n);
      // Boost saturation slightly
      const max=Math.max(r,g,b), min=Math.min(r,g,b);
      if (max-min < 30) { r=Math.min(255,r+20); g=Math.min(255,g+20); }
      $('glow').style.background = `radial-gradient(ellipse at 35% 35%, rgb(${r},${g},${b}), transparent 50%)`;
      $('glow2').style.background = `radial-gradient(ellipse at 65% 65%, rgb(${b},${r},${g}), transparent 50%)`;
      if ($('glow3')) $('glow3').style.background = `radial-gradient(ellipse at 50% 50%, rgb(${g},${b},${r}), transparent 50%)`;
      // Update art glow color
      const artGlow = $('art-glow');
      if (artGlow) artGlow.style.background = `rgb(${r},${g},${b})`;
    } catch(e) {
      // CORS / security error on cross-origin image — skip glow update
    }
  };
  img.onerror = () => {}; // Swallow image load errors silently
}

// ─── NAVIGATION ──────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  const screen = $('s-'+tab);
  if (screen) screen.classList.add('active');
  const navBtn = $('nb-'+tab);
  if (navBtn) navBtn.classList.add('active');
  
  // Hide mobile brand only on search tab, show on all other tabs (including lyrics)
  const mobileBrand = document.querySelector('.mobile-brand');
  if (mobileBrand) {
    mobileBrand.style.display = tab === 'search' ? 'none' : 'flex';
  }
  
  // Hide gear button on all tabs except home
  const gearBtn = document.querySelector('.mobile-gear-btn');
  if (gearBtn) {
    gearBtn.style.display = tab === 'home' ? 'flex' : 'none';
  }
  
  S.tab = tab;
  if (tab === 'search') setTimeout(() => $('search-input').focus(), 100);
  if (tab === 'library') renderLibrary();
  if (tab === 'lyrics') {
    setTimeout(scrollToActiveLyric, 100);
  }
}

function openPlayer()  { if(S.song){ $('player').classList.add('open'); document.body.classList.add('player-open'); } }
function closePlayer() { $('player').classList.remove('open'); document.body.classList.remove('player-open'); }

// Swipe down to close player
let ty0=0;
$('player').addEventListener('touchstart', e=>{
  const t = e.target;
  if (t.closest('.main-ctrls') || t.closest('.player-topbar') || t.closest('.vol-wrap') || t.closest('.c-btn') || t.closest('.prog-track')) {
    ty0 = 999999;
    return;
  }
  ty0=e.touches[0].clientY;
},{passive:true});
$('player').addEventListener('touchend', e=>{
  if (ty0 === 999999) return;
  if(e.changedTouches[0].clientY-ty0>90) closePlayer();
},{passive:true});

// ─── SETTINGS ──────────────────────────────────────────────────────────────
function openSettings()  { 
  $('url-input').value = S.url; 
  const autoIn = $('autoplay-input');
  if (autoIn) autoIn.checked = S.autoplay;
  const autoPlIn = $('autoplay-playlists-input');
  if (autoPlIn) autoPlIn.checked = S.autoplayPlaylists;
  $('settings').classList.add('open'); 
  document.body.classList.add('modal-open');
}
function closeSettings() { $('settings').classList.remove('open'); document.body.classList.remove('modal-open'); }
function saveSettings()  {
  const url = $('url-input').value.trim().replace(/\/$/,'');
  if (!url) return;
  S.url = url;
  localStorage.setItem('dyd_url', url);
  const autoIn = $('autoplay-input');
  if (autoIn) {
    S.autoplay = autoIn.checked;
    localStorage.setItem('dyd_autoplay', S.autoplay ? 'true' : 'false');
  }
  const autoPlIn = $('autoplay-playlists-input');
  if (autoPlIn) {
    S.autoplayPlaylists = autoPlIn.checked;
    localStorage.setItem('dyd_autoplay_playlists', S.autoplayPlaylists ? 'true' : 'false');
  }
  closeSettings();
  toast('Settings saved ✓');
  loadHomeFeeds();
}

// ─── TOAST ─────────────────────────────────────────────────────────────────
let toastT;
function toast(msg) {
  const el = $('toast'); el.textContent=msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(()=>el.classList.remove('show'), 2200);
}

// ─── ACTION SHEET (Song Options) ──────────────────────────────────────────
function openSongActions(song) {
  if (!song) return;
  actionSong = song;
  const sid = getSongId(song);
  const isLiked = S.liked.has(sid);
  const art = getArt(song, false);

  $('action-preview').innerHTML = `
    <img src="${esc(art)}" onerror="this.style.opacity=.15">
    <div>
      <div class="a-title">${esc(song.trackName||song.title||'—')}</div>
      <div class="a-artist">${esc(song.artistName||song.artist||'—')}</div>
    </div>`;

  let plItems = playlists.map(pl => {
    const alreadyIn = pl.songs.some(s => getSongId(s) === sid);
    return `<div class="action-item${alreadyIn ? ' disabled' : ''}" onclick="${alreadyIn ? '' : `addToPlaylist('${pl.id}',actionSong);closeActions()`}">
      <span>${alreadyIn ? '✓' : '📋'}</span>${esc(pl.name)}${alreadyIn ? ' <small style="opacity:.5">(added)</small>' : ''}
    </div>`;
  }).join('');

  // If currently viewing a playlist in library or search feed details, show 'Remove from this playlist' option
  let removeFromPl = '';
  let targetPl = null;
  if (libraryView === 'playlist' && currentPlaylistId) {
    targetPl = playlists.find(p => p.id === currentPlaylistId);
  } else if (currentSearchFeedId && (currentSearchFeedType === 'playlist' || currentSearchFeedType === 'mix')) {
    targetPl = playlists.find(p => p.id === currentSearchFeedId || p.ytId === currentSearchFeedId || p.id === 'pl_yt_' + currentSearchFeedId);
  }
  if (targetPl) {
    const idx = targetPl.songs.findIndex(s => getSongId(s) === sid);
    if (idx >= 0) {
      removeFromPl = `<div class="action-divider"></div>
        <div class="action-item" style="color:var(--pink)" onclick="removeFromPlaylist('${targetPl.id}',${idx});closeActions()">
          <span>🗑</span>Remove from "${esc(targetPl.name)}"
        </div>`;
    }
  }

  $('action-list').innerHTML = `
    <div class="action-item" onclick="_toggleLikeForSong(actionSong);closeActions()">
      <span>${isLiked ? '💔' : '❤️'}</span>${isLiked ? 'Remove from Liked' : 'Add to Liked'}
    </div>
    <div class="action-item" onclick="addToQueue(actionSong);closeActions()">
      <span>➕</span>Add to Queue
    </div>
    ${removeFromPl}
    ${playlists.length ? '<div class="action-divider"></div><div class="action-sublabel">Add to Playlist</div>' + plItems : ''}
    <div class="action-divider"></div>
    <div class="action-item" onclick="_createPlSong=actionSong;closeActions();openCreatePlaylist()">
      <span>✨</span>New Playlist with this song
    </div>`;

  $('action-sheet').classList.add('open');
  document.body.classList.add('modal-open');
}
function closeActions() { $('action-sheet').classList.remove('open'); document.body.classList.remove('modal-open'); actionSong = null; }

// ─── CREATE PLAYLIST MODAL ───────────────────────────────────────────────
function openCreatePlaylist() { $('pl-name-input').value = ''; $('create-pl-modal').classList.add('open'); document.body.classList.add('modal-open'); setTimeout(() => $('pl-name-input').focus(), 100); }
function closeCreatePlaylist() { $('create-pl-modal').classList.remove('open'); document.body.classList.remove('modal-open'); _createPlSong = null; }
function confirmCreatePlaylist() {
  const name = $('pl-name-input').value.trim();
  if (!name) { toast('Enter a name'); return; }
  createPlaylist(name, _createPlSong);
  _createPlSong = null;
  closeCreatePlaylist();
}

// ─── VOLUME SLIDER ─────────────────────────────────────────────────────────
const volSlider = $('vol-slider');
if (volSlider) {
  volSlider.addEventListener('input', e => { audio.volume = e.target.value / 100; });
}

// ─── DESKTOP RIGHT PANEL ──────────────────────────────────────────────────
function switchRpTab(tab) {
  S.rpTab = tab;
  document.querySelectorAll('.rp-tab').forEach(t => t.classList.remove('active'));
  const activeTab = $('rpt-' + tab);
  if (activeTab) activeTab.classList.add('active');

  const q = $('queue-wrapper');
  const l = $('lyrics-wrapper');
  const r = $('related-wrapper');
  if (q) q.style.display = tab === 'queue'   ? 'block' : 'none';
  if (l) l.style.display = tab === 'lyrics'  ? 'block' : 'none';
  if (r) r.style.display = tab === 'related' ? 'block' : 'none';

  if (tab === 'lyrics') {
    setTimeout(scrollToActiveLyric, 50);
  }
  if (tab === 'related') renderRelated();
}

// ─── RELATED TAB ──────────────────────────────────────────────────
let _relatedSong = null;
async function renderRelated() {
  const rw = $('related-wrapper');
  if (!rw || !S.song) return;
  // Don't re-fetch if same song
  if (_relatedSong === (S.song.videoId || S.song.trackId)) return;
  _relatedSong = S.song.videoId || S.song.trackId;

  const rc = $('related-content');
  if (!rc) return;
  rc.innerHTML = `<div class="loader"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;

  try {
    const data = await API.upNext(S.song, 15);
    let songs = (Array.isArray(data) ? data : (data.songs || data.results || [])).map(s => { reg(s); return s; });
    songs = filterBanned(songs);
    if (!songs.length) {
      rc.innerHTML = `<div class="empty"><div class="ico">🎵</div><p>No related songs found</p></div>`;
      return;
    }
    rc.innerHTML = songs.map((s,i) => songItemHTML(s, i, false)).join('');
  } catch(e) {
    rc.innerHTML = `<div class="empty"><div class="ico">⚠️</div><p>Couldn't load related songs</p></div>`;
  }
}
// Reset related cache when song changes
function _resetRelated() { _relatedSong = null; }


// ─── RESPONSIVE DOM SHIFTING ───────────────────────────────────────────────
// ─── RESPONSIVE DOM SHIFTING ───────────────────────────────────────────────
function updateDesktopLayout() {
  const isDesktop = window.innerWidth >= 1200;

  const qWrap = $('queue-wrapper');
  const lWrap = $('lyrics-wrapper');
  const rpContent = $('rp-content');
  const sQueue = $('s-queue');
  const sLyrics = $('s-lyrics');

  // Ensure related-wrapper exists
  let rWrap = $('related-wrapper');
  if (!rWrap && rpContent) {
    rWrap = document.createElement('div');
    rWrap.id = 'related-wrapper';
    rWrap.innerHTML = `
      <div class="screen-header" style="padding:18px 20px 12px">
        <div class="screen-sub">You might like</div>
        <div class="screen-title" style="font-size:1.4rem">Related</div>
      </div>
      <div class="song-list" id="related-content">
        <div class="empty"><div class="ico">🎵</div><p>Play a song to see related tracks</p></div>
      </div>`;
  }

  // Handle resizing while lyrics fullscreen mode is active
  if (lyricsFullscreenMode) {
    if (isDesktop) {
      document.body.classList.add('lyrics-fullscreen');
      if (lWrap && sLyrics && !sLyrics.contains(lWrap)) sLyrics.appendChild(lWrap);
      if (sLyrics) {
        sLyrics.classList.remove('fullscreen-lyrics');
        sLyrics.classList.add('active');
      }
    } else {
      document.body.classList.remove('lyrics-fullscreen');
      if (lWrap && sLyrics && !sLyrics.contains(lWrap)) sLyrics.appendChild(lWrap);
      if (sLyrics) sLyrics.classList.add('fullscreen-lyrics');
    }
  } else if (sLyrics) {
    sLyrics.classList.remove('fullscreen-lyrics');
  }

  if (isDesktop && qWrap && lWrap && rpContent) {
    if (!rpContent.contains(qWrap)) rpContent.appendChild(qWrap);
    if (!lyricsFullscreenMode) {
      if (!rpContent.contains(lWrap)) rpContent.appendChild(lWrap);
    }
    if (rWrap && !rpContent.contains(rWrap)) rpContent.appendChild(rWrap);
    if (!lyricsFullscreenMode) {
      switchRpTab(S.rpTab || 'queue');
    }

    // Add desktop like button (the original is inside the hidden .player-topbar)
    if (!$('desktop-like-btn')) {
      const leftCol = document.querySelector('.player-left-col');
      if (leftCol) {
        const btn = document.createElement('div');
        btn.id = 'desktop-like-btn';
        btn.onclick = () => { if (typeof toggleLike === 'function') toggleLike(); };
        btn.innerHTML = `<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
        if (S.song) {
          const liked = S.liked.has(getSongId(S.song));
          btn.classList.toggle('liked', liked);
        }
        leftCol.appendChild(btn);
      }
    }

    // Add desktop menu button
    if (!$('desktop-menu-btn')) {
      const leftCol = document.querySelector('.player-left-col');
      if (leftCol) {
        const btn = document.createElement('div');
        btn.id = 'desktop-menu-btn';
        btn.title = 'More options';
        btn.onclick = () => { if (S.song) openSongActions(S.song); };
        btn.innerHTML = '&#8942;';
        leftCol.appendChild(btn);
      }
    }
  } else if (!isDesktop && qWrap && lWrap && sQueue && sLyrics) {
    if (!sQueue.contains(qWrap)) sQueue.appendChild(qWrap);
    if (!sLyrics.contains(lWrap)) sLyrics.appendChild(lWrap);
    qWrap.style.display = '';
    lWrap.style.display = '';
    if (rWrap) rWrap.style.display = 'none';

    // Remove desktop buttons on mobile
    const dLike = $('desktop-like-btn');
    if (dLike) dLike.remove();
    const dMenu = $('desktop-menu-btn');
    if (dMenu) dMenu.remove();
  }
}

// ─── LYRICS CONTROLS ─────────────────────────────────────────────────────
let lyricsFullscreenMode = false;
let lyricsSyncDelay = 0;
let lyricsShowSynced = true;

let _prevTab = 'home';
function toggleLyricsFullscreen() {
  lyricsFullscreenMode = !lyricsFullscreenMode;
  const isDesktop = window.innerWidth >= 1200;
  const sLyrics = $('s-lyrics');
  const lWrap = $('lyrics-wrapper');
  const rpContent = $('rp-content');
  const btn = $('lyrics-fullscreen-btn');
  const lyricBg = $('lyric-bg');

  if (lyricsFullscreenMode) {
    _prevTab = S.tab || 'home';
    if (isDesktop) {
      // Move lyrics-wrapper from right panel back into #s-lyrics
      if (lWrap && sLyrics && !sLyrics.contains(lWrap)) {
        sLyrics.appendChild(lWrap);
      }
      lWrap.style.display = '';

      // Add fullscreen class to body (controls grid + right panel visibility)
      document.body.classList.add('lyrics-fullscreen');

      // Make #s-lyrics the active screen
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      sLyrics.classList.add('active');
      S.tab = 'lyrics';
    } else {
      // Mobile: just go fullscreen
      sLyrics.classList.add('fullscreen-lyrics');
    }

    if (btn) {
      btn.classList.add('active');
      btn.textContent = '✕';
      btn.title = 'Exit fullscreen lyrics';
    }

    // Set blurred cover background
    if (S.song && lyricBg) {
      lyricBg.style.backgroundImage = `url(${getArt(S.song, true)})`;
    }

    setTimeout(scrollToActiveLyric, 100);
  } else {
    if (isDesktop) {
      document.body.classList.remove('lyrics-fullscreen');

      // Move lyrics-wrapper back to right panel
      if (lWrap && rpContent && !rpContent.contains(lWrap)) {
        rpContent.appendChild(lWrap);
      }
      // Re-show based on current right panel tab
      switchRpTab(S.rpTab || 'queue');

      // Restore the previous active tab
      switchTab(_prevTab);
    } else {
      sLyrics.classList.remove('fullscreen-lyrics');
    }

    if (btn) {
      btn.classList.remove('active');
      btn.textContent = '⛶';
      btn.title = 'Fullscreen lyrics';
    }
  }
}

function toggleLyricsMode() {
  lyricsShowSynced = !lyricsShowSynced;
  const btn = $('lyrics-mode-btn');
  const hasSynced = S._syncedLyrics && S._syncedLyrics.length > 0;

  if (!hasSynced) {
    // No synced lyrics available, stay on plain
    lyricsShowSynced = false;
    if (btn) {
      btn.textContent = 'plain';
      btn.classList.add('active');
    }
    toast('No synced lyrics available');
    return;
  }

  if (btn) {
    btn.textContent = lyricsShowSynced ? 'synced' : 'plain';
    btn.classList.toggle('active', !lyricsShowSynced);
  }

  // Switch lyrics data
  lastLyricIdx = -1;
  const isSyncedActive = lyricsShowSynced && hasSynced;
  const lyricBody = $('lyric-body');
  const lWrap = $('lyrics-wrapper');
  if (lyricBody) {
    lyricBody.classList.toggle('plain-mode', !isSyncedActive);
  }
  if (lWrap) {
    lWrap.classList.toggle('plain-mode', !isSyncedActive);
  }

  if (lyricsShowSynced && S._syncedLyrics.length) {
    S.lyrics = S._syncedLyrics;
  } else {
    S.lyrics = S._plainLyrics || [];
  }

  // Re-render lyrics
  if (lyricBody) {
    lyricBody.innerHTML = S.lyrics.map((l,i) =>
      `<div class="lyric-line" id="ll-${i}">${esc(l.text||'♪')}</div>`
    ).join('');
  }

  toast(lyricsShowSynced ? 'Synced lyrics' : 'Plain lyrics');
}

function adjustSyncDelay(delta) {
  lyricsSyncDelay += delta;
  lyricsSyncDelay = Math.round(lyricsSyncDelay * 10) / 10; // Round to 1 decimal
  lyricsSyncDelay = Math.max(-2, Math.min(2, lyricsSyncDelay)); // Clamp between -2 and +2

  const display = $('sync-display');
  if (display) {
    display.textContent = lyricsSyncDelay === 0 ? '0s' : (lyricsSyncDelay > 0 ? '+' : '') + lyricsSyncDelay.toFixed(1) + 's';
  }
  // Reset sync state so it re-highlights from current position
  lastLyricIdx = -1;
}

// Listen for window resize to shift DOM dynamically
window.addEventListener('resize', updateDesktopLayout);

// Initialize on load to ensure DOM and viewport are ready
document.addEventListener('DOMContentLoaded', () => {
  updateDesktopLayout();
  if (typeof renderSidebarPlaylists === 'function') renderSidebarPlaylists();

  // Hook cinematic click
  const artWrap = document.querySelector('.art-wrap');
  if (artWrap) {
    artWrap.addEventListener('click', () => {
      if (window.innerWidth >= 1200 && S.song) switchTab('cinematic');
    });
  }
});
window.addEventListener('load', () => {
  updateDesktopLayout();
  if (typeof renderSidebarPlaylists === 'function') renderSidebarPlaylists();
});


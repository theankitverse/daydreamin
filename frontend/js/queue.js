// Preload the next song's stream URL + lyrics in background
async function preloadNext() {
  if (!S.queue.length) return;
  const nextSong = S.queue[0];

  // Preload stream URL
  if (!getCachedUrl(nextSong)) {
    try {
      const data = await API.play(nextSong);
      const streamUrl = (S.skipDirectUrl ? null : data.direct_url) || data.stream_url || data.url || data.audio_url || '';
      const fallbackUrl = data.stream_url || data.url || data.audio_url || '';
      if (streamUrl) setCachedUrl(nextSong, streamUrl, data.videoId || '', fallbackUrl);
    } catch(e) { /* silent */ }
  }

  // Preload lyrics
  const a = nextSong.artistName||nextSong.artist||'';
  const t = nextSong.trackName||nextSong.title||'';
  const lk = `${a}|${t}`.toLowerCase();
  if ((a || t) && !lyricsCache.has(lk)) {
    API.lyrics(a, t).then(d => { if (d) lyricsCache.set(lk, d); }).catch(()=>{});
  }
}

function renderQueue() {
  if (S.song) {
    const art = getArt(S.song, false);
    $('q-now').innerHTML = `
      <div class="q-now">
        <img class="q-now-art" src="${esc(art)}">
        <div>
          <div class="q-now-title">${esc(S.song.trackName||S.song.title||'—')}</div>
          <div class="q-now-artist">${esc(S.song.artistName||S.song.artist||'—')}</div>
        </div>
      </div>`;
  }
  const el = $('queue-list');
  if (!S.queue.length) { el.innerHTML = `<div class="empty"><div class="ico">📋</div><p>Queue is empty</p></div>`; return; }
  el.innerHTML = S.queue.map((s,i) => {
    const rid = reg(s);
    const sid = getSongId(s);
    const art = getArt(s, false);
    const liked = S.liked.has(sid);
    const heartSvg = liked
      ? `<svg class="row-heart liked" width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
      : `<svg class="row-heart" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
    return `<div class="song-item" onclick="playFromQueue(${i})">
      <img class="song-art" src="${esc(art)}" loading="lazy">
      <div class="song-info">
        <div class="song-title">${esc(s.trackName||s.title||'—')}</div>
        <div class="song-artist">${esc(s.artistName||s.artist||'—')}</div>
      </div>
      <button class="song-heart-btn${liked?' liked':''}" data-song-id="${sid}" onclick="event.stopPropagation();_toggleLikeForSong(getSong('${rid}'))" title="${liked?'Remove from Liked':'Add to Liked'}">${heartSvg}</button>
      <button class="song-menu" onclick="event.stopPropagation();openSongActions(getSong('${rid}'))" title="More options">&#8942;</button>
    </div>`;
  }).join('');
}

async function playFromQueue(i) {
  const song = S.queue.splice(i,1)[0];
  renderQueue();
  await playSong(song, true, S._manualQueue);
}

// ─── QUEUE AUTO-REFILL ─────────────────────────────────────────────────────
let _refillPromise = null;
async function refillQueue() {
  if (_refillPromise || !S.song) return;
  _refillPromise = _doRefill();
  try { await _refillPromise; } finally { _refillPromise = null; }
}

async function _doRefill() {
  if (S._manualQueue || !S.song) return;
  const expectedSongId = getSongId(S.song);
  try {
    const data = await API.upNext(S.song, 20);
    if (S._manualQueue || !S.song || getSongId(S.song) !== expectedSongId) return;
    let songs = (Array.isArray(data) ? data : (data.songs||data.results||[])).map(s => { reg(s); return s; });
    songs = diversifyArtists(filterBanned(songs));
    // Don't add duplicates
    const existing = new Set(S.queue.map(s => getSongId(s)));
    const fresh = songs.filter(s => !existing.has(getSongId(s)));
    S.queue.push(...fresh);
    renderQueue();
    if (fresh.length) toast(`+${fresh.length} songs queued`);
  } catch(e) { /* silent */ }
}

function addToQueue(song) {
  reg(song);
  S.queue.push(song);
  renderQueue();
  toast('Added to queue');
}

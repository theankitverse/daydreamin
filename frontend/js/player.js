// ─── AUDIO EVENTS ──────────────────────────────────────────────────────────
audio.addEventListener('timeupdate', onTimeUpdate);
audio.addEventListener('loadedmetadata', () => { $('t-tot').textContent = fmt(audio.duration); updatePositionState(); });
audio.addEventListener('ended', () => { S.repeat ? (audio.currentTime=0, audio.play()) : nextSong(); });
audio.addEventListener('play',  () => { setPlayUI(true); setBufferingUI(false); });
audio.addEventListener('pause', () => setPlayUI(false));
audio.addEventListener('waiting', () => setBufferingUI(true));
audio.addEventListener('canplay', () => setBufferingUI(false));
audio.addEventListener('error', () => { if (audio.src) toast('⚠ Stream error'); setBufferingUI(false); });

function onTimeUpdate() {
  if (!audio.duration || dragging) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  $('prog-fill').style.width = pct + '%';
  $('prog-thumb').style.left = pct + '%';
  $('m-bar').style.width = pct + '%';
  $('t-cur').textContent = fmt(audio.currentTime);
  // Preload when 75% through
  if (pct > 75 && S.queue.length && !getCachedUrl(S.queue[0])) preloadNext();
}

function setPlayUI(playing) {
  const pause = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
  const play  = '<path d="M8 5v14l11-7z"/>';
  const ico = playing ? pause : play;
  $('p-play-ico').innerHTML = ico;
  $('m-play-ico').innerHTML = ico;
  $('p-art').classList.toggle('playing', playing);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

function setBufferingUI(buffering) {
  const btn = $('play-btn');
  if (btn) btn.classList.toggle('buffering', buffering);
  const mBtn = document.querySelector('.mini-btns .mini-btn:nth-child(2)');
  if (mBtn) mBtn.classList.toggle('buffering', buffering);
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !audio.duration) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, audio.duration)
    });
  } catch(e) {}
}

// ─── MEDIA SESSION (lock screen + Bluetooth) ──────────────────────────────
function updateMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  const art = getArt(song, true);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.trackName || song.title || '—',
    artist: song.artistName || song.artist || '—',
    album: song.album || song.collectionName || '',
    artwork: art ? [{ src: art, sizes: '512x512', type: 'image/jpeg' }] : []
  });
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('nexttrack', nextSong);
  navigator.mediaSession.setActionHandler('previoustrack', prevSong);
  navigator.mediaSession.setActionHandler('seekbackward', d => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset||10)); });
  navigator.mediaSession.setActionHandler('seekforward', d => { audio.currentTime = Math.min(audio.duration||0, audio.currentTime + (d.seekOffset||10)); });
  try {
    navigator.mediaSession.setActionHandler('seekto', d => {
      if (d.fastSeek && 'fastSeek' in audio) audio.fastSeek(d.seekTime);
      else audio.currentTime = d.seekTime;
      updatePositionState();
    });
  } catch(e) {}
}

// ─── PLAYBACK ──────────────────────────────────────────────────────────────
async function playSong(song, addHistory=true, keepQueue=false) {
  if (!song) return;
  // If not playing from playlist/liked, clear manual queue flag
  if (!keepQueue) S._manualQueue = false;

  if (addHistory && S.song) S.history.push(S.song);
  if (S.history.length > 50) S.history = S.history.slice(-50);
  try { localStorage.setItem('dyd_history', JSON.stringify(S.history)); } catch(e) {}
  S.prevId = S.song ? getSongId(S.song) : null;
  S.song = song;

  // Persist for session restore and set visibility
  try { localStorage.setItem('dyd_last_song', JSON.stringify(song)); } catch(e) {}
  document.body.classList.add('has-song');

  setNowPlayingUI(song);
  showMini(song);
  updateMediaSession(song);
  toast('Loading…');

  try {
    // Check URL cache first
    let streamUrl = getCachedUrl(song);
    let isDirectUrl = false;
    let fallbackUrl = null;

    if (!streamUrl) {
      setBufferingUI(true);
      const data = await API.play(song);
      streamUrl = (S.skipDirectUrl ? null : data.direct_url) || data.stream_url || data.url || data.audio_url || '';
      isDirectUrl = !S.skipDirectUrl && !!data.direct_url;
      fallbackUrl = data.stream_url || data.url || data.audio_url || '';
      if (data.videoId) song.videoId = data.videoId;
      if (streamUrl) setCachedUrl(song, streamUrl, data.videoId||'', fallbackUrl);
    } else {
      fallbackUrl = getCachedProxy(song);
      isDirectUrl = streamUrl && !streamUrl.includes('/stream_proxy');
    }
    if (!streamUrl) throw new Error('No stream URL');
    audio.pause();

    // Prepare error fallback
    audio.onerror = async () => {
      audio.onerror = null;
      if (S.song !== song) return;
      if (isDirectUrl && fallbackUrl && fallbackUrl !== streamUrl) {
        console.warn("Direct URL playback failed, falling back to proxy URL:", fallbackUrl);
        S.skipDirectUrl = true; // disable direct URLs for the rest of the session
        toast('Direct playback failed, retrying with proxy…');
        try {
          audio.src = fallbackUrl;
          await audio.play();
        } catch(err) {
          toast('Playback failed: ' + err.message);
          setBufferingUI(false);
        }
      } else {
        toast('Playback failed');
        setBufferingUI(false);
      }
    };

    audio.src = streamUrl;
    await audio.play();
    audio.onerror = null; // Clear if play starts successfully

    // Background tasks: queue + lyrics + preload
    // Only auto-fill queue if NOT playing from a manual source (playlist/liked)
    if (!S._manualQueue) {
      const activeSongId = getSongId(song);
      API.upNext(song, 15).then(d => {
        if (S._manualQueue || !S.song || getSongId(S.song) !== activeSongId) return;
        let songs = (Array.isArray(d) ? d : (d.songs||d.results||[])).map(s => { reg(s); return s; });
        S.queue = diversifyArtists(
          filterBanned(songs)
        );
        renderQueue();
        preloadNext();
      }).catch(()=>{});
    } else {
      // Manual queue — just preload next song
      renderQueue();
      preloadNext();
    }

    const artist = song.artistName||song.artist||'';
    const title = song.trackName||song.title||'';
    if (artist || title) {
      const lk = `${artist}|${title}`.toLowerCase();
      const cached = lyricsCache.get(lk);
      if (cached) {
        parseLyrics(cached);
      } else {
        API.lyrics(artist, title).then(d => {
          if (d) lyricsCache.set(lk, d);
          parseLyrics(d);
        }).catch(()=>{});
      }
    }

    bgColor(getArt(song, false));
    // Reset related tab so it refreshes for new song
    if (typeof _resetRelated === 'function') _resetRelated();
  } catch(e) {
    console.error(e);
    toast('Failed: ' + e.message);
    setBufferingUI(false);
  }
}

function togglePlay()   { if(!S.song) return; audio.paused ? audio.play() : audio.pause(); }
function toggleShuffle(){ S.shuffle=!S.shuffle; $('shuffle-btn').classList.toggle('on',S.shuffle); toast(S.shuffle?'Shuffle on':'Shuffle off'); }
function toggleRepeat() { S.repeat=!S.repeat; $('repeat-btn').classList.toggle('on',S.repeat); toast(S.repeat?'Repeat on':'Repeat off'); }

function toggleLike() {
  if (!S.song) return;
  _toggleLikeForSong(S.song);
}

function _toggleLikeForSong(song) {
  const id = getSongId(song);
  const isCurrentSong = S.song && getSongId(S.song) === id;
  if (S.liked.has(id)) {
    S.liked.delete(id);
    delete _savedLikedSongs[id];
    toast('Removed from liked');
  } else {
    S.liked.add(id);
    _savedLikedSongs[id] = song;
    S.songs[id] = song;
    toast('Added to liked ♥');
  }
  const isNowLiked = S.liked.has(id);
  // Update player heart
  const h = $('p-heart');
  if (h && isCurrentSong) h.classList.toggle('liked', isNowLiked);
  // Update desktop like button
  const dLike = $('desktop-like-btn');
  if (dLike && isCurrentSong) dLike.classList.toggle('liked', isNowLiked);
  
  // Dynamically update ALL row and card heart icons on the page matching this song ID
  document.querySelectorAll(`.song-heart-btn[data-song-id="${id}"]`).forEach(btn => {
    btn.classList.toggle('liked', isNowLiked);
    btn.innerHTML = isNowLiked
      ? `<svg class="row-heart liked" width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
      : `<svg class="row-heart" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
  });
  document.querySelectorAll(`.feed-card-heart[data-song-id="${id}"]`).forEach(btn => {
    btn.classList.toggle('liked', isNowLiked);
    btn.innerHTML = isNowLiked
      ? `<svg class="row-heart liked" width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
      : `<svg class="row-heart" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
  });

  // Persist
  localStorage.setItem('dyd_liked', JSON.stringify([...S.liked]));
  localStorage.setItem('dyd_liked_songs', JSON.stringify(_savedLikedSongs));
  // Refresh any visible UI
  if (S.tab === 'library') renderLibrary();
  if (typeof renderSidebarPlaylists === 'function') renderSidebarPlaylists();
}

async function nextSong() {
  if (!S.queue.length) {
    if (S._manualQueue) {
      if (S.autoplayPlaylists) {
        S._manualQueue = false;
        await refillQueue();
      } else {
        audio.pause();
        setPlayUI(false);
        toast('Playlist finished');
        return;
      }
    } else {
      // Try to refill before giving up
      if (S.song) { await refillQueue(); }
    }
    if (!S.queue.length) { toast('Queue is empty'); return; }
  }
  const idx = S.shuffle ? Math.floor(Math.random()*S.queue.length) : 0;
  const next = S.queue.splice(idx,1)[0];

  if (S.song) S.history.push(S.song);
  if (S.history.length > 50) S.history = S.history.slice(-50);
  try { localStorage.setItem('dyd_history', JSON.stringify(S.history)); } catch(e) {}
  S.prevId = S.song ? getSongId(S.song) : null;
  S.song = next;

  try { localStorage.setItem('dyd_last_song', JSON.stringify(next)); } catch(e) {}
  document.body.classList.add('has-song');

  setNowPlayingUI(next);
  showMini(next);
  updateMediaSession(next);

  // Clear any existing audio error handler before starting playback
  audio.onerror = null;

  // Try cached URL for instant play
  let streamUrl = getCachedUrl(next);
  if (streamUrl) {
    if (S.song !== next) return; // Guard
    let isDirectUrl = streamUrl && !streamUrl.includes('/stream_proxy');
    let fallbackUrl = getCachedProxy(next);
    audio.src = streamUrl;
    audio.onerror = async () => {
      audio.onerror = null; // Clear immediately when error triggers to avoid double execution or leaks
      if (S.song !== next) return; // Guard
      if (isDirectUrl && fallbackUrl && fallbackUrl !== streamUrl) {
        console.warn("Direct URL playback failed from cache, falling back to proxy URL:", fallbackUrl);
        S.skipDirectUrl = true;
        toast('Direct playback failed, retrying with proxy…');
        try {
          audio.src = fallbackUrl;
          await audio.play();
        } catch(err) {
          toast('Playback failed: ' + err.message);
        }
      } else {
        try {
          const retry = await API.play(next);
          if (S.song !== next) return; // Guard
          const freshUrl = (S.skipDirectUrl ? null : retry.direct_url) || retry.stream_url || retry.url || '';
          const isFreshDirect = !S.skipDirectUrl && !!retry.direct_url;
          const freshFallback = retry.stream_url || retry.url || '';
          if (freshUrl) {
            audio.onerror = async () => {
              audio.onerror = null;
              if (S.song !== next) return;
              if (isFreshDirect && freshFallback && freshFallback !== freshUrl) {
                S.skipDirectUrl = true;
                toast('Direct playback failed, retrying with proxy…');
                try {
                  audio.src = freshFallback;
                  await audio.play();
                } catch(err) {
                  toast('Playback failed');
                }
              } else {
                toast('Playback failed');
              }
            };
            audio.src = freshUrl;
            await audio.play();
            audio.onerror = null;
          }
        } catch(e) {
          toast('Playback failed');
        }
      }
    };
    try { 
      await audio.play(); 
      if (S.song !== next) return; // Guard
      // Clean up onerror handler since playback successfully started
      audio.onerror = null;
    } catch(e) { 
      streamUrl = null; 
      audio.onerror = null; // Clear if play throws synchronously
    }
  }

  if (!streamUrl) {
    if (S.song !== next) return; // Guard
    try {
      toast('Loading…');
      setBufferingUI(true);
      const data = await API.play(next);
      if (S.song !== next) return; // Guard
      streamUrl = (S.skipDirectUrl ? null : data.direct_url) || data.stream_url || data.url || data.audio_url || '';
      const isDirectUrl = !S.skipDirectUrl && !!data.direct_url;
      const fallbackUrl = data.stream_url || data.url || data.audio_url || '';
      if (!streamUrl) throw new Error('No stream URL');
      if (data.videoId) next.videoId = data.videoId;
      setCachedUrl(next, streamUrl, data.videoId||'', fallbackUrl);

      audio.onerror = async () => {
        audio.onerror = null;
        if (S.song !== next) return;
        if (isDirectUrl && fallbackUrl && fallbackUrl !== streamUrl) {
          S.skipDirectUrl = true;
          toast('Direct playback failed, retrying with proxy…');
          try {
            audio.src = fallbackUrl;
            await audio.play();
          } catch(err) {
            toast('Playback failed: ' + err.message);
            setBufferingUI(false);
          }
        } else {
          toast('Playback failed');
          setBufferingUI(false);
        }
      };

      audio.src = streamUrl;
      await audio.play();
      if (S.song !== next) return; // Guard
      audio.onerror = null;
    } catch(e) {
      if (S.song !== next) return; // Guard
      console.error(e);
      toast('Failed — skipping');
      setBufferingUI(false);
      if (S.queue.length) setTimeout(nextSong, 500);
      return;
    }
  }

  if (S.song !== next) return; // Guard

  // Background: lyrics + preload next
  const artist = next.artistName||next.artist||'';
  const title = next.trackName||next.title||'';
  if (artist || title) {
    const lk = `${artist}|${title}`.toLowerCase();
    const cached = lyricsCache.get(lk);
    if (cached) {
      parseLyrics(cached);
    } else {
      API.lyrics(artist, title).then(d => {
        if (S.song !== next) return;
        if (d) lyricsCache.set(lk, d);
        parseLyrics(d);
      }).catch(()=>{});
    }
  }
  bgColor(getArt(next, false));
  renderQueue();
  preloadNext();

  // Reset related tab so it refreshes for new song
  if (typeof _resetRelated === 'function') _resetRelated();

  // Auto-refill queue when running low (only if not manual queue)
  if (S.queue.length <= 3 && !S._manualQueue) refillQueue();
}

async function prevSong() {
  if (audio.currentTime > 4 || !S.history.length) { audio.currentTime=0; return; }
  const prev = S.history.pop();
  if (S.song) {
    S.queue.unshift(S.song);
    renderQueue();
  }
  await playSong(prev, false, S._manualQueue);
}

// ─── SEEK ──────────────────────────────────────────────────────────────────
let dragging=false, dragPct=0;
const progTrack = $('prog-track');

progTrack.addEventListener('pointerdown', e => {
  dragging = true;
  // Disable smooth transition during drag for accurate feel
  $('prog-fill').style.transition = 'none';
  progTrack.setPointerCapture(e.pointerId);
  moveProg(e);
});
progTrack.addEventListener('pointermove', e => { if(dragging) moveProg(e); });
progTrack.addEventListener('pointerup', e => {
  if (!dragging) return;
  dragging = false;
  moveProg(e);
  if (audio.duration) { audio.currentTime = dragPct * audio.duration; updatePositionState(); }
  // Re-enable transition after seek
  setTimeout(() => { $('prog-fill').style.transition = ''; }, 50);
});

function moveProg(e) {
  const r = progTrack.getBoundingClientRect();
  dragPct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  $('prog-fill').style.width = (dragPct*100) + '%';
  $('prog-thumb').style.left = (dragPct*100) + '%';
  $('t-cur').textContent = fmt(dragPct * (audio.duration||0));
}

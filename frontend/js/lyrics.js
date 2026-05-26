// ─── LYRICS ────────────────────────────────────────────────────────────────
function parseLyrics(data) {
  S.lyrics = [];
  S._rawLyricsData = data; // Store raw data for synced/plain toggle
  lastLyricIdx = -1;
  const synced = data?.syncedLyrics || '';
  const plain = data?.plainLyrics || data?.lyrics || '';
  // Normalize CRLF to LF before any processing
  const raw = (synced || plain || data?.message || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (!raw) {
    $('lyric-body').innerHTML = `<div class="empty"><div class="ico">🎤</div><p>No lyrics found</p></div>`;
    return;
  }

  // Store both versions
  S._syncedLyrics = [];
  S._plainLyrics = [];

  if (synced) {
    const parsed = synced.replace(/\r\n/g, '\n').split('\n').map(l => {
      const m = l.match(/^\[(\d+):(\d+\.?\d*)\](.*)/);
      return m ? { time: parseInt(m[1])*60 + parseFloat(m[2]), text: m[3].trim() } : null;
    }).filter(Boolean);
    if (parsed.length) {
      S._syncedLyrics = parsed;
    }
  }

  // Plain lyrics (always available as fallback)
  const plainText = (plain || synced || '').replace(/\r\n/g, '\n');
  S._plainLyrics = plainText.split('\n')
    .filter(l => l.trim())
    .map(l => ({ time: -1, text: l.replace(/^\[\d+:\d+\.?\d*\]/, '').trim() }));

  // Use synced if available and user wants synced, otherwise plain
  if (lyricsShowSynced && S._syncedLyrics.length) {
    S.lyrics = S._syncedLyrics;
  } else if (S._plainLyrics.length) {
    S.lyrics = S._plainLyrics;
  } else {
    S.lyrics = raw.split('\n').filter(l => l.trim()).map(l => ({ time: -1, text: l }));
  }

  const isSyncedActive = lyricsShowSynced && S._syncedLyrics.length > 0;
  const lyricBody = $('lyric-body');
  const lWrap = $('lyrics-wrapper');
  if (lyricBody) {
    lyricBody.classList.toggle('plain-mode', !isSyncedActive);
    lyricBody.innerHTML = S.lyrics.map((l,i) =>
      `<div class="lyric-line" id="ll-${i}">${esc(l.text||'♪')}</div>`
    ).join('');
  }
  if (lWrap) lWrap.classList.toggle('plain-mode', !isSyncedActive);

  // Update mode button state
  const modeBtn = $('lyrics-mode-btn');
  if (modeBtn) {
    const hasSynced = S._syncedLyrics.length > 0;
    modeBtn.textContent = (lyricsShowSynced && hasSynced) ? 'synced' : 'plain';
    modeBtn.classList.toggle('active', !(lyricsShowSynced && hasSynced));
    if (!hasSynced) {
      modeBtn.style.opacity = '0.4';
      modeBtn.style.pointerEvents = 'none';
    } else {
      modeBtn.style.opacity = '';
      modeBtn.style.pointerEvents = '';
    }
  }

  // Update blurred cover background if lyrics fullscreen mode is active
  const lyricBg = $('lyric-bg');
  if (typeof lyricsFullscreenMode !== 'undefined' && lyricsFullscreenMode && S.song && lyricBg) {
    lyricBg.style.backgroundImage = `url(${getArt(S.song, true)})`;
  }
}

let lastLyricIdx = -1;
const BASE_LYRIC_OFFSET = -0.3; // seconds — adjust if lyrics feel early (+) or late (-)

// ─── SCROLL PAUSE SYSTEM ───────────────────────────────────────────────────
// When user scrolls manually, pause auto-centering for 4 seconds
let _userScrolling = false;
let _scrollPauseTimer = null;
const SCROLL_PAUSE_DURATION = 4000; // 4 seconds

function _onUserInteract(e) {
  _userScrolling = true;
  clearTimeout(_scrollPauseTimer);
  _scrollPauseTimer = setTimeout(() => {
    _userScrolling = false;
    scrollToActiveLyric();
  }, SCROLL_PAUSE_DURATION);
}

// Attach interaction listeners to all possible lyric containers
function _attachLyricScrollListeners() {
  const containers = [$('lyric-body'), $('rp-content')].filter(Boolean);
  containers.forEach(el => {
    if (!el._listenersAttached) {
      el.addEventListener('wheel', _onUserInteract, { passive: true });
      el.addEventListener('touchmove', _onUserInteract, { passive: true });
      el.addEventListener('pointerdown', _onUserInteract, { passive: true });
      el.addEventListener('keydown', _onUserInteract, { passive: true });
      el._listenersAttached = true;
    }
  });
}

// Attach on load and re-attach periodically (DOM shifts lyrics around)
document.addEventListener('DOMContentLoaded', _attachLyricScrollListeners);
window.addEventListener('load', _attachLyricScrollListeners);
setInterval(_attachLyricScrollListeners, 2000);

// Optimized lyrics sync loop (10fps, only runs when active & playing)
function syncLyricLoop() {
  const isLyricsVisible = (
    S.tab === 'lyrics' || 
    S.rpTab === 'lyrics' || 
    document.body.classList.contains('lyrics-fullscreen') || 
    document.querySelector('#s-lyrics.fullscreen-lyrics') ||
    (typeof lyricsFullscreenMode !== 'undefined' && lyricsFullscreenMode)
  );
  if (S.lyrics && S.lyrics.length && !audio.paused && isLyricsVisible) {
    syncLyric();
  }
  setTimeout(syncLyricLoop, 100);
}
setTimeout(syncLyricLoop, 100);

function getScrollParent(node) {
  if (!node || node === document.body || node === document.documentElement) {
    return null;
  }
  const overflowY = window.getComputedStyle(node).overflowY;
  const isScrollable = overflowY === 'auto' || overflowY === 'scroll';
  if (isScrollable && node.scrollHeight > node.clientHeight) {
    return node;
  }
  // Traverse up, but fall back to this node if it's scrollable and no parent actually overflows
  const parentScroll = getScrollParent(node.parentNode);
  if (parentScroll) return parentScroll;
  if (isScrollable) return node;
  return null;
}

function scrollToActiveLyric() {
  if (_userScrolling || (typeof dragging !== 'undefined' && dragging) || (typeof S !== 'undefined' && S.dragging)) return; // User is scrolling/seeking, don't fight them
  if (lastLyricIdx >= 0) {
    const activeEl = document.getElementById(`ll-${lastLyricIdx}`);
    if (activeEl) {
      const container = getScrollParent(activeEl);
      if (container) {
        const containerRect = container.getBoundingClientRect();
        if (containerRect.height === 0 || containerRect.width === 0) return; // Hidden container
        
        const activeRect = activeEl.getBoundingClientRect();
        const relativeTop = activeRect.top - containerRect.top + container.scrollTop;
        const targetScrollTop = relativeTop - (container.clientHeight / 2) + (activeEl.offsetHeight / 2);

        // Optimization: Only scroll if target is significantly different from current position
        if (Math.abs(container.scrollTop - targetScrollTop) < 2) {
          return;
        }

        container.scrollTo({
          top: targetScrollTop,
          behavior: 'smooth'
        });
      }
    }
  }
}

function syncLyric() {
  if (!S.lyrics || !S.lyrics.length) return;

  // Plain (unsynced) lyrics — no highlighting possible
  if (S.lyrics[0].time < 0) return;

  const t = audio.currentTime + BASE_LYRIC_OFFSET + (typeof lyricsSyncDelay !== 'undefined' ? lyricsSyncDelay : 0);
  let active = 0;
  for (let i = 0; i < S.lyrics.length; i++) {
    if (S.lyrics[i].time <= t) active = i; else break;
  }
  if (active === lastLyricIdx) return;

  lastLyricIdx = active;

  // Update class lists for all lyric lines (safely handles seeks/scrubs)
  for (let i = 0; i < S.lyrics.length; i++) {
    const el = document.getElementById(`ll-${i}`);
    if (!el) continue;
    
    el.classList.remove('active', 'active-prev', 'active-next', 'past');
    if (i < active - 1) {
      el.classList.add('past');
    } else if (i === active - 1) {
      el.classList.add('active-prev');
    } else if (i === active) {
      el.classList.add('active');
    } else if (i === active + 1) {
      el.classList.add('active-next');
    }
  }

  // Auto-scroll to active lyric when lyrics tab/panel is visible
  const isLyricsVisible = (
    S.tab === 'lyrics' || 
    S.rpTab === 'lyrics' || 
    document.body.classList.contains('lyrics-fullscreen') || 
    document.querySelector('#s-lyrics.fullscreen-lyrics') ||
    (typeof lyricsFullscreenMode !== 'undefined' && lyricsFullscreenMode)
  );
  if (isLyricsVisible) {
    scrollToActiveLyric();
  }
}

// Sync instantly on seek or time updates (even when paused)
audio.addEventListener('seeked', syncLyric);
audio.addEventListener('timeupdate', () => {
  if (audio.paused) syncLyric();
});

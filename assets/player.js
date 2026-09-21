/* ==================================================================
   全站音乐播放器
   ------------------------------------------------------------------
   - 音频文件来自 content/music/（生成时扫描，写入 data-tracks）
   - 歌名/歌手/专辑/封面 = 直接从音频文件的 ID3 标签读取，不靠手填
   - 单例播放：右上角控件与「音乐」页共用同一个 <audio>，状态实时同步
   - 播放位置与当前曲目存在 localStorage，跨页面/刷新都接着放
   - 对外 API：window.DSHPlayer.{ play, pause, toggle, select, next, prev,
                                 seekTo, setMuted, getState, getTracks }
   - 状态变化广播事件：document 上的 'player:state'
   ================================================================== */
(function () {
  'use strict';

  var holder = document.querySelector('[data-music-player]');
  if (!holder) return;

  var TRACKS = [];
  try {
    TRACKS = JSON.parse(holder.getAttribute('data-tracks') || '[]');
  } catch (e) {
    TRACKS = [];
  }
  if (!TRACKS.length) return;

  holder.hidden = false;
  document.body.classList.add('has-player');

  var audio = new Audio();
  audio.preload = 'metadata';

  var KEY = 'music-player-v2';
  var state = { index: 0, time: 0, muted: false, wantPlay: false };

  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && typeof saved === 'object') {
      state.index = Math.min(Math.max(0, saved.index | 0), TRACKS.length - 1);
      state.time = Number(saved.time) || 0;
      state.muted = !!saved.muted;
      state.wantPlay = !!saved.wantPlay;
    }
  } catch (e) { /* 忽略损坏的存储 */ }
  audio.muted = state.muted;

  var restoreTime = state.time;
  var restored = false;

  /* ---------------------------- DOM ---------------------------- */
  var btn = holder.querySelector('.mp-btn');
  var coverImg = holder.querySelector('.mp-cover');
  var overlay = holder.querySelector('.mp-btn-overlay');
  var titleEl = holder.querySelector('.mp-title');
  var metaEl = holder.querySelector('.mp-meta');
  var progress = holder.querySelector('.mp-progress');
  var fill = holder.querySelector('.mp-progress-fill');
  var volumeBtn = holder.querySelector('.mp-volume');

  /* ---------------------------- 工具 ---------------------------- */
  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        index: state.index,
        time: audio.currentTime || 0,
        muted: audio.muted,
        wantPlay: !audio.paused
      }));
    } catch (e) { /* 隐私模式下忽略 */ }
  }

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function snapshot() {
    return {
      index: state.index,
      track: TRACKS[state.index] || null,
      playing: !audio.paused,
      muted: audio.muted,
      currentTime: audio.currentTime || 0,
      duration: isFinite(audio.duration) ? audio.duration : (TRACKS[state.index] ? TRACKS[state.index].duration : 0),
      count: TRACKS.length
    };
  }

  function broadcast() {
    var s = snapshot();
    try {
      document.dispatchEvent(new CustomEvent('player:state', { detail: s }));
    } catch (e) {
      var ev = document.createEvent('CustomEvent');
      ev.initCustomEvent('player:state', false, false, s);
      document.dispatchEvent(ev);
    }
  }

  /* ---------------------------- 渲染 ---------------------------- */
  function renderMeta() {
    var t = TRACKS[state.index];
    if (!t) return;
    if (titleEl) titleEl.textContent = t.title || '未命名';
    if (metaEl) metaEl.textContent = [t.artist, t.album].filter(Boolean).join(' · ');
    if (coverImg && t.cover) coverImg.src = t.cover;
    if (btn) {
      btn.title = (t.artist ? t.artist + ' - ' : '') + (t.title || '') + (TRACKS.length > 1 ? '（右键/长按封面可下一首）' : '');
      btn.setAttribute('aria-label', audio.paused ? '播放' : '暂停');
    }
    holder.setAttribute('data-current-title', t.title || '');
    holder.setAttribute('data-current-artist', t.artist || '');
  }

  function renderProgress() {
    var d = snapshot().duration;
    var pct = d ? (audio.currentTime / d) * 100 : 0;
    if (fill) fill.style.width = Math.max(0, Math.min(100, pct)).toFixed(2) + '%';
    if (progress) {
      progress.setAttribute('aria-valuenow', Math.round(pct));
      progress.setAttribute('aria-valuetext', fmt(audio.currentTime) + ' / ' + fmt(d));
    }
  }

  function renderPlayState() {
    holder.classList.toggle('is-playing', !audio.paused);
    holder.classList.toggle('is-muted', audio.muted);
    if (btn) btn.setAttribute('aria-label', audio.paused ? '播放' : '暂停');
    var t = TRACKS[state.index];
    if (btn && t) btn.title = (t.artist ? t.artist + ' - ' : '') + (t.title || '');
  }

  /* ---------------------------- 逻辑 ---------------------------- */
  function load(i, keepTime) {
    state.index = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
    var t = TRACKS[state.index];
    audio.src = t.src;
    if (!keepTime) restoreTime = 0;
    renderMeta();
    renderProgress();
    broadcast();
  }

  function play() {
    var p = audio.play();
    if (p && p.catch) {
      p.catch(function () {
        /* 浏览器可能拦自动播放，等用户第一次交互再试 */
        state.wantPlay = true;
        persist();
      });
    }
  }

  function pause() {
    audio.pause();
    persist();
  }

  function toggle() {
    if (audio.paused) play();
    else pause();
  }

  function select(i) {
    load(i, false);
    play();
  }

  function next() { load(state.index + 1, false); play(); }
  function prev() {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    load(state.index - 1, false);
    play();
  }

  function seekTo(sec) {
    var d = snapshot().duration;
    if (!d) return;
    audio.currentTime = Math.max(0, Math.min(d, sec));
    renderProgress();
  }

  function seekRatio(r) { seekTo(snapshot().duration * Math.max(0, Math.min(1, r))); }

  /* ---------------------------- 事件绑定 ---------------------------- */
  if (btn) {
    btn.addEventListener('click', toggle);
    btn.addEventListener('contextmenu', function (e) {
      if (TRACKS.length < 2) return;
      e.preventDefault();
      next();
    });
  }

  if (titleEl) {
    titleEl.addEventListener('click', function () {
      if (TRACKS.length < 2) return;
      var wasPlaying = !audio.paused;
      load(state.index + 1, false);
      if (wasPlaying) play();
      persist();
    });
  }

  audio.addEventListener('play', function () { renderPlayState(); broadcast(); });
  audio.addEventListener('pause', function () { renderPlayState(); persist(); broadcast(); });
  audio.addEventListener('timeupdate', function () { renderProgress(); broadcast(); });
  audio.addEventListener('ended', function () { next(); });
  audio.addEventListener('error', function () {
    if (titleEl) titleEl.textContent = '音频加载失败';
    broadcast();
  });

  audio.addEventListener('loadedmetadata', function () {
    if (!restored && restoreTime > 0 && restoreTime < audio.duration - 0.5) {
      try { audio.currentTime = restoreTime; } catch (e) { /* 忽略 */ }
    }
    restored = true;
    restoreTime = 0;
    renderProgress();
    broadcast();
  });

  audio.src = TRACKS[state.index].src;
  renderMeta();

  /* 进度条拖动 / 点击 */
  var dragging = false;
  function ratioFromEvent(e) {
    var rect = progress.getBoundingClientRect();
    var x = e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX;
    return (x - rect.left) / rect.width;
  }
  function onDown(e) {
    dragging = true;
    progress.classList.add('is-seeking');
    seekRatio(ratioFromEvent(e));
  }
  function onMove(e) { if (dragging) seekRatio(ratioFromEvent(e)); }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    progress.classList.remove('is-seeking');
    persist();
  }
  if (progress) {
    progress.addEventListener('mousedown', function (e) { e.preventDefault(); onDown(e); });
    progress.addEventListener('touchstart', function (e) { onDown(e); }, { passive: true });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);
    progress.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 30 : 5;
      if (e.key === 'ArrowRight') { seekTo(audio.currentTime + step); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { seekTo(audio.currentTime - step); e.preventDefault(); }
      if (e.key === 'Home') { seekTo(0); e.preventDefault(); }
      if (e.key === 'End') { seekTo(snapshot().duration); e.preventDefault(); }
    });
  }

  if (volumeBtn) {
    volumeBtn.addEventListener('click', function () {
      audio.muted = !audio.muted;
      renderPlayState();
      persist();
      broadcast();
    });
  }

  /* 空格：播放/暂停；左右方向键：快退快进 */
  document.addEventListener('keydown', function (e) {
    var el = document.activeElement;
    var tag = (el && el.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
    if (e.target && e.target.closest && e.target.closest('a, button, iframe, [role="slider"]')) return;

    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'ArrowRight' && e.shiftKey) {
      seekTo(audio.currentTime + 10);
    } else if (e.key === 'ArrowLeft' && e.shiftKey) {
      seekTo(audio.currentTime - 10);
    }
  });

  /* 首次交互时补一次自动播放（应对浏览器拦截） */
  function kickstart() {
    if (state.wantPlay && audio.paused) play();
    document.removeEventListener('click', kickstart);
    document.removeEventListener('keydown', kickstart);
    document.removeEventListener('touchstart', kickstart);
  }
  document.addEventListener('click', kickstart);
  document.addEventListener('keydown', kickstart);
  document.addEventListener('touchstart', kickstart);

  window.addEventListener('beforeunload', persist);
  setInterval(persist, 5000);
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) pause();
  });

  /* ---------------------------- 对外 API ---------------------------- */
  window.DSHPlayer = {
    play: play,
    pause: pause,
    toggle: toggle,
    select: select,
    next: next,
    prev: prev,
    seekTo: seekTo,
    seekRatio: seekRatio,
    setMuted: function (m) {
      audio.muted = !!m;
      renderPlayState();
      persist();
      broadcast();
    },
    getState: snapshot,
    getTracks: function () { return TRACKS.slice(); }
  };

  /* 若上次离开时正在播放，尝试接着放（被拦也无所谓，用户一点就会响） */
  if (state.wantPlay) {
    load(state.index, true);
    play();
  }

  broadcast();
})();

/* ==================================================================
   全站音乐播放器
   ------------------------------------------------------------------
   - 音频来自 content/music/（生成时扫描并写入 data-tracks）
   - 歌名/歌手/专辑/封面 = 直接从音频的 ID3 标签读取
   - 三种播放模式：
       list    连续播放（顺序循环）
       single  单曲循环（当前这首反复播）
       shuffle 随机播放（打乱一轮不重复，播完重新洗牌）
   - 右上角可展开播放列表，点任意一首直接播放
   - 单例播放：右上角控件与「音乐」页共用同一个 <audio>，状态实时同步
   - 播放位置、模式、当前曲目存在 localStorage，跨页面/刷新都接着放
   - 对外 API：window.DSHPlayer.{ play, pause, toggle, select, next, prev,
                                 seekTo, seekRatio, setMuted, setMode,
                                 cycleMode, getState, getTracks }
   - 状态变化广播：document 上的 'player:state'
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

  var KEY = 'music-player-v3';
  var MODES = ['list', 'single', 'shuffle'];
  var MODE_TEXT = {
    list: { label: '连续播放', hint: '按顺序循环播放全部曲目' },
    single: { label: '单曲循环', hint: '反复播放当前这一首' },
    shuffle: { label: '随机播放', hint: '打乱顺序播放，一轮内不重复' }
  };

  var state = { index: 0, time: 0, muted: false, wantPlay: false, mode: 'list', pos: null };

  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && typeof saved === 'object') {
      state.index = Math.min(Math.max(0, saved.index | 0), TRACKS.length - 1);
      state.time = Number(saved.time) || 0;
      state.muted = !!saved.muted;
      state.wantPlay = !!saved.wantPlay;
      if (MODES.indexOf(saved.mode) >= 0) state.mode = saved.mode;
      // 播放器上次被拖到的位置（视口坐标）
      if (saved.pos && typeof saved.pos.left === 'number' && typeof saved.pos.top === 'number' &&
          isFinite(saved.pos.left) && isFinite(saved.pos.top)) {
        state.pos = { left: saved.pos.left, top: saved.pos.top };
      }
    }
  } catch (e) { /* 忽略损坏的存储 */ }

  audio.muted = state.muted;
  var restoreTime = state.time;
  var restored = false;

  /* ---------------------------- DOM ---------------------------- */
  var btn = holder.querySelector('.mp-btn');
  var coverImg = holder.querySelector('.mp-cover');
  var titleEl = holder.querySelector('.mp-title');
  var metaEl = holder.querySelector('.mp-meta');
  var progress = holder.querySelector('.mp-progress');
  var fill = holder.querySelector('.mp-progress-fill');
  var volumeBtn = holder.querySelector('.mp-volume');
  var modeBtn = holder.querySelector('.mp-mode');
  var listBtn = holder.querySelector('.mp-list-btn');
  var panel = holder.querySelector('.mp-panel');
  var panelList = holder.querySelector('.mp-panel-list');
  var panelCount = holder.querySelector('.mp-panel-count');

  /* ---------------------------- 工具 ---------------------------- */
  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        index: state.index,
        time: audio.currentTime || 0,
        muted: audio.muted,
        wantPlay: !audio.paused,
        mode: state.mode,
        pos: state.pos
      }));
    } catch (e) { /* 隐私模式下忽略 */ }
  }

  /* ------------------------------------------------------------------
     拖动悬浮：按住胶囊空白处拖到任意位置，松手吸附最近的左右边缘。
     位置存在 state.pos（视口坐标），刷新/翻页后仍在原地。
     ------------------------------------------------------------------ */
  var EDGE = 14;               // 吸附后离屏幕边缘留的空隙
  var DRAG_THRESHOLD = 5;      // 小于这个位移当作点击，避免误触发拖动

  function dims() {
    var r = holder.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  function clampPos(pos) {
    var d = dims();
    var maxL = Math.max(EDGE, window.innerWidth - d.w - EDGE);
    var maxT = Math.max(EDGE, window.innerHeight - d.h - EDGE);
    return {
      left: Math.min(Math.max(EDGE, pos.left), maxL),
      top: Math.min(Math.max(EDGE, pos.top), maxT)
    };
  }

  /** 面板朝哪边展开：跟着播放器所在的半边/上下半边走 */
  function applySide(pos) {
    var d = dims();
    var vw = window.innerWidth, vh = window.innerHeight;
    var cx = pos.left + d.w / 2, cy = pos.top + d.h / 2;
    holder.setAttribute('data-side', cx < vw / 2 ? 'left' : 'right');
    // 面板高约 24rem，下半屏时改成朝上展开
    holder.setAttribute('data-vside', cy > vh * 0.6 ? 'bottom' : 'top');
  }

  function applyPos(pos, snap) {
    var c = clampPos(pos);
    state.pos = c;
    if (snap) {
      holder.classList.add('is-snapping');
      window.setTimeout(function () { holder.classList.remove('is-snapping'); }, 260);
    }
    holder.style.left = c.left + 'px';
    holder.style.top = c.top + 'px';
    holder.style.right = 'auto';
    applySide(c);
  }

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function escapeText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function snapshot() {
    return {
      index: state.index,
      track: TRACKS[state.index] || null,
      playing: !audio.paused,
      muted: audio.muted,
      mode: state.mode,
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

  /* ---------------------------- 随机播放队列 ---------------------------- */
  var shuffleQueue = [];
  var shuffleDone = [];

  function reshuffle(keepCurrent) {
    var idx = TRACKS.map(function (_, i) { return i; });
    for (var i = idx.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    if (keepCurrent && idx.length > 1) {
      var pos = idx.indexOf(state.index);
      if (pos >= 0) { idx.splice(pos, 1); idx.push(state.index); }
    }
    shuffleDone = [];
    shuffleQueue = idx;
  }

  /** 按当前模式取下一首；返回 null 表示不再自动播放 */
  function pickNext() {
    if (TRACKS.length === 1) return 0;
    if (state.mode === 'single') return state.index;
    if (state.mode === 'shuffle') {
      if (!shuffleQueue.length) reshuffle(false);
      var n = shuffleQueue.shift();
      shuffleDone.push(n);
      return n;
    }
    return (state.index + 1) % TRACKS.length;
  }

  /* ---------------------------- 渲染 ---------------------------- */
  function renderMeta() {
    var t = TRACKS[state.index];
    if (!t) return;
    if (titleEl) titleEl.textContent = t.title || '未命名';
    if (metaEl) metaEl.textContent = [t.artist, t.album].filter(Boolean).join(' · ');
    if (coverImg && t.cover) coverImg.src = t.cover;
    if (btn) btn.title = (t.artist ? t.artist + ' - ' : '') + (t.title || '');
    renderPanelCurrent();
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
  }

  function renderMode() {
    if (!modeBtn) return;
    var info = MODE_TEXT[state.mode] || MODE_TEXT.list;
    holder.setAttribute('data-mode', state.mode);
    modeBtn.setAttribute('data-mode', state.mode);
    modeBtn.setAttribute('aria-label', '播放模式：' + info.label);
    modeBtn.setAttribute('title', info.label + '（点击切换）');
  }

  var panelBuilt = false;
  function buildPanel() {
    if (!panelList) return;
    panelList.innerHTML = TRACKS.map(function (t, i) {
      var sub = [t.artist, t.album].filter(Boolean).join(' · ');
      return '<li class="mp-item" data-index="' + i + '">' +
        '<button type="button" class="mp-item-btn" data-index="' + i + '">' +
        (t.cover ? '<img class="mp-item-cover" src="' + t.cover + '" alt="" loading="lazy" />' : '<span class="mp-item-cover mp-item-cover-empty"></span>') +
        '<span class="mp-item-text">' +
        '<span class="mp-item-name">' + escapeText(t.title || '未命名') + '</span>' +
        '<span class="mp-item-sub">' + escapeText(sub) + '</span>' +
        '</span>' +
        '<span class="mp-item-time">' + fmt(t.duration) + '</span>' +
        '</button></li>';
    }).join('');
    if (panelCount) panelCount.textContent = TRACKS.length + ' 首';
    panelBuilt = true;
    renderPanelCurrent();
  }

  function renderPanelCurrent() {
    if (!panelList) return;
    var items = panelList.querySelectorAll('.mp-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('is-current', i === state.index);
    }
  }

  function openPanel(open) {
    if (!panel) return;
    if (open && !panelBuilt) buildPanel();
    panel.hidden = !open;
    holder.classList.toggle('is-panel-open', !!open);
    if (listBtn) listBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) renderPanelCurrent();
  }

  /* ---------------------------- 播放逻辑 ---------------------------- */
  function load(i, keepTime) {
    state.index = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
    audio.src = TRACKS[state.index].src;
    if (!keepTime) restoreTime = 0;
    renderMeta();
    renderProgress();
    broadcast();
  }

  function play() {
    var p = audio.play();
    if (p && p.catch) {
      p.catch(function () {
        state.wantPlay = true;
        persist();
      });
    }
  }

  function pause() { audio.pause(); persist(); }
  function toggle() { if (audio.paused) play(); else pause(); }
  function select(i) { load(i, false); play(); }

  function next() {
    var n = pickNext();
    if (n === null) return;
    load(n, false);
    play();
  }

  function prev() {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (state.mode === 'shuffle') {
      var last = shuffleDone.pop();
      if (last !== undefined) { load(last, false); play(); return; }
    }
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

  function cycleMode() {
    var i = MODES.indexOf(state.mode);
    state.mode = MODES[(i + 1) % MODES.length];
    if (state.mode === 'shuffle') reshuffle(true);
    renderMode();
    persist();
    broadcast();
  }

  function setMode(m) {
    if (MODES.indexOf(m) < 0) return;
    state.mode = m;
    if (m === 'shuffle') reshuffle(true);
    renderMode();
    persist();
    broadcast();
  }

  /* ---------------------------- 事件绑定 ---------------------------- */
  if (btn) btn.addEventListener('click', toggle);

  if (titleEl) {
    titleEl.addEventListener('click', function () {
      if (TRACKS.length < 2) return;
      var wasPlaying = !audio.paused;
      load(state.index + 1, false);
      if (wasPlaying) play();
      persist();
    });
  }

  if (modeBtn) modeBtn.addEventListener('click', cycleMode);

  if (listBtn) {
    listBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openPanel(panel.hidden);
    });
  }

  if (panelList) {
    panelList.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.mp-item-btn') : null;
      if (!b) return;
      select(Number(b.getAttribute('data-index')) || 0);
    });
  }

  document.addEventListener('click', function (e) {
    if (panel && !panel.hidden && !holder.contains(e.target)) openPanel(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel && !panel.hidden) openPanel(false);
  });

  audio.addEventListener('play', function () { renderPlayState(); broadcast(); });
  audio.addEventListener('pause', function () { renderPlayState(); persist(); broadcast(); });
  audio.addEventListener('timeupdate', function () { renderProgress(); broadcast(); });

  // 一首播完 → 按模式决定下一首（单曲循环直接重播）
  audio.addEventListener('ended', function () {
    if (state.mode === 'single') {
      audio.currentTime = 0;
      play();
      return;
    }
    var n = pickNext();
    if (n === null) { persist(); return; }
    load(n, false);
    play();
  });

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

  /* 快捷键：空格 播放/暂停，Shift+左右 快进退，M 切换播放模式 */
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
    } else if (e.key === 'm' || e.key === 'M') {
      cycleMode();
    }
  });

  /* ---------------------------- 拖动 / 吸附 ---------------------------- */
  var drag = null;

  // 进度条是「拖动跳转」，别让它同时触发整个胶囊的移动
  function isSeekArea(t) {
    return !!(progress && (t === progress || progress.contains(t)));
  }

  function onPointerDown(e) {
    if (e.button != null && e.button !== 0) return;   // 只响应左键
    if (isSeekArea(e.target)) return;
    var r = holder.getBoundingClientRect();
    drag = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      // 用 getBoundingClientRect 而不是 offsetLeft —— 左上角还有 transform 时更准
      baseLeft: r.left,
      baseTop: r.top,
      w: r.width,
      h: r.height,
      moved: false
    };
    if (holder.setPointerCapture) {
      try { holder.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    }
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.startX;
    var dy = e.clientY - drag.startY;

    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      drag.moved = true;
      holder.classList.add('is-dragging');
      openPanel(false);                 // 拖的时候先收起列表面板
    }
    if (e.cancelable) e.preventDefault();   // 阻止手机上的页面滚动/文本选中

    drag.left = Math.min(Math.max(EDGE, drag.baseLeft + dx), window.innerWidth - drag.w - EDGE);
    drag.top = Math.min(Math.max(EDGE, drag.baseTop + dy), window.innerHeight - drag.h - EDGE);
    holder.style.left = drag.left + 'px';
    holder.style.top = drag.top + 'px';
    holder.style.right = 'auto';
  }

  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    var d = drag;
    drag = null;
    holder.classList.remove('is-dragging');
    if (!d.moved) return;               // 只是一次点击，不动

    // 吸附到最近的左右边缘
    var leftSpace = d.left - EDGE;
    var rightSpace = window.innerWidth - d.w - EDGE - d.left;
    var snappedLeft = leftSpace <= rightSpace ? EDGE : window.innerWidth - d.w - EDGE;
    applyPos({ left: snappedLeft, top: d.top }, true);
    persist();
    broadcast();
    // 拖完紧跟着会来一个 click，拦掉它，免得误触发播放/暂停
    suppressClick = true;
    window.setTimeout(function () { suppressClick = false; }, 350);
  }

  var suppressClick = false;

  holder.addEventListener('pointerdown', onPointerDown);
  holder.addEventListener('pointermove', onPointerMove);
  holder.addEventListener('pointerup', endDrag);
  holder.addEventListener('pointercancel', endDrag);
  // 捕获阶段拦掉拖动后紧跟的那次 click（各按钮自己的 click 处理器不会执行）
  holder.addEventListener('click', function (e) {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  // 拖出窗口再松手也能收尾
  window.addEventListener('blur', function () { endDrag(null); });

  // 视口变化时把播放器拉回可见范围
  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    if (!state.pos) return;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () { applyPos(state.pos, false); }, 120);
  });

  /* 首次交互时补一次自动播放（浏览器可能拦了自动播放） */
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

  /* ---------------------------- 初始化 ---------------------------- */
  if (state.mode === 'shuffle') reshuffle(true);
  audio.src = TRACKS[state.index].src;
  renderMeta();
  renderMode();
  renderPlayState();
  // 恢复上次拖到的位置（没拖过就保持 CSS 默认的右上角）
  if (state.pos) applyPos(state.pos, false);
  else applySide({ left: window.innerWidth - dims().w - EDGE, top: EDGE });
  holder.style.visibility = '';       // 位置定好了再显示，避免闪一下

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
    setMode: setMode,
    cycleMode: cycleMode,
    getState: snapshot,
    getTracks: function () { return TRACKS.slice(); }
  };

  if (state.wantPlay) {
    load(state.index, true);
    play();
  }

  broadcast();
})();

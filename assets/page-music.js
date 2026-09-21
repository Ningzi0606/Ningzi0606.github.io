/* ==================================================================
   「音乐」页的界面逻辑
   声音由 assets/player.js 的全局播放器负责，这里只做界面与联动：
   - 曲目行点击 → 播放对应曲目
   - 大面板显示当前曲目、封面、进度、时间
   ================================================================== */
(function () {
  'use strict';

  var panel = document.querySelector('.nowplaying');
  var list = document.querySelector('[data-ltrack-list]');
  if (!panel && !list) return;

  function P() { return window.DSHPlayer; }

  var els = {
    cover: panel && panel.querySelector('.np-cover'),
    title: panel && panel.querySelector('.np-title'),
    artist: panel && panel.querySelector('.np-artist'),
    toggle: panel && panel.querySelector('[data-np-toggle]'),
    prev: panel && panel.querySelector('[data-np-prev]'),
    next: panel && panel.querySelector('[data-np-next]'),
    bar: panel && panel.querySelector('[data-np-progress]'),
    fill: panel && panel.querySelector('[data-np-fill]'),
    cur: panel && panel.querySelector('[data-np-current]'),
    dur: panel && panel.querySelector('[data-np-duration]')
  };

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* 曲目行：点击播放 */
  if (list) {
    list.addEventListener('click', function (e) {
      var btn = e.target.closest('.ltrack-play');
      if (!btn) return;
      var p = P();
      if (!p) return;
      p.select(Number(btn.getAttribute('data-index')) || 0);
    });
  }

  /* 大面板控制 */
  if (els.toggle) {
    els.toggle.addEventListener('click', function () {
      var p = P();
      if (p) p.toggle();
    });
  }
  if (els.prev) els.prev.addEventListener('click', function () { var p = P(); if (p) p.prev(); });
  if (els.next) els.next.addEventListener('click', function () { var p = P(); if (p) p.next(); });

  /* 进度条拖动 */
  if (els.bar) {
    var dragging = false;
    function ratio(e) {
      var r = els.bar.getBoundingClientRect();
      var x = e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX;
      return Math.max(0, Math.min(1, (x - r.left) / r.width));
    }
    function down(e) {
      var p = P();
      if (!p) return;
      dragging = true;
      els.bar.classList.add('is-seeking');
      p.seekRatio(ratio(e));
    }
    function move(e) { if (dragging) { var p = P(); if (p) p.seekRatio(ratio(e)); } }
    function up() { dragging = false; els.bar.classList.remove('is-seeking'); }

    els.bar.addEventListener('mousedown', function (e) { e.preventDefault(); down(e); });
    els.bar.addEventListener('touchstart', function (e) { down(e); }, { passive: true });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchmove', move, { passive: true });
    document.addEventListener('mouseup', up);
    document.addEventListener('touchend', up);
    els.bar.addEventListener('keydown', function (e) {
      var p = P();
      if (!p) return;
      var st = p.getState();
      if (e.key === 'ArrowRight') { p.seekTo(st.currentTime + 5); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { p.seekTo(st.currentTime - 5); e.preventDefault(); }
      if (e.key === 'Home') { p.seekTo(0); e.preventDefault(); }
      if (e.key === 'End') { p.seekTo(st.duration); e.preventDefault(); }
    });
  }

  /* 跟随全局播放器状态刷新界面 */
  function render(detail) {
    var s = detail || (P() ? P().getState() : null);
    if (!s || !s.track) return;

    if (els.title) els.title.textContent = s.track.title || '';
    if (els.artist) els.artist.textContent = [s.track.artist, s.track.album].filter(Boolean).join(' · ');
    if (els.cover && s.track.cover) els.cover.src = s.track.cover;

    var pct = s.duration ? (s.currentTime / s.duration) * 100 : 0;
    if (els.fill) els.fill.style.width = Math.max(0, Math.min(100, pct)).toFixed(2) + '%';
    if (els.bar) els.bar.setAttribute('aria-valuenow', Math.round(pct));
    if (els.cur) els.cur.textContent = fmt(s.currentTime);
    if (els.dur) els.dur.textContent = fmt(s.duration);

    if (panel) panel.classList.toggle('is-playing', !!s.playing);

    /* 列表高亮 */
    if (list) {
      var rows = list.querySelectorAll('.ltrack');
      for (var i = 0; i < rows.length; i++) {
        var isCur = i === s.index;
        rows[i].classList.toggle('is-current', isCur);
        rows[i].classList.toggle('is-playing', isCur && !!s.playing);
      }
    }
  }

  document.addEventListener('player:state', function (e) { render(e.detail); });
  window.addEventListener('load', function () { render(null); });
})();

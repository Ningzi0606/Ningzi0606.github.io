/* ==================================================================
   相册灯箱 + 一点小交互
   只依赖原生 JS，没有第三方库。
   ================================================================== */
(function () {
  'use strict';

  var triggers = Array.prototype.slice.call(document.querySelectorAll('[data-lightbox]'));
  if (!triggers.length) return;

  var items = triggers
    .map(function (a) {
      var img = a.querySelector('img');
      return { href: a.getAttribute('href'), alt: (img && img.getAttribute('alt')) || '' };
    })
    .filter(function (it) { return !!it.href; });

  var box = document.createElement('div');
  box.className = 'lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', '图片查看');
  box.innerHTML =
    '<img alt="" />' +
    '<button class="lb-close" type="button" aria-label="关闭">✕</button>' +
    '<button class="lb-prev" type="button" aria-label="上一张">‹</button>' +
    '<button class="lb-next" type="button" aria-label="下一张">›</button>' +
    '<span class="lb-count"></span>';
  document.body.appendChild(box);

  var imgEl = box.querySelector('img');
  var countEl = box.querySelector('.lb-count');
  var index = 0;
  var lastFocus = null;

  function show(i) {
    index = (i + items.length) % items.length;
    imgEl.src = items[index].href;
    imgEl.alt = items[index].alt;
    countEl.textContent = index + 1 + ' / ' + items.length;
  }

  function open(i) {
    lastFocus = document.activeElement;
    show(i);
    box.classList.add('open');
    document.documentElement.style.overflow = 'hidden';
    box.querySelector('.lb-close').focus();
  }

  function close() {
    box.classList.remove('open');
    document.documentElement.style.overflow = '';
    imgEl.removeAttribute('src');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  triggers.forEach(function (a, i) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      open(i);
    });
  });

  box.querySelector('.lb-close').addEventListener('click', close);
  box.querySelector('.lb-prev').addEventListener('click', function () { show(index - 1); });
  box.querySelector('.lb-next').addEventListener('click', function () { show(index + 1); });

  box.addEventListener('click', function (e) {
    if (e.target === box) close();
  });

  document.addEventListener('keydown', function (e) {
    if (!box.classList.contains('open')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
  });

  // 左右滑动切换
  var startX = null;
  box.addEventListener('touchstart', function (e) {
    startX = e.touches[0].clientX;
  }, { passive: true });
  box.addEventListener('touchend', function (e) {
    if (startX === null) return;
    var dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 45) show(dx > 0 ? index - 1 : index + 1);
    startX = null;
  }, { passive: true });
})();

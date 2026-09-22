/* ==================================================================
   自适应码率播放器（零依赖，纯 MSE 实现）
   ------------------------------------------------------------------
   为什么要自己写：外网 CDN 未必可达，站点也不该依赖第三方脚本。

   支持的输入：HLS 播放列表（.m3u8）
     - 主播放列表 → 多档码率
     - 每档的媒体播放列表 → EXT-X-MAP（初始化段）+ 分片
     - 分片是 fMP4（.m4s），由 build/hls.ps1 生成

   标记方式：
     <video class="player-hls" src="...mp4" data-hls="...index.m3u8">

   起播策略（实测出来的关键点）：
     分片要「先攒够再起播」。边播边追加会让 Chrome 的 SourceBuffer 卡在
     updating=true 再也不触发 updateend，画面就冻住了。
     所以这里先按顺序喂满 START_BUFFER，再调用 play()。
   ================================================================== */
(function () {
  'use strict';

  var videos = document.querySelectorAll('video[data-hls]');
  if (!videos.length) return;

  var SEG_TIMEOUT = 20000;    // 单个分片最长等待
  var START_BUFFER = 10;      // 起播前先攒够多少秒
  var MAX_BUFFER = 45;        // 最多缓冲多少秒
  var RETRY = 3;

  /* ---------------------------- m3u8 解析 ---------------------------- */

  function baseOf(url) { return url.slice(0, url.lastIndexOf('/') + 1); }

  function resolveUrl(base, rel) {
    if (/^https?:|^\/\//.test(rel)) return rel;
    if (rel.charAt(0) === '/') return rel;
    return base + rel.replace(/^\.\//, '');
  }

  function attrs(s) {
    var out = {};
    var re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
    var m;
    while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  }

  /** 解析媒体播放列表：init（EXT-X-MAP）+ 分片列表 */
  function parseMedia(text, url) {
    var lines = text.split(/\r?\n/);
    var b = baseOf(url);
    var out = { init: null, segs: [] };
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (!l) continue;
      if (l.indexOf('#EXT-X-MAP:') === 0) {
        var m = l.match(/URI="([^"]+)"/);
        if (m) out.init = resolveUrl(b, m[1]);
      } else if (l.indexOf('#EXTINF:') === 0) {
        var dur = parseFloat(l.slice(8)) || 0;
        for (var j = i + 1; j < lines.length; j++) {
          var nx = lines[j].trim();
          if (!nx || nx.charAt(0) === '#') continue;
          out.segs.push({ url: resolveUrl(b, nx), duration: dur });
          break;
        }
      }
    }
    return out;
  }

  /** 解析主播放列表：各档的播放列表地址、带宽、分辨率与编码串 */
  function parseMaster(text, url) {
    var lines = text.split(/\r?\n/);
    var b = baseOf(url);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (l.indexOf('#EXT-X-STREAM-INF:') !== 0) continue;
      var a = attrs(l.slice(18));
      for (var j = i + 1; j < lines.length; j++) {
        var nx = lines[j].trim();
        if (!nx || nx.charAt(0) === '#') continue;
        out.push({
          url: resolveUrl(b, nx),
          bandwidth: parseInt(a.BANDWIDTH, 10) || 0,
          height: a.RESOLUTION ? parseInt(String(a.RESOLUTION).split('x')[1], 10) : 0,
          // 每档的编码串必须带上：切档时要用它重建 SourceBuffer，
          // 用错档次（profile/level 不同）会让解码器输出花屏。
          codecs: a.CODECS || ''
        });
        break;
      }
    }
    return out.sort(function (x, y) { return x.bandwidth - y.bandwidth; });
  }

  function fetchBuf(url) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('timeout ' + url)); }, SEG_TIMEOUT);
      fetch(url, { credentials: 'same-origin' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        })
        .then(function (b) { clearTimeout(timer); resolve(b); })
        .catch(function (e) { clearTimeout(timer); reject(e); });
    });
  }

  function fetchText(url) {
    return fetchBuf(url).then(function (b) { return new TextDecoder().decode(b); });
  }

  /* ---------------------------- 播放器 ---------------------------- */

  function Player(video) {
    this.video = video;
    this.masterUrl = video.getAttribute('data-hls');
    this.mp4Url = video.getAttribute('src');
    this.shell = video.closest('.video-shell');
    this.statusEl = this.shell ? this.shell.querySelector('.video-status') : null;
    this.statusText = this.shell ? this.shell.querySelector('.vs-text') : null;

    this.levels = [];       // 各档
    this.level = 0;
    this.playlist = null;   // 当前档的分片列表
    this.index = 0;         // 下一个要喂的分片
    this.sb = null;
    this.ms = null;
    this.busy = false;
    this.failed = 0;
    this.started = false;
    this.dead = false;
    this.wantPlay = false;
    this.manual = false;
    this.traceLog = [];
  }

  Player.prototype.trace = function (m) {
    this.traceLog.push(m);
    if (this.traceLog.length > 200) this.traceLog.shift();
    if (window.DSH_HLS_DEBUG && window.console) console.log('[hls] ' + m);
  };

  Player.prototype.status = function (t, show) {
    if (!this.statusEl) return;
    this.statusEl.hidden = !show;
    if (this.statusText) this.statusText.textContent = t || '';
  };

  Player.prototype.giveUp = function (why) {
    if (this.dead) return;
    this.dead = true;
    this.why = why;
    this.status('', false);
    this.video.removeAttribute('data-hls');
    this.video.src = this.mp4Url;          // 回退到普通 MP4，保证一定能看
    this.trace('give up: ' + why);
  };

  Player.prototype.start = function () {
    var self = this;

    // 原生支持 HLS 且没有 MSE 时（老 Safari），交给原生
    var mseOk = window.MediaSource &&
      MediaSource.isTypeSupported('video/mp4; codecs="avc1.640029,mp4a.40.2"');

    if (!mseOk) {
      if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
        this.video.src = this.masterUrl;
        this.dead = true;
        this.native = true;
        return;
      }
      return this.giveUp('浏览器不支持 MediaSource');
    }

    this.status('正在加载清晰度…', true);

    fetchText(this.masterUrl)
      .then(function (t) {
        self.levels = parseMaster(t, self.masterUrl);
        if (!self.levels.length) throw new Error('主播放列表里没有码率档');
        self.level = self.levels.length - 1;      // 默认最高档
        self.buildUi();
        return self.loadLevel(self.level, true);
      })
      .catch(function (e) { self.giveUp(e && e.message); });
  };

  /** 载入某一档的分片列表，并建立 SourceBuffer */
  Player.prototype.loadLevel = function (i, initial) {
    var self = this;
    var lv = this.levels[i];
    if (!lv) return Promise.resolve();

    // 记住当前播放位置：切档后要接着播，而不是从头开始
    var resumeAt = this.video.currentTime || 0;

    // 切档要串行化：先把在途的追加/拉流停下来，
    // 否则旧 SourceBuffer 里还有数据、或 appendBuffer 还在进行时，
    // 新档的 init 段会被拒绝（MSE 要求 init 必须是第一个追加的数据），
    // 解码器就此进入坏状态 —— 表现就是切档后持续花屏且不恢复。
    if (this.switching) return this.switchPromise;
    this.switching = true;
    this.status(initial ? '正在加载清晰度…' : '正在切换清晰度…', true);

    this.switchPromise = fetchText(lv.url)
      .then(function (t) {
        self.playlist = parseMedia(t, lv.url);
        self.level = i;
        if (self.badge) {
          self.badge.textContent = lv.height ? lv.height + 'p' : '自动';
        }

        // 等 SourceBuffer 空闲（有在途 updatestart 就先等一拍）
        return waitIdle(self.sb, 10);
      })
      .then(function () {
        self.teardown();                     // 会重置 index / initSent / busy

        // 定位到 resumeAt 所在的分片，跳过前面已经播过的部分
        var acc = 0;
        for (var k = 0; k < self.playlist.segs.length; k++) {
          acc += self.playlist.segs[k].duration;
          if (acc > resumeAt) { self.index = k; break; }
        }
        self.resumeAt = resumeAt > 1 ? resumeAt : 0;

        return self.setupSourceBuffer();
      })
      .then(function () {
        self.switching = false;
        self.pump();
      })
      .catch(function (e) {
        self.switching = false;
        throw e;
      });

    return this.switchPromise;
  };

  /** 等某个 SourceBuffer 不再 updating（最多等 limit 个 50ms 片） */
  function waitIdle(sb, limit) {
    return new Promise(function (resolve) {
      var n = 0;
      (function step() {
        if (!sb || !sb.updating || n >= limit) return resolve();
        n++;
        setTimeout(step, 50);
      })();
    });
  }

  Player.prototype.teardown = function () {
    // 换代：所有在途的 fetch 回来后都会发现自己过期，直接丢弃，
    // 不会往已经拆掉的 SourceBuffer 里追加。
    this.gen = (this.gen || 0) + 1;

    // 注意：不要调用 removeSourceBuffer —— SourceBuffer 正在 updating 时
    // 调用会抛 InvalidStateError，反而让切换中断在坏状态里。
    // 换一个新的 MediaSource 就足够了。
    if (this.ms && this.ms.readyState === 'open') {
      try { this.ms.endOfStream(); } catch (e) {}
    }
    if (this.objectUrl) {
      try { URL.revokeObjectURL(this.objectUrl); } catch (e) {}
      this.objectUrl = null;
    }
    this.sb = null;
    this.ms = null;
    this.started = false;
    this.busy = false;
    this.initSent = false;      // 新档必须重新喂它自己的 init
    this.index = 0;
    this.failed = 0;
  };

  Player.prototype.setupSourceBuffer = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var ms = new MediaSource();
      self.ms = ms;
      self.video.src = URL.createObjectURL(ms);

      ms.addEventListener('sourceopen', function () {
        // 用【当前档自己的】编码串建 SourceBuffer。
        // 如果拿最高档（High/4.1）的配置去解最低档（Main/3.1）的分片，
        // 解码器会输出花屏（彩色竖条），这是踩过的坑。
        var lv = self.levels[self.level] || {};
        var codecs = lv.codecs || 'avc1.640029,mp4a.40.2';
        var videoCodec = String(codecs).split(',')[0];
        var mimes = [
          'video/mp4; codecs="' + codecs + '"',
          'video/mp4; codecs="' + videoCodec + ',mp4a.40.2"',
          'video/mp4; codecs="' + videoCodec + '"',
          'video/mp4'
        ];
        var sb = null, used = null;
        for (var i = 0; i < mimes.length; i++) {
          try { sb = ms.addSourceBuffer(mimes[i]); used = mimes[i]; break; } catch (e) { sb = null; }
        }
        if (!sb) return reject(new Error('addSourceBuffer 失败'));
        self.sb = sb;
        self.mime = used;
        // 新的解码器，清掉上一轮的错误状态与记录
        self.appendErr = null;
        self.appendOrder = [];
        sb.mode = 'segments';
        sb.addEventListener('updateend', function () {
          self.busy = false;
          self.afterAppend();
        });
        sb.addEventListener('error', function () { self.busy = false; });
        resolve();
      }, { once: true });
    });
  };

  /** 喂分片；攒够 START_BUFFER 秒后才起播 */
  Player.prototype.pump = function () {
    var self = this;
    if (this.dead || this.switching || !this.sb || this.busy || this.sb.updating) return;

    var gen = this.gen || 0;
    var ahead = this.bufferedAhead();
    if (ahead > MAX_BUFFER) return;

    // init 段必须第一个喂
    if (!this.initSent) {
      this.initSent = true;
      this.busy = true;
      return fetchBuf(this.playlist.init)
        .then(function (b) {
          if (self.gen !== gen) return;          // 已换代，丢弃
          self.append(b);
        })
        .catch(function () {
          if (self.gen !== gen) return;
          self.busy = false;
          self.initSent = false;          // 下次重试 init，而不是跳过
          self.fail('init 段加载失败');
        });
    }

    if (this.index >= this.playlist.segs.length) {
      try {
        if (this.ms && this.ms.readyState === 'open' && !this.sb.updating) this.ms.endOfStream();
      } catch (e) {}
      return;
    }

    var seg = this.playlist.segs[this.index];
    var segIdx = this.index;
    this.busy = true;
    fetchBuf(seg.url)
      .then(function (b) {
        if (self.gen !== gen) return;            // 已换代，丢弃这片
        self.failed = 0;
        self.index++;
        self.append(b, segIdx);
      })
      .catch(function () {
        if (self.gen !== gen) return;
        self.busy = false;
        // 取不到就退回去重试同一片，不要跳过（跳过会丢内容）
        self.fail('分片加载失败');
      });
  };

  Player.prototype.append = function (buf, idx) {
    if (!this.sb) return;                        // 已经拆掉了，丢弃
    if (this.appendOrder && this.appendOrder.length < 40) {
      this.appendOrder.push(idx === undefined ? 'init' : idx);
    }
    try {
      this.sb.appendBuffer(new Uint8Array(buf));
    } catch (e) {
      this.busy = false;
      this.appendErr = e.name + ': ' + e.message;
      this.trace('append 抛错 ' + this.appendErr);
    }
  };

  /** 一片喂完之后：够了就起播，否则继续攒 */
  Player.prototype.afterAppend = function () {
    var ahead = this.bufferedAhead();
    var atEnd = this.index >= this.playlist.segs.length;

    // 切档后把播放头拉回原来的位置（等缓冲覆盖到那里再做，否则会卡住）
    if (this.resumeAt) {
      var t = this.resumeAt;
      var b = this.video.buffered;
      var covered = false;
      for (var i = 0; i < b.length; i++) {
        if (t >= b.start(i) && t <= b.end(i) - 0.05) { covered = true; break; }
      }
      if (covered) {
        try { this.video.currentTime = t; } catch (e) {}
        this.resumeAt = 0;
      }
    }

    // 攒够 START_BUFFER 秒、或者已经喂完整片，就可以起播
    if (!this.started && (ahead >= START_BUFFER || (atEnd && ahead > 1))) {
      this.started = true;
      this.status('', false);
      if (this.wantPlay || this.autoStart) {
        var p = this.video.play();
        if (p && p.catch) p.catch(function () {});
      }
    }
    this.pump();
  };

  /** 一旦真的开始出画面，就把加载遮罩收掉（缓冲完成前的兜底） */
  Player.prototype.hideStatusWhenPlaying = function () {
    if (this.started) return;
    this.started = true;
    this.status('', false);
  };

  Player.prototype.fail = function (why) {
    this.failed++;
    var self = this;
    if (this.failed >= RETRY) {
      // 连续失败：先尝试降档，最低档还失败就回退 MP4
      if (this.level > 0) {
        this.failed = 0;
        this.loadLevel(this.level - 1, false)
          .then(function () { self.initSent = false; self.pump(); })
          .catch(function (e) { self.giveUp(e && e.message); });
      } else {
        this.giveUp(why);
      }
      return;
    }
    setTimeout(function () { self.pump(); }, 400 * self.failed);
  };

  Player.prototype.bufferedAhead = function () {
    try {
      var t = this.video.currentTime;
      var b = this.video.buffered;
      for (var i = 0; i < b.length; i++) {
        if (t >= b.start(i) - 0.1 && t <= b.end(i)) return b.end(i) - t;
      }
      // 播放头还没进缓冲（起播前）：返回已缓冲总时长
      if (b.length) return b.end(b.length - 1) - b.start(0);
    } catch (e) {}
    return 0;
  };

  /** 清晰度菜单 */
  Player.prototype.buildUi = function () {
    if (!this.shell || this.uiBuilt) return;
    this.uiBuilt = true;
    var self = this;

    var badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'vq-btn';
    badge.title = '清晰度';
    badge.textContent = '自动';
    this.badge = badge;

    var menu = document.createElement('div');
    menu.className = 'vq-menu';
    menu.hidden = true;

    function active(el) {
      Array.prototype.forEach.call(menu.querySelectorAll('.vq-item'), function (n) {
        n.classList.toggle('is-active', n === el);
      });
    }

    var auto = document.createElement('button');
    auto.type = 'button';
    auto.className = 'vq-item is-active';
    auto.textContent = '自动';
    auto.addEventListener('click', function () {
      self.manual = false;
      active(auto);
      menu.hidden = true;
      self.loadLevel(self.levels.length - 1, false)['catch'](function () {});
    });
    menu.appendChild(auto);

    this.levels.slice().reverse().forEach(function (lv) {
      var idx = self.levels.indexOf(lv);
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'vq-item';
      item.textContent = (lv.height ? lv.height + 'p' : Math.round(lv.bandwidth / 1000) + 'k');
      item.addEventListener('click', function () {
        self.manual = true;
        active(item);
        menu.hidden = true;
        self.badge.textContent = item.textContent;
        self.loadLevel(idx, false)['catch'](function () {});
      });
      menu.appendChild(item);
    });

    badge.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    document.addEventListener('click', function (e) {
      if (!menu.hidden && self.shell && !self.shell.contains(e.target)) menu.hidden = true;
    });

    this.shell.appendChild(badge);
    this.shell.appendChild(menu);
  };

  /* ---------------------------- 绑定 ---------------------------- */

  function bufferedDesc(video) {
    try {
      var b = video.buffered;
      var parts = [];
      for (var i = 0; i < b.length; i++) parts.push(b.start(i).toFixed(1) + '~' + b.end(i).toFixed(1));
      return parts.length ? parts.join(' ') : '(空)';
    } catch (e) { return '(err)'; }
  }

  Array.prototype.forEach.call(videos, function (video) {
    if (!window.DSH_HLS_DEBUG && document.documentElement.hasAttribute('data-hls-debug')) {
      window.DSH_HLS_DEBUG = true;
    }

    var p = new Player(video);
    video.__hlsPlayer = p;
    p.autoStart = true;      // 用户按播放时若缓冲已够，立即播

    video.addEventListener('play', function () {
      p.wantPlay = true;
      p.hideStatusWhenPlaying();      // 用户主动播放时立刻收掉加载遮罩
      p.pump();
    });
    video.addEventListener('playing', function () { p.hideStatusWhenPlaying(); });
    // 能播了（哪怕还没攒够 START_BUFFER）也不要一直盖着遮罩
    video.addEventListener('canplay', function () {
      if (p.bufferedAhead() > 1) p.hideStatusWhenPlaying();
    });
    video.addEventListener('timeupdate', function () {
      if (video.currentTime > 0.2) p.hideStatusWhenPlaying();
      p.pump();
    });
    video.addEventListener('seeking', function () {
      // 拖到还没缓冲的位置：从对应分片重新开始喂
      if (p.dead || !p.playlist) return;
      var t = video.currentTime;
      var acc = 0;
      for (var i = 0; i < p.playlist.segs.length; i++) {
        acc += p.playlist.segs[i].duration;
        if (acc > t) { p.index = i; break; }
      }
      p.initSent = p.initSent || false;
      p.pump();
    });

    p.start();

    // 定时兜底：防止某个事件丢失导致再也不填充
    var tick = setInterval(function () {
      if (p.dead) { clearInterval(tick); return; }
      p.pump();
    }, 500);

    // 调试面板：<html data-hls-debug> 时右下角显示状态
    if (window.DSH_HLS_DEBUG) {
      var panel = document.createElement('pre');
      panel.className = 'hls-debug';
      document.body.appendChild(panel);
      setInterval(function () {
        panel.textContent =
          'hlsDebug  levels=' + p.levels.length + ' level=' + p.level +
          ' segs=' + (p.playlist ? p.playlist.segs.length : 0) + ' next=' + p.index + '\n' +
          'dead=' + p.dead + ' why=' + (p.why || '-') + ' initSent=' + !!p.initSent + ' started=' + p.started + '\n' +
          'busy=' + p.busy + ' sbUpdating=' + (p.sb ? p.sb.updating : 'n/a') + ' mime=' + (p.mime || '-') + '\n' +
          'ct=' + video.currentTime.toFixed(2) + ' paused=' + video.paused +
          ' rs=' + video.readyState + ' dur=' + (isFinite(video.duration) ? video.duration.toFixed(1) : 'NaN') + '\n' +
          'buf=' + bufferedDesc(video) + '\n' +
          'verr=' + (video.error ? video.error.code : '-') + ' appErr=' + (p.appendErr || '-') + '\n' +
          'appended=' + (p.appendOrder || []).slice(0, 10).join(',') + '\n' +
          (p.traceLog.slice(-5).join('\n'));
      }, 400);
    }
  });

  // 供外部使用（也方便测试）
  window.DSHHls = {
    players: function () {
      return Array.prototype.map.call(document.querySelectorAll('video[data-hls], video.player-hls'), function (v) {
        return v.__hlsPlayer;
      }).filter(Boolean);
    }
  };
})();

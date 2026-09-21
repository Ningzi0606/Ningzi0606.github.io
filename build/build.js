#!/usr/bin/env node
/**
 * 零依赖静态站点生成器
 * ------------------------------------------------------------------
 * 读取 content/ 里的 Markdown 与图片，生成可以直接打开的静态 HTML。
 * 用法：node build/build.js
 *
 * 生成结果（全部位于项目根目录）：
 *   index.html            首页
 *   posts/index.html      文字列表
 *   posts/<slug>/index.html
 *   photos/index.html     相册（自动扫描 content/photos/）
 *   videos/index.html     视频（来自 content/videos.md）
 *   about/index.html      关于我
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const POSTS_DIR = path.join(CONTENT, 'posts');
const PHOTOS_DIR = path.join(CONTENT, 'photos');

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg'];
const VIDEO_EXT = ['.mp4', '.webm', '.ogv', '.mov'];
const AUDIO_EXT = ['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac'];
const GALLERY_DIR = 'content/photos'; // 相册目录（站内相对路径）
const MUSIC_DIR = path.join(CONTENT, 'music');
const MUSIC_DIR_REL = 'content/music';

const config = readJSON(path.join(ROOT, 'site.config.json')) || {};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`  ! 无法读取 ${path.relative(ROOT, file)}：${err.message}`);
    return null;
  }
}

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

/**
 * 读取 MP3 的 ID3v2 标签 + 精确时长
 * 返回 { title, artist, album, cover: {data, ext} | null, duration }
 * 不是 MP3（或没有标签）时返回空字段，调用方再退回文件名。
 */
function readAudioMeta(file) {
  const result = { title: '', artist: '', album: '', cover: null, duration: 0 };
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    return result;
  }
  if (buf.length < 128) return result;

  let audioStart = 0;

  /* ---------- ID3v2 ---------- */
  if (buf.toString('ascii', 0, 3) === 'ID3') {
    const id3Size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    audioStart = 10 + id3Size;

    let p = 10;
    while (p + 10 <= audioStart && p + 10 <= buf.length) {
      const id = buf.toString('ascii', p, p + 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fsize = buf.readUInt32BE(p + 4);
      if (fsize <= 0 || p + 10 + fsize > buf.length) break;
      const body = buf.slice(p + 10, p + 10 + fsize);

      const textOf = () => {
        const enc = body[0];
        const raw = body.slice(1);
        if (enc === 0) return raw.toString('latin1');
        if (enc === 1) return raw.toString('utf16le');
        if (enc === 2) return raw.toString('utf16be');
        return raw.toString('utf8');
      };

      if (id === 'TIT2') result.title = textOf().replace(/\u0000+$/, '').trim();
      else if (id === 'TPE1') result.artist = textOf().replace(/\u0000+$/, '').trim();
      else if (id === 'TALB') result.album = textOf().replace(/\u0000+$/, '').trim();
      else if (id === 'APIC' && !result.cover) {
        const enc = body[0];
        const mimeEnd = body.indexOf(0, 1);
        let q = mimeEnd + 2; // 跳过 mime 和图片类型字节
        if (enc === 0 || enc === 3) q = body.indexOf(0, q) + 1;
        else {
          while (q + 1 < body.length && !(body[q] === 0 && body[q + 1] === 0)) q += 2;
          q += 2;
        }
        const img = body.slice(q);
        const isJpg = img[0] === 0xff && img[1] === 0xd8;
        const isPng = img[0] === 0x89 && img[1] === 0x50;
        if (isJpg || isPng) result.cover = { data: img, ext: isJpg ? 'jpg' : 'png' };
      }
      p += 10 + fsize;
    }
  }

  /* ---------- 遍历 MPEG 帧算时长 ---------- */
  const BITRATES = {
    1: { 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
         2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
         1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448] },
    2: { 3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
         2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
         1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256] }
  };
  const RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

  let off = audioStart;
  let samples = 0;
  let sr = 44100;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff || (buf[off + 1] & 0xe0) !== 0xe0) { off++; continue; }
    const h1 = buf[off + 1], h2 = buf[off + 2];
    const verBits = (h1 >> 3) & 0x03;
    const layerBits = (h1 >> 1) & 0x03;
    if (verBits === 1 || layerBits === 0) { off++; continue; }
    const version = verBits === 3 ? 1 : 2;
    const layer = 4 - layerBits;
    const brIdx = (h2 >> 4) & 0x0f;
    const srIdx = (h2 >> 2) & 0x03;
    const padding = (h2 >> 1) & 0x01;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) { off++; continue; }
    const bitrate = BITRATES[version][layer][brIdx] * 1000;
    sr = RATES[verBits === 3 ? 1 : verBits === 2 ? 2 : 0][srIdx];
    const spf = layer === 1 ? 384 : layer === 2 ? 1152 : (version === 1 ? 1152 : 576);
    const frameLen = layer === 1
      ? Math.floor((12 * bitrate / sr + padding) * 4)
      : Math.floor(spf / 8 * bitrate / sr) + padding;
    if (frameLen < 24) { off++; continue; }
    samples += spf;
    off += frameLen;
  }
  result.duration = sr ? samples / sr : 0;
  return result;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function write(file, content) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content);
}

/**
 * 把站点路径转成当前页面的链接。
 * depth = 页面在目录树中的层级（首页 0，posts/index.html 1，posts/xx/index.html 2）
 * 生成相对路径，这样用双击打开 index.html 也能正常显示。
 */
function url(target, depth) {
  const prefix = depth > 0 ? '../'.repeat(depth) : '';
  const clean = String(target || '').replace(/^\/+/, '');
  return prefix + clean;
}

/** 把行内出现的 content/... 之类的相对路径转成当前页可用的路径 */
function resolveRefs(html, depth) {
  if (!depth) return html;
  return String(html).replace(/(?<==["'(])(?:\.\/)?(content|assets)\//g, (m, dir) => url(`${dir}/`, depth));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, '&#39;');
}

function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(input) {
  if (!input) return '';
  const raw = String(input).trim();
  const m = raw.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?/);
  if (!m) return raw;
  const year = Number(m[1]);
  const month = Number(m[2]) || 1;
  const day = Number(m[3]) || 1;
  return `${MONTHS_EN[month - 1]} ${day}, ${year}`;
}

/** 从 Markdown 正文里提取纯文本摘要 */
function excerptOf(text, len = 120) {
  const flat = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')          // 代码块
    .replace(/::video\[[^\]]+\](?:\{[^}]*\})?/g, ' ') // 视频
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')    // 图片
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // 链接保留文字
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, ' ')   // 标题整行去掉
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\|/g, ' ');
  const clean = stripTags(flat).replace(/\s+/g, ' ').trim();
  return clean.length > len ? clean.slice(0, len).trim() + '…' : clean;
}

/* ------------------------------------------------------------------ */
/* Front matter（文件开头 --- 之间的配置）                              */
/* ------------------------------------------------------------------ */

function parseFrontMatter(raw) {
  const text = String(raw).replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { data: {}, body: text };
  return { data: parseYamlLite(match[1]), body: text.slice(match[0].length) };
}

function parseYamlLite(block) {
  const data = {};
  const lines = block.split('\n');
  let listKey = null;

  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const item = line.match(/^\s*-\s*(.+)$/);
    if (item && listKey) {
      data[listKey].push(parseScalar(item[1]));
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();

    if (value === '') {
      data[key] = [];
      listKey = key;
    } else if (value === '|' || value === '>') {
      data[key] = value;
      listKey = null;
    } else {
      data[key] = parseScalar(value);
      listKey = null;
    }
  }
  return data;
}

function parseScalar(value) {
  let v = String(value).trim();
  if (/^"(.*)"$/.test(v) || /^'(.*)'$/.test(v)) v = v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^\[.*\]$/.test(v)) {
    return v
      .slice(1, -1)
      .split(',')
      .map((s) => parseScalar(s))
      .filter((s) => s !== '');
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* Markdown 渲染（支持常用语法子集）                                    */
/* ------------------------------------------------------------------ */

function renderMarkdown(md, depth = 0) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const listItem = (line) => line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);

  while (i < lines.length) {
    const line = lines[i];

    /* 空行 */
    if (!line.trim()) {
      i++;
      continue;
    }

    /* 代码块 */
    const fence = line.match(/^\s*```\s*([A-Za-z0-9#+-]*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // 跳过结束的 ```
      const cls = lang ? ` class="language-${escapeAttr(lang)}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    /* 分隔线 */
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    /* 标题 */
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2].trim(), depth)}</h${level}>`);
      i++;
      continue;
    }

    /* 引用 */
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), depth)}</blockquote>`);
      continue;
    }

    /* 表格 */
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const cells = (row) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      const th = head.map((c) => `<th>${inline(c, depth)}</th>`).join('');
      const tb = rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c, depth)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }

    /* 列表（有序 / 无序，支持一层缩进续行） */
    if (listItem(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      let current = null;
      while (i < lines.length && listItem(lines[i])) {
        const m = listItem(lines[i]);
        current = [m[2]];
        i++;
        // 续行：缩进但不是新的列表项
        while (i < lines.length && lines[i].trim() && !listItem(lines[i]) && /^\s{2,}\S/.test(lines[i])) {
          current.push(lines[i].trim());
          i++;
        }
        items.push(`<li>${inline(current.join(' '), depth)}</li>`);
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    /* 段落 */
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(#{1,6}\s|```|>|\|)/.test(lines[i]) &&
      !listItem(lines[i]) &&
      !/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(lines[i])
    ) {
      buf.push(lines[i].trim());
      i++;
    }
    if (buf.length) out.push(`<p>${inline(buf.join(' '), depth)}</p>`);
    else i++;
  }

  return out.join('\n');
}

/** 行内语法：视频、图片、链接、强调、代码、换行 */
function inline(text, depth = 0) {
  let s = String(text);

  // 先保护行内代码
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000code${codes.length - 1}\u0000`;
  });

  // ::video[地址]{poster="封面地址"} —— 本地文件、YouTube、Bilibili 都支持
  // 生成的 HTML 先存起来、用占位符代替，等转义完成后再还原，
  // 否则下面的 escapeHtml 会把 <div> 转成 &lt;div&gt;，视频就变成一串源代码了。
  const embeds = [];
  s = s.replace(/::video\[([^\]]+)\](?:\{([^}]*)\})?/g, (_, src, opts) => {
    let poster = '';
    if (opts) {
      const m = opts.match(/poster\s*=\s*"?([^",}]+)"?/);
      if (m) poster = m[1].trim();
    }
    embeds.push(videoEmbed(src.trim(), poster, depth));
    return `\u0000video${embeds.length - 1}\u0000`;
  });

  s = escapeHtml(s);

  // 图片 ![alt](src "title")
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, src, title) =>
    `<img src="${url(src, depth)}" alt="${escapeAttr(alt)}"${title ? ` title="${escapeAttr(title)}"` : ''} loading="lazy" />`
  );

  // 链接 [text](href)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, label, href, title) =>
    `<a href="${external(href, depth)}"${title ? ` title="${escapeAttr(title)}"` : ''}>${label}</a>`
  );

  // 粗体 / 斜体 / 删除线
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // 换行
  s = s.replace(/ {2,}$/gm, '<br />');

  // 还原行内代码
  s = s.replace(/\u0000code(\d+)\u0000/g, (_, n) => codes[Number(n)]);

  // 还原视频嵌入
  s = s.replace(/\u0000video(\d+)\u0000/g, (_, n) => embeds[Number(n)]);

  return s;
}

/** 把图片地址变成绝对地址（og:image 需要绝对路径） */
function absoluteUrl(target) {
  const clean = String(target || '').replace(/^\/+/, '');
  if (/^https?:/i.test(clean)) return clean;
  const site = String(config.url || '').replace(/\/+$/, '');
  return site ? `${site}/${clean}` : `/${clean}`;
}

/** 站内相对路径按当前页面层级解析，外链原样保留 */
function external(href, depth = 0) {
  // 屏蔽 javascript: 之类的危险协议
  if (/^\s*(javascript|data|vbscript):/i.test(href)) return '#';
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(href)) return href;
  return url(href, depth);
}

/** 视频嵌入：本地文件用 <video>，YouTube / Bilibili 用 <iframe> */
function videoEmbed(src, poster, depth = 0) {
  const yt = src.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  if (yt) {
    return `<div class="embed"><iframe src="https://www.youtube.com/embed/${yt[1]}" title="video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`;
  }

  const bili = src.match(/bilibili\.com\/video\/(BV[A-Za-z0-9]+)/);
  if (bili) {
    return `<div class="embed"><iframe src="https://player.bilibili.com/player.html?bvid=${bili[1]}&high_quality=1&danmaku=0" title="video" loading="lazy" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe></div>`;
  }

  const ext = path.extname(src.split(/[?#]/)[0]).toLowerCase();
  if (VIDEO_EXT.includes(ext)) {
    return `<video class="player" src="${url(src, depth)}" controls playsinline preload="metadata"${poster ? ` poster="${url(poster, depth)}"` : ''}></video>`;
  }

  // 兜底：当作外链视频
  return `<p><a href="${escapeAttr(src)}" target="_blank" rel="noopener">观看视频 →</a></p>`;
}

/* ------------------------------------------------------------------ */
/* 页面模板                                                            */
/* ------------------------------------------------------------------ */

function navHtml(active, depth = 0) {
  const items = [
    { key: 'home', label: '首页', href: '' },
    { key: 'posts', label: '文字', href: 'posts/' },
    { key: 'photos', label: '照片', href: 'photos/' },
    { key: 'videos', label: '视频', href: 'videos/' },
    { key: 'music', label: '音乐', href: 'music/' },
    { key: 'about', label: '关于', href: 'about/' }
  ];
  return items
    .map((it) => {
      const cls = it.key === active ? ' class="active"' : '';
      return `<a href="${url(it.href, depth)}"${cls}>${it.label}</a>`;
    })
    .join('\n        ');
}

/** 曲目列表，build() 时填充；所有页面共用 */
let TRACKS = [];

function layout({ title, description, active, body, bodyClass = '', depth = 0, script = '' }) {
  const siteTitle = config.title || '个人网站';
  const pageTitle = title ? `${title} · ${siteTitle}` : siteTitle;
  const desc = description || config.description || '';
  const year = new Date().getFullYear();
  const footer = (config.footer || `© ${year} ${config.name || siteTitle}`).replace('{year}', String(year));
  const ogImage = config.ogImage || config.avatar || '';
  const tracks = TRACKS;
  const hasPlayer = tracks.length > 0;

  // 播放器曲目写进 data 属性，交给 assets/player.js 处理（一个全局播放器）
  const tracksData = hasPlayer
    ? tracks.map((t) => ({
        src: url(t.src, depth),
        title: t.title,
        artist: t.artist || '',
        album: t.album || '',
        cover: t.cover ? url(t.cover, depth) : '',
        duration: Math.round(t.duration || 0)
      }))
    : [];
  const first = tracksData[0] || { title: '', artist: '', cover: '' };

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(pageTitle)}</title>
<meta name="description" content="${escapeAttr(desc)}" />
<meta name="generator" content="build/build.js" />
<link rel="icon" href="${url('assets/favicon.png', depth)}" type="image/png" />
<link rel="apple-touch-icon" href="${url('assets/favicon.png', depth)}" />
<link rel="stylesheet" href="${url('assets/style.css', depth)}" />
<meta property="og:title" content="${escapeAttr(pageTitle)}" />
<meta property="og:description" content="${escapeAttr(desc)}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${escapeAttr(config.url || absoluteUrl(''))}" />
<meta property="og:image" content="${escapeAttr(absoluteUrl(ogImage))}" />
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
<a class="skip" href="#main">跳到正文</a>

<header class="site-head">
  <div class="wrap head-inner">
    <a class="brand name-gradient" href="${url('', depth)}">${escapeHtml(config.name || siteTitle)}</a>
    <nav class="nav">
        ${navHtml(active, depth)}
    </nav>${hasPlayer ? `
    <div class="music-player" data-music-player hidden data-tracks="${escapeAttr(JSON.stringify(tracksData))}">
      <button class="mp-btn" type="button" aria-label="播放" title="播放">${first.cover
        ? `<img class="mp-cover" src="${escapeAttr(first.cover)}" alt="" />`
        : `<svg class="mp-icon-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>
        <svg class="mp-icon-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></svg>`}
        <span class="mp-btn-overlay" aria-hidden="true">
          <svg class="mp-icon-play" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>
          <svg class="mp-icon-pause" viewBox="0 0 24 24"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></svg>
        </span>
      </button>
      <div class="mp-info">
        <span class="mp-title" role="button" tabindex="0" title="点击切换下一首">${escapeHtml(first.title)}</span>
        <span class="mp-meta">${escapeHtml([first.artist, first.album].filter(Boolean).join(' · '))}</span>
        <div class="mp-progress" role="slider" tabindex="0" aria-label="播放进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <span class="mp-progress-fill"></span>
        </div>
      </div>
      <button class="mp-volume" type="button" aria-label="静音" title="静音">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h3.5L12 19V5L7.5 9H4z"/><path class="mp-wave" d="M15.5 9.2a4 4 0 0 1 0 5.6M18 7a7.4 7.4 0 0 1 0 10"/></svg>
      </button>
    </div>` : ''}
  </div>
</header>

<main id="main" class="wrap">
${body}
</main>

<footer class="site-foot">
  <div class="wrap">
    <p>${escapeHtml(footer)}</p>
  </div>
</footer>

<script src="${url('assets/app.js', depth)}" defer></script>${hasPlayer ? `
<script src="${url('assets/player.js', depth)}" defer></script>` : ''}${script ? `
<script src="${url('assets/' + script, depth)}" defer></script>` : ''}
</body>
</html>
`;
}

/* ------------------------------------------------------------------ */
/* 内容读取                                                            */
/* ------------------------------------------------------------------ */

function slugify(str) {
  const s = String(str)
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'untitled';
}

function loadPosts(depth = 0) {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const files = fs.readdirSync(POSTS_DIR).filter((f) => f.toLowerCase().endsWith('.md'));

  return files
    .map((file) => {
      const full = path.join(POSTS_DIR, file);
      const { data, body } = parseFrontMatter(readText(full));
      const base = path.basename(file, path.extname(file));
      const slug = data.slug ? slugify(data.slug) : slugify(base);
      const html = renderMarkdown(body, depth);
      const title = data.title || base;
      const date = data.date ? String(data.date) : '';
      const excerpt = data.excerpt ? String(data.excerpt) : excerptOf(body, 140);
      const tags = Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [];
      return {
        file: path.relative(ROOT, full),
        slug,
        title,
        date,
        dateText: formatDate(date),
        tags,
        excerpt,
        html,
        cover: data.cover || '',
        draft: data.draft === true,
        order: date ? Date.parse(date) || 0 : fs.statSync(full).mtimeMs
      };
    })
    .filter((p) => !p.draft)
    .sort((a, b) => b.order - a.order || a.title.localeCompare(b.title, 'zh'));
}

function listPhotos() {
  if (!fs.existsSync(PHOTOS_DIR)) return [];
  return fs
    .readdirSync(PHOTOS_DIR)
    .filter((f) => IMAGE_EXT.includes(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }))
    .map((f) => ({
      name: f.replace(path.extname(f), ''),
      src: `${GALLERY_DIR}/${f}`
    }));
}

/** 扫描 content/music/ 里的音频，读取 ID3 标签与封面，作为播放器曲目 */
function listMusic() {
  if (!fs.existsSync(MUSIC_DIR)) return [];
  const coverDir = path.join(ROOT, 'assets', 'music');

  return fs
    .readdirSync(MUSIC_DIR)
    .filter((f) => AUDIO_EXT.includes(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }))
    .map((f, i) => {
      const full = path.join(MUSIC_DIR, f);
      const meta = readAudioMeta(full);
      const base = f.replace(path.extname(f), '');

      // 文件名形如「歌手 - 歌名」时自动拆分
      let fileArtist = '';
      let fileTitle = base;
      const dash = base.split(/\s+-\s+/);
      if (dash.length >= 2) {
        fileArtist = dash[0].trim();
        fileTitle = dash.slice(1).join(' - ').trim();
      }
      fileTitle = fileTitle.replace(/^\d+[\s._-]+/, '') || fileTitle;

      // 提取内嵌封面到 assets/music/，文件名用序号保证稳定
      let cover = '';
      if (meta.cover) {
        const name = `cover-${String(i + 1).padStart(2, '0')}.${meta.cover.ext}`;
        ensureDir(coverDir);
        fs.writeFileSync(path.join(coverDir, name), meta.cover.data);
        cover = `assets/music/${name}`;
      }

      return {
        title: meta.title || fileTitle,
        artist: meta.artist || fileArtist,
        album: meta.album || '',
        duration: meta.duration,
        cover,
        src: `${MUSIC_DIR_REL}/${f}`
      };
    });
}

/** 格式化为 m:ss */
function fmtTime(sec) {
  if (!sec || !isFinite(sec)) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function loadVideos(depth = 0) {
  const file = path.join(CONTENT, 'videos.md');
  if (!fs.existsSync(file)) return { html: '', items: [] };
  const { body } = parseFrontMatter(readText(file));
  const html = renderMarkdown(body, depth);

  // 只扫描代码块 / 行内代码以外的内容，避免文档里的示例被当成真正的视频
  const scanText = body
    .replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, '\n')
    .replace(/`[^`\n]*`/g, ' ');

  const items = [];
  const re = /::video\[([^\]]+)\](?:\{([^}]*)\})?/g;
  let m;
  while ((m = re.exec(scanText))) {
    let poster = '';
    let title = '';
    if (m[2]) {
      const p = m[2].match(/poster\s*=\s*"?([^",}]+)"?/);
      const t = m[2].match(/title\s*=\s*"?([^",}]+)"?/);
      if (p) poster = p[1].trim();
      if (t) title = t[1].trim();
    }
    items.push({ src: m[1].trim(), poster, title: title || `视频 ${items.length + 1}` });
  }
  return { html, items };
}

function loadPage(name, depth = 0) {
  const file = path.join(CONTENT, `${name}.md`);
  if (!fs.existsSync(file)) return { data: {}, html: '' };
  const { data, body } = parseFrontMatter(readText(file));
  return { data, html: renderMarkdown(body, depth) };
}

/* ------------------------------------------------------------------ */
/* 片段                                                                */
/* ------------------------------------------------------------------ */

function postCard(post, depth = 0) {
  const meta = [post.dateText, post.tags.length ? post.tags.join(' · ') : ''].filter(Boolean).join(' · ');
  return `<article class="card">
  <h3 class="card-title"><a href="${url(`posts/${post.slug}/`, depth)}">${escapeHtml(post.title)}</a></h3>
  ${meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ''}
  <p class="excerpt">${escapeHtml(post.excerpt)}</p>
</article>`;
}

function photoFigure(photo, depth = 0) {
  return `<figure class="shot">
  <a href="${url(photo.src, depth)}" data-lightbox>
    <img src="${url(photo.src, depth)}" alt="${escapeAttr(photo.name)}" loading="lazy" />
  </a>
</figure>`;
}

function videoFigure(v, depth = 0) {
  return `<figure class="video-item">
  <div class="video-frame">${videoEmbed(v.src, v.poster, depth)}</div>
  ${v.title ? `<figcaption>${escapeHtml(v.title)}</figcaption>` : ''}
</figure>`;
}

/** 联系方式按钮：type 为 text 时只显示文本（比如微信号） */
function linkPills(depth = 0) {
  return (config.links || [])
    .filter((l) => l && (l.url || l.type === 'text'))
    .map((l) => {
      if (l.type === 'text') {
        return `<span class="pill pill-static" title="复制后添加">${escapeHtml(l.label)} · ${escapeHtml(l.url)}</span>`;
      }
      const isMail = /^(mailto:|tel:)/.test(l.url);
      const href = isMail ? l.url : external(l.url, depth);
      const ext = isMail ? '' : ' target="_blank" rel="noopener"';
      return `<a class="pill" href="${escapeAttr(href)}"${ext}>${escapeHtml(l.label)}</a>`;
    })
    .join('\n      ');
}

function homePage(posts, photos, videos) {
  const page = loadPage('index');
  // 首页头部信息：优先取 content/index.md 的配置，否则用 site.config.json
  const name = page.data.name || config.name || config.title || '你的名字';
  const tagline = page.data.tagline || config.tagline || '';
  const avatar = page.data.avatar || config.avatar || '';
  const recentCount = Number(config.home?.recentCount ?? 3);
  const photoCount = Number(config.home?.latestPhotosCount ?? 6);
  const videoCount = Number(config.home?.latestVideosCount ?? 2);

  const recent = posts.slice(0, recentCount);
  const shots = photos.slice(0, photoCount);
  const vids = videos.slice(0, videoCount);

  const links = linkPills(0);

  // 头像外框：粉色圆环 + 可选的「直播中」标签（在 site.config.json 的 avatarBadge 里配置）
  const badgeConf = config.avatarBadge || {};
  const badgeOn = badgeConf.enabled !== false && (badgeConf.text || '直播中');
  const avatarBlock = avatar
    ? `<span class="avatar-frame${badgeOn ? ' has-badge' : ''}">
    <img class="avatar" src="${url(avatar)}" alt="${escapeAttr(name)}" />${badgeOn ? `
    <span class="avatar-badge"><img src="${url('assets/badge-live.svg')}" alt="" aria-hidden="true" />${escapeHtml(badgeConf.text || '直播中')}</span>` : ''}
  </span>`
    : '';

  const body = `<section class="hero">
  ${avatarBlock}
  <h1 class="name-gradient">${escapeHtml(name)}</h1>
  ${tagline ? `<p class="tagline">${escapeHtml(tagline)}</p>` : ''}
</section>

<section class="prose">
${page.html}
</section>

${links ? `<section class="block"><h2 class="block-title">联系我</h2><div class="links">\n      ${links}\n    </div></section>` : ''}

${recent.length ? `<section class="block">
  <h2 class="block-title"><a href="${url('posts/')}">${escapeHtml(config.home?.recentTitle || '最新文字')}</a></h2>
  <div class="cards">
    ${recent.map((p) => postCard(p, 0)).join('\n    ')}
  </div>
</section>` : ''}

${shots.length ? `<section class="block">
  <h2 class="block-title"><a href="${url('photos/')}">${escapeHtml(config.home?.latestPhotosTitle || '最新照片')}</a></h2>
  <div class="gallery gallery-home">
    ${shots.map((p) => photoFigure(p, 0)).join('\n    ')}
  </div>
</section>` : ''}

${vids.length ? `<section class="block">
  <h2 class="block-title"><a href="${url('videos/')}">${escapeHtml(config.home?.latestVideosTitle || '最新视频')}</a></h2>
  <div class="video-grid">
    ${vids.map((v) => videoFigure(v, 0)).join('\n    ')}
  </div>
</section>` : ''}`;

  return layout({ title: '', description: config.description, active: 'home', body, bodyClass: 'page-home' });
}

function postsIndexPage(posts) {
  const body = `<header class="page-head">
  <h1>文字</h1>
  <p class="lede">共 ${posts.length} 篇。按时间从新到旧排列。</p>
</header>

<div class="cards">
  ${posts.map((p) => postCard(p, 1)).join('\n  ') || '<p class="empty">还没有文章。在 content/posts/ 里新建一个 .md 文件即可。</p>'}
</div>`;

  return layout({ title: '文字', description: '所有文字记录', active: 'posts', body, depth: 1 });
}

function postPage(post) {
  const meta = [post.dateText, post.tags.length ? post.tags.join(' · ') : ''].filter(Boolean).join(' · ');
  const body = `<article class="post">
  <header class="page-head">
    <h1>${escapeHtml(post.title)}</h1>
    ${meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ''}
  </header>
  <div class="prose">
${post.html}
  </div>
  <p class="back"><a href="${url('posts/', 2)}">← 返回文字列表</a></p>
</article>`;

  return layout({
    title: post.title,
    description: post.excerpt,
    active: 'posts',
    body,
    bodyClass: 'page-post',
    depth: 2
  });
}

function photosPage(photos, depth = 1) {
  const page = loadPage('photos', depth);
  const body = `<header class="page-head">
  <h1>照片</h1>
  <p class="lede">共 ${photos.length} 张。</p>
</header>

${page.html ? `<div class="prose">\n${page.html}\n</div>` : ''}

${photos.length
      ? `<div class="gallery">
  ${photos.map((p) => photoFigure(p, depth)).join('\n  ')}
</div>`
      : '<p class="empty">相册还是空的。</p>'}`;

  return layout({
    title: '照片',
    description: '相册',
    active: 'photos',
    body,
    bodyClass: 'page-photos',
    depth
  });
}

function videosPage(videos, depth = 1) {
  const page = loadPage('videos', depth);
  const body = `<header class="page-head">
  <h1>视频</h1>
  <p class="lede">共 ${videos.length} 段。</p>
</header>

${videos.length
      ? `<div class="video-grid">
  ${videos.map((v) => videoFigure(v, depth)).join('\n  ')}
</div>`
      : '<p class="empty">还没有视频。</p>'}

${page.html ? `<div class="prose">\n${page.html}\n</div>` : ''}`;

  return layout({ title: '视频', description: '视频', active: 'videos', body, bodyClass: 'page-videos', depth });
}

function aboutPage(depth = 1) {
  const page = loadPage('about', depth);
  const links = linkPills(depth);
  const music = musicSection(loadMusicList());

  const body = `<header class="page-head">
  <h1>${escapeHtml(page.data.title || '关于我')}</h1>
</header>

<div class="prose">
${page.html}
</div>

${music}

${links ? `<section class="block"><h2 class="block-title">联系方式</h2><div class="links">\n      ${links}\n    </div></section>` : ''}`;

  return layout({ title: page.data.title || '关于我', description: '关于我', active: 'about', body, depth });
}

/** 读取 content/music-list.json（网易云外链播放器清单） */
function loadMusicList() {
  const file = path.join(CONTENT, 'music-list.json');
  if (!fs.existsSync(file)) return null;
  const data = readJSON(file);
  if (!data || !Array.isArray(data.tracks) || !data.tracks.length) return null;
  return data;
}

function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** 旧地址的重定向页（老链接不至于 404） */
function redirectPage(target, depth = 1) {
  const href = url(target, depth);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>跳转中…</title>
<meta http-equiv="refresh" content="0; url=${escapeAttr(href)}" />
<link rel="canonical" href="${escapeAttr(href)}" />
<meta name="robots" content="noindex" />
</head>
<body style="font-family:system-ui,sans-serif;padding:3rem 1.5rem;color:#2c2340">
<p>页面已合并，正在跳转到 <a href="${escapeAttr(href)}">关于</a>…</p>
</body>
</html>
`;
}

/**
 * 「我在听」区块：
 *  ① 本地曲目（content/music/）→ 点一下就能放，由右上角那个全站播放器出声
 *  ② 网易云歌单 → 官方外链播放器（合法嵌入，音频由网易云托管）
 */
function musicSection(netease) {
  const local = TRACKS;
  const p = (netease && netease.profile) || {};

  /* ---------- ① 本地曲目列表 ---------- */
  let localHtml = '';
  if (local.length) {
    const rows = local
      .map((t, i) => {
        const meta = [t.artist, t.album].filter(Boolean).join(' · ');
        return `<li class="ltrack" data-index="${i}">
  <button class="ltrack-play" type="button" data-index="${i}" aria-label="播放 ${escapeAttr(t.title)}">
    <span class="ltrack-num">${String(i + 1).padStart(2, '0')}</span>
    ${t.cover ? `<img class="ltrack-cover" src="${escapeAttr(url(t.cover, 1))}" alt="" loading="lazy" />` : '<span class="ltrack-cover ltrack-cover-empty"></span>'}
    <span class="ltrack-text">
      <span class="ltrack-name">${escapeHtml(t.title)}</span>
      <span class="ltrack-meta">${escapeHtml(meta)}</span>
    </span>
    <span class="ltrack-time">${escapeHtml(fmtTime(t.duration))}</span>
    <span class="ltrack-ico" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>
    </span>
  </button>
</li>`;
      })
      .join('\n');

    localHtml = `<section class="block" id="listening">
  <h2 class="block-title">我在听</h2>
  <p class="lede">本地曲目 ${local.length} 首，点一下就开始放——声音来自右上角那个全站播放器，切页面也不会断。</p>
  <ul class="ltracks">
${rows}
  </ul>
  <p class="note">这些是我自己上传到网站上的音频文件，可以完整播放。下面的网易云歌单用的是官方外链播放器，需要登录网易云账号才能听完整版。</p>
</section>`;
  }

  /* ---------- ② 网易云嵌入 ---------- */
  let neteaseHtml = '';
  if (netease && netease.tracks.length) {
    const items = netease.tracks
      .map((t, i) => {
        const meta = [t.artists, t.album, fmtTime(t.duration)].filter(Boolean).join(' · ');
        return `<li class="track">
  <span class="track-no">${String(i + 1).padStart(2, '0')}</span>
  <div class="track-body">
    <h3 class="track-name">${escapeHtml(t.name)}</h3>
    <p class="track-meta">${escapeHtml(meta)}</p>
    <iframe class="netease-embed" src="https://music.163.com/outchain/player?type=2&id=${encodeURIComponent(t.id)}&auto=0&height=66" frameborder="no" border="0" marginwidth="0" marginheight="0" width="100%" height="86" loading="lazy" title="${escapeAttr(t.name)}"></iframe>
  </div>
  <a class="track-link" href="https://music.163.com/song?id=${encodeURIComponent(t.id)}" target="_blank" rel="noopener" title="在网易云音乐打开">↗</a>
</li>`;
      })
      .join('\n');

    const buttons = [
      p.profileUrl ? `<a class="pill" href="${escapeAttr(p.profileUrl)}" target="_blank" rel="noopener">我的网易云主页</a>` : '',
      p.playlistUrl ? `<a class="pill" href="${escapeAttr(p.playlistUrl)}" target="_blank" rel="noopener">完整歌单</a>` : ''
    ].filter(Boolean).join('\n      ');

    neteaseHtml = `<section class="block" id="netease">
  <h2 class="block-title">网易云歌单</h2>
  <p class="lede">来自我的网易云歌单「${escapeHtml(p.playlist || '我喜欢的音乐')}」，挑了前 ${netease.tracks.length} 首。播放器由网易云音乐提供。</p>
  ${buttons ? `<div class="links">\n      ${buttons}\n    </div>` : ''}
  <ul class="tracks">
${items}
  </ul>
  <p class="note">这些是网易云的官方外链播放器，音频由网易云托管。部分曲目需要登录网易云账号才能听完整版，未登录通常只能试听片段——这是平台的授权限制，不是网站坏了。</p>
</section>`;
  }

  return localHtml + neteaseHtml;
}

/** 「音乐」页：一块大播放面板 + 本地曲目列表 + 网易云歌单 */
function musicPage(netease, depth = 1) {
  const local = TRACKS;
  const p = (netease && netease.profile) || {};
  const first = local[0] || null;

  const nowPlaying = local.length
    ? `<section class="nowplaying">
  ${first.cover ? `<img class="np-cover" src="${escapeAttr(url(first.cover, depth))}" alt="" />` : '<div class="np-cover np-cover-empty"></div>'}
  <div class="np-body">
    <p class="np-label">正在播放</p>
    <h1 class="np-title">${escapeHtml(first.title)}</h1>
    <p class="np-artist">${escapeHtml([first.artist, first.album].filter(Boolean).join(' · '))}</p>
    <div class="np-controls">
      <button class="np-btn" type="button" data-np-prev aria-label="上一首">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 6h2v12H7zM19 6v12l-9-6z"/></svg>
      </button>
      <button class="np-btn np-btn-main" type="button" data-np-toggle aria-label="播放">
        <svg class="np-icon-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>
        <svg class="np-icon-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></svg>
      </button>
      <button class="np-btn" type="button" data-np-next aria-label="下一首">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6h2v12h-2zM5 6l9 6-9 6z"/></svg>
      </button>
    </div>
    <div class="np-progress" data-np-progress role="slider" tabindex="0" aria-label="播放进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <span class="np-progress-fill" data-np-fill></span>
    </div>
    <div class="np-times"><span data-np-current>0:00</span><span data-np-duration>${escapeHtml(fmtTime(first.duration))}</span></div>
  </div>
</section>

<ul class="ltracks" data-ltrack-list>
  ${local
    .map((t, i) => `<li class="ltrack" data-index="${i}">
    <button class="ltrack-play" type="button" data-index="${i}" aria-label="播放 ${escapeAttr(t.title)}">
      <span class="ltrack-num">${String(i + 1).padStart(2, '0')}</span>
      ${t.cover ? `<img class="ltrack-cover" src="${escapeAttr(url(t.cover, depth))}" alt="" loading="lazy" />` : '<span class="ltrack-cover ltrack-cover-empty"></span>'}
      <span class="ltrack-text">
        <span class="ltrack-name">${escapeHtml(t.title)}</span>
        <span class="ltrack-meta">${escapeHtml([t.artist, t.album].filter(Boolean).join(' · '))}</span>
      </span>
      <span class="ltrack-time">${escapeHtml(fmtTime(t.duration))}</span>
      <span class="ltrack-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg></span>
    </button>
  </li>`)
    .join('\n  ')}
</ul>`
    : '<p class="empty">还没有本地曲目。</p>';

  const neteaseHtml = netease && netease.tracks.length
    ? `<section class="block" id="netease">
  <h2 class="block-title">网易云歌单</h2>
  <p class="lede">来自我的网易云歌单「${escapeHtml(p.playlist || '我喜欢的音乐')}」，挑了前 ${netease.tracks.length} 首。用的是网易云官方外链播放器，需要登录网易云才能听完整版。</p>
  ${[p.profileUrl ? `<a class="pill" href="${escapeAttr(p.profileUrl)}" target="_blank" rel="noopener">我的网易云主页</a>` : '',
     p.playlistUrl ? `<a class="pill" href="${escapeAttr(p.playlistUrl)}" target="_blank" rel="noopener">完整歌单</a>` : ''].filter(Boolean).join('\n      ')}
  <ul class="tracks">
${netease.tracks
      .map((t, i) => `<li class="track">
    <span class="track-no">${String(i + 1).padStart(2, '0')}</span>
    <div class="track-body">
      <h3 class="track-name">${escapeHtml(t.name)}</h3>
      <p class="track-meta">${escapeHtml([t.artists, t.album, fmtTime(t.duration)].filter(Boolean).join(' · '))}</p>
      <iframe class="netease-embed" src="https://music.163.com/outchain/player?type=2&id=${encodeURIComponent(t.id)}&auto=0&height=66" frameborder="no" border="0" marginwidth="0" marginheight="0" width="100%" height="86" loading="lazy" title="${escapeAttr(t.name)}"></iframe>
    </div>
    <a class="track-link" href="https://music.163.com/song?id=${encodeURIComponent(t.id)}" target="_blank" rel="noopener" title="在网易云音乐打开">↗</a>
  </li>`)
      .join('\n    ')}
  </ul>
</section>`
    : '';

  const body = `<header class="page-head page-head-plain">
  <h1>音乐</h1>
  <p class="lede">${local.length ? `本地曲目 ${local.length} 首，点一下就能放。` : ''}右上角的播放器是全站共用的，切页面也不会断。</p>
</header>

${nowPlaying}

${neteaseHtml}`;

  return layout({
    title: '音乐',
    description: '我的音乐',
    active: 'music',
    body,
    bodyClass: 'page-music',
    depth,
    script: 'page-music.js'
  });
}

/** 404 页：访客走到不存在的地址时显示，而不是 GitHub 的默认报错页 */
function notFoundPage(depth = 0) {
  const body = `<header class="page-head">
  <h1>页面走丢了</h1>
  <p class="lede">这个地址下没有内容 —— 可能是链接写错了，或者页面被移走了。</p>
</header>

<div class="links">
  <a class="pill" href="${url('', depth)}">回首页</a>
  <a class="pill" href="${url('posts/', depth)}">看看文字</a>
  <a class="pill" href="${url('photos/', depth)}">看看照片</a>
  <a class="pill" href="${url('music/', depth)}">听听音乐</a>
</div>`;

  return layout({
    title: '页面走丢了',
    description: '没有找到这个页面',
    active: '',
    body,
    depth
  });
}

/* ------------------------------------------------------------------ */
/* 构建                                                                */
/* ------------------------------------------------------------------ */

function build() {
  const started = Date.now();
  console.log('正在生成站点…');

  const postsIndex = loadPosts(1);          // 列表页里的链接
  const postsDetail = loadPosts(2);         // 文章详情页里的图片等
  const photos = listPhotos();
  const videos = loadVideos(1);
  TRACKS = listMusic();                     // 填充播放器曲目（所有页面共用）

  // 清理旧的产物
  const generated = ['index.html', 'posts/', 'photos/', 'videos/', 'music/', 'about/'];
  for (const name of ['posts', 'photos', 'videos', 'music', 'about']) {
    fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
  }

  write(path.join(ROOT, 'index.html'), homePage(postsIndex, photos, videos.items));
  write(path.join(ROOT, 'posts', 'index.html'), postsIndexPage(postsIndex));
  for (const post of postsDetail) {
    write(path.join(ROOT, 'posts', post.slug, 'index.html'), postPage(post));
  }
  write(path.join(ROOT, 'photos', 'index.html'), photosPage(photos, 1));
  write(path.join(ROOT, 'videos', 'index.html'), videosPage(videos.items, 1));
  write(path.join(ROOT, 'about', 'index.html'), aboutPage(1));
  write(path.join(ROOT, 'music', 'index.html'), musicPage(loadMusicList(), 1));
  write(path.join(ROOT, '404.html'), notFoundPage(0));
  write(path.join(ROOT, '.nojekyll'), '');

  // 检查引用的本地媒体是否存在，提前提醒
  const missing = new Set();
  const allHtml = postsDetail.map((p) => p.html).join('\n') + videos.html;
  const re = /(?:src|poster)="((?:\.\.\/)*(?:content|assets)\/[^"]+?\.(?:jpg|jpeg|png|gif|webp|avif|svg|mp4|webm|ogv|mov))"/gi;
  let m;
  while ((m = re.exec(allHtml))) {
    const rel = m[1].replace(/^(\.\.\/)+/, '');
    if (!fs.existsSync(path.join(ROOT, rel))) missing.add(rel);
  }
  if (missing.size) {
    console.log('  ! 以下文件被引用但还不存在（放进去或改掉引用即可）：');
    for (const f of missing) console.log(`      - ${f}`);
  }

  console.log(`完成：${postsIndex.length} 篇文章 · ${photos.length} 张照片 · ${videos.items.length} 段视频（${Date.now() - started}ms）`);
  console.log('已生成：' + generated.join(' '));
}

if (require.main === module) build();

module.exports = { build, renderMarkdown, parseFrontMatter };

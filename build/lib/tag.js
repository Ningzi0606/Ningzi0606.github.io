#!/usr/bin/env node
/**
 * 给音频文件写入 ID3v2.3 标签（供 build/make-demo-tracks.ps1 调用）
 * ------------------------------------------------------------------
 * 用法：
 *   node build/lib/tag.js <源.mp3> <输出.mp3> <标题> [封面.jpg] [艺术家] [专辑]
 *
 * 说明：只是把 ID3 头拼到 MP3 数据前面，不重新编码，音质无损。
 */

'use strict';

const fs = require('fs');
const { tagMp3 } = require('./id3');

const [src, dest, title, coverPath, artist, album] = process.argv.slice(2);

if (!src || !dest) {
  console.error('用法: node build/lib/tag.js <源.mp3> <输出.mp3> <标题> [封面.jpg] [艺术家] [专辑]');
  process.exit(1);
}

if (!fs.existsSync(src)) {
  console.error('找不到源文件：' + src);
  process.exit(1);
}

const cover = coverPath && fs.existsSync(coverPath) ? fs.readFileSync(coverPath) : null;

const out = tagMp3(fs.readFileSync(src), {
  title: title || '',
  artist: artist || '',
  album: album || '',
  cover
});

fs.writeFileSync(dest, out);
console.log(`已写入标签：${dest}（${(out.length / 1024).toFixed(0)} KB${cover ? '，含封面' : ''}）`);

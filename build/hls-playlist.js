#!/usr/bin/env node
/**
 * 把 DASH 产物（manifest.mpd + fMP4 分片）转换成 HLS 播放列表。
 * ------------------------------------------------------------------
 * 为什么要转：ffmpeg 的 HLS 复用器不会输出 fMP4 的初始化段（EXT-X-MAP），
 * 只有 DASH 复用器会；而页面播放器读的是 HLS 播放列表，所以这里做一次转换。
 *
 * 产出：
 *   index.m3u8    主播放列表（每个档位一行，含分辨率/带宽/编解码）
 *   <name>.m3u8   每档的媒体播放列表（EXT-X-MAP + EXTINF + 分片名）
 *
 * 用法：node build/hls-playlist.js <输出目录>
 */
'use strict';

const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error('用法: node build/hls-playlist.js <目录>');
  process.exit(1);
}

const mpdPath = path.join(dir, 'manifest.mpd');
if (!fs.existsSync(mpdPath)) {
  console.error('找不到 manifest.mpd：' + mpdPath);
  process.exit(1);
}
const mpd = fs.readFileSync(mpdPath, 'utf8');

/** 从 MPD 里抓出一个 AdaptationSet 块（按 id） */
function adaptationSet(id) {
  const re = new RegExp('<AdaptationSet[^>]*\\bid="' + id + '"[^>]*>([\\s\\S]*?)</AdaptationSet>', 'i');
  const m = mpd.match(re);
  return m ? m[1] : null;
}

function attr(tag, name) {
  const m = tag.match(new RegExp('\\b' + name + '="([^"]*)"', 'i'));
  return m ? m[1] : '';
}

/** 解析一个 AdaptationSet 里的 Representation 列表 */
function repsOf(block) {
  if (!block) return [];
  const out = [];
  const re = /<Representation\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(block))) {
    const a = m[1];
    out.push({
      id: attr(a, 'id'),
      bandwidth: parseInt(attr(a, 'bandwidth'), 10) || 0,
      width: parseInt(attr(a, 'width'), 10) || 0,
      height: parseInt(attr(a, 'height'), 10) || 0,
      codecs: attr(a, 'codecs'),
      mime: attr(a, 'mimeType')
    });
  }
  return out;
}

/** 收集某个 representation 的分片（按编号排序） */
function segmentsFor(repId) {
  const re = new RegExp('^seg-' + repId + '-(\\d+)\\.m4s$');
  return fs.readdirSync(dir)
    .map((f) => {
      const m = f.match(re);
      return m ? { file: f, num: parseInt(m[1], 10) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.num - b.num);
}

/** 某个分片的时长：从 MPD 的 SegmentTimeline 里取，取不到就用平均值兜底 */
function segmentDurations(block) {
  if (!block) return [];
  const timescale = parseInt((block.match(/<SegmentTemplate[^>]*\btimescale="(\d+)"/i) || [])[1], 10) || 0;
  const durs = [];
  const re = /<S\b[^>]*\bd="(\d+)"/gi;
  let m;
  while ((m = re.exec(block))) {
    const d = parseInt(m[1], 10);
    durs.push(timescale ? d / timescale : 0);
  }
  return durs;
}

// ---- 解析各档 ----
const videoIds = [];
const audioIds = [];
const asRe = /<AdaptationSet\b([^>]*)>/gi;
let am;
while ((am = asRe.exec(mpd))) {
  const id = attr(am[1], 'id');
  const type = attr(am[1], 'contentType');
  if (!id) continue;
  if (type === 'video') videoIds.push(id);
  else if (type === 'audio') audioIds.push(id);
}

const videos = [];
videoIds.forEach((id) => {
  const block = adaptationSet(id);
  const reps = repsOf(block);
  if (!reps.length) return;
  const rep = reps[0];
  const segs = segmentsFor(rep.id);
  if (!segs.length) return;
  videos.push({
    area: id,
    repId: rep.id,
    bandwidth: rep.bandwidth,
    width: rep.width,
    height: rep.height,
    codecs: rep.codecs,
    // 每档用自己的初始化段：分辨率/档次必须和分片一致，
    // 否则 MSE 会拒绝追加（isTypeSupported 通过但 appendBuffer 失败）。
    // 命名与 DASH 的 representation id 对应（init-0.mp4 / init-2.mp4 ...），
    // 由 build/hls.ps1 用同参数生成后覆盖。
    init: 'init-' + rep.id + '.mp4',
    segments: segs.map((s) => s.file),
    durations: segmentDurations(block)
  });
});

if (!videos.length) {
  console.error('MPD 里没有可用的视频档');
  process.exit(1);
}

// 低码率在前，播放器按带宽挑档时更好处理
videos.sort((a, b) => a.bandwidth - b.bandwidth);

// ---- 每档写一个媒体播放列表 ----
const targetDur = Math.max(1, Math.round(
  Math.max.apply(null, videos.map((v) => Math.max.apply(null, v.durations.concat([6]))))
));

videos.forEach((v, i) => {
  v.file = 'v' + i + '.m3u8';
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:' + targetDur,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MAP:URI="' + v.init + '"'
  ];
  v.segments.forEach((seg, k) => {
    const d = v.durations[k] || v.durations[v.durations.length - 1] || targetDur;
    lines.push('#EXTINF:' + d.toFixed(3) + ',');
    lines.push(seg);
  });
  lines.push('#EXT-X-ENDLIST');
  fs.writeFileSync(path.join(dir, v.file), lines.join('\n') + '\n', 'utf8');
});

// ---- 主播放列表 ----
const master = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
videos.forEach((v) => {
  master.push(
    '#EXT-X-STREAM-INF:BANDWIDTH=' + v.bandwidth +
    ',RESOLUTION=' + v.width + 'x' + v.height +
    ',CODECS="' + v.codecs + ',mp4a.40.2"'
  );
  master.push(v.file);
});
fs.writeFileSync(path.join(dir, 'index.m3u8'), master.join('\n') + '\n', 'utf8');

console.log('  写好了 index.m3u8 和 ' + videos.length + ' 个媒体播放列表：' +
  videos.map((v) => v.width + 'x' + v.height + '@' + Math.round(v.bandwidth / 1000) + 'k').join(', '));

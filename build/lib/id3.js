/**
 * 极简 ID3v2.3 标签写入器（用于给生成的音频加上歌名/歌手/专辑/封面）
 * ------------------------------------------------------------------
 * 只实现需要的部分：TIT2 / TPE1 / TALB / APIC
 * 文本用 UTF-16LE（带 BOM），中文不会乱码
 */

'use strict';

/** 构造一个文本帧（TIT2 = 标题，TPE1 = 艺术家，TALB = 专辑） */
function textFrame(id, value) {
  const text = Buffer.from('\uFEFF' + String(value), 'utf16le'); // BOM + UTF-16LE
  const body = Buffer.concat([Buffer.from([0x01]), text]);        // 0x01 = UTF-16 with BOM
  const header = Buffer.alloc(10);
  header.write(id, 0, 4, 'ascii');
  header.writeUInt32BE(body.length, 4);
  header.writeUInt16BE(0, 8); // flags
  return Buffer.concat([header, body]);
}

/** 构造封面帧（APIC） */
function pictureFrame(data, mime = 'image/jpeg') {
  const mimeBuf = Buffer.from(mime + '\0', 'latin1');
  const descBuf = Buffer.from([0x00]);            // 空描述（latin1 编码 → 1 字节结束符）
  const body = Buffer.concat([
    Buffer.from([0x00]),   // 文本编码 latin1
    mimeBuf,
    Buffer.from([0x03]),   // 图片类型 3 = 封面
    descBuf,
    data
  ]);
  const header = Buffer.alloc(10);
  header.write('APIC', 0, 4, 'ascii');
  header.writeUInt32BE(body.length, 4);
  header.writeUInt16BE(0, 8);
  return Buffer.concat([header, body]);
}

/** 把标签拼成完整的 ID3v2.3 头 + 帧数据 */
function buildId3({ title, artist, album, cover }) {
  const frames = [];
  if (title) frames.push(textFrame('TIT2', title));
  if (artist) frames.push(textFrame('TPE1', artist));
  if (album) frames.push(textFrame('TALB', album));
  if (cover) frames.push(pictureFrame(cover));

  const body = Buffer.concat(frames);

  // ID3v2.3 头（10 字节），大小用 synchsafe 编码
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 3, 'ascii');
  header[3] = 3;  // 版本 2.3
  header[4] = 0;  // 修订号
  header[5] = 0;  // flags
  const size = body.length;
  header[6] = (size >> 21) & 0x7f;
  header[7] = (size >> 14) & 0x7f;
  header[8] = (size >> 7) & 0x7f;
  header[9] = size & 0x7f;

  return Buffer.concat([header, body]);
}

/** 给一段 MP3 数据加上 ID3 标签，返回新的 Buffer */
function tagMp3(mp3Buffer, meta) {
  return Buffer.concat([buildId3(meta), mp3Buffer]);
}

module.exports = { buildId3, tagMp3, textFrame, pictureFrame };

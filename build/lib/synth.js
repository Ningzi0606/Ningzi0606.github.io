#!/usr/bin/env node
/**
 * 音频合成小工具（供 build/make-demo-tracks.ps1 调用）
 * ------------------------------------------------------------------
 * 用法：
 *   node build/lib/synth.js <输出.wav> <秒数> <随机种子> "110,164.81,220;98,146.83,196"
 *       → 合成一段氛围和弦铺底，写成一个立体声 WAV
 *   node build/lib/synth.js --cover <输出.ppm> <序号>
 *       → 生成一张 320x320 的蓝紫渐变封面（PPM 格式，交给 ffmpeg 转 JPEG）
 *
 * 用来生成免版权的测试音乐，方便验证播放器的多曲目功能。
 */

'use strict';

const fs = require('fs');
const SR = 44100;
const SEG = 5.0;   // 每个和弦持续 5 秒

/** 合成一段氛围乐，返回 WAV Buffer */
function synthWav({ seconds = 40, seed = 1, chords = [] }) {
  const N = Math.floor(SR * seconds);
  const left = new Float32Array(N);
  const right = new Float32Array(N);

  let rnd = seed;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  chords.forEach((notes, ci) => {
    const start = ci * SEG;
    const len = SEG * 1.6;   // 稍作重叠，衔接更顺

    notes.forEach((f, ni) => {
      const detune = 1 + (ni - notes.length / 2) * 0.0016;
      const amp = 0.2 / Math.sqrt(notes.length);
      const offset = ni * 0.22 + rand() * 0.1;

      for (let i = 0; i < N; i++) {
        const t = i / SR;
        const x = t - start - offset;
        if (x < 0 || x > len) continue;
        const atk = Math.min(1, x / 2.0);
        const rel = Math.min(1, (len - x) / 2.4);
        const e = Math.pow(Math.min(atk, rel), 1.5);
        if (e <= 0) continue;

        const ph = 2 * Math.PI * f * detune * t;
        // 基频 + 两个泛音，音色更暖
        const v = Math.sin(ph) * 0.78 + Math.sin(ph * 2) * 0.15 + Math.sin(ph * 3) * 0.05;
        const pan = 0.5 + 0.14 * Math.sin(2 * Math.PI * 0.05 * t + ni + ci);
        left[i] += v * amp * e * pan;
        right[i] += v * amp * e * (1 - pan);
      }
    });
  });

  // 轻混响
  [[0.17, 0.34], [0.31, 0.2], [0.47, 0.11]].forEach(([dly, g]) => {
    const d = Math.floor(dly * SR);
    for (let i = d; i < N; i++) {
      left[i] += left[i - d] * g * 0.3;
      right[i] += right[i - d] * g * 0.3;
    }
  });

  // 淡入淡出，避免爆音
  const fade = 2.0 * SR;
  for (let i = 0; i < N; i++) {
    let g = 1;
    if (i < fade) g = i / fade;
    const tail = N - i;
    if (tail < fade) g *= tail / fade;
    left[i] *= g;
    right[i] *= g;
  }

  // 归一化到 0.85 峰值
  let peak = 0;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const norm = peak > 0 ? 0.85 / peak : 1;

  // 写 16bit PCM 立体声 WAV
  const dataSize = N * 2 * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  let off = 44;
  for (let i = 0; i < N; i++) {
    const l = Math.max(-32768, Math.min(32767, Math.round(left[i] * norm * 32767)));
    const r = Math.max(-32768, Math.min(32767, Math.round(right[i] * norm * 32767)));
    buf.writeInt16LE(l, off); off += 2;
    buf.writeInt16LE(r, off); off += 2;
  }
  return buf;
}

/** 生成蓝紫渐变封面（PPM 二进制格式） */
function makeCover(index) {
  const size = 320;
  const header = Buffer.from(`P6\n${size} ${size}\n255\n`, 'ascii');
  const px = Buffer.alloc(size * size * 3);
  const hue = index * 2.1;
  let p = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x / size + y / size) / 2;
      const r = Math.round(60 + 120 * t + 30 * Math.sin(hue + x / 40));
      const g = Math.round(50 + 60 * t + 20 * Math.sin(hue + y / 60));
      const b = Math.round(140 + 90 * (1 - t) + 25 * Math.cos(hue + x / 50));
      px[p++] = Math.max(0, Math.min(255, r));
      px[p++] = Math.max(0, Math.min(255, g));
      px[p++] = Math.max(0, Math.min(255, b));
    }
  }
  return Buffer.concat([header, px]);
}

/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);

if (argv[0] === '--cover') {
  const dest = argv[1];
  const idx = Number(argv[2]) || 1;
  fs.writeFileSync(dest, makeCover(idx));
  console.log(`封面已生成 ${dest}`);
} else {
  const [dest, seconds, seed, chordStr] = argv;
  if (!dest || !chordStr) {
    console.error('用法: node build/lib/synth.js <输出.wav> <秒数> <种子> "110,164;98,146"');
    process.exit(1);
  }
  const chords = chordStr.split(';').map((c) => c.split(',').map(Number).filter((n) => n > 0));
  const buf = synthWav({ seconds: Number(seconds) || 40, seed: Number(seed) || 1, chords });
  fs.writeFileSync(dest, buf);
  console.log(`已合成 ${dest}（${(buf.length / 1024 / 1024).toFixed(1)} MB）`);
}

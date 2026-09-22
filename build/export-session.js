/**
 * 把 DSH 会话日志导出成可读的纯文本对话记录
 * ------------------------------------------------------------------
 * DSH 用「多帧 zstd 追加写」保存会话，一次 zstdDecompress 只能拿到第一帧，
 * 所以这里先按魔数 28 b5 2f fd 扫描帧边界，逐帧解压再拼接。
 *
 * 用法:
 *   node build/export-session.js <session.v3.jsonl.zstd> <输出.txt>
 * 不传参数时自动找 ~/.dsh/sessions 下最新的会话。
 */

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const os = require('os');

function findLatest() {
  const base = path.join(os.homedir(), '.dsh', 'sessions');
  if (!fs.existsSync(base)) return null;
  let newest = null;
  for (const ws of fs.readdirSync(base)) {
    const wsDir = path.join(base, ws);
    if (!fs.statSync(wsDir).isDirectory()) continue;
    for (const s of fs.readdirSync(wsDir)) {
      const f = path.join(wsDir, s, 'session.v3.jsonl.zstd');
      if (fs.existsSync(f)) {
        const m = fs.statSync(f).mtimeMs;
        if (!newest || m > newest.m) newest = { f, m, id: s };
      }
    }
  }
  return newest;
}

const src = process.argv[2] || (findLatest() || {}).f;
const dst = process.argv[3] || path.join(process.cwd(), '对话记录导出.txt');
if (!src || !fs.existsSync(src)) {
  console.error('找不到会话文件，请把路径作为第一个参数传入。');
  process.exit(1);
}

const buf = fs.readFileSync(src);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// 扫描 zstd 帧边界
const starts = [];
let i = 0;
while (i + 4 <= buf.length) {
  const idx = buf.indexOf(MAGIC, i);
  if (idx < 0) break;
  starts.push(idx);
  i = idx + 4;
}
starts.push(buf.length);

const parts = [];
let failed = 0;
for (let k = 0; k < starts.length - 1; k++) {
  try {
    parts.push(zlib.zstdDecompressSync(buf.slice(starts[k], starts[k + 1])));
  } catch (e) {
    failed++;
  }
}

const lines = Buffer.concat(parts).toString('utf8').split('\n').filter((l) => l.trim());

/* ---------------------------------------------------------------- */

const body = [];
let userCount = 0;
let aiCount = 0;
let toolCount = 0;
let sessionMeta = null;
let firstTime = 0;
let lastTime = 0;

/** 把 content 数组里的文本/思考/工具调用拼成可读字符串 */
function textsOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    // 只导出面向用户的正文，跳过内部推理（reasoning）
    if (c.type === 'text' && typeof c.text === 'string' && c.text) parts.push(c.text);
    else if (c.type === 'tool-call' || c.type === 'tool_use') parts.push(`[调用工具] ${c.name || c.toolName || ''}`);
    else if (typeof c.text === 'string' && c.text && c.type === undefined) parts.push(c.text);
  }
  return parts.join('\n');
}

const records = [];
for (const l of lines) {
  let o;
  try { o = JSON.parse(l); } catch (e) { continue; }
  if (o.type === 'session') { sessionMeta = o; continue; }
  if (o.time) { if (!firstTime) firstTime = o.time; lastTime = o.time; }
  records.push(o);
}

for (const o of records) {
  const d = o.data || {};

  if (o.type === 'user/message' || o.type === 'agent/inbox/spliced') {
    let msg = d;
    if (o.type === 'agent/inbox/spliced' && Array.isArray(d.inserted)) {
      for (const ins of d.inserted) {
        const t = textsOf(ins.content);
        if (t) { userCount++; body.push('## 我'); body.push(''); body.push(t); body.push(''); }
      }
      continue;
    }
    const t = textsOf(msg.content) || d.text || '';
    if (t) { userCount++; body.push('## 我'); body.push(''); body.push(t); body.push(''); }
    continue;
  }

  if (o.type === 'assistant/message') {
    // 结构：data.message.content[] ，元素形如 {type:'text'|'reasoning'|'tool-call'}
    const content = (d.message && d.message.content) || d.content || d.text || '';
    const t = textsOf(content);
    if (t && t.trim()) {
      aiCount++;
      body.push('## AI');
      body.push('');
      body.push(t);
      body.push('');
    }
    continue;
  }

  if (o.type === 'tool/call') {
    toolCount++;
    const name = d.name || d.toolName || '工具';
    let arg = '';
    const a = d.arguments || d.input || d.args;
    if (a) arg = typeof a === 'string' ? a : JSON.stringify(a);
    body.push(`> 调用工具：**${name}**` + (arg ? `　\`${arg.slice(0, 220)}\`` : ''));
    continue;
  }
}

const header = [];
header.push('# DSH 对话记录导出');
header.push('');
if (sessionMeta) {
  header.push(`会话 ID：${sessionMeta.id}`);
  header.push(`工作目录：${sessionMeta.cwd}`);
  header.push(`创建时间：${new Date(sessionMeta.createdAt).toLocaleString('zh-CN')}`);
}
header.push(`来源文件：${src}`);
header.push(`解压帧数：${starts.length - 1}（失败 ${failed}）　记录数：${lines.length}`);
if (firstTime) {
  header.push(`时间跨度：${new Date(firstTime).toLocaleString('zh-CN')} ~ ${new Date(lastTime).toLocaleString('zh-CN')}`);
}
header.push('');
header.push(`消息统计：我 ${userCount} 条　AI ${aiCount} 条　工具调用 ${toolCount} 次`);
header.push('');
header.push('─'.repeat(60));
header.push('');

fs.writeFileSync(dst, header.concat(body).join('\n'), 'utf8');
console.log(`导出完成：${dst}`);
console.log(`帧 ${starts.length - 1} 个（失败 ${failed}）｜我 ${userCount} 条｜AI ${aiCount} 条｜工具 ${toolCount} 次`);
console.log(`大小：${(fs.statSync(dst).size / 1024).toFixed(0)} KB`);

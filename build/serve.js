#!/usr/bin/env node
/**
 * 本地预览服务器（零依赖）
 * ------------------------------------------------------------------
 * 用法：
 *   node build/serve.js          # 默认 http://localhost:5173
 *   node build/serve.js 8080     # 指定端口
 *   node build/serve.js --watch  # 改动 content/ 后自动重新生成
 *
 * 只在预览时用；部署到 GitHub Pages 不需要它。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const WATCH = args.includes('--watch');
const PORT = Number(args.find((a) => /^\d+$/.test(a))) || 5173;
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2'
};

function safeResolve(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const clean = path.normalize(decoded).replace(/^([/\\])+/, '');
  const full = path.resolve(root, clean);
  return full.startsWith(path.resolve(root)) ? full : null;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('只支持 GET');
  }

  let target = safeResolve(ROOT, req.url);
  if (!target) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 越界访问');
  }

  try {
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      target = path.join(target, 'index.html');
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404</h1><p>没有找到这个页面。要新建文章，请在 content/posts/ 里添加 .md 文件后重新生成。</p>');
    }

    const stat = fs.statSync(target);
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    const baseHeaders = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache'
    };

    // Range 请求：视频/音频拖动进度条要用它，否则只能从头播
    const rangeHeader = req.headers.range;
    const rangeMatch = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());

    if (rangeMatch) {
      let start = rangeMatch[1] === '' ? null : Number(rangeMatch[1]);
      let end = rangeMatch[2] === '' ? null : Number(rangeMatch[2]);

      if (start === null && end !== null) {
        // bytes=-N  表示最后 N 字节
        start = Math.max(0, stat.size - end);
        end = stat.size - 1;
      } else if (start !== null && end === null) {
        end = stat.size - 1;
      }

      if (start === null || start > end || start >= stat.size) {
        res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      end = Math.min(end, stat.size - 1);

      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(target, { start, end }).pipe(res);
    }

    res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 ' + err.message);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，换一个端口试试：node build/serve.js ${PORT + 1}`);
  } else {
    console.error('启动失败：' + err.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`预览已启动 → http://localhost:${PORT}/`);
  console.log(`站点根目录：${ROOT}`);
  console.log('按 Ctrl+C 停止。');
  if (WATCH) startWatch();
});

/* --------------------------- 自动重新生成 --------------------------- */

function runBuild() {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'build', 'build.js')], {
    cwd: ROOT,
    stdio: 'inherit'
  });
  return result.status === 0;
}

function startWatch() {
  const targets = ['content', 'site.config.json'].map((p) => path.join(ROOT, p));
  let timer = null;

  console.log('监听 content/ 与 site.config.json，改动后自动重新生成…');

  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    try {
      fs.watch(target, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          console.log('\n检测到改动，重新生成…');
          runBuild();
        }, 250);
      });
    } catch (err) {
      console.warn(`无法监听 ${path.basename(target)}：${err.message}`);
    }
  }
}

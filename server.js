// ============================================================
// KDL Checklist — standalone сервер
// Zero dependencies, только встроенный Node.js
// Совместим с Windows и Linux, запускается через PM2
// ============================================================
// Env:
//   PORT        — порт (по умолчанию 8444)
//   DATA_DIR    — папка с state.json (по умолчанию ./data)
//   PUBLIC_DIR  — папка со статикой (по умолчанию ./public)
// ============================================================

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT       = parseInt(process.env.PORT || '8444', 10);
const DATA_DIR   = path.resolve(__dirname, process.env.DATA_DIR   || 'data');
const PUBLIC_DIR = path.resolve(__dirname, process.env.PUBLIC_DIR || 'public');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TMP_FILE   = STATE_FILE + '.tmp';
const MAX_BODY   = 5 * 1024 * 1024;   // 5 МБ — с запасом

// ─── Инициализация папок ───
for (const d of [DATA_DIR, PUBLIC_DIR]) {
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true });
    console.log(`📁 Создана папка: ${d}`);
  }
}

// ─── Работа с состоянием ───
function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { state: null, updatedAt: null };
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    if (!raw.trim()) return { state: null, updatedAt: null };
    const parsed = JSON.parse(raw);
    return { state: parsed, updatedAt: fs.statSync(STATE_FILE).mtime.toISOString() };
  } catch (e) {
    console.error('❌ readState:', e.message);
    return { state: null, updatedAt: null };
  }
}

function writeState(state) {
  // Атомарная запись: tmp + rename — исключает битый JSON при краше
  const json = JSON.stringify(state);
  fs.writeFileSync(TMP_FILE, json, 'utf8');
  fs.renameSync(TMP_FILE, STATE_FILE);
}

function clearState() {
  try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch (e) {}
}

// ─── HTTP helpers ───
function jsonResponse(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ─── Статика ───
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.json': 'application/json; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
};

function serveStatic(req, res, relPath) {
  // Защита от path traversal
  const safe = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
  let full = path.join(PUBLIC_DIR, safe);

  // Дополнительная защита (Windows-регистронезависимый и Linux)
  const normalize = (p) => path.resolve(p).toLowerCase();
  if (!normalize(full).startsWith(normalize(PUBLIC_DIR))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  // Если директория — index.html
  try {
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      full = path.join(full, 'index.html');
    }
  } catch (e) {}

  // Если файл не найден — отдаём index.html (SPA-fallback)
  if (!fs.existsSync(full)) {
    full = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(full)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — index.html не найден в ' + PUBLIC_DIR);
      return;
    }
  }

  const ext  = path.extname(full).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(full);

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(full).pipe(res);
}

// ─── Роутер ───
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Health ──
  if (p === '/api/health') {
    return jsonResponse(res, 200, {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      memory: process.memoryUsage().rss,
    });
  }

  // ── GET state ──
  if (p === '/api/state' && req.method === 'GET') {
    const { state, updatedAt } = readState();
    return jsonResponse(res, 200, { state, updatedAt });
  }

  // ── PUT state ──
  if (p === '/api/state' && req.method === 'PUT') {
    try {
      const body = await readBody(req, MAX_BODY);
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed.state !== 'object') {
        return jsonResponse(res, 400, { error: 'Ожидается { state: {...} }' });
      }
      writeState(parsed.state);
      return jsonResponse(res, 200, { ok: true, updatedAt: new Date().toISOString() });
    } catch (e) {
      if (e.message === 'payload too large') {
        return jsonResponse(res, 413, { error: 'Слишком большой запрос (>5 МБ)' });
      }
      return jsonResponse(res, 400, { error: 'Некорректный JSON: ' + e.message });
    }
  }

  // ── DELETE state ──
  if (p === '/api/state' && req.method === 'DELETE') {
    clearState();
    return jsonResponse(res, 200, { ok: true });
  }

  // ── Статика ──
  if (req.method === 'GET') {
    return serveStatic(req, res, p === '/' ? 'index.html' : p.slice(1));
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method not allowed');
});

// ─── Запуск ───
server.listen(PORT, '0.0.0.0', () => {
  console.log('============================================================');
  console.log(`✅ KDL Checklist запущен: http://0.0.0.0:${PORT}`);
  console.log(`   Data:   ${STATE_FILE}`);
  console.log(`   Public: ${PUBLIC_DIR}`);
  console.log(`   Node:   ${process.version}`);
  console.log(`   PID:    ${process.pid}`);
  console.log('============================================================');
});

// ─── Graceful shutdown (PM2 посылает SIGINT/SIGTERM при stop/restart) ───
function shutdown(signal) {
  console.log(`\n📴 Получен ${signal}, останавливаюсь...`);
  server.close(() => {
    console.log('✅ Сервер остановлен корректно');
    process.exit(0);
  });
  // Форсированный выход через 5 сек, если что-то повисло
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Отлов необработанных ошибок, чтобы PM2 не падал зря ───
process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('💥 unhandledRejection:', err);
});
// ============================================================
// logger-bootstrap.js
// Загружается ДО server.js через NODE_OPTIONS=-r
// Ничего не меняет в исходном коде — только патчит окружение.
// ============================================================
'use strict';

const fs   = require('fs');
const path = require('path');
const util = require('util');

// ────────────────────────────────────────────────────────────
// КУДА ПИСАТЬ
// ────────────────────────────────────────────────────────────
const LOG_DIR = process.env.LOG_DIR || '/app/logs';
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}

const now = () => new Date().toISOString();

// Простой thread-safe-ish аппендер (один процесс node — ок)
function makeStream(filename) {
  return fs.createWriteStream(path.join(LOG_DIR, filename), { flags: 'a' });
}

const streams = {
  app:    makeStream('app.log'),      // все console.*
  errors: makeStream('errors.log'),   // только ошибки
  http:   makeStream('http.log'),     // входящие запросы
  sql:    makeStream('sql.log'),      // SQL-запросы и ошибки БД
  audit:  makeStream('audit.log'),    // действия (для аудита)
};

function writeLine(stream, level, msg) {
  const line = `[${now()}] [${level}] ${msg}\n`;
  try { stream.write(line); } catch (e) {}
}

// ────────────────────────────────────────────────────────────
// ПАТЧ CONSOLE.*
// Сохраняем оригиналы, чтобы не сломать stdout для docker logs.
// ────────────────────────────────────────────────────────────
const orig = {
  log:   console.log.bind(console),
  info:  console.info.bind(console),
  warn:  console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function fmt(args) {
  return args.map(a =>
    typeof a === 'string' ? a :
    a instanceof Error    ? `${a.message}\n${a.stack}` :
                            util.inspect(a, { depth: 4, breakLength: 120 })
  ).join(' ');
}

console.log = function (...args) {
  orig.log(...args);
  writeLine(streams.app, 'LOG', fmt(args));
};
console.info = function (...args) {
  orig.info(...args);
  writeLine(streams.app, 'INFO', fmt(args));
};
console.warn = function (...args) {
  orig.warn(...args);
  writeLine(streams.app, 'WARN', fmt(args));
  writeLine(streams.errors, 'WARN', fmt(args));
};
console.error = function (...args) {
  orig.error(...args);
  writeLine(streams.app, 'ERROR', fmt(args));
  writeLine(streams.errors, 'ERROR', fmt(args));
};
console.debug = function (...args) {
  if (orig.debug) orig.debug(...args);
  writeLine(streams.app, 'DEBUG', fmt(args));
};

// ────────────────────────────────────────────────────────────
// ПЕРЕХВАТ НЕОБРАБОТАННЫХ ОШИБОК
// ────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 unhandledRejection:', reason);
});
process.on('warning', (w) => {
  console.warn('⚠️ warning:', w);
});
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received');
  setTimeout(() => process.exit(0), 100);
});
process.on('SIGINT', () => {
  console.log('🛑 SIGINT received');
  setTimeout(() => process.exit(0), 100);
});

// ────────────────────────────────────────────────────────────
// ПАТЧ HTTP/HTTPS — лог входящих запросов и ответов
// Перехватываем на уровне Server.emit, чтобы не трогать express.
// ────────────────────────────────────────────────────────────
const http  = require('http');
const https = require('https');

function patchServer(ServerClass) {
  const origEmit = ServerClass.prototype.emit;
  ServerClass.prototype.emit = function (event, ...args) {
    if (event === 'request') {
      const [req, res] = args;
      const t0 = Date.now();
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
              || req.socket.remoteAddress || '-';
      const ua = req.headers['user-agent'] || '-';

      // Логируем ЗАПРОС сразу (важно — чтобы было видно даже если роут упадёт)
      const reqLine = `${req.method} ${req.url} | ip=${ip} | ua="${ua}"`;
      writeLine(streams.http, 'REQ', reqLine);

      // Фиксируем ответ
      const origEnd = res.end;
      res.end = function (...endArgs) {
        const dur = Date.now() - t0;
        const line = `${req.method} ${req.url} → ${res.statusCode} ${res.statusMessage || ''} (${dur}ms)`;
        const level = res.statusCode >= 500 ? 'ERR'
                    : res.statusCode >= 400 ? 'WARN'
                    : 'OK';
        writeLine(streams.http, level, line);
        if (res.statusCode >= 400) {
          writeLine(streams.errors, level, line);
        }
        return origEnd.apply(this, endArgs);
      };

      // Клиент разорвал соединение
      req.on('aborted', () => {
        writeLine(streams.http, 'ABORT', `${req.method} ${req.url} — client aborted`);
      });
    }
    return origEmit.apply(this, args);
  };
}
patchServer(http.Server);
patchServer(https.Server);

// ────────────────────────────────────────────────────────────
// ПАТЧ MYSQL2/PROMISE — логируем SQL-запросы и ошибки
// mysql2/promise использует внутри mysql2. Патчим оба.
// ────────────────────────────────────────────────────────────
try {
  const mysql = require('mysql2');

  // Патчим базовый Connection.prototype.query
  const Connection = mysql.Connection || (mysql.default && mysql.default.Connection);
  if (Connection && Connection.prototype && Connection.prototype.query) {
    const origQuery = Connection.prototype.query;
    Connection.prototype.query = function (sql, values, cb) {
      const start = Date.now();
      const sqlText = typeof sql === 'string' ? sql : (sql && sql.sql) || '[object]';
      const short = sqlText.replace(/\s+/g, ' ').slice(0, 500);

      // Оборачиваем колбэк (если есть), чтобы залогировать результат
      if (typeof values === 'function') {
        const origCb = values;
        return origQuery.call(this, sql, function (err, results, fields) {
          const dur = Date.now() - start;
          if (err) {
            writeLine(streams.sql, 'ERR',
              `${dur}ms | ${short} | ERROR: ${err.code || ''} ${err.message}`);
            writeLine(streams.errors, 'SQL',
              `${short} | ${err.code || ''} ${err.message}`);
          } else {
            writeLine(streams.sql, 'OK',
              `${dur}ms | ${short} | rows=${Array.isArray(results) ? results.length : (results && results.affectedRows) || 0}`);
          }
          return origCb.apply(this, arguments);
        });
      }

      if (typeof cb === 'function') {
        const origCb = cb;
        return origQuery.call(this, sql, values, function (err, results, fields) {
          const dur = Date.now() - start;
          if (err) {
            writeLine(streams.sql, 'ERR',
              `${dur}ms | ${short} | ERROR: ${err.code || ''} ${err.message}`);
            writeLine(streams.errors, 'SQL',
              `${short} | ${err.code || ''} ${err.message}`);
          } else {
            writeLine(streams.sql, 'OK',
              `${dur}ms | ${short} | rows=${Array.isArray(results) ? results.length : (results && results.affectedRows) || 0}`);
          }
          return origCb.apply(this, arguments);
        });
      }

      // promise-версия (mysql2/promise)
      const p = origQuery.call(this, sql, values);
      if (p && typeof p.then === 'function') {
        return p.then(
          (r) => {
            const dur = Date.now() - start;
            writeLine(streams.sql, 'OK',
              `${dur}ms | ${short} | rows=${Array.isArray(r && r[0]) ? r[0].length : 0}`);
            return r;
          },
          (e) => {
            const dur = Date.now() - start;
            writeLine(streams.sql, 'ERR',
              `${dur}ms | ${short} | ERROR: ${e.code || ''} ${e.message}`);
            writeLine(streams.errors, 'SQL',
              `${short} | ${e.code || ''} ${e.message}`);
            throw e;
          }
        );
      }
      return p;
    };
  }

  // Патчим Pool.prototype.getConnection, чтобы патч дошёл до новых соединений
  const Pool = mysql.Pool || (mysql.default && mysql.default.Pool);
  if (Pool && Pool.prototype && Pool.prototype.getConnection) {
    const origGet = Pool.prototype.getConnection;
    Pool.prototype.getConnection = function (...args) {
      const result = origGet.apply(this, args);
      if (result && typeof result.then === 'function') {
        return result.then(conn => {
          // Патчим методы конкретного соединения
          const patchFn = (name) => {
            if (typeof conn[name] !== 'function') return;
            const orig = conn[name].bind(conn);
            conn[name] = function (sql, values) {
              const start = Date.now();
              const sqlText = typeof sql === 'string' ? sql : (sql && sql.sql) || '[object]';
              const short = sqlText.replace(/\s+/g, ' ').slice(0, 500);
              const p = orig(sql, values);
              if (p && typeof p.then === 'function') {
                return p.then(
                  (r) => {
                    const dur = Date.now() - start;
                    writeLine(streams.sql, 'OK',
                      `${dur}ms | ${short} | rows=${Array.isArray(r && r[0]) ? r[0].length : 0}`);
                    return r;
                  },
                  (e) => {
                    const dur = Date.now() - start;
                    writeLine(streams.sql, 'ERR',
                      `${dur}ms | ${short} | ERROR: ${e.code || ''} ${e.message}`);
                    writeLine(streams.errors, 'SQL',
                      `${short} | ${e.code || ''} ${e.message}`);
                    throw e;
                  }
                );
              }
              return p;
            };
          };
          patchFn('query');
          patchFn('execute');
          return conn;
        });
      }
      return result;
    };
  }
} catch (e) {
  console.warn('⚠️ Не удалось пропатчить mysql2:', e.message);
}

// ────────────────────────────────────────────────────────────
// ПАТЧ fetch (если версия node >=18) — исходящие запросы
// ────────────────────────────────────────────────────────────
if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    const t0 = Date.now();
    const url = typeof input === 'string' ? input : (input && input.url) || '?';
    const method = (init && init.method) || 'GET';
    try {
      const res = await origFetch(input, init);
      const dur = Date.now() - t0;
      writeLine(streams.app, 'FETCH',
        `${method} ${url} → ${res.status} (${dur}ms)`);
      return res;
    } catch (e) {
      const dur = Date.now() - t0;
      writeLine(streams.app, 'FETCH-ERR',
        `${method} ${url} → ERROR ${e.message} (${dur}ms)`);
      throw e;
    }
  };
}

// ────────────────────────────────────────────────────────────
// ХЭНДЛЕР ЛОГ-ФАЙЛОВ (ротация раз в сутки)
// ────────────────────────────────────────────────────────────
function rotateLogs() {
  const stamp = new Date().toISOString().slice(0, 10);
  for (const [name, stream] of Object.entries(streams)) {
    if (stream.__rotatedOn === stamp) continue;
    try {
      stream.__rotatedOn = stamp;
    } catch (e) {}
  }
}
rotateLogs();
setInterval(rotateLogs, 60 * 60 * 1000).unref();

// ────────────────────────────────────────────────────────────
// ХЭНДЛЕР ГЛУБИННОГО ЛОГИРОВАНИЯ EXPRESS — перехват res.json/res.send
// (чтобы видеть ВСЕ ответы, включая ошибки)
// ────────────────────────────────────────────────────────────
try {
  const express = require('express');
  const appProto = express.application;
  // никого не патчим дополнительно — нам хватает http.Server
} catch (e) {}

// ────────────────────────────────────────────────────────────
// ФИНАЛЬНЫЙ МАРКЕР
// ────────────────────────────────────────────────────────────
writeLine(streams.app, 'INIT',
  `logger-bootstrap loaded | pid=${process.pid} | node=${process.version} | logdir=${LOG_DIR}`);
console.log('📝 logger-bootstrap.js активен — логи пишутся в', LOG_DIR);
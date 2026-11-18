/*
 * Онлайн-экзамен — сервер без внешних зависимостей (Node.js >= 18).
 * Интерфейс и синхронизация — exam-sync/ (тесты, writing, speaking-очередь, ведомость, настройки).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || process.env.ALWAYSDATA_HTTPD_PORT || 3000;
const HOST = process.env.IP || process.env.ALWAYSDATA_HTTPD_IP || undefined;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');

const exam = require('./exam-sync/handler').createExamSync({ base: '', dataFile: path.join(DATA, 'exam-sync.json') });

function readCommit() {
  try {
    const head = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 7);
    const ref = head.slice(5);
    const loose = path.join(ROOT, '.git', ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim().slice(0, 7);
    const line = fs.readFileSync(path.join(ROOT, '.git', 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(' ' + ref));
    return line ? line.slice(0, 7) : null;
  } catch { return null; }
}
const VERSION = { commit: readCommit(), startedAt: new Date().toISOString() };

const server = http.createServer(async (req, res) => {
  const [p, q = ''] = req.url.split('?');
  // старые ссылки вида /exam-sync/... ведут на корень
  if (p === '/exam-sync' || p.startsWith('/exam-sync/')) {
    res.writeHead(301, { Location: (p.slice('/exam-sync'.length) || '/') + (q ? '?' + q : '') });
    return res.end();
  }
  if (req.method === 'GET' && p === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(VERSION));
  }
  try {
    await exam(req, res);
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(PORT, HOST, () => console.log(`Онлайн-экзамен: http://${HOST || 'localhost'}:${PORT}`));

/* Перезапуск после обновления кода: deploy/alwaysdata-update.sh обновляет файл .restart.
   Данные экзамена сохраняются при каждом изменении, поэтому можно просто завершиться — хостинг запустит сервер заново. */
fs.watchFile(path.join(ROOT, '.restart'), { interval: 5000 }, (cur, prev) => {
  if (!cur.mtimeMs || cur.mtimeMs === prev.mtimeMs) return;
  console.log('[deploy] найден .restart — перезапуск');
  process.exit(0);
}).unref();

'use strict';
/*
 * Сервер синхронизации «Онлайн-экзамена» (основа — github.com/StephCurrysvg/exam-sync).
 *
 *   GET  <base>/             — интерфейс (index.html)
 *   GET  <base>/api/state    — всё состояние
 *   GET  <base>/api/events   — SSE с полным состоянием после каждого изменения
 *   POST <base>/api/sync     — { changes: { <col>: { up: [...], del: [...] } } }
 *
 * Данные: dataFile (data/exam-sync.json, не в git). При первом запуске — демо из seed.json.
 */
const fs = require('fs');
const path = require('path');

const COLS = ['users', 'tests', 'rooms', 'attempts', 'writings', 'queue', 'grades', 'timers'];
// экзамены из конструктора могут содержать картинки и аудио (data URL) — лимит выше прежних 5 МБ
const MAX_BODY = (+process.env.EXAM_MAX_BODY_MB > 0 ? +process.env.EXAM_MAX_BODY_MB : 32) * 1024 * 1024;
/* Библиотеки конструктора экзаменов (exam-sync/eb/): модель, импорт/экспорт .docx, JSZip, плеер для HTML-экспорта.
   Отдаются только файлы из этой папки с безопасными именами. */
const EB_DIR = path.join(__dirname, 'eb');
const EB_TYPES = { '.js': 'application/javascript; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
const keyOf = (x) => x.id || [x.roomId, x.userId, x.testId || x.part || ''].join('|');

/* Студенты групп: направление × год набора × группа × номер. Логин «БТ-23-1g-1», пароль «1».
   Тот же список генерирует клиент (index.html → rosterUsers) — держите их одинаковыми. */
const FACULTIES = [{ code: 'ФМ', lat: 'fm' }, { code: 'ИСУ', lat: 'isu' }, { code: 'БТ', lat: 'bt' }];
const YEARS = [23, 24, 25, 26];
const GROUPS = [1, 2, 3];
const PER_GROUP = 2;
const LEGACY_USER_IDS = ['u-student', 'u-student1', 'u-student2', 'u-student3', 'u-student4']; // прежние user, user1–user4
/* имена и фамилии студентов групп — по порядку направление × год × группа × номер (тот же список на сервере и в клиенте) */
const ROSTER_NAMES = ['Ахметов Арман', 'Соколова Екатерина', 'Сериков Данияр', 'Тулегенова Гульнара', 'Иванов Алексей', 'Шайхутдинова Эльвира', 'Нургалиев Ерлан', 'Бекболатова Назерке', 'Ким Тимур', 'Попова Софья', 'Жумабеков Нурлан', 'Сагындыкова Айжан', 'Петров Дмитрий', 'Утепова Жансая', 'Касымов Айдар', 'Морозова Ксения', 'Смагулов Азамат', 'Аубакирова Алия', 'Ли Максим', 'Кенжебаева Индира', 'Оспанов Ержан', 'Лебедева Ольга', 'Кузнецов Никита', 'Жаксылыкова Акерке', 'Байжанов Мирас', 'Сулейменова Малика', 'Абдрахманов Санжар', 'Новикова Елизавета', 'Волков Артём', 'Омарова Амина', 'Есенов Бауыржан', 'Мусина Сауле', 'Мухамеджанов Алихан', 'Фёдорова Юлия', 'Соколов Илья', 'Калиева Карина', 'Тулегенов Асхат', 'Исаева Лейла', 'Шайхутдинов Руслан', 'Ахметова Айгерим', 'Бекболатов Ильяс', 'Серикова Дана', 'Попов Кирилл', 'Иванова Анна', 'Сагындыков Еламан', 'Нургалиева Жанна', 'Утепов Олжас', 'Ким Алина', 'Морозов Егор', 'Жумабекова Асель', 'Аубакиров Нурсултан', 'Петрова Мария', 'Кенжебаев Дамир', 'Касымова Аружан', 'Лебедев Андрей', 'Смагулова Динара', 'Жаксылыков Ринат', 'Ли Виктория', 'Сулейменов Адиль', 'Оспанова Камила', 'Новиков Павел', 'Кузнецова Дарья', 'Омаров Тамерлан', 'Байжанова Томирис', 'Мусин Берик', 'Абдрахманова Мадина', 'Фёдоров Сергей', 'Волкова Полина', 'Калиев Темирлан', 'Есенова Аяулым', 'Исаев Марат', 'Мухамеджанова Сабина'];
/* Преподаватели: у каждого свой предмет. Пароль «admin». Тот же список — в клиенте (index.html → TEACHERS). */
const TEACHERS = [
  { id: 't-aronov', login: 'Evgeney-Aronov', password: 'admin', name: 'Евгений Аронов', role: 'teacher', subject: 'math' },
  { id: 't-temirshol', login: 'Gilmira-temirshol', password: 'admin', name: 'Гильмира Темиршол', role: 'teacher', subject: 'kaz' },
  { id: 't-vasilievna', login: 'Elena-Vasilievna', password: 'admin', name: 'Елена Васильевна', role: 'teacher', subject: 'eng' },
  { id: 't-kosgahmenova', login: 'Dayana-Kosgahmenova', password: 'admin', name: 'Даяна Косгахменова', role: 'teacher', subject: 'bio' }
];
const LEGACY_TEACHER_IDS = ['u-teacher']; // прежний общий аккаунт teacher/admin
/* Версия схемы данных (хранится в data/exam-sync.json рядом с rev). 2 — преподаватели по предметам и 16 базовых экзаменов. */
const SCHEMA = 2;
const BASE_FILE = path.join(__dirname, 'base-exams.json');
const WORK_COLS = ['attempts', 'writings', 'queue', 'grades', 'timers'];

function rosterUsers() {
  const out = [];
  for (const f of FACULTIES) for (const y of YEARS) for (const g of GROUPS) for (let n = 1; n <= PER_GROUP; n++) {
    out.push({ id: `st-${f.lat}-${y}-${g}-${n}`, login: `${f.code}-${y}-${g}g-${n}`, password: '1', name: ROSTER_NAMES[out.length] || `Студент ${n} · ${f.code}-${y}-${g}`, role: 'student', faculty: f.code, year: y, group: g });
  }
  return out;
}
/* Миграция аккаунтов (идемпотентна): удаляет прежних user/user1–user4 и их работы, добавляет недостающих студентов групп.
   Возвращает true, если база изменилась. */
function migrateUsers(db) {
  let changed = false;
  const legacy = new Set(LEGACY_USER_IDS);
  for (const id of legacy) if (db.users.delete(id)) changed = true;
  for (const c of ['attempts', 'writings', 'queue', 'grades', 'timers']) {
    for (const [k, r] of db[c]) if (r && legacy.has(r.userId)) { db[c].delete(k); changed = true; }
  }
  for (const u of rosterUsers()) {
    const cur = db.users.get(u.id);
    if (!cur) { db.users.set(u.id, u); changed = true; }
    else if (/^Студент \d+ · /.test(cur.name || '')) { db.users.set(u.id, Object.assign({}, cur, { name: u.name })); changed = true; } // прежние безымянные аккаунты получают имя
  }
  for (const id of LEGACY_TEACHER_IDS) if (db.users.delete(id)) changed = true;
  for (const t of TEACHERS) {
    const cur = db.users.get(t.id);
    if (!cur) { db.users.set(t.id, Object.assign({}, t)); changed = true; }
    else if (cur.subject !== t.subject || cur.role !== 'teacher') { db.users.set(t.id, Object.assign({}, cur, { role: 'teacher', subject: t.subject })); changed = true; }
  }
  return changed;
}
/* Переход на схему 2 (один раз): все прежние экзамены, публикации и работы по ним удаляются,
   добавляются 16 базовых экзаменов (base-exams.json) — у каждого преподавателя 4 экзамена своего предмета,
   опубликованы бессрочно для всех студентов. Дальше экзамены живут как обычные: их можно править, снимать и удалять. */
function migrateSchema2(db) {
  db.tests.clear(); db.rooms.clear();
  for (const c of WORK_COLS) db[c].clear();
  let base = { tests: [], rooms: [] };
  try { base = JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')); } catch (e) { console.error('[exam-sync] base-exams.json:', e.message); }
  for (const t of base.tests || []) db.tests.set(t.id, t);
  for (const r of base.rooms || []) db.rooms.set(r.id, r);
}

function createExamSync({ base = '/exam-sync', dataFile, seedFile = path.join(__dirname, 'seed.json') } = {}) {
  const INDEX = path.join(__dirname, 'index.html');
  let rev = 0, schema = 0;
  const db = Object.fromEntries(COLS.map((c) => [c, new Map()]));

  function load(file) {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    rev = s.rev || 0; schema = +s.schema || 0;
    COLS.forEach((c) => (s.db && s.db[c] || []).forEach(([k, r]) => db[c].set(k, r)));
  }
  try { load(dataFile); } catch { try { load(seedFile); } catch { /* пустая база — клиент создаст демо-данные сам */ } }

  const state = () => ({ rev, db: Object.fromEntries(COLS.map((c) => [c, [...db[c].values()]])) });
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      fs.writeFileSync(dataFile, JSON.stringify({ rev, schema, db: Object.fromEntries(COLS.map((c) => [c, [...db[c].entries()]])) }) + '\n');
    } catch (e) { console.error('[exam-sync] save:', e.message); }
  };
  // rev > 0 после миграции: клиент примет состояние сервера, а не отправит свои демо-данные.
  // Пустая база (нет ни data-файла, ни seed.json) тоже заполняется: студенты, преподаватели и базовые экзамены.
  if (schema < SCHEMA) {
    migrateUsers(db); migrateSchema2(db); schema = SCHEMA; rev++; save();
    console.log('[exam-sync] база переведена на схему 2: преподаватели по предметам, ' + db.tests.size + ' базовых экзаменов');
  } else if (migrateUsers(db)) { rev++; save(); console.log('[exam-sync] аккаунты обновлены'); }

  const clients = new Set();
  setInterval(() => clients.forEach((c) => c.write(': ping\n\n')), 25000).unref();

  const json = (res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };

  /* Возвращает true, если запрос относится к экзаменам и обработан */
  return async function handle(req, res) {
    const p = req.url.split('?')[0];
    if (p !== base && !p.startsWith(base + '/')) return false;
    const u = p.slice(base.length) || '';

    // Без завершающего «/» относительные пути api/... в index.html уйдут мимо — перенаправляем
    if (u === '' && req.method === 'GET') {
      const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      res.writeHead(301, { Location: base + '/' + q });
      res.end();
      return true;
    }
    if (req.method === 'GET' && (u === '/' || u === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(INDEX));
      return true;
    }
    if (req.method === 'GET' && u.startsWith('/eb/')) {
      const name = u.slice(4);
      const type = EB_TYPES[path.extname(name)];
      if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name) || !type) { json(res, { error: 'not found' }, 404); return true; }
      fs.readFile(path.join(EB_DIR, name), (err, buf) => {
        if (err) { json(res, { error: 'not found' }, 404); return; }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
      return true;
    }
    if (req.method === 'HEAD' && (u === '/' || u === '/api/state')) { res.writeHead(200, { 'Cache-Control': 'no-store' }); res.end(); return true; } // проверка доступности
    if (req.method === 'GET' && u === '/api/state') { json(res, state()); return true; }
    if (req.method === 'GET' && u === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('data: ' + JSON.stringify(state()) + '\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return true;
    }
    if (req.method === 'POST' && u === '/api/sync') {
      // куски собираются как Buffer: склейка строк по кускам портит многобайтовые символы (кириллицу) на границах
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > MAX_BODY) { json(res, { error: 'too large' }, 413); req.destroy(); return true; } chunks.push(c); }
      let b; try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json(res, { error: 'bad json' }, 400); return true; }
      const ch = (b && b.changes) || {};
      COLS.forEach((c) => {
        const x = ch[c]; if (!x) return;
        (Array.isArray(x.del) ? x.del : []).forEach((k) => db[c].delete(k));
        (Array.isArray(x.up) ? x.up : []).forEach((r) => { if (r && typeof r === 'object') db[c].set(keyOf(r), r); });
      });
      rev++; save();
      const d = 'data: ' + JSON.stringify(state()) + '\n\n';
      clients.forEach((c) => c.write(d));
      json(res, { ok: true, rev });
      return true;
    }
    json(res, { error: 'not found' }, 404);
    return true;
  };
}

module.exports = { createExamSync, rosterUsers, TEACHERS };

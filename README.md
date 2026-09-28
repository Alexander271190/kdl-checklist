# KDL Checklist — standalone QA-инструмент

Изолированный сервис чек-листа с серверным хранением состояния.
Не связан с основным проектом. Свой порт, свой процесс, свой файл данных.

## Требования

- Node.js 18+ (`node --version`)
- PM2 (`npm install -g pm2` или `pm2 --version`)

## Структура

```
kdl-checklist/
├── server.js              ← сервер (zero deps)
├── package.json
├── ecosystem.config.js    ← PM2 конфиг
├── public/
│   └── index.html         ← чек-лист
├── data/                  ← создастся автоматически
│   └── state.json         ← состояние (бэкапить!)
└── logs/                  ← создастся автоматически
    ├── out.log
    └── error.log
```

## Быстрый старт (Windows)

```powershell
cd kdl-checklist
pm2 start ecosystem.config.js
pm2 status
```

Открыть: <http://localhost:8444/>

## Установка на сервер (Linux, 5.189.243.15)

### 1. Копирование

```bash
# С локальной машины
scp -r kdl-checklist user@5.189.243.15:~/
ssh user@5.189.243.15
cd ~/kdl-checklist
```

### 2. Права и запуск

```bash
mkdir -p logs data
chmod +x server.js
pm2 start ecosystem.config.js
pm2 save   # запомнить процессы для авто-старта после ребута

# Автозапуск PM2 при старте системы (если ещё не сделано)
pm2 startup
# выполнить команду, которую он выведет (sudo env PATH=... pm2 startup systemd ...)
```

### 3. Firewall

```bash
# Если ufw включён
sudo ufw allow 8444/tcp
```

### 4. Проверка

```bash
curl http://localhost:8444/api/health
# {"status":"ok","uptime":42,"memory":...}

curl http://localhost:8444/api/state
# {"state":null,"updatedAt":null}   (при первом запуске)
```

Открыть: <http://5.189.243.15:8444/>

## Управление через PM2

```bash
pm2 status                    # статус
pm2 logs kdl-checklist        # живые логи
pm2 logs kdl-checklist --lines 200   # последние 200 строк
pm2 restart kdl-checklist     # перезапуск
pm2 stop kdl-checklist        # остановка
pm2 delete kdl-checklist      # удалить процесс
pm2 monit                     # мониторинг ресурсов
```

## Обновление файлов

```bash
# Закинуть новый index.html
scp public/index.html user@5.189.243.15:~/kdl-checklist/public/
# Перезапуск не нужен — файл отдаётся каждый раз заново
# Достаточно F5 в браузере (Ctrl+F5)

# Если менялся server.js
scp server.js user@5.189.243.15:~/kdl-checklist/
ssh user@5.189.243.15 "pm2 restart kdl-checklist"
```

## Бэкапы

Состояние — **один файл** `data/state.json`.

### Ручной бэкап

```bash
cp data/state.json data/state.$(date +%F).json
```

### Cron (ежедневно в 3:00, храним 30 дней)

```bash
crontab -e
# добавить строку:
0 3 * * * cd /home/user/kdl-checklist/data && cp state.json state.$(date +\%F).json && find . -name 'state.*.json' -mtime +30 -delete
```

### Восстановление

```bash
pm2 stop kdl-checklist
cp data/state.2025-01-15.json data/state.json
pm2 start kdl-checklist
```

## Как работает синхронизация

1. При открытии страницы HTML мгновенно рендерится из localStorage.
2. Параллельно клиент запрашивает `GET /api/state`.
3. Если на сервере состояние свежее (по `_updated`) — заменяет локальное и перерисовывает.
4. Если локальное свежее — пушит на сервер.
5. Дальше каждое изменение дебаунсится (800 мс) и уходит `PUT /api/state`.
6. Если сервер недоступен — работает на localStorage + индикатор «Офлайн».
7. При возврате связи — автосинхронизация.

### Индикатор синхронизации (в шапке)

| Цвет | Текст | Значит |
|---|---|---|
| 🟢 | Сохранено | Всё на сервере |
| 🟡 | Сохранение… | Идёт debounce или PUT |
| 🔴 | Ошибка | Сервер ответил ошибкой |
| ⚪ | Офлайн | Сервер недоступен |

## API

Все эндпоинты — без авторизации. Если нужна защита — см. ниже.

| Метод | URL | Назначение |
|---|---|---|
| GET | `/api/health` | Проверка живости |
| GET | `/api/state` | Прочитать состояние |
| PUT | `/api/state` | Записать состояние (`{"state": {...}}`) |
| DELETE | `/api/state` | Сбросить состояние |

## Многопользовательский режим

Несколько человек открывают <http://5.189.243.15:8444/> — все работают с общим состоянием.

**Модель:** last-write-wins (по полю `_updated`). Работает корректно, если каждый тестирует свою часть (A: блоки 1–7, B: блоки 8–15, ... — см. сценарий S18).

⚠️ Если двое одновременно правят один и тот же пункт — победит тот, кто сохранит позже. Если это критично — используйте персональные снимки (`📸 Снимки`) для изоляции сессий.

## (Опционально) Защита паролем

Если нужно закрыть доступ посторонним, добавьте в `ecosystem.config.js` в блок `env`:

```js
CHECKLIST_PASSWORD: 'ваш_секрет'
```

И замените начало роутера в `server.js`:

```js
const server = http.createServer(async (req, res) => {
  // 🆕 Проверка пароля
  const requiredPwd = process.env.CHECKLIST_PASSWORD;
  if (requiredPwd) {
    const given = req.headers['x-checklist-password'] || url.searchParams.get('pwd');
    if (given !== requiredPwd) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized');
      return;
    }
  }
  // ... дальше как было
```

Затем в `index.html` в блоке `bootSync()` и во всех `fetch` к `/api/state` — добавить заголовок `'x-checklist-password': localStorage.getItem('checklist_pwd')`. При отсутствии — спросить через `prompt()`.

Проще всего — не защищать и держать порт 8444 открытым только в локальной сети. Например, в iptables:

```bash
sudo iptables -A INPUT -p tcp --dport 8444 -s 192.168.0.0/16 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 8444 -j DROP
```

## Диагностика

### Порт занят

```bash
# Найти, кто занял порт
sudo lsof -i :8444     # Linux
netstat -ano | findstr :8444   # Windows
```

Если занят — поменяйте `PORT` в `ecosystem.config.js`.

### 502 / «Ошибка соединения»

```bash
pm2 status                          # процесс должен быть online
curl http://localhost:8444/api/health   # проверка локально
```

### Не синхронизируется

1. Открыть DevTools → Network → фильтр `api/state`.
2. Если запросы падают — смотреть `pm2 logs kdl-checklist`.
3. Если сервер отвечает 200 — состояние сохраняется, проблема в браузере (кэш, расширения).

### Битый state.json

Сервер не упадёт, просто вернёт `state: null`. Клиент возьмёт данные из localStorage.

Восстановление из бэкапа:

```bash
pm2 stop kdl-checklist
cp data/state.2025-01-15.json data/state.json
pm2 start kdl-checklist
```

## Что этот сервис **не** делает

- Не лезет в MySQL основного проекта.
- Не переиспользует порт 8443.
- Не требует перезапуска основного приложения.
- Не разделяет процесс/логи/конфиги с основным.

Даже полное удаление папки `kdl-checklist` и остановка её PM2-процесса никак не повлияют на основной проект.
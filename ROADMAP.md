# Claude Terminal — Roadmap

Живой документ. Обновляется по ходу. Источник P-приоритетов и детального обоснования — `AUDIT-2026-05-13.md` (snapshot одноразового аудита).

---

## ✅ Сделано (2026-05-13)

| Что | Коммит |
|-----|--------|
| Services Panel (admin) — discovery nginx-vhost'ов + systemd-юнитов, whitelisted действия через sudoers, HTTP-проба, журналы | `ba61584` |
| Security hardening — HOST=127.0.0.1, password 4→8, изоляция AI-прокси для child-PTY (`~/.config/ai-proxy.env`) | `ba61584` |
| Symphony отключён — иконка скрыта в IconRail, orchestrator не auto-start'ит, файлы оставлены (для безболезненного `git pull`) | `ba61584` |
| Группировка сессий в SessionPanel по проекту (basename `projectDir`); «Сандбокс» = `~/projects/Claude/*`; складываемые группы в localStorage | `ba61584` |
| Авто-название чатов через Haiku — `hooks/notify.js` + standalone `hooks/title-gen.js` wrapper, persist в `<cwd>/.claude/title.json`, не перетирает ручной rename | `ba61584` + `fc30373` |
| Rebrand login: Claude Terminal → Neureca | `14b621f` |

---

## 🎯 Активный фокус — Центр управления + PWA

### Концепция

Заменить пустой Welcome-экран **виджет-дашбордом**, который служит «главной» приложения. Каждый виджет — обзор + 1-2 быстрых действия, глубокая работа остаётся в специализированных вкладках IconRail.

**Принципы (выработаны в обсуждении):**
1. Variant A («overview»), не B («single-page»). Вкладки IconRail сохраняются. Виджет ≠ замена вкладки.
2. Фиксированный grid в MVP. Drag-and-drop / resize / сохранение раскладок — отложено.
3. Каждый виджет реализует контракт: заголовок · 1-3 ключевых метрики · 1-2 inline-action · ссылка «открыть всю вкладку».
4. Один общий polling-хук + WebSocket-канал для пушей. Никаких 8 параллельных fetch'ей.
5. Mobile: виджеты сворачиваются в одну колонку с приоритетом сверху-вниз. Опция «скрыть виджет» в каждом.

### Кандидаты в виджеты

| Виджет | Источник данных | Inline-action | «Открыть» |
|--------|------------------|----------------|------------|
| Проекты | `~/projects/*` + git + сессии в каждом | «Новая сессия» | панель проектов |
| Сервисы | `services-manager.getSnapshot()` | «Перезапустить» / «Логи» | вкладка Сервисы |
| Активные сессии | `terminalManager.listSessions()` | «Перейти» | список в SessionPanel |
| System health | `/api/system/stats` (CPU/RAM/диск/uptime) | — | вкладка Система |
| Недавние файлы | recent в файловом менеджере (новый эндпоинт) | «Открыть» | FileManager |
| TODO из CLAUDE.md | парсер `^- \[ \]` + `## TODO` в каждом проекте | — | проект → файл |
| Последние коммиты git | `git log -10` по `~/projects/*` и `~/services/*` | — | проект |
| Чат-превью | последние 2 сообщения из `chat_messages` | «Открыть чат» | ChatPanel |
| Pending-регистрации | `users WHERE status='pending'` | «Подтвердить» / «Отклонить» | AdminPanel |
| Ресерчи | список из `~/services/deepresearch-site/src/content/research/` | — | сайт ресерчей |

**MVP-набор (1 PR):** проекты, сервисы, активные сессии, system health, TODO из CLAUDE.md, чат-превью. Шесть штук — пограничное число для одного экрана.

### Открытые вопросы по виджетам

- Какие именно 5-6 в MVP? (см. список выше — ждём подтверждения от пользователя)
- Где жить настройкам «скрытых виджетов»: `localStorage` или новая таблица `user_widgets` в SQLite (нужно при multi-device sync)?
- Алерты: где показывать «упал сервис» / «новая регистрация» — toast в правом-нижнем + бейдж на иконке? Сейчас только favicon-точка.

### PWA — параллельная подзадача

- `public/manifest.json` (name=Neureca, theme_color, background_color)
- Иконки 192/512 (генерим из текущего `favicon.ico` через canvas)
- Минимальный service worker: precache static assets `/_next/static/**`, runtime для favicon, NO offline-fallback в MVP (CLI всё равно требует онлайн)
- `<meta name="apple-mobile-web-app-capable">` + `apple-touch-icon`
- Install prompt на mobile (Chrome banner, iOS — инструкция «Добавить на главный экран»)

---

## 🛠 Технический долг (P0-P1)

### P0 — закрыть в ближайшую итерацию

- [ ] **Удалить или доделать `TerminalIOContext.tsx`** — мёртвый phase-2 скаффолд, `useTerminalIO()` нигде не вызывается. Сейчас `<TerminalIOProvider>` обёрнут в `dashboard/page.tsx` без эффекта. Решение: **удалить**, пока никто реально не унаследует Terminal.tsx (924 строки) от него.
- [ ] **Снять CT_WS_DEBUG=1 в проде** или отфильтровать focus-event input (`[O`/`[I`). Сейчас `/var/log/claude-terminal.log` распухает мегабайтами на каждый клик.

### P1 — стабильность

- [ ] **Декомпозиция `terminal-manager.js`** (1364 строки) на: `pty-pool.js` (lifecycle), `tmux-bridge.js` (capture-pane, snapshot), `hooks-state.js` (busy/waiting/title через `notify.js`), `proxy-env.js` (загрузчик `~/.config/ai-proxy.env`).
- [ ] **API-тесты на critical-роуты** (vitest + supertest): auth/sessions/services. Сейчас покрытие — только UI Playwright (e2e), API не покрыт.
- [ ] **Бэкап-хук памяти** в крон рядом с `backup-claude-terminal.sh` (висит из старого `setup_pending`).
- [ ] **Lazy-load языковых модулей CodeMirror** — сейчас 17 пакетов в client bundle, большинство не используется на сессию.

---

## 🚀 Backlog UI/UX (после ЦУ)

| Тема | Размер | Заметка |
|------|--------|---------|
| **Cmd+K глобальная fuzzy-палетка** | M | Сейчас только active-сессии; fuzzy по сессиям/файлам/проектам/скиллам/настройкам/сервисам, недавние действия, AI-предложения |
| **Side-panel в активной сессии** | L | Tool-вызовы Claude + diff'ы изменённых файлов + preview открытых. Источник — `~/.claude/projects/<id>/<conv>.jsonl`. Похоже на Cursor's Composer. |
| **UI для cron-задач** | M | Расширить существующий `system/cron/route.ts` (read) на add/edit с whitelist-валидацией. |
| **Drag-and-drop файлов в xterm** | S | Перетащить файл в терминал → авто-attach к промпту. Mы уже умеем clipboard image bridge — основа есть. |
| **Voice input** | S | Web Speech API в mobile-composer (Chrome/Safari iOS). Бесплатно. |
| **Activity timeline** | M | Лента «что Claude делал» (запросы, токены, время). Парсер jsonl-историй. |
| **Diff viewer auto-popup** | M | Когда Claude меняет файл — diff в side-panel автоматом. Зависит от Side-panel. |
| **Темы** | S | Solarized / Tokyo Night / Catppuccin + кастомная через JSON. |
| **Notifications system** | M | Toast'ы для упавших сервисов, новых регистраций, завершения busy. |
| **Onboarding для нового админа** | M | Tour: добавить пользователя, запустить сессию, подключить проект. |

---

## 🔬 Открытые исследования

Темы, которые предлагал в внешний deep-research, но пока не делали:

- **PTY-replay и shared-сессии у конкурентов** — Warp, Wave, ttyd, gotty, tmate, sshx. Как решён persistent buffer и multi-cursor. Может, у нас велосипед на 600 строк там, где есть готовый протокол.
- **Mobile-CLI UX** — Cursor mobile, Goose Web, claude-squad. Паттерны ввода с телефона.
- **AI-агентные браузерные обёртки** — claude-squad, Aider Web, Goose, Open WebUI. Какие фичи у них есть, которых нет у нас.
- **Self-hosted dev-окружения** — Coder, Gitpod self-hosted, code-server, devpod. Terminal-подсистема как сделана. Что переиспользуемо.

Запустить через скилл `deep-research`, результат публикуется на `deepresearch.neureca.club`.

---

## ❌ Не делаем

- **Symphony обратно** — фича умерла, оставлена в коде только для безболезненного `git pull` от апстрима.
- **Drag-and-drop виджетов с resize** в первой итерации центра управления — overengineering для одного-пользователя.
- **Backwards-compat для старого SessionPanel layout** — группировка по проекту заменила «Активные/Остановленные», без compat-флага.

---

## История решений

- **2026-05-13.** Symphony отключён по запросу пользователя — фича не используется. Минимальная инвазия (комментарий + скрытие иконки), файлы оставлены.
- **2026-05-13.** Группировка сессий: «Сандбокс» внизу, проекты сверху по `lastActivity` desc. Решение от пользователя в обсуждении.
- **2026-05-13.** Авто-название только на первый промпт (не на смену темы) — предсказуемее, не «прыгает» в списке.
- **2026-05-13.** Авто-название через Claude CLI с подпиской (Haiku), не через Anthropic API — нет API-ключа, есть только OAuth-токен подписки.
- **2026-05-13.** Center-of-control направление: выбран Variant A (виджеты как обзор, вкладки сохраняются), не Variant B (single-page).

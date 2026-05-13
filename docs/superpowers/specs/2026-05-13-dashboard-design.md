# Центр управления — дизайн главной страницы

**Дата:** 2026-05-13
**Статус:** утверждён через брейнсторминг, ожидает план реализации
**Скоуп:** замена Welcome-экрана на полноценный обзорный дашборд с двумя hero-блоками и расширенным набором виджетов. ClickUp-интеграция спроектирована, но реализация отложена в Этап 3.

---

## Контекст

Главная страница сейчас — Welcome-экран (40vh с провайдер-сеткой) + 6 одинаковых виджет-карточек ниже (MVP, коммит `f16a364`, ROADMAP §«Активный фокус»). Все карточки равного веса, без иерархии, без чёткого «что делать дальше». Welcome-блок дублирует функцию IconRail (создание сессии есть и там).

Пользователь хочет, чтобы главная была **рабочим местом** — два главных сценария первого клика:
1. «Продолжить со вчерашнего» — Resume последней сессии, контекст недавних изменений
2. «Взять следующую задачу» — список задач из ClickUp с быстрым стартом в нужном проекте

Метрики и системные виджеты — вторичны, но видны для быстрого health-check.

---

## Принципы

1. **Два hero-блока вместо плоской сетки.** Hero «Continue» и hero «Tasks» — главный визуальный акцент. Вторичные виджеты — компактная сетка ниже.
2. **Welcome-экран уходит.** Создание сессии становится split-button в action-bar. Провайдер-настройки достаются через ту же кнопку.
3. **Polling, не push.** Push-канал WS отложен. Используем существующий `useDashboardData` hook с интервалом 15с, ClickUp — 60с (rate-limit).
4. **Деградация gracefully.** Если ClickUp лёг или ещё не настроен — hero показывает empty-state или cached данные. Hero «Continue» работает всегда, пока есть хоть одна сессия.
5. **Без drag-and-drop.** Управление виджетами — простая модалка с чекбоксами и ↑↓. DnD остаётся в backlog с заглушкой ☰.

---

## Архитектура страницы

```
┌─ Page container (max-w-6xl, p-4) ──────────────────────────┐
│                                                            │
│  ┌─ Action bar (sticky top, h ~44px) ────────────────┐    │
│  │ [+ Новая сессия Claude ▾]   [⚙ Виджеты] [📚 Ресерчи]│    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─ Hero row (lg: 1×2, <lg: stacked) ──────────────────┐   │
│  │ ┌────────────────┐  ┌────────────────┐               │   │
│  │ │   Continue     │  │     Tasks      │               │   │
│  │ │   (~280px)     │  │    (~280px)    │               │   │
│  │ └────────────────┘  └────────────────┘               │   │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─ Secondary grid (sm:1 / md:2 / lg:3) ───────────────┐   │
│  │ Проекты    Сессии     Коммиты                        │   │
│  │ TODO       Чат        Pending (admin)                │   │
│  │ Сист.(adm) Серв.(adm) Прокси (admin)                 │   │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Action bar

- Sticky под Navbar (`sticky top-0 z-10`), padding-y 8px, высота ~44px
- **Split-button «+ Новая сессия [Claude ▾]»** — левая половина создаёт сессию в дефолтном провайдере (последний выбранный, persisted в `localStorage.selectedProvider`), правая (chevron) — dropdown со списком провайдеров и пунктом «⚙ Настроить провайдеры» (открывает существующий `ProviderConfigModal`)
- **«⚙ Виджеты»** — ghost-кнопка, открывает `<WidgetSettingsModal>` (Этап 2)
- **«📚 Ресерчи»** — ghost-кнопка, внешний линк на `https://deepresearch.neureca.club`
- Mobile: action-bar полная ширина, split-button во всю ширину, две правые кнопки уходят в overflow-menu `…`

### Hero «Continue» — продолжение работы

**Цель:** один клик → возвращение к последней сессии.

**Источник данных:**
- `terminalManager.listSessions()` через `/api/sessions`
- Сортировка приоритета: `busy > waiting > active > stopped`, внутри статуса — по `lastActivity` desc
- Берём верхнюю сессию
- Если `projectDir` определён — `git log -3` через новый `/api/projects/commits?dir=<projectDir>&limit=3` (server-side кэш 60с)

**Структура карточки:**
```
┌─ Hero: Continue ───────────────────────────────────┐
│  PRODUCT  /  PROJECT-NAME              [4 мин назад]│
│                                                     │
│  Refactor terminal-manager: split into             │
│  pty-pool + tmux-bridge                            │
│                                                     │
│  ─────────────────────────────────────────────     │
│  Последние 3 коммита проекта:                       │
│    f16a364  feat: proxy panel + session…   2ч       │
│    fc30373  fix(hooks): standalone title…  7ч       │
│    ba61584  feat: services panel, hard…   24ч       │
│  ─────────────────────────────────────────────     │
│                                                     │
│  [▶ Resume сессию]    [Открыть проект →]            │
└─────────────────────────────────────────────────────┘
```

**Состояния:**
- **Есть сессия + есть git:** полный layout
- **Сессия есть, projectDir пустой (сандбокс):** секция коммитов скрыта, hero ужимается, кнопка «Открыть проект» заменяется на «Открыть сессию»
- **Сессия есть, но `git log` упал / `.git` отсутствует:** «Коммиты недоступны» мелким серым
- **Все сессии stopped:** primary button = «🔄 Resume», подпись «Последняя — остановлена N ч назад»
- **Сессий нет совсем:** empty-state — большая иконка ▶, текст «Создайте первую сессию», CTA «+ Новая сессия» (тот же handler, что split-button)

**Действия:**
- `Resume` → существующий `handleResumeSession(sessionId)`
- «Открыть проект» → `setActiveSection("sessions")` + автоскролл `SessionPanel` к нужному проекту с раскрытием группы (`scrollIntoView` + state-флаг в `NavigationContext`)

### Hero «Tasks» — задачи (заглушка в Этап 1)

**Цель:** взять задачу в работу одним кликом (Этап 3). В Этап 1 — placeholder, чтобы layout был финальный с первого этапа.

**Этап 1 (заглушка):**
```
┌─ Hero: Tasks ───────────────────────────────────────┐
│                                                     │
│        [📋]                                         │
│                                                     │
│  Интеграция с ClickUp                              │
│  В разработке. Скоро здесь будут твои задачи        │
│  из ClickUp с быстрым стартом в нужном проекте.    │
│                                                     │
│  [⏳ Скоро]  (disabled)                             │
└─────────────────────────────────────────────────────┘
```

**Этап 3 (отложен, проектирование заморожено до отдельной итерации):**
- Personal API token, per-user (зашифрованный AES-GCM)
- Cache-first рендеринг из SQLite
- Polling 60с, ручной refresh
- Фильтр в шапке: Сегодня / Эта неделя / Все open
- Top-5 видимых, expand-on-click с description + actions
- Actions: «▶ Взять в работу» (диалог выбора проекта с памятью), «✓ Готово» (с toast undo), «Открыть в ClickUp», «Detach»
- Auto-смена статуса в ClickUp на «In Progress» при «Взять в работу» (галка в настройках, дефолт on)
- Память выбора проекта на задачу в `clickup_task_routes`
- Если у задачи уже есть session_id и сессия активна — диалог «Resume существующую?»

Полная схема таблиц, API и UI Этапа 3 — в Appendix A.

### Secondary widgets

**Финальный набор (per-role):**

| Виджет | Видим | Источник | Inline action | Alert state |
|---|---|---|---|---|
| Проекты | all | `~/projects/*` + `~/services/*` + git + lastActivity сессий | «Новая сессия здесь» | — |
| Сессии | all | `terminalManager.listSessions()` | «Resume» | — |
| Коммиты | all | `/api/projects/commits/all` (агрегированно top-5) | Клик → открыть в FM | — |
| TODO | all | парсер CLAUDE.md (как сейчас) | Клик → файл | — |
| Чат | all | `/api/chat/messages?limit=2` | «Открыть чат» | — |
| Pending | admin | `/api/admin/users` фильтр pending | «Подтвердить» / «Отклонить» | warn если count > 0 |
| Система | admin | `/api/system/stats` | — | warn если CPU > 90% или disk > 90% |
| Сервисы | admin | `services-manager.getSnapshot()` | «Перезапустить» / «Логи» (hover) | danger если хотя бы один failed |
| Прокси | admin | новый `/api/proxies/health` | «Тест» | warn если primary недоступен |

**Удалено из дефолтов:** виджет «Ресерчи» — заменён на ссылку в action-bar.

**Дефолтная видимость (миграция `WIDGET_REGISTRY`):**
- Admin: 9 виджетов (все)
- User: 5 виджетов (Проекты, Сессии, Коммиты, TODO, Чат)
- Guest: 2 виджета (Сессии, Чат)

**Контракт виджета сохраняется** (`WidgetCard.tsx`):
- Заголовок (uppercase tracking-wider, как сейчас — создаёт ритм против hero)
- 1-3 ключевые метрики/строки
- Опциональный header-action (мелкая кнопка справа от title)
- Опциональный footer-link («→ открыть всю вкладку»)
- `min-h-[160px]`

**Изменения контракта (Этап 1):**
- Новый prop `alert?: "warn" | "danger"` — добавляет `border-l-2` цветом и tinted-фон, точку рядом с title
- Новый prop `inlineActions?: ReactNode` — слот для hover-actions справа от каждой строки контента (используется в Сервисах и Сессиях)
- Skeleton-state при первой загрузке: 3 row-skeletons с `animate-pulse`, не «Загрузка…»

---

## Визуальный язык

### Hero блоки

- Padding: `p-6`
- Border: `border-accent/20` (заметнее чем secondary `border-border`)
- Фон: `bg-gradient-to-br from-accent/[0.04] via-surface to-surface` — тонкий «свет» в верхнем-левом углу через accent-токен темы. Адаптируется под Dark Violet (violet-tinted) и Retro OS (tan-tinted).
- Title: 17px / 600, обычный case (НЕ uppercase)
- Subtitle (eyebrow): 11px / 600 / uppercase / `text-accent-fg/70`
- Body: 13px / 400
- Primary action: filled с accent-фоном, `min-h-9 px-4`, font-medium
- Secondary action: text-link с accent цветом

### Secondary widgets

- Padding: `p-3` (как сейчас)
- Border: `border-border` дефолт
- **Hover:** `hover:border-accent/40 transition-colors 150ms`
- **Alert warn:** `border-l-2 border-l-amber-500/60 bg-amber-500/[0.03]`, точка `bg-amber-500` рядом с title
- **Alert danger:** `border-l-2 border-l-red-500/70 bg-red-500/[0.04]`, точка `bg-red-500`
- Header сохраняется (uppercase tracking-wider, 11px / 600)
- Content: 12px / 400
- Numbers в Сист./Серв./Прокси виджетах: 20px / 600 (крупно, для glance)

### Анимации

- **Fade-in на mount:** 200ms ease-out, stagger 50ms между карточками (через `motion/react` — уже подключён)
- **Refresh-индикатор:** тонкая прогресс-полоска под action-bar (1px, `bg-accent/30`), видна во время активного fetch
- **Hover transitions:** 150ms на border-color

### Mobile

- Action-bar: полная ширина, split-button во всю ширину, две правые кнопки → overflow `…`
- Hero: стек 1 колонка, `min-h-280px` снимается (auto-grow)
- Secondary grid: 1 колонка
- Action-bar остаётся sticky
- `<WidgetSettingsModal>` (Этап 2) на mobile — полноэкранный sheet

---

## Управление виджетами (Этап 2)

**`<WidgetSettingsModal>`** — открывается из action-bar по «⚙ Виджеты».

```
┌─ Виджеты ──────────────────────────── ✕ ┐
│  Включенные                              │
│  ☰ ☑  Проекты                  ↑ ↓       │
│  ☰ ☑  Сессии                   ↑ ↓       │
│  ☰ ☑  Коммиты                  ↑ ↓       │
│  ☰ ☑  TODO                     ↑ ↓       │
│  ☰ ☑  Чат                      ↑ ↓       │
│  ☰ ☑  Pending (admin)          ↑ ↓       │
│  ☰ ☑  Система (admin)          ↑ ↓       │
│  ☰ ☑  Сервисы (admin)          ↑ ↓       │
│  ☰ ☑  Прокси (admin)           ↑ ↓       │
│                                          │
│  Отключенные                             │
│  (пусто)                                 │
│                                          │
│              [Сбросить]    [Сохранить]   │
└──────────────────────────────────────────┘
```

- Чекбокс → toggle hidden
- ↑/↓ → swap position в видимой группе
- «Сбросить» → восстановить дефолты из `WIDGET_REGISTRY`
- «Сохранить» → `PUT /api/widgets` (endpoint уже существует, нужно проверить полноту реализации)
- Закрытие с pending changes → подтверждение
- ☰ слева — disabled заглушка под будущий DnD

**Empty-state «все виджеты скрыты»:** в центре сетки карточка с текстом «У тебя выключены все виджеты» и кнопкой «Открыть настройки».

---

## Backend изменения

### Новые endpoints (Этап 1)

| Endpoint | Назначение | Кэш |
|---|---|---|
| `GET /api/projects/commits?dir=<path>&limit=3` | git log одного проекта для hero «Continue» | 60с per dir |
| `GET /api/projects/commits/all?limit=5` | агрегированный git log по `~/projects/*` + `~/services/*` для виджета «Коммиты» | 60с |
| `GET /api/proxies/health` | latency-snapshot всех прокси для виджета «Прокси» | 30с |
| `GET /api/admin/pending-users` (или фильтр в существующем `/api/admin/users`) | pending заявки для виджета | — |

**Path validation для `dir`:** строго whitelist `~/projects/*` + `~/services/*` (как уже сделано для других endpoints). Никаких `..` или абсолютных путей вне whitelist.

**Git log query:** `git -C <dir> log -n <limit> --format=%H%x09%s%x09%cr 2>/dev/null` через child_process. Timeout 1.5с. Если падает — возвращаем `{ commits: [], error: "git_unavailable" }`.

### Доработка `useDashboardData`

- Добавляются ключи: `commits`, `commitsAll`, `proxies`, `pending`
- ClickUp ключ зарезервирован, но в Этап 1 — null (заглушка)
- Polling tick остаётся 15с
- ClickUp (Этап 3) — отдельный sub-tick 60с

### `WIDGET_REGISTRY` миграция

```ts
export const WIDGET_REGISTRY: WidgetMeta[] = [
  { key: "projects", title: "Проекты", defaultPosition: 1 },
  { key: "active_sessions", title: "Сессии", defaultPosition: 2, guestVisible: true },
  { key: "commits", title: "Коммиты", defaultPosition: 3 },
  { key: "todos", title: "TODO", defaultPosition: 4 },
  { key: "chat_preview", title: "Чат", defaultPosition: 5, guestVisible: true },
  { key: "pending_users", title: "Pending", defaultPosition: 6, adminOnly: true },
  { key: "system_health", title: "Система", defaultPosition: 7, adminOnly: true },
  { key: "services", title: "Сервисы", defaultPosition: 8, adminOnly: true },
  { key: "proxies", title: "Прокси", defaultPosition: 9, adminOnly: true },
];
```

«Ресерчи» НЕ добавляется в registry — это ссылка в action-bar.

При деплое: существующие записи в `user_widgets` остаются как есть (мы не ломаем). Новые виджеты (commits, pending_users, proxies) автоматически добавятся в дефолтной видимости при первом обращении к виджет-API (логика `defaultLayoutFor(role)` в `widgets-registry.ts`).

---

## Компоненты — карта файлов

**Новые (Этап 1):**
- `src/components/dashboard/HeroBlock.tsx` — общий контейнер для hero (props: eyebrow, title, children, primaryAction, secondaryAction, empty)
- `src/components/dashboard/ContinueHero.tsx` — hero «Continue»
- `src/components/dashboard/TasksHero.tsx` — hero «Tasks» (заглушка в Этап 1)
- `src/components/dashboard/ActionBar.tsx` — sticky action-bar с split-button
- `src/components/dashboard/widgets/CommitsWidget.tsx`
- `src/components/dashboard/widgets/PendingUsersWidget.tsx`
- `src/components/dashboard/widgets/ProxiesWidget.tsx`
- `src/components/dashboard/WidgetSkeleton.tsx` — общий skeleton-stub

**Новые (Этап 2):**
- `src/components/dashboard/WidgetSettingsModal.tsx`

**Изменяемые (Этап 1):**
- `src/components/dashboard/ControlCenter.tsx` — добавить hero-row, заменить grid layout, рендер новых виджетов
- `src/components/dashboard/WidgetCard.tsx` — добавить `alert` и `inlineActions` props, hover-state, skeleton-state
- `src/components/dashboard/widgets/ServicesWidget.tsx` — добавить inline-actions «Перезапустить» / «Логи»
- `src/components/dashboard/widgets/ActiveSessionsWidget.tsx` — компактнее, inline-action «Resume»
- `src/lib/widgets-registry.ts` — добавить новые ключи
- `src/lib/useDashboardData.ts` — добавить новые источники
- `src/app/dashboard/page.tsx` — убрать `<WelcomeScreen>` (~40vh блок) из welcome-секции, заменить на `<ControlCenter>` с action-bar выше всего

**Удаляемые:**
- Большой `<WelcomeScreen>` (компонент с provider-сеткой) — функция выноса создания сессии в split-button делает его лишним. **Файл компонента оставляем** на случай если ещё где-то используется (поиск usage перед удалением).

---

## Состояния и UX edge cases

| Сценарий | Поведение |
|---|---|
| Сессий вообще нет | Hero «Continue» = empty-state с CTA «+ Новая сессия» |
| Все сессии stopped | Hero «Continue» показывает последнюю + кнопка «🔄 Resume» |
| Projectdir в сандбоксе | Секция коммитов скрыта в hero |
| `git log` упал | Секция коммитов: «Коммиты недоступны» |
| `/api/projects/commits/all` пуст | Виджет «Коммиты»: empty-state |
| ClickUp не настроен (Этап 1) | Hero «Tasks» = disabled-заглушка «Скоро» |
| Юзер скрыл ВСЕ виджеты | В центре secondary-сетки empty-state с кнопкой «Открыть настройки» |
| Сервис failed | Виджет «Сервисы» = `alert="danger"`, failed первыми |
| Pending count > 0 | Виджет «Pending» = `alert="warn"` |
| Refresh идёт | Тонкая полоска под action-bar, viewport не дёргается |
| Mobile | Action-bar full-width, hero stack, grid 1col |
| Pre-data render | Skeleton три row на каждый виджет/hero |

---

## Acceptance criteria

1. Захожу на `/dashboard` — за 2 сек вижу два hero-блока и сетку виджетов, без 40vh Welcome-секции
2. Hero «Continue» с активной сессией: показывает displayName, eyebrow «product / projectName», 3 коммита проекта, кнопка Resume работает
3. Сессий нет → empty-state с CTA «+ Новая сессия», клик на CTA создаёт сессию в дефолтном провайдере
4. Hero «Tasks» = заглушка с надписью «Интеграция с ClickUp / Скоро» и disabled-кнопкой
5. Action-bar sticky, split-button «+ Новая сессия [Claude ▾]» работает, dropdown даёт выбор провайдера и пункт «Настроить»
6. Кнопка «Ресерчи» в action-bar открывает `deepresearch.neureca.club` в новой вкладке
7. Виджет «Сервисы» при падении сервиса показывает `danger`-state (красная полоса слева, точка у заголовка)
8. Hover на строке сервиса в виджете «Сервисы» → справа всплывают inline-actions «Перезапустить» / «Логи», они работают
9. Виджет «Коммиты» агрегирует по всем проектам, клик на коммит открывает файл в FM
10. Виджет «Pending» (admin) показывает count и верх-2 заявки с кнопками «Подтвердить»/«Отклонить» (Этап 1)
11. Виджет «Прокси» (admin) показывает primary/fallback статусы с латенси, inline-action «Тест» (Этап 1)
12. Кнопка «⚙ Виджеты» открывает модалку, можно скрыть Pending → виджет исчезает из сетки, состояние сохраняется после reload (Этап 2)
13. В модалке «Виджеты» — ↑/↓ переставляет порядок, «Сбросить» откатывает к дефолтам (Этап 2)
14. Скрыл все виджеты → empty-state в центре с кнопкой «Открыть настройки» (Этап 2)
15. На мобильном: action-bar full-width, hero stack 1col, grid 1col, всё кликабельно
16. Skeleton-state виден при первой загрузке, fade-in на mount с stagger 50ms
17. Refresh не дёргает viewport, тонкая прогресс-полоска под action-bar
18. Тема Dark Violet и Retro OS — оба hero корректно адаптируют градиент через accent-токен

---

## Outside scope (явный backlog)

- Drag-and-drop виджетов (заглушка ☰ оставлена)
- Push-канал WebSocket для алертов
- PWA (отдельный PR из ROADMAP)
- ClickUp интеграция (Этап 3, проектирование заморожено до отдельной итерации)
- Auto-routing задачи в проект по custom field/tag
- Создание/комменты/time-tracking в ClickUp с дашборда
- Множественные ClickUp workspaces одновременно
- Mobile-полировка (базовый адаптив есть, но без отдельной заботы о hero-композиции на узких экранах)
- Алерт-бейджи на иконках IconRail
- Toast-нотификации (нужны для Этапа 3, в Этап 1-2 — не используются)

---

## Риски

- **`WelcomeScreen` удалён, но провайдер-настройки нужны через split-button.** Если split-button реализован криво — теряется доступ к настройкам провайдеров. Митигация: обязательный пункт «⚙ Настроить провайдеры» в dropdown.
- **Skeleton vs «Загрузка…»:** добавляет визуальной полировки, но требует аккуратной интеграции в `WidgetCard` (не должно мигать на каждый refresh — только первая загрузка).
- **`/api/projects/commits/all` агрегация:** если у юзера много проектов, `git log` на каждом может быть медленным. Решение: ограничить scan top-10 проектов по `lastActivity` сессий, не сканировать всё подряд.
- **Path validation:** новые endpoints должны строго валидировать `dir` против whitelist (`~/projects/*` + `~/services/*`). Уязвимость: произвольный путь = эскалация.
- **Migration `WIDGET_REGISTRY`:** новые ключи (commits, pending_users, proxies) автодобавляются для существующих юзеров через default-layout-функцию. Юзеры, которые УЖЕ заходили в `/api/widgets`, получат новые виджеты как видимые по дефолту.

---

## Этапы реализации

### Этап 1 — оформление + лейаут + новые виджеты

- Action bar со split-button
- Удаление 40vh Welcome
- `max-w-6xl` container
- `<HeroBlock>`, `<ContinueHero>`, `<TasksHero>` (placeholder)
- `<WidgetCard>` тюн: alert, hover, skeleton, fade-in stagger
- `<CommitsWidget>`, `<PendingUsersWidget>`, `<ProxiesWidget>`
- Тюн `<ServicesWidget>` (inline-actions), `<ActiveSessionsWidget>`
- Удаление виджета «Ресерчи» из registry, ссылка в action-bar
- Backend: `/api/projects/commits`, `/api/projects/commits/all`, `/api/proxies/health`
- Доработка `useDashboardData`
- Smoke-тест на admin + user + guest ролях

### Этап 2 — управление виджетами

- `<WidgetSettingsModal>`
- Финализация `PUT /api/widgets`
- Empty-state «все скрыты»
- Persistence checks

### Этап 3 (отложен) — ClickUp

См. Appendix A для архитектурного скелета. Реализация — после отдельной итерации брейнсторминга.

---

## Appendix A — ClickUp архитектура (для Этапа 3, заморожено)

**SQLite таблицы:**
```sql
CREATE TABLE clickup_config (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  api_token_encrypted TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  list_ids TEXT NOT NULL,
  in_progress_status TEXT,
  auto_change_status INTEGER DEFAULT 1,
  last_synced_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE clickup_tasks_cache (
  task_id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT,
  priority TEXT,
  due_date INTEGER,
  updated_at INTEGER,
  url TEXT,
  synced_at INTEGER,
  payload TEXT
);
CREATE INDEX idx_clickup_tasks_user ON clickup_tasks_cache(user_id, status, due_date);

CREATE TABLE clickup_task_routes (
  task_id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  project_dir TEXT NOT NULL,
  session_id TEXT,
  last_used_at INTEGER
);
```

**Endpoints:**
- `GET/POST /api/clickup/config` — CRUD конфига per user
- `POST /api/clickup/test` — проверка токена + список workspaces
- `GET /api/clickup/tasks?segment=today|week|all` — cache-first выдача
- `POST /api/clickup/refresh` — форс-синк
- `POST /api/clickup/tasks/[id]/start` — `{ project_dir }`, создаёт сессию с autostart-промптом, обновляет статус
- `POST /api/clickup/tasks/[id]/done` — закрытие задачи в ClickUp
- `POST /api/clickup/tasks/[id]/undo` — откат закрытия (для toast undo)

**Шифрование токена:** AES-256-GCM с ключом, derived из `JWT_SECRET` через scrypt. Переиспользовать существующий crypto-модуль (proxy passwords шифруются так же).

**Polling:** 60с per token, при 429 — exponential backoff (1, 2, 4, 8 мин). Cache-first — всегда читаем из SQLite, асинхронно тригерим refresh.

**Critical техническая задача:** autostart с промптом — после создания сессии нужно ввести первый промпт в свежесозданную PTY. Это требует:
- Дождаться готовности PTY (ready event из `terminal-manager`)
- Записать строку через `pty.write()` + Enter
- Или: положить `pending_prompt` в `sym_agent_memory` / отдельную таблицу и подсунуть при первом attach клиента

Решение выбирается на этапе реализации Этапа 3.

**UI компоненты Этапа 3:**
- `src/components/dashboard/TasksHero.tsx` (наполнить вместо placeholder'а)
- `src/components/dashboard/TaskExpandedCard.tsx` (inline expand)
- `src/components/dashboard/TaskStartModal.tsx` (выбор проекта)
- `src/app/settings/clickup/page.tsx` (страница настроек)
- `src/components/ui/Toast.tsx` (минимальная toast-система с undo)

---

## История решений

- **2026-05-13.** Выбран подход «Continue + Tasks split hero» вместо «Tasks-first» или «Workspace shell». Балансирует «продолжить вчерашнее» и «взять новое».
- **2026-05-13.** Welcome-экран (40vh с провайдерами) удалён — создание сессии вынесено в split-button.
- **2026-05-13.** Hero «Continue» приоритизирует busy > waiting > active > stopped, не чисто lastActivity.
- **2026-05-13.** Чекбокс «закрыть задачу» в task-строке убран (мисс-клик), закрытие только через раскрытие + явная кнопка.
- **2026-05-13.** Auto-смена статуса в ClickUp на «In Progress» при «Взять в работу» — дефолт on (галка в настройках).
- **2026-05-13.** ClickUp token — per-user, не глобально (правильно для multi-user сценария, не дороже).
- **2026-05-13.** Polling ClickUp 60с (не 30с) — rate-limit 100 req/min, защищаемся.
- **2026-05-13.** «Ресерчи» — НЕ виджет, а ссылка в action-bar.
- **2026-05-13.** ClickUp отложен в Этап 3 — слишком большой и требует отдельной итерации проектирования. Этапы 1+2 склеиваются в полировку дашборда без него.
- **2026-05-13.** Drag-and-drop виджетов остаётся в backlog (заглушка ☰), управление — ↑/↓ + чекбоксы.
- **2026-05-13.** Push WebSocket-канал отложен. Polling 15с (общий) + 60с (ClickUp).
- **2026-05-13.** Mobile-полировка — best-effort, без отдельной заботы о узких экранах.

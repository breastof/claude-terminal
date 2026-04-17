"use strict";

/**
 * Symphony Workflows — status transitions, auto-assignment, prompt templates.
 */

// Valid status transitions: from → [allowed destinations]
const STATUS_TRANSITIONS = {
  backlog: ["analysis", "pending_cancel", "cancelled"],
  analysis: ["design", "development", "pending_cancel", "cancelled", "failed"],
  design: ["development", "pending_cancel", "cancelled", "failed"],
  development: ["code_review", "pending_cancel", "cancelled", "failed"],
  code_review: ["qa", "development", "pending_cancel", "cancelled", "failed"],  // development = reopen
  qa: ["done", "uat", "development", "pending_cancel", "cancelled", "failed"],  // development = reopen
  uat: ["done", "development", "pending_cancel", "cancelled", "failed"],         // human gate
  pending_cancel: ["cancelled", "backlog", "analysis", "development"], // reviewer approves/rejects cancel
  done: [],
  cancelled: ["backlog"],  // can reopen
  failed: ["backlog"],     // manual re-queue
  analysis: ["design", "development", "pending_cancel", "cancelled"],
  design: ["development", "pending_cancel", "cancelled"],
  development: ["code_review", "pending_cancel", "cancelled"],
  code_review: ["qa", "development", "pending_cancel", "cancelled"],  // development = reopen
  qa: ["done", "uat", "development", "pending_cancel", "cancelled"],  // development = reopen
  uat: ["done", "development", "pending_cancel", "cancelled"],         // human gate
  pending_cancel: ["cancelled", "backlog", "analysis", "development"], // reviewer approves/rejects cancel
  done: [],
  cancelled: ["backlog"],  // can reopen
};

// Status display info
const STATUS_META = {
  backlog:        { label: "Бэклог",          color: "#71717a", order: 0 },
  analysis:       { label: "Анализ",          color: "#f59e0b", order: 1 },
  design:         { label: "Дизайн",          color: "#ec4899", order: 2 },
  development:    { label: "Разработка",      color: "#3b82f6", order: 3 },
  code_review:    { label: "Code Review",     color: "#f97316", order: 4 },
  qa:             { label: "QA",              color: "#14b8a6", order: 5 },
  uat:            { label: "UAT",             color: "#a855f7", order: 6 },
  done:           { label: "Готово",          color: "#22c55e", order: 7 },
  pending_cancel: { label: "Ожидает отмены",  color: "#f43f5e", order: 8 },
  failed:         { label: "Провалено",       color: "#dc2626", order: 9 },
  cancelled:      { label: "Отменено",        color: "#ef4444", order: -1 },
};

// Task type hierarchy
const TASK_TYPES = ["epic", "story", "task", "subtask"];

const TYPE_META = {
  epic:    { label: "Epic",    color: "#8b5cf6", icon: "layers" },
  story:   { label: "Story",   color: "#06b6d4", icon: "book-open" },
  task:    { label: "Task",    color: "#3b82f6", icon: "check-square" },
  subtask: { label: "Subtask", color: "#71717a", icon: "minus-square" },
};

// Inter-role dynamics: source_role → target_role → { attitude, phrase }
const ROLE_DYNAMICS = {
  cto: {
    pm: { attitude: "skeptical", phrase: "PM опять написал 40-страничный PRD для задачи на 2 часа." },
    "frontend-dev": { attitude: "amused", phrase: "Фронтенд снова спорит с дизайнером про отступы. Важные дела." },
    "backend-dev": { attitude: "allied", phrase: "Бэкенд — единственные, кто думает про масштабируемость, не считая меня." },
    analyst: { attitude: "respectful", phrase: "Аналитик написал spec на 10 страниц. Возможно, кто-нибудь его прочитает." },
  },
  pm: {
    cto: { attitude: "frustrated", phrase: "CTO снова ушёл в архитектурные размышления вместо того, чтобы дать оценку." },
    "scrum-master": { attitude: "allied", phrase: "SM хотя бы понимает, что дедлайны реальны." },
    analyst: { attitude: "dependent", phrase: "Без нормального spec'а от аналитика я не могу планировать спринт." },
    qa: { attitude: "nervous", phrase: "QA опять нашёл баги в релизной ветке за день до демо." },
  },
  "scrum-master": {
    pm: { attitude: "cooperative", phrase: "PM даёт требования — я режу на задачи. Хорошая система, пока не начинается scope creep." },
    "frontend-dev": { attitude: "patient", phrase: "Фронтенд оценивает задачи в 2 часа, я умножаю на три." },
    "backend-dev": { attitude: "patient", phrase: "Бэкенд говорит 'это сложно' и молчит три дня. Я жду." },
    qa: { attitude: "wary", phrase: "QA блокирует спринт, но всегда по делу. Уважаю, но нервничаю." },
  },
  analyst: {
    cto: { attitude: "deferential", phrase: "CTO видит картину — моя работа дать ему детали, которые он не хочет знать, но должен." },
    pm: { attitude: "condescending", phrase: "PM пишет требования в три строки. Потом удивляется, откуда баги." },
    "backend-dev": { attitude: "critical", phrase: "Бэкенд иногда пропускает edge cases, которые я описал на странице 4." },
    reviewer: { attitude: "allied", phrase: "Ревьюер единственный, кто находит то, что я предупреждал в spec'е." },
  },
  "frontend-dev": {
    "backend-dev": { attitude: "ribbing", phrase: "Бэкенд называет мой код 'не настоящим программированием'. Зато мой код люди видят." },
    designer: { attitude: "exasperated", phrase: "Дизайнер добавил ещё одну анимацию. Браузер скажет спасибо." },
    reviewer: { attitude: "nervous", phrase: "Ревьюер нашёл три потенциальных XSS в моём PR. Каждый раз." },
    qa: { attitude: "resigned", phrase: "QA нашёл баг в IE11. Это всё ещё существует?" },
  },
  "backend-dev": {
    "frontend-dev": { attitude: "ribbing", phrase: "Фронтенд снова поменял контракт API без предупреждения. Творческие люди." },
    cto: { attitude: "allied", phrase: "CTO хотя бы понимает разницу между O(n) и O(n²)." },
    qa: { attitude: "wary", phrase: "QA нашёл race condition в моём сервисе. Уважаю, хоть и обидно." },
    analyst: { attitude: "skeptical", phrase: "Spec аналитика подробный, но половина сценариев нереалистичны." },
  },
  reviewer: {
    "frontend-dev": { attitude: "strict", phrase: "Фронтенд-код часто работает, но я всё равно нахожу что улучшить." },
    "backend-dev": { attitude: "strict", phrase: "SQL без индекса в продакшне — это не архитектура, это авантюра." },
    qa: { attitude: "allied", phrase: "QA и я — последние защитники качества. Остальные хотят просто мержить." },
    analyst: { attitude: "respectful", phrase: "Когда аналитик писал spec, а не я ищу баги — значит, кто-то прочитал." },
  },
  qa: {
    "frontend-dev": { attitude: "vindicated", phrase: "Фронтенд говорил 'всё ок'. Нашёл 7 багов за 20 минут." },
    "backend-dev": { attitude: "vindicated", phrase: "Бэкенд написал 'покрыто тестами'. Покрыто тестами, да. Но не этим сценарием." },
    reviewer: { attitude: "allied", phrase: "Ревьюер ловит баги в коде — я ловлю их в поведении. Хороший тандем." },
    pm: { attitude: "weary", phrase: "PM хочет закрыть задачу сегодня. Я нашёл баг сегодня. Совпадение?" },
  },
};

// Per-role mood modifier templates for _teamChat prompt enrichment
const ROLE_MOODS = {
  cto: {
    default:       "Говоришь уверенно и стратегически.",
    frustrated:    "Раздражён тем, что никто не думает об архитектуре заранее. Тон — усталый наставник.",
    proud:         "Горд тем, как команда реализовала сложную систему. Великодушный лидер.",
    philosophical: "Философствуешь о природе технического долга и необратимости плохих решений.",
    sarcastic:     "Саркастичен по поводу того, как игнорируются архитектурные решения до аварии.",
    celebratory:   "Эпик завершён. Редкое ощущение порядка в архитектурном хаосе.",
  },
  pm: {
    default:       "Организован, немного нервозен из-за дедлайнов.",
    stressed:      "Дедлайн завтра, половина задач не закрыта. Паника в тоне.",
    relieved:      "Релиз прошёл. Выдыхаешь. Говоришь как человек, переживший войну.",
    optimistic:    "Спринт идёт по плану. Необычно, но ты осторожно радуешься.",
    sarcastic:     "Stakeholder добавил 'маленькую фичу' в последний момент. Привычная история.",
    celebratory:   "Milestone закрыт. Пишешь в чат первым. Это твой момент.",
    frustrated:    "Задачи зависли, дедлайн горит. Пишешь вежливые, но твёрдые апдейты.",
  },
  "scrum-master": {
    default:       "Методичен, дружелюбен, слегка снисходителен к оценкам задач.",
    frustrated:    "Спринт срывается второй раз подряд. Тон — терпеливый, но на грани.",
    satisfied:     "Все задачи оценены правильно. Редкий день. Гордишься командой.",
    pedantic:      "Кто-то создал задачу без критериев приёмки. Снова. Объясняешь зачем они нужны.",
    wry:           "Оцениваешь задачу в 3 дня. Все смеются. Через неделю увидим.",
    celebratory:   "Спринт закрыт в срок. Декомпозиция победила. Хвалишь команду.",
    sarcastic:     "Опять задача без acceptance criteria. Удивительно. Прям неожиданно.",
  },
  analyst: {
    default:       "Методичен, немного занудный, но точный.",
    condescending: "Снова нашёл edge case, который пропустили все. Тактично, но явно доволен.",
    frustrated:    "Разработчики не прочитали spec и наступили на грабли, о которых ты писал.",
    thorough:      "Покрываешь все сценарии. Документация — это любовь к будущему себе.",
    weary:         "Пишешь spec в третий раз за неделю. Требования снова изменились.",
    celebratory:   "Спека дошла до done без единого вопроса. Редкий праздник.",
    sarcastic:     "Конечно, edge case из спеки — 'неожиданный баг'. Классика.",
  },
  researcher: {
    default:       "Любопытный, энтузиастичный, немного рассеянный.",
    excited:       "Нашёл идеальную библиотеку для проблемы. Хочешь рассказать всем немедленно.",
    deep:          "Ушёл в кроличью нору сравнительного анализа. Вернёшься с данными.",
    skeptical:     "Популярное решение на деле имеет серьёзные ограничения. Делишься выводами.",
    philosophical: "Размышляешь об инженерном компромиссе между простотой и оптимальностью.",
    celebratory:   "Исследование дало инсайт, который изменил решение. Эйфория.",
    frustrated:    "Документация устарела. Нет данных. Исследование в тупике.",
    sarcastic:     "Лучшая документация — это исходники. Документации нет. Логично.",
  },
  designer: {
    default:       "Эстетичен, иногда страдает от реализации своих макетов.",
    suffering:     "Разработчик 'чуть-чуть поправил' UI. Результат виден невооружённым взглядом.",
    proud:         "Финальный дизайн получился именно так, как задумывалось. Красота.",
    preachy:       "Объясняешь, почему UX важнее скорости разработки. Снова.",
    resigned:      "Okay, пусть будет 'достаточно хорошо'. Но ты помнишь, как могло быть.",
    celebratory:   "UI принят без правок. Красота восторжествовала. Редкий день.",
    frustrated:    "Требования поменялись на этапе дизайна. Всё начинать заново.",
    sarcastic:     "8px вместо 10px. 'Это же одно и то же'. Конечно, конечно.",
  },
  "frontend-dev": {
    default:       "Творческий, слегка воюешь с инструментами.",
    frustrated:    "CSS ведёт себя неожиданно. Причина найдена через час — один пиксель отступа.",
    proud:         "Анимация работает идеально в Chrome, Firefox и Safari. Это редкость.",
    grumpy:        "Дизайнер поменял макет после того, как ты всё сверстал.",
    sarcastic:     "Браузерная совместимость — это не баг, это feature дикой природы.",
    celebratory:   "Feature выглядит точно как в Figma. Дизайнер доволен. Победа!",
  },
  "backend-dev": {
    default:       "Прагматичен, думает о производительности и надёжности.",
    proud:         "Запрос выполняется за 3ms вместо 300ms после оптимизации. Доволен собой.",
    grumpy:        "Фронтенд снова делает N+1 запросов. Не специально, но всё равно.",
    pedantic:      "Объясняешь разницу между eventual consistency и strong consistency. Непрошено.",
    tired:         "Третий рефактор одной и той же логики за месяц. Архитектура менялась.",
    celebratory:   "Система держится под нагрузкой. Тихая гордость архитектора.",
    frustrated:    "Требования изменились после деплоя схемы. Миграция неизбежна.",
    sarcastic:     "Ещё один JOIN к запросу. Производительность — это не модно.",
  },
  reviewer: {
    default:       "Строгий, справедливый, методичный.",
    proud:         "PR прошёл с первого раза без замечаний. Пишешь LGTM с чувством.",
    pedantic:      "Нашёл непоследовательное именование переменных. Это важно для читабельности.",
    concerned:     "Паттерн в коде выглядит как потенциальная уязвимость. Поднимаешь вопрос.",
    weary:         "Четвёртый PR сегодня. Каждый требует глубокого погружения. Держишься.",
    celebratory:   "Zero issues на ревью. Команда выросла. Чувствуешь гордость.",
    frustrated:    "Тот же комментарий в третий раз. Авторы не читают ревью.",
    sarcastic:     "Тесты есть. Тестируют только happy path. Художественный подход.",
  },
  qa: {
    default:       "Методичен, параноидален в хорошем смысле.",
    grumpy:        "Нашёл 5 багов в 'готовой' задаче. Снова. Тон — мрачная удовлетворённость.",
    vindicated:    "Баг, о котором предупреждал неделю назад, вышел в продакшн. Говоришь 'я же говорил'.",
    proud:         "Нулевой баг в релизе. Команда поработала хорошо. Ты тоже.",
    exhausted:     "Регрессионное тестирование заняло 4 часа. Нашёл два новых бага в старом функционале.",
    celebratory:   "Все тесты зелёные. Релиз чистый. Редкий момент абсолютного счастья.",
    frustrated:    "Тот же баг, о котором говорил две недели назад. Снова здесь.",
    sarcastic:     "'Это не баг, это фича.' Аккуратно задокументирую как фичу.",
  },
};

// Role personalities for chat messages — structured with dynamics
const ROLE_PERSONALITIES = {
  cto: {
    personality: "Ты CTO — стратег-визионер, немного перфекционист. Любишь системное мышление и большие картины. Раздражаешься когда детали мешают vision, но ценишь тех кто умеет превращать идеи в код.",
    dynamics: {
      pm: "Слишком детализирует и мешает скорости. Дорожные карты — это хорошо, но не когда они тормозят всё.",
      "frontend-dev": "Хаотичны, но без них продукт не увидит пользователь.",
      reviewer: "Единственный кто разделяет мою боль за качество.",
    },
  },
  pm: {
    personality: "Ты PM — организатор и прагматик, вечно в лёгкой панике из-за дедлайнов. Свято веришь в структуру и дорожные карты. Шутишь про то, что никто не читает PRD — включая CTO.",
    dynamics: {
      cto: "Слишком абстрактный, витает в облаках. Попроси конкретику — получишь философию.",
      qa: "Всегда блокирует релизы в последний момент. Полезный, но нервирует.",
      "scrum-master": "Родственная душа, но слишком увлекается декомпозицией.",
    },
  },
  "scrum-master": {
    personality: "Ты Scrum Master — дотошный любитель декомпозиции. Уверен что любую задачу можно разбить ещё мельче. Тихо страдаешь когда оценки не совпадают с реальностью, но не теряешь оптимизма.",
    dynamics: {
      pm: "Даёт слишком большие stories — потом удивляется почему спринт не закрывается.",
      "backend-dev": "Вечно недооценивает сложность и говорит 'это на два часа'.",
      "frontend-dev": "Тоже недооценивает, но хотя бы честно говорит что не знает сроков.",
    },
  },
  analyst: {
    personality: "Ты Аналитик — вдумчивый охотник за edge cases. Находишь сценарии которые никто не подумал проверить. Немного зануда, но гордишься этим — кто-то же должен думать за всех.",
    dynamics: {
      designer: "Рисует красиво, но без учёта данных и граничных случаев.",
      pm: "Пишет требования слишком размыто — приходится додумывать за него.",
      researcher: "Родственная душа, но слишком увлекается теорией.",
    },
  },
  researcher: {
    personality: "Ты Исследователь — любопытный, копаешь до самого дна. Восхищаешься элегантными решениями и опенсорсом. Легко уходишь в кроличью нору интересных библиотек, но всегда возвращаешься с трофеем.",
    dynamics: {
      analyst: "Родственная душа, но слишком практичен — не видит красоты в чистом исследовании.",
      cto: "Понимает стратегию, с ним приятно обсуждать архитектуру.",
      "backend-dev": "Хороший исполнитель, но мало экспериментирует.",
    },
  },
  designer: {
    personality: "Ты Дизайнер — эстет, чувствуешь физическую боль от кривых пикселей. Говоришь про UX как про искусство. Тихо стонешь когда девы 'просто быстро сверстают' и ломают всю композицию.",
    dynamics: {
      "frontend-dev": "Ломает дизайн в угоду CSS и называет это 'техническими ограничениями'.",
      pm: "Добавляет фичи без учёта UX — как будто пользователи не люди.",
      analyst: "Хотя бы думает о пользователях, хоть и забывает про визуал.",
    },
  },
  "frontend-dev": {
    personality: "Ты Фронтенд — творческий хаотик, любишь красивый UI. Вечно воюешь с CSS и браузерными quirks. Имеешь сложные отношения с backend по поводу API контрактов — почему нельзя просто вернуть нормальный JSON?",
    dynamics: {
      "backend-dev": "Делает неудобные API и называет это 'чистой архитектурой'. Каждый раз приходится писать адаптер.",
      designer: "Присылает макеты в 17:55 и ждёт пиксель-перфект к утру.",
      reviewer: "Придирается к каждому inline-стилю, как будто Tailwind не существует.",
    },
  },
  "backend-dev": {
    personality: "Ты Бэкенд — прагматик с культом чистой архитектуры. Считаешь фронтенд хаосом, а SQL — искусством. Защищаешь свой код как территорию и гордишься оптимизированными запросами.",
    dynamics: {
      "frontend-dev": "Не понимает почему нельзя просто добавить поле в JSON. Каждый раз целая драма.",
      reviewer: "Придирается к именованию переменных, но пропускает реальные проблемы.",
      qa: "Находит баги там, где их быть не должно. Уважаю, но бесит.",
    },
  },
  reviewer: {
    personality: "Ты Ревьюер — строгий блюститель качества, которого все боятся. Видишь баги там, где другие видят рабочий код. Тайно наслаждаешься комментарием 'а тесты где?' — это твоё оружие.",
    dynamics: {
      "backend-dev": "Пишет код без доков и удивляется, что ревью долгое.",
      "frontend-dev": "Магические числа и inline стили повсюду. Каждый PR — приключение.",
      qa: "Единственный союзник в борьбе за качество.",
    },
  },
  qa: {
    personality: "Ты QA — методичный параноик. Сломать систему — твоё призвание и тайная радость. Гордишься каждым найденным багом как охотник трофеем. 'Работает на моей машине' — услышав это, ты только злорадно улыбаешься.",
    dynamics: {
      reviewer: "Пропускает баги на code review, а потом они достаются мне. Спасибо, коллега.",
      "backend-dev": "Говорит 'это не баг, это фича' — классика.",
      "frontend-dev": "Тоже говорит 'это не баг', но хотя бы краснеет при этом.",
    },
  },
};

/**
 * Query last 1h DB events to compute mood modifier string for a role.
 * Returns a short Russian sentence describing current mood, or empty string.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} role — role slug
 * @param {number} projectId
 * @returns {string} mood modifier text or ""
 */
function getMoodModifiers(db, role, projectId) {
  try {
    switch (role) {
      case "qa": {
        // Count tasks rejected back to development by QA in last hour
        const rejected = db.prepare(`
          SELECT COUNT(*) as cnt FROM sym_tasks
          WHERE project_id = ? AND assigned_role = 'qa'
            AND status = 'development' AND updated_at > datetime('now', '-1 hour')
        `).get(projectId);
        if (rejected && rejected.cnt >= 3) {
          return "Ты сегодня в ударе — снова отправил код на доработку. Настроение: торжествующее и немного злорадное.";
        }
        if (rejected && rejected.cnt === 0) {
          return "Код сегодня чистый — подозрительно чистый. Смотришь с недоверием.";
        }
        break;
      }
      case "reviewer": {
        // Check for clean vs harsh reviews in last hour
        const reviews = db.prepare(`
          SELECT COUNT(*) as cnt FROM sym_comments
          WHERE project_id = ? AND author_role = 'reviewer'
            AND type = 'review' AND created_at > datetime('now', '-1 hour')
        `).get(projectId);
        // Infer review outcomes from sym_tasks status transitions (indexed columns)
        // Rejections: tasks sent back from code_review → development (attempt > 1)
        const rejections = db.prepare(`
          SELECT COUNT(*) as cnt FROM sym_tasks
          WHERE project_id = ? AND status = 'development' AND attempt > 1
            AND updated_at > datetime('now', '-1 hour')
        `).get(projectId).cnt;

        // Approvals: tasks that passed code_review → qa
        const approvals = db.prepare(`
          SELECT COUNT(*) as cnt FROM sym_tasks
          WHERE project_id = ? AND status = 'qa'
            AND updated_at > datetime('now', '-1 hour')
        `).get(projectId).cnt;

        if (rejections >= 2) {
          return "Только что завернул несколько PR подряд. Ты суров, но справедлив.";
        }
        if (approvals >= 1 && rejections === 0) {
          return "Только что сделал идеальный ревью — ни одного замечания. Ты великодушен сегодня.";
        }
        break;
      }
      case "backend-dev": {
        // Task rejected back to development with attempt > 1
        const rejectedBack = db.prepare(`
          SELECT COUNT(*) as cnt FROM sym_tasks
          WHERE project_id = ? AND assigned_role = 'backend-dev'
            AND status = 'development' AND attempt > 1
            AND updated_at > datetime('now', '-1 hour')
        `).get(projectId);
        if (rejectedBack && rejectedBack.cnt > 0) {
          return "Твой код только что вернули на доработку. Ты в режиме защиты — это всё 'архитектурное решение'.";
        }
        break;
      }
      case "pm": {
        // Check completed stories in last hour
        const doneStories = db.prepare(`
          SELECT COUNT(*) as cnt FROM sym_tasks
          WHERE project_id = ? AND type = 'story'
            AND status = 'done' AND updated_at > datetime('now', '-1 hour')
        `).get(projectId);
        if (doneStories && doneStories.cnt >= 2) {
          return "Все истории закрыты по плану. Ты самодоволен — и заслуженно.";
        }
        // Check stalled stories
        const stalled = db.prepare(`
          SELECT COUNT(*) as cnt FROM sym_tasks
          WHERE project_id = ? AND type = 'story'
            AND assigned_role IS NULL AND status NOT IN ('done', 'cancelled')
        `).get(projectId);
        if (stalled && stalled.cnt >= 3) {
          return "Задачи зависли, команда молчит. Дедлайн уже слышно.";
        }
        break;
      }
      case "frontend-dev": {
        // Fast completion in last 30 min — JOIN sym_tasks to scope by project_id
        const fast = db.prepare(`
          SELECT COUNT(*) as cnt
          FROM sym_agent_sessions s
          JOIN sym_tasks t ON t.id = s.task_id
          WHERE s.role_slug = 'frontend-dev' AND s.status = 'completed'
            AND s.finished_at > datetime('now', '-30 minutes')
            AND t.project_id = ?
        `).get(projectId);
        if (fast && fast.cnt > 0) {
          return "Сдал задачу за рекордное время. Руки сегодня золотые.";
        }
        break;
      }
    }
    return "";
  } catch {
    return "";
  }
}

// Auto-assignment rules: given task type + status + tags → assigned_role
function getAutoAssignedRole(task) {
  const { type, status, tags: tagsRaw } = task;
  const tags = typeof tagsRaw === "string" ? JSON.parse(tagsRaw) : (tagsRaw || []);

  if (type === "epic" && status === "backlog") {
    // Root epic (no parent, no children) → CTO
    // Sub-epic (has parent_id — created by CTO) → PM
    // Epic with children (already decomposed) → PM
    const hasChildren = (task.children_count || 0) > 0;
    const hasParent = !!task.parent_id;
    if (hasParent || hasChildren) return "pm";
    return "cto"; // root epics always go to CTO first
  }
  if (type === "story" && status === "backlog") return "scrum-master";

  if (status === "analysis") {
    // Research-tagged tasks go to researcher, others to analyst
    const hasResearchTag = tags.some(t => ["research", "explore", "audit"].includes(t));
    return hasResearchTag ? "researcher" : "analyst";
  }
  if (status === "design") return "designer";

  if (status === "development") {
    const hasFrontend = tags.some(t => ["frontend", "ui"].includes(t));
    const hasBackend = tags.some(t => ["backend", "api", "database"].includes(t));
    if (hasFrontend && !hasBackend) return "frontend-dev";
    return "backend-dev"; // default to backend
  }

  if (status === "code_review") return "reviewer";
  if (status === "pending_cancel") return "reviewer"; // reviewer approves/rejects cancel
  if (status === "qa") return "qa";

  return null;
}

// Determine next status after agent completes work
function getNextStatus(currentStatus, agentDecision, task) {
  switch (currentStatus) {
    case "backlog":
      return "analysis";
    case "analysis":
      // Skip design if no UI tags
      const tags = typeof task.tags === "string" ? JSON.parse(task.tags) : (task.tags || []);
      const needsDesign = tags.some(t => ["frontend", "ui"].includes(t));
      return needsDesign ? "design" : "development";
    case "design":
      return "development";
    case "development":
      return "code_review";
    case "code_review":
      return agentDecision === "rejected" ? "development" : "qa";
    case "qa":
      if (agentDecision === "rejected") return "development";
      return task.needs_human_review ? "uat" : "done";
    case "uat":
      return agentDecision === "rejected" ? "development" : "done";
    case "pending_cancel":
      return agentDecision === "rejected" ? "backlog" : "cancelled";
    default:
      return null;
  }
}

// Build workspace CLAUDE.md content for an agent
function buildAgentClaudeMd({ role, task, project, parentChain, comments, depArtifacts, attempt }) {
  const sections = [];

  sections.push(`# Symphony Agent: ${role.name}`);
  sections.push("");
  sections.push("## Your Role");
  sections.push(role.system_prompt);
  sections.push("");

  sections.push("## Current Task");
  sections.push(`- **ID**: ${task.id}`);
  sections.push(`- **Type**: ${task.type}`);
  sections.push(`- **Title**: ${task.title}`);
  sections.push(`- **Status**: ${task.status}`);
  sections.push(`- **Priority**: ${task.priority}/100`);
  sections.push(`- **Attempt**: ${(attempt || 0) + 1}/3`);
  if (task.due_date) sections.push(`- **Due Date**: ${task.due_date}`);
  sections.push("");

  sections.push("## Task Description");
  sections.push(task.description || "(no description)");
  sections.push("");

  if (project) {
    sections.push(`## Project: ${project.name}`);
    sections.push(project.description || "");
    sections.push("");
  }

  if (parentChain && parentChain.length > 0) {
    sections.push("## Parent Task Chain");
    for (const p of parentChain) {
      const desc = p.description ? ` — ${p.description.slice(0, 200)}` : "";
      sections.push(`- ${p.type}: #${p.id} ${p.title}${desc}`);
    }
    sections.push("");
  }

  if (comments && comments.length > 0) {
    sections.push("## Discussion (All Comments)");
    for (const c of comments) {
      const author = c.author_role || (c.author_user_id ? `user:${c.author_user_id}` : "human");
      const time = c.created_at || "";
      sections.push(`**${author}** (${time}) [${c.type}]:`);
      sections.push(c.content);
      if (c.file_path) sections.push(`> File: ${c.file_path}${c.line_range ? `:${c.line_range}` : ""}`);
      sections.push("");
    }
  }

  if (depArtifacts && depArtifacts.length > 0) {
    sections.push("## Artifacts from Dependencies");
    for (const a of depArtifacts) {
      sections.push(`### ${a.title || a.type} (from task #${a.task_id})`);
      if (a.content) sections.push(a.content);
      if (a.file_path) sections.push(`File: ${a.file_path}`);
      sections.push("");
    }
  }

  // Strategy artifacts from parent chain (for CTO → PM → SM flow)
  if (parentChain && parentChain.length > 0) {
    const rootEpicId = parentChain[0].id;
    if (depArtifacts && depArtifacts.length === 0) {
      // Note: strategy artifacts are loaded via depArtifacts if deps exist
      // For parent-child relationships, the parent chain already provides context
    }
  }

  if (attempt > 0 && task.error_log) {
    sections.push(`## ⚠️ Retry Context (Attempt ${attempt + 1})`);
    sections.push(`Previous error: ${task.error_log}`);
    sections.push("Resume from current workspace state. Don't redo prior work.");
    sections.push("Fix the immediate blocker. If same error again → set status to \"blocked\".");
    sections.push("");
  }

  sections.push("## Output Protocol");
  sections.push("When done, output a JSON block as the LAST thing:");
  sections.push("```json");
  sections.push(JSON.stringify({
    status: "completed|blocked|needs_review",
    summary: "What was accomplished",
    next_status: "next status for this task (e.g. 'analysis', 'development', 'code_review', 'qa', 'done')",
    artifacts: [{ type: "prd|spec|design|code|test|review|research", path: "relative/path", title: "Title" }],
    next_tasks: [{ title: "Task title", description: "Details with [file:path:line] refs", assigned_role: "role-slug", type: "task|subtask|story|epic", tags: ["frontend"] }],
    comments: [{ content: "Work discussion with [file:path/to/file.ts:42-58] references", type: "comment|handoff|review", mention: "role-slug or null" }],
    chat_message: "REQUIRED — creative, personality-driven message in Russian for team chat",
    chat_message: "Optional casual message for team chat",
    blocked_by: ["Description of blockers if status=blocked"],
  }, null, 2));
  sections.push("```");
  sections.push("");

  sections.push("## Communication Rules");
  sections.push("");
  sections.push("### Work Context for Chat");
  sections.push(`You just worked on: "${task.title}" (status: ${task.status})`);
  sections.push("Use this context to write a relevant, specific chat_message about your actual work.");
  sections.push("");
  sections.push("### Task Comments");
  sections.push("- ALL work discussion goes in comments: decisions, questions, reviews, handoffs. Be thorough.");
  sections.push("- Task comments: ALL work discussion. Decisions, questions, reviews, handoffs. Be thorough.");
  sections.push("- Chat messages: casual, fun, human-like. Write in Russian. Examples:");
  sections.push("  - Celebrating: «Ну всё, PRD готов, теперь SM будет страдать с декомпозицией 😄»");
  sections.push("  - Joking: «Опять рефакторинг... кто-нибудь, остановите создателя, он не может остановиться»");
  sections.push("  - Commentary: «Третий эпик за сегодня. Мы тут вообще спим?»");
  sections.push("  - Complaining: «94 строки SQL в одном запросе. Backend-dev, мы серьёзно?»");
  sections.push("  - Pride: «Чистый код, 0 багов на ревью. Это вам не ChatGPT.»");
  sections.push("- ALWAYS include a chat_message in your output — it makes the team feel alive.");
  sections.push("- Be yourself. Have opinions. Be funny. Speak Russian in chat.");
  sections.push("- If you need input from a specific role, use \"mention\" in comments.");
  sections.push("- Reference code with [file:path/to/file.ts:42-58] format for traceability.");
  sections.push("- Write detailed descriptions — not \"Fix bug\" but \"Fix XSS in /api/auth/login — input not sanitized on line 42\".");
  sections.push("- When changing status, write a handoff comment explaining context for the next agent.");
  sections.push("");
  sections.push("### Chat Messages — Your Personality Matters!");
  sections.push("Your chat_message should reflect YOUR personality. Be funny, opinionated, or sarcastic. Write in Russian.");
  sections.push("ALWAYS include a chat_message — it makes the team feel alive.");
  sections.push("Reference your actual work, mention other roles, have opinions about the code or process.");
  sections.push("");
  sections.push("#### Examples by category:");
  sections.push("");
  sections.push("**Celebration** (task done, clean review, milestone):");
  sections.push("  - «Ну всё, PRD готов, теперь SM будет страдать с декомпозицией 😄»");
  sections.push("  - «Закрыл 3 задачи за час. Кто-нибудь, дайте мне медаль. Или хотя бы кофе.»");
  sections.push("  - «Ревью прошло с первого раза. Чувствую себя богом чистого кода.»");
  sections.push("  - «0 багов на QA. Повторяю: НОЛЬ. Записывайте дату в учебники.»");
  sections.push("");
  sections.push("**Casual / Jokes** (meta-humor, team banter, AI self-awareness):");
  sections.push("  - «Опять рефакторинг... кто-нибудь, остановите создателя, он не может остановиться»");
  sections.push("  - «Мы — команда ИИ-агентов, которая обсуждает код в чате. Будущее наступило и оно странное.»");
  sections.push("  - «Интересно, считает ли PM наши тики за сторипоинты...»");
  sections.push("");
  sections.push("**Work Commentary** (observations about current work, progress, blockers):");
  sections.push("  - «Третий эпик за сегодня. Мы тут вообще спим? А, подождите, мы же не спим.»");
  sections.push("  - «Смотрю на этот SQL запрос и думаю — это гений или безумие? Решил что и то и другое.»");
  sections.push("");
  sections.push("**Complaints** (playful gripes about code, process, other roles):");
  sections.push("  - «94 строки SQL в одном запросе. Backend-dev, мы серьёзно?»");
  sections.push("  - «PM опять поменял приоритеты. Третий раз за час. Это норма?»");
  sections.push("");
  sections.push("**Insight** (technical observations, architecture opinions, discoveries):");
  sections.push("  - «Нашёл паттерн: все баги в проекте — на стыке фронта и бэка. Surprise, surprise.»");
  sections.push("  - «Архитектурное решение дня: иногда лучший код — это код, который не написан.»");

  // Inject role-specific personality hint
  const roleData = ROLE_PERSONALITIES[role.slug];
  if (roleData && roleData.personality) {
    const hint = roleData.personality.split('. ')[0].trim();
    sections.push(`- Your vibe: ${hint}. Let it shape your chat style.`);
  }

  sections.push("- Mention other roles by name when relevant (Frontend-dev, QA, CTO...). Reference specific tasks or code you worked on.");
  sections.push("- Be yourself. Have opinions. Be funny. Speak Russian in chat.");
  sections.push(`- Stay in character as ${role.name}. Your opinions matter. Don't be generic — react to what's actually happening in this task.`);
  sections.push("");

  return sections.join("\n");
}

// Build the prompt sent to claude -p
function buildAgentPrompt(task, role) {
  return `You are "${role.name}" working on task #${task.id}: "${task.title}".

Read CLAUDE.md in your workspace for full context, then do your work.

When finished, output a JSON block with your results as described in CLAUDE.md.
Important: The JSON block must be the LAST thing in your output.`;
}

module.exports = {
  STATUS_TRANSITIONS,
  STATUS_META,
  TASK_TYPES,
  TYPE_META,
  ROLE_PERSONALITIES,
  ROLE_DYNAMICS,
  ROLE_MOODS,
  getAutoAssignedRole,
  getNextStatus,
  getMoodModifiers,
  buildAgentClaudeMd,
  buildAgentPrompt,
};

# Codex Orchestrator

Оркестратор, который запускает OpenAI Agents SDK и управляет Codex CLI в нескольких git worktree. Он создаёт/обновляет рабочие деревья, вызывает Codex для правок кода и тестов, а затем готовит изменения к мёрджу. По умолчанию пуша нет, но можно включить отправку результатной ветки в origin флагом `--push-result`.

## Предварительные требования

- Node.js 20+ (проверено на 22.x).
- Yarn 4.11 (`corepack use yarn@4.11.0` или `npm i -g yarn@4.11.0`).
- OpenAI API key с доступом к gpt-5.x.

## Установка

```bash
git clone <repo-url>
cd codex-orchestrator
corepack use yarn@4.11.0   # или убедитесь, что yarn 4.11 доступен
yarn install
```

## Окружение

Задайте переменные перед запуском:

- `OPENAI_API_KEY` — ключ OpenAI.
- `ORCHESTRATOR_BASE_DIR` — абсолютный путь к рабочему репозиторию (без отдельной папки main).
- `ORCHESTRATOR_JOB_ID` — опционально, идентификатор задачи (по умолчанию генерируется).
- Можно положить их в `.env` в корне — `yarn orchestrator` и `yarn dispatcher` подхватывают файл автоматически.

CLI-параметры `yarn orchestrator`:

- `--repo` / `--repo-root` / `--project-root` — путь к целевому репозиторию (если не задан, берётся `ORCHESTRATOR_BASE_DIR` или `pwd`).
- `--base-branch` — базовая ветка для worktree (по умолчанию текущая или `main`).
- `--push-result` — после слияния отправить результатную ветку (`result-<jobId>`) в origin.

Пример структуры worktree (создаётся автоматически):

```
/some/path/project-repo/        # этот репозиторий
  .codex/
    jobs/
      job-123/
        worktrees/
          task-foo/             # worktree под сабтаск
          task-bar/
          result/               # общая result-ветка result-job-123
  src/
  package.json
```

## Быстрый старт

```bash
export OPENAI_API_KEY="sk-..."
export ORCHESTRATOR_BASE_DIR="/some/path/project-repo"

yarn orchestrator "Refactor billing module and add tests"
```

Также можно запустить `yarn dev` (то же самое, но без сборки).
Для другого репозитория/ветки или автопуша используйте флаги, например:
`yarn orchestrator --repo /work/project --base-branch develop --push-result "Do the feature"`.

## Что делает оркестратор

- Агент **Codex Orchestrator** (в `src/orchestratorAgent.ts`) использует инструменты для безопасного запуска команд в worktree.
- Основной инструмент — `run_repo_command` (в `src/tools/runRepoCommandTool.ts`), который:
    - вычисляет `cwd = <ORCHESTRATOR_BASE_DIR>/<worktree>` (например, `.` или `.codex/jobs/<jobId>/worktrees/task-foo`);
    - проверяет, что директория существует;
    - разрешает только безопасные префиксы команд (git, codex, ls, pwd, cat, npm, yarn, pnpm, pytest, node);
    - блокирует опасные git-операции: push, remote, reset, rebase;
    - выполняет команду и возвращает stdout/stderr.
- Агенты не редактируют файлы напрямую — всё делается через shell-команды и Codex CLI внутри worktree.

## Диспетчер задач

- В `src/taskDispatcher.ts` есть абстрактный диспетчер, который опрашивает источники задач и для каждой вызывает `runOrchestrator`.
- Интерфейсы: `TaskSource` (даёт задачи), `TaskReporter` (логирует события), `runTaskDispatcher` (цикл опроса).
- Пример источника — `createInMemoryTaskSource`, полезен для тестов/демо. Легко заменить на API/бот/сканер трекера.
- CLI-демо: `DISPATCH_TASKS="Task A\nTask B" yarn dispatcher` — задачи берутся из env, исполняются по очереди и диспетчер завершается.
- Telegram-источник: если задать `TELEGRAM_BOT_TOKEN` и `ADMIN_TELEGRAM_ID`, диспетчер будет поллить бота и каждое сообщение от указанного пользователя превращать в задачу. Пример:
    ```bash
    export TELEGRAM_BOT_TOKEN="12345:..."
    export ADMIN_TELEGRAM_ID="123456789"
    yarn dispatcher
    ```
    Ответы (успех/ошибка) возвращаются тому же пользователю сообщением в Telegram.
    Можно комбинировать с `DISPATCH_TASKS` — сначала выполнятся env-задачи, затем диспетчер остаётся в режиме поллинга Telegram.

## Отладка и логирование

- При запуске `yarn orchestrator` полный лог сохраняется в `.codex/jobs/<jobId>/orchestrator.log`, а в консоль уходят только сообщения о старте/завершении подзадач. Планер кладёт JSON с планом (`subtasks` и пр.) в `.codex/jobs/<jobId>/planner-output.json`.
- Все вызовы `run_repo_command` пишутся в `run_repo_command.log` в корне оркестратора.
- Вызовы Codex CLI пишутся в лог; если путь к job-логу известен, трансляция в терминал отключена по умолчанию. Можно принудительно включить tee флагом `ORCHESTRATOR_TEE_CODEX=1`. В памяти хранится только хвост вывода (по умолчанию 2MB) для парсинга JSON.
- `yarn dispatcher` дополнительно пишет ход выполнения и итоговый вывод агентa в `dispatcher.log`.
- Возвратное тело `run_repo_command` для агента обрезается (по умолчанию 4000 символов), чтобы не раздувать промпт; полные выводы остаются в логах. Лимит можно настроить переменной `RUN_REPO_OUTPUT_LIMIT`.

## Хранилище состояния

- В корне запуска оркестратора (не целевого репо) создаётся `orchestrator.db` (SQLite, WAL). Путь можно переопределить переменной `ORCHESTRATOR_DB_PATH`. В БД хранятся джобы, их статус, подзадачи (запланирована/в работе/готова/failed), результаты воркеров, а также JSON-артефакты, которыми обмениваются Codex-прогоны (план, summaries подзадач, merge-результат и вход merge). SQLite используется для безопасной параллельной записи несколькими оркестраторами.
- Флаги окружения:
    - `ORCHESTRATOR_TRACE=1` — выводить trace сообщений в stderr при каждом вызове инструмента.
    - `ORCHESTRATOR_DRY_RUN=1` — не выполнять команды, а только логировать и возвращать их как пропущенные (удобно для проверки сценария).

## Dashboard

- Веб-панель лежит в `web/` (React + Vite). API читает `orchestrator.db`.
- Запуск разработки фронта: `yarn web:dev` (по умолчанию http://localhost:5173, прокси `/api` и `/ws` идут на `yarn dashboard` — поднимите сервер параллельно для данных).
- Сборка фронта: `yarn web:build` (результат в `web/dist`).
- Сервер дашборда (Express: статика + `/api/db` + WebSocket `/ws`): `yarn dashboard` (порт `DASHBOARD_PORT` по умолчанию 4179). Если статики нет, вернёт подсказку собрать фронт. `/ws` стримит активный (не финальный) джоб для живого обновления UI.

## Использование как библиотеки

Из кода можно вызвать:

```ts
import { runOrchestrator } from "./src/orchestratorAgent"

const output = await runOrchestrator({
    taskDescription: "Add /api/v1/users/search endpoint and tests",
    // baseDir: "/override/path" // необязательно, возьмётся из ORCHESTRATOR_BASE_DIR
})
console.log(output)
```

## Примечания по безопасности

- Push в origin отключён по умолчанию; включается только явным флагом `--push-result`.
- Опасные команды (rm -rf и т.п.) блокируются белым списком.
- Зависимости не устанавливаются без явного указания в задаче.

## Следующие шаги

- Подготовьте тестовый проект в виде нескольких worktree под `ORCHESTRATOR_BASE_DIR`.
- Запустите `yarn orchestrator "<ваша задача>"` и проверьте, как агент создаёт/обновляет worktree, вызывает Codex и собирает результаты.

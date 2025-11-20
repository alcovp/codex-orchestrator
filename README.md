# Codex Orchestrator

Оркестратор, который запускает OpenAI Agents SDK и управляет Codex CLI в нескольких git worktree. Он создаёт/обновляет рабочие деревья, вызывает Codex для правок кода и тестов, а затем готовит изменения к мёрджу — без push в origin.

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
- `ORCHESTRATOR_BASE_DIR` — абсолютный путь к каталогу, где лежат git worktree целевого проекта.

Пример структуры worktree:
```
/some/path/ORCHESTRATION_ROOT/
  codex-orchestrator/    # этот репозиторий
  main/                  # основная ветка проекта
  task-foo/              # рабочие деревья задач
  task-bar/
```

## Быстрый старт
```bash
export OPENAI_API_KEY="sk-..."
export ORCHESTRATOR_BASE_DIR="/some/path/ORCHESTRATION_ROOT"

yarn orchestrator "Refactor billing module and add tests"
```

Также можно запустить `yarn dev` (то же самое, но без сборки).

## Что делает оркестратор
- Агент **Codex Orchestrator** (в `src/orchestratorAgent.ts`) использует инструменты для безопасного запуска команд в worktree.
- Основной инструмент — `run_repo_command` (в `src/tools/runRepoCommandTool.ts`), который:
  - вычисляет `cwd = <ORCHESTRATOR_BASE_DIR>/<worktree>`;
  - проверяет, что директория существует;
  - разрешает только безопасные префиксы команд (git, codex, ls, pwd, cat, npm, yarn, pnpm, pytest, node);
  - блокирует опасные git-операции: push, remote, reset, rebase;
  - выполняет команду и возвращает stdout/stderr.
- Агенты не редактируют файлы напрямую — всё делается через shell-команды и Codex CLI внутри worktree.

## Отладка и логирование
- Все вызовы `run_repo_command` пишутся в `run_repo_command.log` в корне оркестратора.
- Флаги окружения:
  - `ORCHESTRATOR_TRACE=1` — выводить trace сообщений в stderr при каждом вызове инструмента.
  - `ORCHESTRATOR_DRY_RUN=1` — не выполнять команды, а только логировать и возвращать их как пропущенные (удобно для проверки сценария).

## Использование как библиотеки
Из кода можно вызвать:
```ts
import { runOrchestrator } from "./src/orchestratorAgent";

const output = await runOrchestrator({
  taskDescription: "Add /api/v1/users/search endpoint and tests",
  // baseDir: "/override/path" // необязательно, возьмётся из ORCHESTRATOR_BASE_DIR
});
console.log(output);
```

## Примечания по безопасности
- Никогда не делается `git push` и не меняются remotes.
- Опасные команды (rm -rf и т.п.) блокируются белым списком.
- Зависимости не устанавливаются без явного указания в задаче.

## Следующие шаги
- Подготовьте тестовый проект в виде нескольких worktree под `ORCHESTRATOR_BASE_DIR`.
- Запустите `yarn orchestrator "<ваша задача>"` и проверьте, как агент создаёт/обновляет worktree, вызывает Codex и собирает результаты.

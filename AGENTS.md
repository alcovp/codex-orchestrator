# Codex Orchestrator Guide

Этот репозиторий — тупой диспетчер Codex CLI. Он не понимает контекст проекта, не хранит состояния и не принимает технических решений. Его единственная работа — запускать Codex CLI этапами и прокидывать результаты дальше.

## 0. Главная идея

- Orchestrator-agent (Agents SDK) — тонкий слой: принимает задачу, дергает инструменты, которые уже крутят Codex CLI, ждёт результаты, склеивает JSON и передаёт дальше.
- Всё «думанье о проекте» живёт в Codex-прогонах: Planner делит задачу и решает, можно ли параллелить; Workers реализуют subtasks; Merger/Finalizer сшивает, чистит, доводит.
- Оркестратор не понимает TS/React/OpenGL и не знает структуру проекта: он видит только входной JSON-план и N JSON-результатов сабтасков и в правильном порядке скармливает их следующему Codex-прогону.

## 1. Назначение

### Цели
- Оркестратор намеренно «глупый»: не анализирует задачи, не пишет код, не решает архитектуру, не оптимизирует решения.
- Единственный функционал — ставить в очередь Codex CLI прогоны (Planner → Workers → Merger → дополнительные стадии) и следить за зависимостями/параллельностью.
- Минимум логики: вся «умная» часть формулируется в промптах к Codex CLI и легко развивается.
- Codex всегда работает в актуальном worktree; параллельные subtasks получают собственные worktree.

### Что репозиторий не делает
- Не содержит бизнес‑логики целевого проекта.
- Не общается с внешними сервисами, кроме OpenAI API.
- Не пушит в удалённые репозитории.
- Не занимается CI/CD — только локальная автоматизация.

## 2. Архитектура и роли

- **System prompt оркестратора:** «я тупой, всё через инструменты». Любая логика — в Codex CLI.
- **CLI-вход** (`yarn orchestrator`): принимает задачу и запускает Orchestrator Agent с контекстом worktree/окружения.
- **Orchestrator Agent** (gpt-5.x, Agents SDK): не читает файлы и не принимает решений; только вызывает инструменты `run_repo_command`, `codex_plan_task`, `codex_run_subtask`, `codex_merge_results`, то есть запускает Codex CLI и прокидывает между прогонами JSON-артефакты.
- **run_repo_command**: обёртка для команд внутри конкретного worktree; белый список команд и логирование в `run_repo_command.log`.
- **Task Dispatcher** (`src/taskDispatcher.ts`): опрашивает источники задач и вызывает `runOrchestrator`.
- **Контекст OrchestratorContext**: минимум `baseDir: string` — абсолютный путь к директории с worktree.
- **Состояние**: отсутствует; между задачами ничего не запоминается, всё берётся из git-дерева.

## 3. Поведение Orchestrator Agent (тонкий слой)

- System prompt (суть): «Ты Orchestrator, ты тупой. Не пишешь код, не анализируешь исходники, не отвечаешь человеку. Единственное назначение: вызывать инструменты `codex_plan_task`, `codex_run_subtask`, `codex_merge_results` и связывать их JSON-ответы».
- Протокол:
  1) На любой запрос пользователя про разработку — сначала вызвать `codex_plan_task`.
  2) Получить план, построить зависимости и parallel_groups; запускать `codex_run_subtask` для каждой подзадачи, параллельно где можно, когда зависимости готовы.
  3) Собрать результаты `subtasks_results`, вызвать `codex_merge_results`.
  4) Итоговый ответ пользователю: summary из merge-JSON + список подсистем/файлов, изменения и статус (ok/needs manual review).
- Запрещено: придумывать реализацию от себя; пропускать `codex_plan_task`; завершать работу без вызовов инструментов.
- Логика (шаги): принять `user_task` → `codex_plan_task` → граф зависимостей → параллельно/последовательно `codex_run_subtask` → `subtasks_results` → `codex_merge_results` → human-friendly summary: сколько подзадач, какие файлы/подсистемы, финальный статус.

## 3. Инструменты агента (API к Codex CLI)

### 3.1 codex_plan_task

- Вход: `{ project_root: string; user_task: string; }`.
- Действия: `cd` в `project_root`, при необходимости создаёт отдельный worktree/ветку под план, запускает Codex с запретом менять код. Промпт: понять задачу, разложить на подзадачи, отметить параллелизацию.
- Формат ответа (строго JSON): `{ "can_parallelize": boolean, "subtasks": [ { "id": string, "title": string, "description": string, "parallel_group": string, "notes": string | null } ] }`.
- Выход инструмента: распарсенный JSON.

### 3.2 codex_run_subtask

- Вход: `{ project_root: string; worktree_name: string; subtask: { id: string; title: string; description: string; parallel_group?: string; } }`.
- Действия: `git worktree add work3/${worktree_name} <base-branch>`, `cd work3/${worktree_name}`, запускает Codex с описанием подзадачи и требованиями минимизировать изменения и писать понятные коммиты.
- Формат финального ответа Codex (JSON в конце): `{ "subtask_id": "{{subtask.id}}", "status": "ok" | "failed", "summary": string, "important_files": [ "path/file1.tsx", "..." ] }`.
- Выход инструмента: парсится JSON с конца ответа и отдаётся наружу.

### 3.3 codex_merge_results

- Вход: `{ project_root: string; base_branch: string; subtasks_results: { subtask_id: string; worktree_path: string; summary: string; }[] }`.
- Действия: создаёт merge worktree `git worktree add work3/merge-final base_branch`, туда переносит изменения из worktree сабтасков (любой стратегией: cherry-pick/patch/cp+add), затем запускает Codex с JSON результатов.
- Формат ответа (строго JSON): `{ "status": "ok" | "needs_manual_review", "notes": string, "touched_files": [ "...", "..." ] }`.
- Выход инструмента: финальный JSON-отчёт.

## 4. Этапы Codex

1) **Codex Planner** (первый прогон)  
   - Запускается в основном worktree.  
   - Анализирует проект и запрос пользователя, делит на строгие подзадачи.  
   - Строит зависимости/параллельность и выдаёт строгий JSON-план (id, описание, зависимости, предполагаемые worktree/branch, критерии готовности, проверки).  
   - Оркестратор только парсит JSON, без доработок.

2) **Codex Worker** (выполняет subtasks)  
   - Каждая подзадача — отдельный worktree от `origin/main`.  
   - Codex пишет код, запускает тесты, коммитит, оставляет JSON summary (ветка, коммиты, тесты, артефакты).  
   - Оркестратор следит за зависимостями, ждёт готовность зависимых задач и может гонять независимые параллельно.

3) **Codex Merger** (последний прогон)  
   - Сшивает ветки subtasks в основную ветку/worktree.  
   - Разбирает конфликты, приводит формат/стиль, обновляет документацию, при необходимости гоняет быстрые проверки.  
   - Возвращает JSON-отчёт (merged branches, конфликты/решения, формат/тесты).

Дополнительные стадии (Codex QA/Reviewer/Linter/Security/Benchmarks) — просто новые Codex-прогоны после или параллельно с основными.

## 5. Окружение и структура каталогов

### Переменные окружения
- `OPENAI_API_KEY` — ключ OpenAI (обязателен).
- `ORCHESTRATOR_BASE_DIR` — абсолютный путь к директории с git worktree целевого проекта.
- Для Telegram-диспетчера (опционально): `TELEGRAM_BOT_TOKEN`, `ADMIN_TELEGRAM_ID`.

### Типичная структура
```
/some/path/ORCHESTRATION_ROOT/
  codex-orchestrator/    # этот репозиторий (Node/TS)
  main/                  # worktree с веткой main
  task-users-search/     # worktree под задачу
  task-billing-optim/    # ещё один worktree
```
В коде: `ORCHESTRATOR_BASE_DIR = /some/path/ORCHESTRATION_ROOT`.  
Примеры `run_repo_command`:  
 `worktree="main"` → `/some/path/ORCHESTRATION_ROOT/main`  
 `worktree="task-users-search"` → `/some/path/ORCHESTRATION_ROOT/task-users-search`

## 6. Правила работы с git

### Общие принципы
- Работать только с локальными ветками и worktree.
- Основание для новых задач — ветка main (если не указано иное).
- Не трогать origin без явного письменного разрешения.
- История должна быть аккуратной: осмысленные ветки и коммиты.

### Разрешённые операции (через run_repo_command)
- Инфо: `git status`, `git log`, `git branch (-a)`, `git diff`.
- Worktree (обычно в `main`): `git worktree list`, `git worktree add ../task-<имя> origin/main`, `git worktree remove <путь>` (только временные).
- Ветки (внутри worktree): `git checkout/switch`, `git checkout -B <branch> origin/main`, `git branch -d <branch>` после мёрджа.
- Локальные коммиты: `git add <...>`, `git commit -m "..."`
- Локальные мёрджи (в `main`): `git merge --no-ff <branch>` или `git merge <branch>` без конфликтов.
- Обновление main (по согласованию): `git fetch origin`; аккуратный `git pull --ff-only` или `git reset --hard origin/main` только если явно разрешено и нет незакоммиченных изменений.

### Условно разрешённые (крайняя необходимость)
- `git clean -fd` во временных worktree, если нет ценных untracked файлов.
- `git reset` (без `--hard`) для правки истории в рамках задачи.
- Перед такими командами: зафиксировать план и последствия (например, удаление untracked).

## 7. Правила работы с Codex CLI

- Все команды запускаются через `run_repo_command`, без прямого доступа к файлам.
- Базовые команды: `codex exec --full-auto "<подробная задача>"`; при необходимости полного доступа — `--sandbox danger-full-access`.
- Задачи к Codex должны описывать цель, ограничения, тесты, формат JSON-ответов (для planner/worker/merger).
- Предпочитаем несколько коротких прогона вместо одного длинного (скелет → реализация → тесты → финальная полировка).
- Новые инструменты `codex_plan_task`, `codex_run_subtask`, `codex_merge_results` — тонкие обёртки вокруг `codex exec`, которые формируют нужный промпт и параметры ввода/вывода.

## 8. Типичный сценарий

Пользователь: `yarn orchestrator "<большая задача>"`.

Оркестратор (ничего не придумывает сам):
- Запускает Codex Planner в worktree `main` → получает строгий JSON-план.
- Создаёт/переиспользует worktree `task-<slug>` под каждую подзадачу. Проверяет зависимости; независимые subtasks запускает параллельно через Codex Worker, зависимые ждут готовности.
- Собирает JSON summary от воркеров.
- Запускает Codex Merger: мёржит ветки, решает конфликты, правит формат/доки, отдаёт итоговый отчёт.
- К финальному выводу прикладывает лог команд и краткое резюме стадий.

## 9. TODO и расширения

- Реализовать инструменты `codex_plan_task`, `codex_run_subtask`, `codex_merge_results` поверх `run_repo_command`.
- Добавить лёгкий граф зависимостей между subtasks (выполнение/ожидание, лимиты параллельности, ретраи).
- Улучшать промпты Codex для JSON-схем, проверок и автоформатирования.
- Расширять проверки безопасности (блокировать опасные git-команды при появлении новых сценариев).
- Подключать дополнительные Codex-стадии (QA/Reviewer/Linter/Security/Benchmarks) как отдельные шаги пайплайна.

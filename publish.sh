#!/usr/bin/env bash
# Публикация результатов скрапа с защитой от гонки пушей.
# Если remote ушёл вперёд (кто-то запушил, пока мы скрапили) — rebase и повтор.
# До 6 попыток: переживает даже перекрытие с другим запуском Actions.
#
# -X theirs: при rebase «theirs» — это НАШ коммит с данными (свежий скрап),
# «ours» — origin/main. То есть при конфликте в данных побеждает свежий скрап.
# Пропущенные из-за гонки игры само восстановятся: --all обходит sitemap заново.

set -euo pipefail

cd "$(dirname "$0")"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# Если нечего публиковать — выходим без коммита
git add erotorrent.json .cache/ 2>/dev/null || true
if git diff --cached --quiet; then
  echo "No changes to publish."
  exit 0
fi

git commit -m "${1:-chore: update erotorrent.json} [skip ci]"

PUSHED=0
for i in 1 2 3 4 5 6; do
  git fetch origin main
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    # Первый родитель — наша ветка: при конфликте данных побеждает свежий скрап
    git rebase -X theirs origin/main || { git rebase --abort; exit 1; }
  fi
  if git push origin HEAD:main; then
    echo "Pushed on attempt $i."
    PUSHED=1
    break
  fi
  echo "Push rejected on attempt $i, retrying..."
  sleep 5
done

if [ "$PUSHED" -eq 0 ]; then
  echo "ERROR: could not push after 6 attempts" >&2
  exit 1
fi

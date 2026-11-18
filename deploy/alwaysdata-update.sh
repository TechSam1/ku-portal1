#!/bin/sh
# Автообновление сервера на alwaysdata: забирает свежий код из GitHub и перезапускает сайт, если код изменился.
# Запускается по расписанию (alwaysdata → Advanced → Scheduled tasks).
# data/exam-sync.json не в git — reset его не трогает.
set -eu
APP="$HOME/ku-portal"
cd "$APP"
git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git reset -q --hard origin/main
  echo "$(date '+%F %T') обновлено до $(git rev-parse --short HEAD)"
  # сервер замечает обновление .restart и перезапускается
  date > "$APP/.restart"
fi

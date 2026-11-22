#!/bin/bash
set -u
cd /data/home/webmail-restore-ui-ib3 || exit 3
python3 /data/home/ar-codegen/gemini_chat_codegen.py --task "$(cat restore_ui_round3b_neon_app_task.txt)" --files src/App.tsx --verify "npx tsc --noEmit" --model Neon --rounds 3 --workdir /data/home/webmail-restore-ui-ib3 --new-tab > neon-3b-app.log 2>&1
echo "GEMINI_RC $?" >> neon-3b-app.log

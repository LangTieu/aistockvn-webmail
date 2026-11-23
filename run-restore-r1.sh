#!/bin/bash
# Webmail UI restore round 1 - OpenCode via Workers AI (litellm-router/vn-stock-workersai)
# Router key is read from the running litellm process environ into a shell
# variable only. It is NEVER printed, logged or written to any file.
set -u
cd /data/home/webmail-restore-ui || exit 3
LITELLM_PID=$(pgrep -f 'litellm --port 4000' | head -1)
if [ -z "$LITELLM_PID" ]; then echo "ROUTER DEAD - restart with /data/home/litellm/start.sh"; exit 3; fi
export ROUTER_KEY=$(tr '\0' '\n' < /proc/$LITELLM_PID/environ | grep '^LITELLM_MASTER_KEY=' | cut -d= -f2-)
if [ -z "$ROUTER_KEY" ]; then echo "NO ROUTER KEY in litellm environ"; exit 3; fi
/data/home/.opencode/bin/opencode run --dir /data/home/webmail-restore-ui -m litellm-router/vn-stock-workersai --auto "$(cat restore_ui_task.txt)" > opencode-restore-r1.log 2>&1 < /dev/null
echo "OPENCODE_RC $?" >> opencode-restore-r1.log

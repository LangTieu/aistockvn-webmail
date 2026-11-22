#!/bin/bash
set -u
cd /data/home/webmail-restore-ui-ib3 || exit 3
opencode run --dir /data/home/webmail-restore-ui-ib3 -m opencode/nemotron-3.5-lightning-free --auto "$(cat restore_ui_round3_fix2.txt)" > opencode-restore-r3-fix2.log 2>&1 < /dev/null
echo "OPENCODE_RC $?" >> opencode-restore-r3-fix2.log

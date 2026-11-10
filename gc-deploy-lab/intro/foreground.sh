#!/bin/bash
# 준비 진행 상황을 터미널에 보여 준다
clear
echo "연습장을 준비하고 있습니다 (3~5분)..."
last=""
while [ ! -f /root/.gc-lab-status ]; do
  sleep 3
  now=$(grep '^== ' /root/gc-lab-setup.log 2>/dev/null | tail -1)
  if [ -n "$now" ] && [ "$now" != "$last" ]; then echo "  $now"; last=$now; fi
done
echo
if grep -q '^ok' /root/.gc-lab-status; then
  kubectl get nodes -L lab.io/role
  echo
  echo "연습장 준비 완료 — 왼쪽 START 를 누르세요."
else
  echo "준비에 실패했습니다: $(cat /root/.gc-lab-status)"
  echo "기록 보기: tail -30 /root/gc-lab-setup.log"
fi

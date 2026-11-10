#!/bin/bash
# 연습장 준비 (보이지 않는 곳에서 실행) — 기록: /root/gc-lab-setup.log
exec > /root/gc-lab-setup.log 2>&1
for i in 1 2 3 4 5; do
  git clone -q --depth 1 https://github.com/hongin81/gc-k8s-lab /root/gc-k8s-lab && break
  sleep 5
done
if [ ! -f /root/gc-k8s-lab/lab/setup.sh ]; then
  echo "준비 실패: 연습 자료를 받지 못함"
  echo "fail: clone" > /root/.gc-lab-status
  exit 1
fi
bash /root/gc-k8s-lab/lab/setup.sh --mode killercoda

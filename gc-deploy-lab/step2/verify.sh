#!/bin/bash
# 반입 폴더에 이미지 2개 · 목록 · 체크섬이 있고 체크섬이 맞는지
TAG=$(cat /root/.lab-tag 2>/dev/null) || exit 1
cd "/root/out/$TAG" || exit 1
test -s sample-api.tar && test -s sample-web.tar && test -s images.txt && sha256sum -c --quiet SHA256SUMS

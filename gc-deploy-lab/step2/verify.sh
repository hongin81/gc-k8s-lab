#!/bin/bash
# 반입 폴더에 이미지 2개 · 목록 · 체크섬이 있고 체크섬이 맞는지
fail() { echo "확인 실패: $*" >&2; exit 1; }
TAG=$(cat /root/.lab-tag 2>/dev/null) || fail "태그 파일(~/.lab-tag) 없음"
cd "/root/out/$TAG" 2>/dev/null || fail "반입 폴더 ~/out/$TAG 없음"
test -s sample-api.tar || fail "sample-api.tar 없음"
test -s sample-web.tar || fail "sample-web.tar 없음"
test -s images.txt || fail "images.txt 없음"
sha256sum -c --quiet SHA256SUMS >/dev/null || fail "체크섬 불일치"

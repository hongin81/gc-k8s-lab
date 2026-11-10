#!/bin/bash
# 창고에 이번 태그가 두 이미지 모두 있는지
fail() { echo "확인 실패: $*" >&2; exit 1; }
TAG=$(cat /root/.lab-tag 2>/dev/null) || fail "태그 파일 없음"
for n in sample-api sample-web; do
  curl -s "http://localhost:5000/v2/lab/$n/tags/list" | grep -q "\"$TAG\"" || fail "창고에 lab/$n:$TAG 없음"
done
test -d /opt/deploy/gc-app-deploy/k8s/services/sample || fail "/opt/deploy/gc-app-deploy 없음"

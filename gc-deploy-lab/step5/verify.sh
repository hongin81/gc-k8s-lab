#!/bin/bash
# 두 구성 요소가 2/2 준비됐고, 입구 → API → DB, 입구 → 화면이 연결되는지
fail() { echo "확인 실패: $*" >&2; exit 1; }
for d in sample-web sample-api; do
  [ "$(kubectl -n sample get deploy $d -o jsonpath='{.status.readyReplicas}' 2>/dev/null)" = 2 ] || fail "$d 준비 2/2 아님"
done
curl -sk --max-time 10 https://ai.lab.example/sample-api/hello | grep -q db_time || fail "/sample-api/hello 에서 DB 응답 없음"
curl -sk --max-time 10 https://ai.lab.example/sample/ | grep -q '<title>' || fail "/sample/ 화면 응답 없음"

#!/bin/bash
# 두 구성 요소가 2/2 준비됐고, 입구 → API → DB 가 연결되는지
for d in sample-web sample-api; do
  [ "$(kubectl -n sample get deploy $d -o jsonpath='{.status.readyReplicas}' 2>/dev/null)" = 2 ] || exit 1
done
curl -sk --max-time 10 https://ai.lab.example/sample-api/hello | grep -q db_time || exit 1
curl -sk --max-time 10 https://ai.lab.example/sample/ | grep -q '<title>'

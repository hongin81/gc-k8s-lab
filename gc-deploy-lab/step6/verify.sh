#!/bin/bash
# 고장 5가지가 모두 고쳐졌는지 (설정 파일대로 돌아왔고, 서비스가 정상인지)
fail() { echo "확인 실패: $*" >&2; exit 1; }
for d in sample-web sample-api; do
  s=$(kubectl -n sample get deploy $d -o jsonpath='{.spec.replicas} {.status.readyReplicas} {.status.updatedReplicas} {.status.unavailableReplicas}' 2>/dev/null)
  [ "$s" = "2 2 2 " ] || fail "$d 상태 '$s' (원하는 값 '2 2 2 ')"
done
kubectl -n sample get secret sample-secret >/dev/null 2>&1 || fail "Secret 없음 (고장 2)"
[ "$(kubectl -n sample get configmap sample-api-config -o jsonpath='{.data.APP_WORK_DIR}')" = /tmp/work ] || fail "APP_WORK_DIR 가 /tmp/work 아님 (고장 3)"
[ "$(kubectl -n sample get deploy sample-web -o jsonpath='{.spec.template.spec.nodeSelector.lab\.io/role}')" = app ] || fail "sample-web 서버 조건이 app 아님 (고장 4)"
kubectl -n sample get ingress sample -o jsonpath='{.spec.rules[0].http.paths[*].path}' | grep -qw /sample-api || fail "외부 경로 /sample-api 없음 (고장 5)"
curl -sk --max-time 10 https://ai.lab.example/sample-api/hello | grep -q db_time || fail "/sample-api/hello 응답 없음"

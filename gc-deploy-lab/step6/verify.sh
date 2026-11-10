#!/bin/bash
# 고장 5가지가 모두 고쳐졌는지 (설정 파일대로 돌아왔고, 서비스가 정상인지)
for d in sample-web sample-api; do
  s=$(kubectl -n sample get deploy $d -o jsonpath='{.spec.replicas} {.status.readyReplicas} {.status.updatedReplicas} {.status.unavailableReplicas}' 2>/dev/null)
  [ "$s" = "2 2 2 " ] || exit 1
done
kubectl -n sample get secret sample-secret >/dev/null 2>&1 || exit 1
[ "$(kubectl -n sample get configmap sample-api-config -o jsonpath='{.data.APP_WORK_DIR}')" = /tmp/work ] || exit 1
[ "$(kubectl -n sample get deploy sample-web -o jsonpath='{.spec.template.spec.nodeSelector.lab\.io/role}')" = app ] || exit 1
kubectl -n sample get ingress sample -o jsonpath='{.spec.rules[0].http.paths[*].path}' | grep -qw /sample-api || exit 1
curl -sk --max-time 10 https://ai.lab.example/sample-api/hello | grep -q db_time

#!/bin/bash
# 새 버전을 한 번 내보냈다가 되돌렸고, 설정 파일 태그도 되돌린 태그와 같은지
K=/opt/deploy/gc-app-deploy/k8s/services/sample/kustomization.yaml
OLD=$(cat /root/.lab-old-tag 2>/dev/null) || exit 1
NEW=$(cat /root/.lab-tag 2>/dev/null) || exit 1
[ "$OLD" != "$NEW" ] || exit 1
cfg=$(grep -A1 'name: docker.io/lab/sample-web' "$K" | awk '/newTag/{print $2}')
live=$(kubectl -n sample get deploy sample-web -o jsonpath='{.spec.template.spec.containers[0].image}')
[ "$cfg" = "$OLD" ] && [ "$live" = "docker.io/lab/sample-web:$OLD" ] || exit 1
[ "$(kubectl -n sample get deploy sample-web -o jsonpath='{.status.readyReplicas}')" = 2 ] || exit 1
curl -s "http://localhost:5000/v2/lab/sample-web/tags/list" | grep -q "\"$NEW\""

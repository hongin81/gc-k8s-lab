#!/bin/bash
# 새 버전을 한 번 내보냈다가 되돌렸고, 설정 파일 태그도 되돌린 태그와 같은지
fail() { echo "확인 실패: $*" >&2; exit 1; }
K=/opt/deploy/gc-app-deploy/k8s/services/sample/kustomization.yaml
OLD=$(cat /root/.lab-old-tag 2>/dev/null) || fail "이전 태그 파일 없음"
NEW=$(cat /root/.lab-tag 2>/dev/null) || fail "태그 파일 없음"
[ "$OLD" != "$NEW" ] || fail "새 태그를 만들지 않음"
curl -s "http://localhost:5000/v2/lab/sample-web/tags/list" | grep -q "\"$NEW\"" || fail "창고에 새 화면 이미지 없음"
cfg=$(grep -A1 'name: docker.io/lab/sample-web' "$K" | awk '/newTag/{print $2}')
live=$(kubectl -n sample get deploy sample-web -o jsonpath='{.spec.template.spec.containers[0].image}')
[ "$cfg" = "$OLD" ] || fail "설정 파일 화면 태그 $cfg ≠ 이전 태그 $OLD"
[ "$live" = "docker.io/lab/sample-web:$OLD" ] || fail "돌고 있는 화면 이미지 $live"
[ "$(kubectl -n sample get deploy sample-web -o jsonpath='{.status.readyReplicas}')" = 2 ] || fail "화면 준비 2/2 아님"

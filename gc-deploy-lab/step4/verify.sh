#!/bin/bash
# Secret · 인증서가 있고, 태그를 바꿨고, 평문 파일이 남아 있지 않은지
fail() { echo "확인 실패: $*" >&2; exit 1; }
K=/opt/deploy/gc-app-deploy/k8s/services/sample/kustomization.yaml
kubectl -n sample get secret sample-secret >/dev/null 2>&1 || fail "Secret sample-secret 없음"
kubectl -n sample get secret ai-lab-tls >/dev/null 2>&1 || fail "인증서 Secret ai-lab-tls 없음"
grep -q "newTag: CHANGE-ME" "$K" && fail "newTag 가 아직 CHANGE-ME"
[ ! -e /root/secret.env ] || fail "/root/secret.env 가 남아 있음 (shred -u)"
exit 0

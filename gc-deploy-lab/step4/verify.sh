#!/bin/bash
# Secret · 인증서가 있고, 태그를 바꿨고, 평문 파일이 남아 있지 않은지
K=/opt/deploy/gc-app-deploy/k8s/services/sample/kustomization.yaml
kubectl -n sample get secret sample-secret >/dev/null 2>&1 || exit 1
kubectl -n sample get secret ai-lab-tls >/dev/null 2>&1 || exit 1
! grep -q CHANGE-ME "$K" || exit 1
[ ! -e /root/secret.env ]

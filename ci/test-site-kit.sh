#!/usr/bin/env bash
# 현장 키트 시험 (연습장 kind 위, 연습 단계를 다 마친 뒤):
#   점검 스크립트 → 꾸러미 만들기(인증서 Secret 없음 = 입구 기본 인증서) → 순서서대로 첫 배포 → 확인 → 지우기
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
export HOME=/root

echo "== 1. 점검 스크립트"
bash "$REPO/site-kit/check-cluster.sh" "$REPO/site-kit/site.lab.env"
R=$(ls -d /root/cluster-check-*/ | tail -1)
for want in "정상      gc-lab-worker Ready" "정상      gc-lab-worker2 lab.io/role=app" \
            "창고 localhost:5000 응답" "입구 127.0.0.1:443 응답" "IngressClass traefik 있음" \
            "DB 주소 db-general-rw" "data-db 있음"; do
  grep -qF "$want" "$R/report.txt" || { echo "점검 결과에 없음: $want"; exit 1; }
done
ls /root/cluster-check-*.tar.gz >/dev/null
echo "점검 스크립트 정상"

echo "== 2. 꾸러미 만들기"
IMG=/root/out/$(cat /root/.lab-old-tag)
sed 's/^TLS_SECRET=.*/TLS_SECRET=/' "$REPO/site-kit/site.lab.env" > /tmp/site.notls.env
python3 "$REPO/site-kit/render-site.py" /tmp/site.notls.env "$IMG" /tmp/kit
grep -q 'router.tls: "true"' /tmp/kit/k8s/services/sample/30-ingress.yaml
! grep -q 'secretName' /tmp/kit/k8s/services/sample/30-ingress.yaml
! grep -q 'CHANGE-ME' /tmp/kit/k8s/services/sample/kustomization.yaml

echo "== 3. 기존 샘플을 지우고 꾸러미 순서대로 첫 배포"
kubectl delete -k /opt/deploy/gc-app-deploy/k8s/services/sample --wait=true
TAG=$(ls /tmp/kit/images)
mkdir -p /opt/import && rm -rf "/opt/import/$TAG" && cp -r "/tmp/kit/images/$TAG" /opt/import/
bash /tmp/kit/scripts/load-images.sh "/opt/import/$TAG"
cd /tmp/kit
kubectl apply -f k8s/services/sample/00-namespace.yaml
kubectl -n sample create secret generic sample-secret --from-literal=DB_PASSWORD=none
kubectl diff -k k8s/services/sample >/dev/null || true
kubectl apply -k k8s/services/sample
kubectl -n sample rollout status deploy/sample-web --timeout=5m
kubectl -n sample rollout status deploy/sample-api --timeout=10m
kubectl -n sample get pods -o wide
sleep 5
for p in /sample/ /sample-api/health; do
  code=$(curl -sk --resolve ai.lab.example:443:127.0.0.1 -o /dev/null -w '%{http_code}' "https://ai.lab.example$p")
  echo "  $p → $code"
  [ "$code" = 200 ]
done
VIP=127.0.0.1 bash scripts/check-service.sh sample

echo "== 4. 지우기"
kubectl delete -k k8s/services/sample --wait=true
! kubectl get ns sample >/dev/null 2>&1
echo "현장 키트 시험 통과"

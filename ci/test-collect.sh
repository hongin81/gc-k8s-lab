#!/usr/bin/env bash
# 구성 수집 시험 (연습 단계를 마친 kind 위): 가짜 비밀번호를 곳곳에 숨겨 두고 수집 → 결과에 새지 않는지 · 요약이 맞는지
set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
export HOME=/root
fail() { echo "시험 실패: $*"; exit 1; }

echo "== 가짜 비밀번호 숨기기"
kubectl create ns leaktest
kubectl -n leaktest create configmap leak-cm --from-literal=DB_PASSWORD=supersecret123 --from-literal=JWT_SECRET=jwtsecret456 --from-literal=TZ=Asia/Seoul
kubectl -n leaktest create secret generic leak-secret --from-literal=DB_PASSWORD=topsecretvalue987
openssl genrsa 2048 2>/dev/null > /tmp/leak.key
kubectl -n leaktest create configmap leak-pem --from-file=key.pem=/tmp/leak.key
KEYLINE=$(sed -n 3p /tmp/leak.key)
cat <<YAML | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata: { name: leak-app, namespace: leaktest }
spec:
  replicas: 0
  selector: { matchLabels: { app: leak-app } }
  template:
    metadata: { labels: { app: leak-app } }
    spec:
      containers:
        - name: app
          image: public.ecr.aws/docker/library/busybox:1.36
          env:
            - name: DB_PASSWORD
              value: plainenv789
            - name: API_URL
              value: https://admin:urlpass321@example.com/x
YAML
B=/tmp/bundle-test; rm -rf $B; cp -r /opt/deploy/gc-app-deploy $B
echo "DB_PASSWORD=leakvalue555" > $B/k8s/services/sample/secret.env
cp /tmp/leak.key $B/k8s/services/sample/server.key

echo "== 수집 (작업 서버 방식)"
rm -rf /root/collect-*
bash "$REPO/site-kit/collect.sh" --bundle $B || fail "수집 스크립트 실패"
TGZ=$(ls /root/collect-*.tar.gz | head -1); [ -n "$TGZ" ] || fail "결과 파일 없음"
X=/tmp/collect-x; rm -rf $X; mkdir -p $X; tar -C $X -xzf "$TGZ"; D=$(ls -d $X/collect-*)

echo "== 새어 나왔나"
for leak in supersecret123 jwtsecret456 topsecretvalue987 plainenv789 urlpass321 leakvalue555 "$KEYLINE"; do
  if grep -rqF -- "$leak" $D; then grep -rlF -- "$leak" $D; fail "결과에 비밀값이 있음: ${leak:0:20}"; fi
done
echo "  가짜 비밀번호 7가지 — 결과에 없음"

echo "== 필요한 정보는 남았나"
grep -q "leaktest/leak-secret" $D/config/secrets-list.txt || fail "Secret 이름 목록 없음"
grep -q "DB_PASSWORD" $D/config/secrets-list.txt || fail "Secret 키 이름 없음"
grep -q "secretName: ai-lab-tls" $D/network/ingress.yaml || fail "인증서 Secret 이름이 가려짐"
grep -q "TZ: Asia/Seoul" $D/config/configmaps.yaml || fail "일반 설정값이 없음"
grep -q "secret.env" $D/bundle/excluded.txt || fail "비밀값 파일이 뺀 목록에 없음"
[ ! -e $D/bundle/files/k8s/services/sample/secret.env ] || fail "비밀값 파일을 가져옴"
[ ! -e $D/bundle/files/k8s/services/sample/server.key ] || fail "개인키 파일을 가져옴"
[ -s $D/bundle/rendered/k8s_services_sample.yaml ] || fail "배포 묶음 조립 결과 없음"
for want in "있음  입구 Traefik" "없음  PostgreSQL 운영 장치 CNPG" "gc-lab-worker" "lab/sample-api" "/sample/" "쿠버 API" "이미지 창고"; do
  grep -qF "$want" $D/00-summary.txt || fail "요약에 없음: $want"
done
echo "  요약 · 원본 정상"

echo "== 수집 (다른 서버 방식 --node)"
rm -rf /root/collect-*
bash "$REPO/site-kit/collect.sh" --node || fail "--node 실패"
ls /root/collect-*.tar.gz >/dev/null || fail "--node 결과 파일 없음"

kubectl delete ns leaktest --wait=false >/dev/null
echo "구성 수집 시험 통과"

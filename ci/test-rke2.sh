#!/usr/bin/env bash
# RKE2 위에서 구성 수집 · 클러스터 점검 · 배포 묶음 점검을 돌리고 확인한다. 결과는 /tmp/rke2-results 에 모아 올린다.
set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
export HOME=/root
R=/tmp/rke2-results; rm -rf $R; mkdir -p $R
fail=0
bad() { echo "시험 실패: $*"; fail=1; }

echo "== 1. 구성 수집 (작업 서버 방식)"
rm -rf /root/collect-*
( cd /root && sed -e 's#^REGISTRY=.*#REGISTRY="infra01:5000"#' "$REPO/site-kit/collect.sh" > /tmp/collect.sh && bash /tmp/collect.sh --yes ) > $R/collect-console.txt 2>&1 || bad "구성 수집 실패"
cp /root/collect-*.tar.gz $R/ 2>/dev/null; X=/tmp/cx; rm -rf $X; mkdir -p $X; tar -C $X -xzf /root/collect-*.tar.gz; D=$(ls -d $X/collect-*)
cp -r $D $R/collect-unpacked

echo "== 2. 구성 수집 (다른 서버 방식 --node)"
rm -rf /root/collect-*
( cd /root && bash /tmp/collect.sh --node --yes ) > $R/collect-node-console.txt 2>&1 || bad "--node 실패"

echo "== 3. 클러스터 점검"
cat > /tmp/site.rke2.env <<EOF
DOMAIN=ai.lab.example
INGRESS_VIP=127.0.0.1
L4_VIP=
REGISTRY=infra01:5000
ROLE_LABEL=lab.io/role
INGRESS_CLASS=traefik
NODES_CONTROL=""
NODES_APP="$(hostname)"
NODES_AI=""
NODES_LLM=""
KAFKA_LABEL=""
SERVICE_NAMESPACES="sample"
DATA_NAMESPACES="data-db data-kafka"
OUT_DIR=/root
EOF
rm -rf /root/cluster-check-*
bash "$REPO/site-kit/check-cluster.sh" /tmp/site.rke2.env > $R/check-cluster-console.txt 2>&1 || bad "클러스터 점검 실패"
cp /root/cluster-check-*/report.txt $R/check-cluster-report.txt 2>/dev/null

echo "== 4. 배포 묶음 점검"
rm -rf /root/bundle-check-*
python3 "$REPO/site-kit/check-bundle.py" /opt/deploy/gc-app-deploy --env /tmp/site.rke2.env > $R/check-bundle-console.txt 2>&1 || bad "배포 묶음 점검 실패"

echo "== 5. 비밀값이 새지 않았나 (모든 결과)"
for leak in leaktoken-rke2-7f3a9c leakagent-rke2-2b8d1e regpass-leak-999 miniopass-leak-555 plainenv-leak-444 helmpass-leak-333 \
            bundlesecret-leak-222 secretvalue-leak-111 cmtoken-leak-666; do
  if grep -rqF -- "$leak" $R /root/collect-* /root/cluster-check-* /root/bundle-check-* 2>/dev/null; then
    bad "새어 나옴: $leak  ($(grep -rlF -- "$leak" $R | head -3 | tr '\n' ' '))"
  fi
done
[ $fail = 0 ] && echo "  가짜 비밀번호 9가지 — 어디에도 없음"

echo "== 6. 요약이 RKE2 를 제대로 읽었나"
S=$D/00-summary.txt
for want in "RKE2      : rke2 version" "rke2-server 실행 중" "있음  네트워크(CNI)" "있음  입구 Traefik" "있음  PostgreSQL 운영 장치 CNPG" \
            "있음  Kafka 운영 장치 Strimzi" "있음  Redis" "있음  MinIO" "db-general" "signal-kafka" "lab/sample-api" "metrics-server" "/sample/"; do
  grep -qF -- "$want" $S || bad "요약에 없음: $want"
done
grep -q "token: \*\*\*" $D/node/rke2-config.yaml || bad "RKE2 config.yaml 토큰이 가려지지 않음"
grep -q "password: \*\*\*" $D/node/registries.yaml || bad "registries.yaml 비밀번호가 가려지지 않음"
grep -q "infra01:5000" $D/node/registries.yaml || bad "registries.yaml 미러 주소가 안 보임"
[ -s $D/cluster/rke2-addons.yaml ] || bad "RKE2 부가 설정(HelmChart) 없음"
grep -q "정상      CNPG" $R/check-cluster-report.txt || bad "클러스터 점검: CNPG 정상 아님"
grep -q "정상      Strimzi" $R/check-cluster-report.txt || bad "클러스터 점검: Strimzi 정상 아님"
grep -q "브로커 파드: 1 개 Running" $R/check-cluster-report.txt || bad "클러스터 점검: 브로커 수가 틀림"
grep -q "있음  Kafka 브로커 — 파드 1/1" $S || bad "구성 수집: 브로커 수가 틀림"
grep -q "있음  입구 Traefik — 파드 1/1" $S || bad "구성 수집: 끝난 설치 작업까지 셈"
grep -q "docker.io → http://infra01:5000" $S || bad "구성 수집: 미러 대상이 안 보임"
grep -q "Gi" <(grep -A3 "이름 .*역할라벨" $S) || bad "구성 수집: 메모리가 Gi 로 안 바뀜"
grep -q "이 서버 미러 설정" $R/check-cluster-report.txt || bad "클러스터 점검: 미러 설정 확인 안 됨"
grep -q "^정상 [0-9]* · 문제 0$" $R/check-bundle-console.txt || bad "배포 묶음 점검: 문제가 나옴"
[ $fail = 0 ] && echo "RKE2 시험 통과" || { echo "RKE2 시험 실패"; exit 1; }

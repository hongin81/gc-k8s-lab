#!/usr/bin/env bash
# 배포 묶음 점검 시험 (연습 단계를 마친 kind 위):
#   ① 정상 묶음 → 문제 0  ② 일부러 틀린 묶음 → 9가지를 모두 잡아내는지
set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
export HOME=/root
CHK="$REPO/site-kit/check-bundle.py"
ENV="$REPO/site-kit/site.lab.env"
fail() { echo "시험 실패: $*"; exit 1; }

echo "== ① 정상 묶음"
python3 "$CHK" /opt/deploy/gc-app-deploy --env "$ENV" | tee /tmp/good.txt
grep -q "^정상 [0-9]* · 문제 0$" /tmp/good.txt || fail "정상 묶음인데 문제가 나옴"

echo "== ② 일부러 틀린 묶음"
B=/tmp/broken-bundle; rm -rf $B; cp -r /opt/deploy/gc-app-deploy $B
S=$B/k8s/services/sample
sed -i 's/SERVER_PORT: "8080"/SERVER_PORT: "8081"/' $S/21-sample-api.yaml                                   # 1 앱 포트
sed -i 's/secretKeyRef: { name: sample-secret,/secretKeyRef: { name: sample-secrett,/' $S/21-sample-api.yaml  # 2 Secret 이름
sed -i '/name: sample-web/,$ s/lab.io\/role: app/lab.io\/role: web/' $S/20-sample-web.yaml                    # 3 서버 라벨
sed -i '/name: docker.io\/lab\/sample-web/{n;s/newTag: .*/newTag: nosuchtag/}' $S/kustomization.yaml          # 4 이미지 태그
sed -i 's/svc.cluster.local:5432/svc.cluster.local:5433/' $S/21-sample-api.yaml                                # 5 다른 서비스 포트
sed -i '/readinessProbe:/{n;s/path: \/sample-api\/health, port: http/path: \/sample-api\/health, port: 9090/}' $S/21-sample-api.yaml  # 6 헬스체크 포트
sed -i 's#  TZ: Asia/Seoul#  TZ: Asia/Seoul\n  LEGACY_URL: http://192.168.1.10:8080/api#' $S/21-sample-api.yaml           # 7 사설 IP
cp -r $S $B/k8s/services/sample2                                                                                 # 8 경로 겹침
sed -i 's/^namespace: sample$/namespace: sample2/' $B/k8s/services/sample2/kustomization.yaml
sed -i 's/name: sample$/name: sample2/' $B/k8s/services/sample2/00-namespace.yaml
printf '# 서비스\t구성 요소\t포트\t외부 경로\nsample\tsample-api\t8085\t/sample-api\nsample\tsample-web\t8080\t/sample/\n' > /tmp/expect.tsv  # 9 카드와 다름
python3 "$CHK" $B --env "$ENV" --expect /tmp/expect.tsv | tee /tmp/bad.txt
n=0
for want in "앱 포트 설정 SERVER_PORT=8081" "Secret sample/sample-secrett 없음" "lab.io/role=web 에 맞는 서버가 없음" \
            "창고에 lab/sample-web:nosuchtag 없음" "서비스는 있지만 포트 5433 없음" "readinessProbe 포트 9090" \
            "사설 IP" "경로 /sample/ 를 다른 곳도 씀" "sample-api 포트 8080 — 가이드 카드는 8085"; do
  n=$((n+1))
  if grep -qF "$want" /tmp/bad.txt; then echo "  잡아냄 $n: $want"; else fail "못 잡음 $n: $want"; fi
done
ls /root/bundle-check-*.tar.gz >/dev/null || fail "결과 파일 없음"
echo "배포 묶음 점검 시험 통과"

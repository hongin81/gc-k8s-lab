#!/usr/bin/env bash
# 연습용 고장 내기 — bash ~/gc-k8s-lab/lab/break.sh <1~5>
#   1 이미지 태그 틀림        → ImagePullBackOff
#   2 Secret 없음             → CreateContainerConfigError
#   3 읽기 전용 폴더에 쓰기   → CrashLoopBackOff (Read-only file system)
#   4 없는 서버 조건          → Pending
#   5 외부 경로 철자 틀림     → 404
set -uo pipefail
NS=sample

case "${1:-}" in
  1) kubectl -n $NS set image deploy/sample-api sample-api=docker.io/lab/sample-api:no-such-tag ;;
  2) kubectl -n $NS delete secret sample-secret
     kubectl -n $NS rollout restart deploy/sample-api ;;
  3) kubectl -n $NS patch configmap sample-api-config --type merge -p '{"data":{"APP_WORK_DIR":"/app/work"}}'
     kubectl -n $NS rollout restart deploy/sample-api ;;
  4) kubectl -n $NS patch deploy sample-web --type merge \
       -p '{"spec":{"template":{"spec":{"nodeSelector":{"lab.io/role":"ai"}}}}}' ;;
  5) kubectl -n $NS patch ingress sample --type json \
       -p '[{"op":"replace","path":"/spec/rules/0/http/paths/1/path","value":"/sampel-api"}]' ;;
  *) echo "사용: bash break.sh <1~5>"; exit 1 ;;
esac
echo "고장 $1 을 냈습니다. 아래 확인 명령으로 증상을 보세요."

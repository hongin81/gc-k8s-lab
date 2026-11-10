#!/usr/bin/env bash
# 서비스 점검 + 증적 저장 — 배포 · 되돌리기 뒤에 돌린다.
# 사용: bash scripts/check-service.sh <네임스페이스>
# 결과: 판정(정상 / 확인 필요) + evidence/<네임스페이스>-<일시>/ 에 상태 기록
set -uo pipefail

NS=${1:?"네임스페이스를 주세요 (예: sample)"}
DOMAIN=${DOMAIN:-ai.lab.example}
VIP=${VIP:-$(getent hosts "$DOMAIN" | awk '{print $1; exit}')}
BASE=$(cd "$(dirname "$0")/.." && pwd)
EV="$BASE/evidence/$NS-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$EV"
ok=1

kubectl -n "$NS" get deploy,pods,svc,ingress -o wide > "$EV/resources.txt" 2>&1
kubectl -n "$NS" get events --sort-by=.lastTimestamp > "$EV/events.txt" 2>&1
kubectl -n "$NS" get deploy -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[*].image' > "$EV/images.txt" 2>&1

echo "[구성 요소]"
for d in $(kubectl -n "$NS" get deploy -o jsonpath='{.items[*].metadata.name}'); do
  want=$(kubectl -n "$NS" get deploy "$d" -o jsonpath='{.spec.replicas}')
  ready=$(kubectl -n "$NS" get deploy "$d" -o jsonpath='{.status.readyReplicas}')
  updated=$(kubectl -n "$NS" get deploy "$d" -o jsonpath='{.status.updatedReplicas}')
  if [ "${ready:-0}" = "$want" ] && [ "${updated:-0}" = "$want" ]; then
    echo "  정상      $d  준비 ${ready}/${want}"
  else
    echo "  확인 필요 $d  준비 ${ready:-0}/${want} (새 버전 ${updated:-0}/${want})"
    ok=0
  fi
done

echo "[외부 경로]  https://$DOMAIN  (입구 $VIP)"
paths=$(kubectl -n "$NS" get ingress -o jsonpath='{range .items[*]}{.metadata.annotations.lab\.io/check-paths}{" "}{end}')
[ -z "${paths// /}" ] && paths=$(kubectl -n "$NS" get ingress -o jsonpath='{range .items[*].spec.rules[*].http.paths[*]}{.path}{" "}{end}')
for p in $paths; do
  code=$(curl -sk --max-time 10 --resolve "$DOMAIN:443:$VIP" -o /dev/null -w '%{http_code}' "https://$DOMAIN$p")
  case $code in
    2??|3??|401|403) echo "  정상      $p  → $code" ;;
    *)               echo "  확인 필요 $p  → $code"; ok=0 ;;
  esac
  echo "$p $code" >> "$EV/paths.txt"
done

if [ $ok = 1 ]; then judge="정상"; else judge="확인 필요"; fi
echo "판정: $judge" | tee "$EV/judge.txt"
echo "증적: $EV"
[ $ok = 1 ]

#!/usr/bin/env bash
# 클러스터 점검 (읽기 전용) — 구성도대로 되어 있는지 항목별로 확인한다. 아무것도 바꾸지 않는다.
# 사용 (작업 서버, root): bash check-cluster.sh [설정파일]      (기본: 같은 폴더의 site.env)
# 결과: 화면 + <OUT_DIR>/cluster-check-<일시>/ (report.txt · raw/) + 같은 이름 .tar.gz (보내기용 · 비밀번호 없음)
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ENV_FILE=${1:-$HERE/site.env}
[ -f "$ENV_FILE" ] || { echo "설정 파일이 없습니다: $ENV_FILE"; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${DOMAIN:=}" "${INGRESS_VIP:=}" "${L4_VIP:=}" "${REGISTRY:=}" "${ROLE_LABEL:=}" "${INGRESS_CLASS:=traefik}"
: "${NODES_CONTROL:=}" "${NODES_APP:=}" "${NODES_AI:=}" "${NODES_LLM:=}" "${TAINT_AI:=}" "${TAINT_LLM:=}"
: "${KAFKA_LABEL:=}" "${SERVICE_NAMESPACES:=}" "${DATA_NAMESPACES:=}" "${OUT_DIR:=/root}"

# RKE2 기본 위치
# sudo 로 돌리면 /usr/local/bin 이 실행 경로에서 빠지는 서버가 있음 (k3s · kubectl 이 거기 있음)
export PATH=$PATH:/usr/local/bin:/usr/local/sbin
for d in rke2 k3s; do
  [ -x /var/lib/rancher/$d/bin/kubectl ] && export PATH=$PATH:/var/lib/rancher/$d/bin
  [ -z "${KUBECONFIG:-}" ] && [ -f /etc/rancher/$d/$d.yaml ] && export KUBECONFIG=/etc/rancher/$d/$d.yaml
done

OUT=$OUT_DIR/cluster-check-$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT/raw"
REPORT=$OUT/report.txt
N_OK=0; N_BAD=0; TODO=()

say()  { echo "$*" | tee -a "$REPORT"; }
sec()  { say ""; say "[$1] $2"; }
ok()   { say "  정상      $*"; N_OK=$((N_OK+1)); }
bad()  { say "  확인 필요 $1"; N_BAD=$((N_BAD+1)); if [ -n "${2:-}" ]; then say "            → $2"; TODO+=("$1 → $2"); fi; }
info() { say "  참고      $*"; }
raw()  { local name=$1; shift; "$@" > "$OUT/raw/$name.txt" 2>&1; }
k()    { kubectl "$@" 2>/dev/null; }
esc()  { echo "${1//./\\.}"; }        # jsonpath 용: 라벨 이름의 점(.) 앞에 \
in_list() { case " $2 " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

finish() {
  say ""
  say "================ 요약 ================"
  say "정상 $N_OK · 확인 필요 $N_BAD"
  if [ ${#TODO[@]} -gt 0 ]; then
    say "할 일:"
    local i=1 t
    for t in "${TODO[@]}"; do say "  $i. $t"; i=$((i+1)); done
  fi
  tar -C "$(dirname "$OUT")" -czf "$OUT.tar.gz" "$(basename "$OUT")" 2>/dev/null
  say ""
  say "결과 폴더: $OUT"
  say "보낼 파일: $OUT.tar.gz  (비밀번호 · Secret 값은 들어 있지 않음)"
  exit 0
}

say "클러스터 점검 — $(date '+%Y-%m-%d %H:%M') · $(hostname) · 설정 $ENV_FILE"
say "읽기만 합니다. 아무것도 바꾸지 않습니다."

# ── 1. 쿠버 연결 ─────────────────────────────────────────────
sec 1 "쿠버 연결"
ver=$(k get --raw /version | grep -o '"gitVersion": *"[^"]*"' | cut -d'"' -f4)
if [ -n "$ver" ]; then
  ok "쿠버 API 응답 · 버전 $ver"
  py=$(python3 --version 2>&1)
  if command -v python3 >/dev/null; then info "$py — 배포 묶음 점검(check-bundle.py) 실행 가능"
  else info "python3 없음 — 배포 묶음 점검(check-bundle.py)은 python3 가 있는 작업 서버(m2 · m3)에서"; fi
else
  bad "쿠버 API 에 연결 안 됨" "작업 서버에서 root 로 실행했는지, kubeconfig(/etc/rancher/rke2/rke2.yaml)가 있는지"
  finish
fi

# ── 2. 서버 ──────────────────────────────────────────────────
sec 2 "서버 (노드)"
raw nodes kubectl get nodes -o wide
raw node-labels kubectl get nodes --show-labels
actual=$(k get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" "}{end}')
expected="$NODES_CONTROL $NODES_APP $NODES_AI $NODES_LLM"
for n in $expected; do
  if ! in_list "$n" "$actual"; then
    bad "$n 없음" "실제 이름이 다르면 설정 파일의 서버 이름을 고치세요 (실제: $actual)"
    continue
  fi
  ready=$(k get node "$n" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
  if [ "$ready" = True ]; then ok "$n Ready"; else bad "$n Ready 아님 ($ready)" "kubectl describe node $n"; fi
done
for n in $actual; do in_list "$n" "$expected" || info "설계에 없는 서버: $n"; done
info "전체 $(echo $actual | wc -w) 대 (설계 $(echo $expected | wc -w) 대)"

# ── 3. 배치 조건 (라벨 · taint) ──────────────────────────────
sec 3 "서버 라벨 · taint (앱이 어느 서버에 뜰지 정하는 조건)"
check_role() {  # check_role <노드> <기대 라벨값> <기대 taint(키=값) 또는 빈칸>
  local n=$1 want=$2 taint=$3 r t
  in_list "$n" "$actual" || return 0
  r=$(k get node "$n" -o jsonpath="{.metadata.labels.$(esc "$ROLE_LABEL")}")
  if [ "$r" = "$want" ]; then ok "$n $ROLE_LABEL=$r"
  else bad "$n 라벨 $ROLE_LABEL=${r:-없음} (설계 $want)" "kubectl label node $n $ROLE_LABEL=$want --overwrite (인프라 담당)"; fi
  if [ -n "$taint" ]; then
    t=$(k get node "$n" -o jsonpath='{range .spec.taints[*]}{.key}={.value}:{.effect}{" "}{end}')
    case " $t" in
      *" $taint:"*) ok "$n taint $taint" ;;
      *) bad "$n taint ${t:-없음} (설계 $taint)" "kubectl taint node $n $taint:NoSchedule (인프라 담당)" ;;
    esac
  fi
}
if [ -n "$ROLE_LABEL" ]; then
  for n in $NODES_APP; do check_role "$n" app ""; done
  for n in $NODES_AI;  do check_role "$n" ai  "$TAINT_AI"; done
  for n in $NODES_LLM; do check_role "$n" llm "$TAINT_LLM"; done
fi
for n in $NODES_CONTROL; do
  in_list "$n" "$actual" || continue
  t=$(k get node "$n" -o jsonpath='{range .spec.taints[*]}{.key}:{.effect}{" "}{end}')
  info "$n (관리 서버) taint: ${t:-없음}"
done
if [ -n "$KAFKA_LABEL" ]; then
  kn=$(k get nodes -l "$KAFKA_LABEL" -o jsonpath='{range .items[*]}{.metadata.name}{" "}{end}')
  if [ -n "$kn" ]; then ok "Kafka 브로커 서버 라벨 $KAFKA_LABEL: $kn"
  else bad "Kafka 브로커 서버 라벨($KAFKA_LABEL) 붙은 서버 없음" "브로커 3대에 라벨 (인프라 담당 · README §K)"; fi
fi

# ── 4. 이미지 창고 ───────────────────────────────────────────
sec 4 "이미지 창고 ($REGISTRY)"
if [ -n "$REGISTRY" ]; then
  cat=$(curl -s --max-time 5 "http://$REGISTRY/v2/_catalog?n=1000")
  echo "$cat" > "$OUT/raw/registry-catalog.txt"
  if echo "$cat" | grep -q '"repositories"'; then
    cnt=$(echo "$cat" | grep -o '"[^"]*"' | grep -vc repositories)
    ok "창고 $REGISTRY 응답 · 이미지 $cnt 종"
  else
    bad "창고 $REGISTRY 응답 없음" "infra01 의 registry 컨테이너 상태 확인 (인프라 담당)"
  fi
fi
f=/etc/rancher/rke2/registries.yaml; [ -f $f ] || f=/etc/rancher/k3s/registries.yaml
if [ -f "$f" ]; then
  grep -vE -i 'password|username|auth|token|key' "$f" > "$OUT/raw/registries.yaml.txt"
  if grep -q "${REGISTRY%%:*}" "$f"; then ok "이 서버 미러 설정($f)에 ${REGISTRY%%:*} 있음"
  else bad "이 서버 $f 에 창고 주소 없음" "모든 노드 registries.yaml 에 docker.io 미러 → http://$REGISTRY (인프라 담당)"; fi
  info "다른 서버의 미러 설정은 첫 배포 시험(이미지 받기)에서 확인됨"
else
  info "$f 없음 — 미러 설정은 첫 배포 시험(이미지 받기)에서 확인"
fi

# ── 5. 입구 ─────────────────────────────────────────────────
sec 5 "입구 (Ingress · $DOMAIN)"
raw ingressclass kubectl get ingressclass
raw ingress kubectl get ingress -A
ic=$(k get ingressclass -o jsonpath='{range .items[*]}{.metadata.name}{" "}{end}')
if in_list "$INGRESS_CLASS" "$ic"; then ok "IngressClass $INGRESS_CLASS 있음"
else bad "IngressClass $INGRESS_CLASS 없음 (있는 것: ${ic:-없음})" "서비스 30-ingress.yaml 의 ingressClassName 을 실제 이름으로"; fi
tr=$(k get pods -A --no-headers | grep -i traefik | grep -c Running)
if [ "${tr:-0}" -gt 0 ]; then ok "Traefik 파드 Running $tr 개"; else bad "Traefik 파드 Running 없음" "Traefik 설치 상태 (인프라 담당)"; fi
if [ -n "$INGRESS_VIP" ]; then
  code=$(curl -sk --max-time 5 --resolve "$DOMAIN:443:$INGRESS_VIP" -o /dev/null -w '%{http_code}' "https://$DOMAIN/")
  if [ "$code" = 000 ]; then bad "입구 $INGRESS_VIP:443 응답 없음" "kube-vip · Traefik 상태 (인프라 담당)"
  else ok "입구 $INGRESS_VIP:443 응답 (https://$DOMAIN/ → $code)"; fi
  cert=$(echo | openssl s_client -connect "$INGRESS_VIP:443" -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -subject -issuer -enddate 2>/dev/null)
  echo "$cert" > "$OUT/raw/tls-cert.txt"
  if [ -z "$cert" ]; then info "인증서를 읽지 못함"
  elif echo "$cert" | grep -qi "TRAEFIK DEFAULT"; then
    bad "기관 인증서가 아니라 Traefik 기본 인증서가 나옴" "create-tls.sh 로 기관 인증서 넣기 (가이드 11장 ⑤)"
  else ok "인증서: $(echo "$cert" | grep -i subject= | head -1 | sed 's/^subject=//') · 만료 $(echo "$cert" | grep notAfter | cut -d= -f2)"; fi
fi
ip=$(getent hosts "$DOMAIN" | awk '{print $1; exit}')
if [ -n "$ip" ]; then info "이 서버에서 $DOMAIN → $ip"; else info "이 서버에서는 $DOMAIN 이 DNS 로 안 풀림 — 업무망 PC 브라우저로 확인"; fi
if [ -n "$L4_VIP" ]; then
  code=$(curl -sk --max-time 5 --resolve "$DOMAIN:443:$L4_VIP" -o /dev/null -w '%{http_code}' "https://$DOMAIN/")
  if [ "$code" = 000 ]; then info "L4 $L4_VIP:443 는 이 서버에서 안 닿음 — 업무망 PC 에서 확인"
  else ok "L4 $L4_VIP:443 응답 ($code)"; fi
fi

# ── 6. 네임스페이스 ──────────────────────────────────────────
sec 6 "네임스페이스 (서비스별 공간)"
raw namespaces kubectl get ns --show-labels
for ns in $DATA_NAMESPACES; do
  if k get ns "$ns" >/dev/null; then ok "$ns 있음 (파드 $(k -n "$ns" get pods --no-headers | wc -l) 개)"
  else bad "$ns 없음" "공통 데이터 공간 — 인프라 담당 선행 작업 (가이드 11장)"; fi
done
for ns in $SERVICE_NAMESPACES; do
  if k get ns "$ns" >/dev/null; then ok "$ns 있음 (파드 $(k -n "$ns" get pods --no-headers | wc -l) 개)"
  else info "$ns 아직 없음 — 그 서비스 첫 배포 때 생김"; fi
done

# ── 7. DB ───────────────────────────────────────────────────
sec 7 "DB (PostgreSQL)"
if k get crd clusters.postgresql.cnpg.io >/dev/null; then
  ok "CNPG(PostgreSQL 운영 장치) 설치됨"
  raw db-clusters kubectl get clusters.postgresql.cnpg.io -A
  raw db-databases kubectl get databases.postgresql.cnpg.io -A
  while read -r ns name phase; do
    [ -z "$name" ] && continue
    case "$phase" in *healthy*) ok "DB $ns/$name: $phase" ;; *) bad "DB $ns/$name: ${phase:-상태 없음}" "kubectl -n $ns describe cluster $name" ;; esac
  done < <(k get clusters.postgresql.cnpg.io -A -o jsonpath='{range .items[*]}{.metadata.namespace}{" "}{.metadata.name}{" "}{.status.phase}{"\n"}{end}')
else
  bad "CNPG 설치 안 됨" "가이드 11장 ③"
fi
for s in db-general-rw pg-signal-rw; do
  if k -n data-db get svc "$s" >/dev/null; then ok "DB 주소 $s.data-db.svc.cluster.local 있음"
  elif [ "$s" = pg-signal-rw ]; then info "$s 아직 없음 (신호 DB 구축 예정)"
  else bad "DB 주소 $s 없음" "가이드 11장 ③ kubectl apply -k k8s/db"; fi
done

# ── 8. Kafka ────────────────────────────────────────────────
sec 8 "Kafka"
if k get crd kafkas.kafka.strimzi.io >/dev/null; then
  ok "Strimzi(Kafka 운영 장치) 설치됨"
  raw kafka kubectl get kafka,kafkanodepool -A
  while read -r ns name rd; do
    [ -z "$name" ] && continue
    if [ "$rd" = True ]; then ok "Kafka $ns/$name Ready"; else bad "Kafka $ns/$name Ready 아님" "kubectl -n $ns describe kafka $name"; fi
  done < <(k get kafka -A -o jsonpath='{range .items[*]}{.metadata.namespace}{" "}{.metadata.name}{" "}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}')
  kb=$(k get pods -A -l strimzi.io/broker-role=true --no-headers)
  info "브로커 파드: $(echo -n "$kb" | grep -c ' Running ') 개 Running / 전체 $(echo -n "$kb" | grep -c .) 개 (Strimzi 브로커 역할)"
else
  bad "Strimzi(Kafka) 설치 안 됨" "가이드 11장 ④"
fi

# ── 9. Redis · MinIO ────────────────────────────────────────
sec 9 "Redis · MinIO"
for name in redis minio; do
  all=$(k get pods -A --no-headers | grep -i "$name" | awk '$4!="Completed"')
  tot=$(echo -n "$all" | grep -c .); run=$(echo -n "$all" | grep -c ' Running ')
  if [ "$tot" -gt 0 ] && [ "$run" -gt 0 ]; then ok "$name 파드 Running $run/$tot"
  elif [ "$tot" -gt 0 ]; then bad "$name 파드는 있으나 돌지 않음 ($(echo "$all" | awk '{print $1"/"$2" "$4}' | head -2 | paste -sd' ' -))" "kubectl -n <ns> describe pod <파드> 맨 아래 Events"
  else bad "$name 없음" "구성 파일 필요 (가이드 11장 마지막: 아직 구성 파일이 없는 공통 요소)"; fi
done

# ── 10. 스토리지 ────────────────────────────────────────────
sec 10 "스토리지"
raw storageclass kubectl get sc
raw pv kubectl get pv
raw pvc kubectl get pvc -A
scs=$(k get sc -o jsonpath='{range .items[*]}{.metadata.name}{" "}{end}')
if [ -n "$scs" ]; then ok "StorageClass: $scs"; else info "StorageClass 없음 (정적 PV 만 쓰는 구성이면 정상)"; fi
info "PV $(k get pv --no-headers | wc -l) 개 (Bound $(k get pv --no-headers | grep -c Bound))"
pend=$(k get pvc -A --no-headers | awk '$3!="Bound"{print $1"/"$2"("$3")"}' | paste -sd' ' -)
if [ -n "$pend" ]; then bad "묶이지 않은 PVC: $pend" "kubectl -n <ns> describe pvc <이름>"; else ok "PVC 모두 Bound ($(k get pvc -A --no-headers | wc -l) 개)"; fi

# ── 11. GPU ─────────────────────────────────────────────────
sec 11 "GPU"
for n in $NODES_AI $NODES_LLM; do
  in_list "$n" "$actual" || continue
  g=$(k get node "$n" -o jsonpath='{.status.allocatable.nvidia\.com/gpu}')
  if [ -n "$g" ] && [ "$g" != 0 ]; then ok "$n GPU $g 장 인식"
  else bad "$n GPU 인식 안 됨" "GPU Operator · device plugin 상태 (인프라 담당)"; fi
done
[ -z "$NODES_AI$NODES_LLM" ] && info "GPU 서버 없음 (설정 파일 기준)"

# ── 12. 모니터링 · 관리 화면 ────────────────────────────────
sec 12 "모니터링 · 관리 화면"
if kubectl top nodes > "$OUT/raw/top-nodes.txt" 2>&1; then ok "kubectl top 동작 (metrics-server)"
else bad "kubectl top 안 됨" "metrics-server 설치 (인프라 담당)"; fi
m=$(k get pods -A --no-headers | grep -iE "prometheus|grafana" | grep -c Running)
if [ "${m:-0}" -gt 0 ]; then ok "Prometheus · Grafana 파드 Running $m 개"
else bad "모니터링(Prometheus · Grafana) 없음" "모니터링 구성 필요"; fi
if k get ns cattle-system >/dev/null; then info "Rancher 설치됨 (cattle-system)"; else info "Rancher 아직 없음"; fi

# ── 13. 문제 있는 파드 ──────────────────────────────────────
sec 13 "문제 있는 파드 · 최근 경고"
raw pods kubectl get pods -A -o wide
raw events-warning kubectl get events -A --field-selector type=Warning --sort-by=.lastTimestamp
probs=$(k get pods -A --no-headers | awk '{split($3,a,"/"); if (($4!="Running" && $4!="Completed" && $4!="Succeeded") || ($4=="Running" && a[1]!=a[2])) print $1"/"$2"  "$4"  "$3}')
if [ -z "$probs" ]; then ok "모든 파드 Running · 준비 완료"
else
  bad "정상이 아닌 파드 $(echo "$probs" | wc -l) 개 (아래)" "가이드 10장 표 — kubectl -n <ns> describe pod <파드> 맨 아래 Events"
  echo "$probs" | head -20 | sed 's/^/              /' | tee -a "$REPORT"
fi
info "최근 경고 이벤트 $(k get events -A --field-selector type=Warning --no-headers | wc -l) 건 (raw/events-warning.txt)"

# ── 14. 자원 여유 ──────────────────────────────────────────
sec 14 "자원 여유 (요청 기준)"
for n in $NODES_APP $NODES_AI $NODES_LLM; do
  in_list "$n" "$actual" || continue
  kubectl describe node "$n" 2>/dev/null | sed -n '/Allocated resources/,/Events/p' > "$OUT/raw/alloc-$n.txt"
  cpu=$(awk '$1=="cpu"{print $3}' "$OUT/raw/alloc-$n.txt" | tr -d '()')
  mem=$(awk '$1=="memory"{print $3}' "$OUT/raw/alloc-$n.txt" | tr -d '()')
  info "$n 요청 CPU ${cpu:-?} · 메모리 ${mem:-?}"
done

raw workloads kubectl get deploy,sts,ds -A -o wide
raw services kubectl get svc -A -o wide
raw crds kubectl get crd
finish

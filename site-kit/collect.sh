#!/usr/bin/env bash
# 쿠버 클러스터 구성 수집 — 클러스터 구성을 있는 그대로 모아 파일 하나로 묶는다. 읽기만 한다.
#
# 쓰는 법 (root 로):
#   bash collect.sh            작업 서버(관리 서버)에서 — 클러스터 전체 + 이 서버.  보통은 이것만.
#   bash collect.sh --node     그 밖의 서버에서 — 그 서버 정보만 (선택, 인프라 담당)
#   bash collect.sh --bundle <폴더>   SVN 배포 묶음 위치가 기본값과 다를 때
#   bash collect.sh --yes      시작 확인(Enter) 없이 바로
# 결과: 마지막에 "보낼 파일" 로 나오는 .tar.gz 하나
#
# 지키는 것:
#   - 읽기만 한다 (조회 · 파일 읽기). 아무것도 만들거나 바꾸지 않는다.
#   - Secret 은 이름 · 종류 · 키 이름만 본다. 값과 kubeconfig 는 가져오지 않는다.
#   - 비밀번호 · 토큰 · 키처럼 보이는 값은 모두 *** 로 가린다.
#   - 배포 묶음에서 비밀값 파일(*.env — 서식 *.example.env 제외)과 개인키는 빼고 가져온다.
#   - 비밀번호를 묻지 않는다.
set -uo pipefail

# ==== 서버 주소 설정 시작 — 받은 그대로 쓰면 됨 (주소가 바뀐 경우에만 고침) ====
DOMAIN="ai.lab.example"                  # 대표 도메인
INGRESS_VIP="127.0.0.1"                  # 입구 가상 주소 (Traefik)
L4_VIP=""                                # L4 (부하분산 장비)
REGISTRY="localhost:5000"                # 이미지 창고 주소:포트
ROLE_LABEL="lab.io/role"                 # 서버 역할 라벨 이름
NFS_SERVER=""                            # 스토리지(NFS) 주소
EXTRA_TCP=""                             # 그 밖에 연결을 확인할 주소:포트 (공백으로 여러 개)
WORK_SERVER=""                           # 이 작업 서버에 접속하는 주소 (마지막 안내 문구용)
BUNDLE_DIR="/opt/deploy/gc-app-deploy"   # SVN 배포 묶음을 둔 곳
OUT_DIR="/root"                          # 결과 파일을 만들 곳
# ==== 서버 주소 설정 끝 ====

MODE=cluster
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --node) MODE=node ;;
    --yes|-y) YES=1 ;;
    --bundle) BUNDLE_DIR=${2:-}; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
  esac
  shift
done

# sudo 로 돌리면 /usr/local/bin 이 실행 경로에서 빠지는 서버가 있음 (k3s · kubectl 이 거기 있음)
export PATH=$PATH:/usr/local/bin:/usr/local/sbin
# 쿠버 배포판 (RKE2 · k3s) — 설정 파일 위치가 다름
K8S_DIST=""; for d in rke2 k3s; do if [ -d /etc/rancher/$d ] || [ -d /var/lib/rancher/$d ]; then K8S_DIST=$d; break; fi; done
RCONF=/etc/rancher/${K8S_DIST:-rke2}; RDATA=/var/lib/rancher/${K8S_DIST:-rke2}
[ -x $RDATA/bin/kubectl ] && export PATH=$PATH:$RDATA/bin
[ -z "${KUBECONFIG:-}" ] && [ -f $RCONF/${K8S_DIST:-rke2}.yaml ] && export KUBECONFIG=$RCONF/${K8S_DIST:-rke2}.yaml
[ -z "${CRI_CONFIG_FILE:-}" ] && [ -f $RDATA/agent/etc/crictl.yaml ] && export CRI_CONFIG_FILE=$RDATA/agent/etc/crictl.yaml

HOST=$(hostname 2>/dev/null || uname -n)
# 꼭 필요한 기본 명령 — 최소 설치 서버에는 없을 수 있음
for c in awk sed grep tar timeout; do
  command -v $c >/dev/null 2>&1 || { echo "필요한 명령 '$c' 이(가) 이 서버에 없습니다. 설치 후 다시 돌려 주세요 (수세: zypper in gawk · 레드햇: dnf install gawk)."; exit 1; }
done
line() { printf '%s\n' "════════════════════════════════════════════════════════════"; }

if [ "$(id -u)" != 0 ]; then
  echo "root 로 실행해야 합니다:  sudo bash $0 $*"
  exit 1
fi
if [ "$MODE" = cluster ] && ! timeout 15 kubectl get --raw /version >/dev/null 2>&1; then
  line
  echo " 이 서버($HOST)에서는 쿠버 관리 권한(kubectl)이 없습니다."
  echo " 클러스터 전체를 모으려면 작업 서버${WORK_SERVER:+ ($WORK_SERVER)} 에서 돌려 주세요."
  echo " 이 서버 정보만 모으려면:  bash $0 --node"
  line
  exit 1
fi

line
echo " 쿠버 구성 수집 — 읽기만 합니다 (아무것도 만들거나 바꾸지 않음)"
if [ "$MODE" = cluster ]; then
  echo " 모으는 것: 클러스터 전체(서버 · 설치된 구성 요소 · 설정 · 경로 · 스토리지 · DB · 카프카 ·"
  echo "            이미지 창고 · 연결 시험) + 이 서버 정보 + SVN 배포 묶음(있으면)"
  echo " 걸리는 시간: 1~3분"
else
  echo " 모으는 것: 이 서버($HOST) 정보만 (OS · 디스크 · 네트워크 · 미러 설정 · GPU 등)"
  echo " 걸리는 시간: 30초 정도"
fi
echo " 비밀번호를 묻지 않습니다. 비밀값은 가져오지 않고, 비밀번호처럼 보이는 값은 *** 로 가립니다."
echo
echo " 쓰는 주소 (주소가 바뀐 경우에만 이 파일 맨 위 '서버 주소 설정' 을 고치세요)"
echo "   대표 도메인     : ${DOMAIN:-없음}"
echo "   입구 가상 주소  : ${INGRESS_VIP:-없음}"
echo "   L4              : ${L4_VIP:-없음}"
echo "   이미지 창고     : ${REGISTRY:-없음}"
echo "   스토리지(NFS)   : ${NFS_SERVER:-없음}"
echo "   배포 묶음 위치  : $BUNDLE_DIR $( [ -d "$BUNDLE_DIR" ] && echo '(있음)' || echo '(없음 — 건너뜀)')"
line
if [ "$YES" != 1 ] && [ -t 0 ]; then
  read -r -p "시작하려면 Enter, 그만두려면 Ctrl+C: " _
fi
NAME=collect-$HOST-$(date +%Y%m%d-%H%M%S)
OUT=$OUT_DIR/$NAME
mkdir -p "$OUT"
SUM=$OUT/00-summary.txt

# 비밀번호 · 토큰 · 키처럼 보이는 값 가리기
#  - 이름이 비밀 낱말로 끝나는 키의 값:  DB_PASSWORD: x · JWT_SECRET=x · token: x · MINIO_ACCESS_KEY: x · tls.key: x
#    (secretName · secretKeyRef · tokenTTL 처럼 뒤에 다른 말이 붙으면 안 가림 — 어떤 Secret 을 쓰는지는 보여야 하므로)
#  - 두 줄짜리 env:  - name: DB_PASSWORD  /  value: x   · 한 줄 JSON(마지막 적용 기록): {"name":"DB_PASSWORD","value":"x"}
#  - 개인키(PEM) 본문 · 주소 안의 사용자:비밀번호@
SECRET_WORDS='(pass(word|wd)?|pwd|secret|token|[._-]key|apikey|credentials?|auth|identitytoken)'
mask() {
  sed -E \
    -e "s/([A-Za-z0-9_.-]*${SECRET_WORDS}[\"']?[[:space:]]*[:=][[:space:]]*)(\"[^\"]*\"|'[^']*'|[^[:space:],}]+)/\1***/Ig" \
    -e "s/(\"name\":[[:space:]]*\"[A-Za-z0-9_.-]*${SECRET_WORDS}\",[[:space:]]*\"value\":[[:space:]]*)\"[^\"]*\"/\1\"***\"/Ig" \
    -e "/name:[[:space:]]*[\"']?[A-Za-z0-9_.-]*${SECRET_WORDS}[\"']?[[:space:]]*\$/I{n;s/(value:[[:space:]]*).+/\1***/}" \
    -e "s/(name:[[:space:]]*[A-Za-z0-9_.-]*${SECRET_WORDS}(\\\\n|\\\\r)+[[:space:]]*value:[[:space:]]*)[^\\\\\"]+/\1***/Ig" \
    -e 's/-----BEGIN [A-Z ]*PRIVATE KEY-----.*-----END [A-Z ]*PRIVATE KEY-----/*** 개인키 가림 ***/' \
    -e '/-----BEGIN [A-Z ]*PRIVATE KEY-----/,/-----END [A-Z ]*PRIVATE KEY-----/c\    *** 개인키 가림 ***' \
    -e 's#(://[^:/@[:space:]]+:)[^@/[:space:]]+@#\1***@#g' \
    -e 's/(login[^#]*[[:space:]](-p|--password)[ =])[^[:space:]]+/\1***/g; s/(--password[ =])[^[:space:]]+/\1***/g; s/(-creds[ =][^:[:space:]]+:)[^[:space:]]+/\1***/g' \
    -e 's/\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{30,}|\bglpat-[A-Za-z0-9_-]{20,}|\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/***/g'
}
T()    { timeout 120 "$@"; }
save() { local f=$1; shift; mkdir -p "$(dirname "$OUT/$f")"; T "$@" 2>&1 | mask > "$OUT/$f"; }
have() { command -v "$1" >/dev/null 2>&1; }
sum()  { echo "$*" >> "$SUM"; }
head_() { sum ""; sum "■ $*"; }
k()    { T kubectl "$@" 2>/dev/null; }
tcp()  { timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null && echo 열림 || echo 닫힘; }

STEPS=$( [ "$MODE" = cluster ] && echo 4 || echo 2 )
sum "구성 수집 결과 — $(date '+%Y-%m-%d %H:%M:%S') · 서버 $HOST · 방식 $MODE"
sum "읽기만 했고, Secret 값 · kubeconfig 는 가져오지 않았으며, 비밀번호처럼 보이는 값은 *** 로 가렸습니다."

# ════════════════════════════════════════════════════════════
# 이 서버 정보 (두 방식 공통)
# ════════════════════════════════════════════════════════════
collect_node() {
  echo "[1/$STEPS] 이 서버($HOST) 정보 모으는 중..."
  local d=node
  save $d/os.txt            bash -c 'cat /etc/os-release; echo; uname -a; echo; uptime'
  save $d/cpu-mem.txt       bash -c 'nproc; echo; free -h; echo; lscpu 2>/dev/null | head -20'
  save $d/disk.txt          bash -c 'df -hT -x tmpfs -x devtmpfs -x overlay 2>/dev/null || df -h; echo; lsblk 2>/dev/null'
  save $d/mounts-nfs.txt    bash -c 'mount | grep -Ei " type (nfs|nfs4|cifs) " || echo "(NFS 마운트 없음)"; echo; cat /etc/fstab 2>/dev/null'
  save $d/network.txt       bash -c 'ip -br addr 2>/dev/null; echo; ip route 2>/dev/null; echo; cat /etc/resolv.conf 2>/dev/null; echo; cat /etc/hosts'
  save $d/listen-ports.txt  bash -c 'ss -ltnup 2>/dev/null || netstat -ltnup 2>/dev/null'
  save $d/firewall.txt      bash -c 'systemctl is-active firewalld 2>&1; firewall-cmd --list-all 2>/dev/null; echo; iptables -S 2>/dev/null | head -60; echo; nft list ruleset 2>/dev/null | head -60'
  save $d/time.txt          bash -c 'timedatectl 2>/dev/null; chronyc tracking 2>/dev/null; chronyc sources 2>/dev/null'
  save $d/security.txt      bash -c 'getenforce 2>/dev/null; aa-status 2>/dev/null | head -5; swapon --show 2>/dev/null; sysctl net.ipv4.ip_forward vm.swappiness fs.inotify.max_user_instances 2>/dev/null'
  save $d/k8s-dist.txt      bash -c 'rke2 --version 2>/dev/null; k3s --version 2>/dev/null; echo; systemctl status rke2-server rke2-agent k3s k3s-agent --no-pager 2>/dev/null | head -40'
  save $d/k8s-config.yaml   bash -c "cat $RCONF/config.yaml 2>/dev/null || echo '(없음)'; ls $RCONF/config.yaml.d/ 2>/dev/null && cat $RCONF/config.yaml.d/*.yaml 2>/dev/null"
  save $d/registries.yaml   bash -c "cat $RCONF/registries.yaml 2>/dev/null || echo '(없음)'"
  save $d/containerd-mirror.txt bash -c 'f='"$RDATA"'/agent/etc/containerd/config.toml; [ -f $f ] && grep -nE "registry|mirror|endpoint|config_path|insecure" $f; ls -R '"$RDATA"'/agent/etc/containerd/certs.d 2>/dev/null; cat '"$RDATA"'/agent/etc/containerd/certs.d/*/hosts.toml 2>/dev/null; cat /etc/containerd/certs.d/*/hosts.toml 2>/dev/null'
  save $d/containers.txt    bash -c 'crictl ps 2>/dev/null | head -80; echo; crictl images 2>/dev/null | head -150'
  save $d/gpu.txt           bash -c 'nvidia-smi 2>/dev/null || echo "(nvidia-smi 없음)"; echo; nvidia-smi -L 2>/dev/null; lsmod 2>/dev/null | grep -i nvidia'
  save $d/services.txt      bash -c 'systemctl list-units --type=service --state=running --no-pager 2>/dev/null | head -80'
  # 빌드 · 배포 도구 (이 서버에서 도는 것 · 있는 명령) · 배포 스크립트 (이미지를 containerd 에 넣기 · 창고로 보내기 · 쿠버에 올리기)
  local CI_PAT='jenkins|teamcity|buildAgent|gitlab|gitea|tekton|drone|woodpecker|harbor|nexus|sonarqube|argo-workflows|buildkit|kaniko|svnserve'
  local DEPLOY_PAT='ctr .*(images?|i) +import|nerdctl .*(load|push)|(docker|podman) +(save|load|push)|skopeo +copy|kubectl .*(apply|set +image|rollout|create +-f)|helm +(upgrade|install)|argocd +app'
  HOST_CI=$( { ps -eo args 2>/dev/null; systemctl list-units --type=service --state=running --no-pager 2>/dev/null; docker ps --format '{{.Image}} {{.Names}}' 2>/dev/null; podman ps --format '{{.Image}} {{.Names}}' 2>/dev/null; } \
    | grep -vF 'jenkins|teamcity' | grep -ioE "$CI_PAT" | tr 'A-Z' 'a-z' | sort -u | paste -sd' ' -)
  HOST_TOOLS=""; local t; for t in docker podman nerdctl ctr crictl skopeo buildah helm kustomize argocd svn git mvn java node python3; do have $t && HOST_TOOLS="$HOST_TOOLS $t"; done
  HOST_SCRIPTS=$(for x in /root /home /opt /data /app /apps /deploy /srv /work /svn /usr/local/bin; do [ -d "$x" ] && find "$x" -maxdepth 4 -type f \( -name '*.sh' -o -name '*.bash' -o -name 'Jenkinsfile*' -o -name 'Makefile' \) -size -256k 2>/dev/null; done \
    | grep -vE '/(\.git|\.svn|node_modules|\.cache|\.local|snap|go/pkg|\.m2)/|/(collect|cluster-check|bundle-check)-[0-9]' | head -3000 | while read -r f; do grep -q 'DEPLOY_PAT=\|SECRET_WORDS=' "$f" 2>/dev/null || grep -lE "$DEPLOY_PAT" "$f" 2>/dev/null; done | head -40)
  { echo "이 서버에서 도는 빌드 · 배포 도구: ${HOST_CI:-없음}"; echo "있는 명령:${HOST_TOOLS:- 없음}"; echo; echo "배포 스크립트 (찾은 곳: /root /home /opt /data /app /deploy /srv /work, 4단계):"
    echo "${HOST_SCRIPTS:-(없음)}" | while read -r f; do [ -f "$f" ] && echo "  $f — $(grep -ohE "$DEPLOY_PAT" "$f" | cut -c1-60 | sort -u | paste -sd',' -)"; done; } > "$OUT/$d/deploy-tools.txt"
  if [ -n "$HOST_SCRIPTS" ]; then mkdir -p "$OUT/$d/deploy-scripts"; echo "$HOST_SCRIPTS" | while read -r f; do mask < "$f" > "$OUT/$d/deploy-scripts/$(echo "$f" | sed 's#^/##; s#/#_#g')"; done; fi

  head_ "이 서버 ($HOST)"
  sum "  OS        : $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-?}") · 커널 $(uname -r)"
  sum "  CPU · 메모리: $(nproc) 코어 · $(free -h 2>/dev/null | awk '/^Mem/{print $2" (사용 "$3")"}')"
  local r2=없음 sv
  for sv in rke2-server rke2-agent k3s k3s-agent; do systemctl is-active --quiet $sv 2>/dev/null && r2="$sv 실행 중"; done
  sum "  쿠버 배포판: $( { rke2 --version 2>/dev/null || k3s --version 2>/dev/null; } | head -1 | grep . || echo 없음) · 서비스 $r2"
  local fw=꺼짐; systemctl is-active --quiet firewalld 2>/dev/null && fw=켜짐
  local ntp; ntp=$(timedatectl show -p NTPSynchronized --value 2>/dev/null)
  case "$ntp" in yes) ntp="됨" ;; no) ntp="안 됨 ⚠ (chronyd 확인 — 서버 시계가 틀어지면 인증서 · 로그 시간이 어긋남)" ;; *) ntp="알 수 없음" ;; esac
  sum "  시간 동기화: $ntp · 방화벽(firewalld) $fw"
  sum "  디스크(사용률 높은 순):"
  df -h -x tmpfs -x devtmpfs -x overlay 2>/dev/null | awk 'NR>1' | sort -k5 -rn | head -5 | sed 's/^/    /' >> "$SUM"
  sum "  NFS 마운트: $(mount | grep -cEi ' type nfs') 개"
  sum "  미러 설정(registries.yaml): $( [ -f $RCONF/registries.yaml ] && { awk '/^mirrors:/{m=1;next} /^[^ ]/{m=0} m && /^  [^ -]/ && /:[[:space:]]*$/{r=$1; gsub(/"/,"",r); sub(/:$/,"",r)} m && /https?:\/\//{match($0,/https?:\/\/[^" ]+/); printf "%s → %s  ", r, substr($0,RSTART,RLENGTH)}' $RCONF/registries.yaml; echo; } || echo 없음)"
  sum "  빌드 · 배포 도구(이 서버에서 도는 것): ${HOST_CI:-없음} · 있는 명령:${HOST_TOOLS:- 없음}"
  sum "  배포 스크립트: $( [ -n "$HOST_SCRIPTS" ] && echo "$(echo "$HOST_SCRIPTS" | wc -l) 개 (node/deploy-tools.txt · 사본 node/deploy-scripts/)" || echo "못 찾음")"
  if have nvidia-smi; then sum "  GPU       : $(nvidia-smi -L 2>/dev/null | wc -l) 장 · 드라이버 $(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)"; fi
  if [ -n "$NFS_SERVER" ]; then sum "  스토리지 NFS $NFS_SERVER:2049 → $(tcp "$NFS_SERVER" 2049)"; fi
}

collect_node

# ════════════════════════════════════════════════════════════
# 클러스터 정보 (작업 서버에서)
# ════════════════════════════════════════════════════════════
if [ "$MODE" = cluster ]; then
  if ! k get --raw /version >/dev/null; then
    sum ""; sum "쿠버 API 에 연결되지 않아 클러스터 정보는 모으지 못했습니다 (작업 서버에서 root 로 실행했는지 확인)."
    MODE=none
  fi
fi

if [ "$MODE" = cluster ]; then
  echo "[2/$STEPS] 클러스터 정보 모으는 중... (1~2분)"
  # 원본 자료 ───────────────────────────────────────────
  save cluster/version.txt        kubectl version
  save cluster/nodes-wide.txt     kubectl get nodes -o wide --show-labels
  save cluster/nodes.yaml         bash -c 'kubectl get nodes -o yaml | grep -v "^ *- sha256:"'
  save cluster/nodes-describe.txt kubectl describe nodes
  save cluster/namespaces.yaml    kubectl get ns -o yaml
  save cluster/api-resources.txt  kubectl api-resources
  save cluster/crds.txt           kubectl get crd
  save cluster/apiservices.txt    kubectl get apiservices
  save cluster/webhooks.txt       kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations
  save cluster/k8s-addons.yaml    kubectl get helmcharts.helm.cattle.io,helmchartconfigs.helm.cattle.io -A -o yaml
  save cluster/helm-releases.txt  bash -c 'if command -v helm >/dev/null; then helm list -A; else kubectl get secrets -A --field-selector type=helm.sh/release.v1 -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name; fi'
  save cluster/priority-quota-limit.txt kubectl get priorityclass,resourcequota,limitrange -A
  save workloads/all-wide.txt     kubectl get all -A -o wide
  save workloads/pods-wide.txt    kubectl get pods -A -o wide
  save workloads/deployments.yaml kubectl get deploy -A -o yaml
  save workloads/statefulsets.yaml kubectl get sts -A -o yaml
  save workloads/daemonsets.yaml  kubectl get ds -A -o yaml
  save workloads/jobs.yaml        kubectl get cronjobs,jobs -A -o yaml
  save workloads/managers.tsv     kubectl get deploy,sts,ds -A --show-managed-fields -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.kind}{"\t"}{.metadata.name}{"\t"}{.status.readyReplicas}{"/"}{.spec.replicas}{"\t"}{range .spec.template.spec.containers[*]}{.image}{"|"}{.readinessProbe.periodSeconds}{"|"}{.resources.limits.memory}{.resources.requests.memory}{"|"}{.imagePullPolicy}{" "}{end}{"\t"}{.spec.template.spec.nodeSelector}{"\t"}{range .metadata.managedFields[*]}{.manager}{","}{end}{"\n"}{end}'
  save gitops/argocd.yaml         kubectl get applications.argoproj.io,applicationsets.argoproj.io,appprojects.argoproj.io -A -o yaml
  save gitops/flux.yaml           kubectl get gitrepositories.source.toolkit.fluxcd.io,kustomizations.kustomize.toolkit.fluxcd.io,helmreleases.helm.toolkit.fluxcd.io -A -o yaml
  save workloads/pods-describe-problem.txt bash -c 'kubectl get pods -A --no-headers | awk '"'"'$4!="Running" && $4!="Completed" {print $1" "$2}'"'"' | head -30 | while read ns p; do echo "===== $ns/$p"; kubectl -n $ns describe pod $p | tail -40; done'
  save network/services.yaml      kubectl get svc -A -o yaml
  save network/services-wide.txt  kubectl get svc -A -o wide
  save network/endpointslices.txt kubectl get endpointslices -A
  save network/ingress.yaml       kubectl get ingress -A -o yaml
  save network/ingressclass.yaml  kubectl get ingressclass -o yaml
  save network/traefik-crds.yaml  kubectl get ingressroutes.traefik.io,middlewares.traefik.io,tlsoptions.traefik.io,tlsstores.traefik.io -A -o yaml
  save network/networkpolicy.yaml kubectl get networkpolicy -A -o yaml
  save storage/storage.txt        kubectl get sc,pv,pvc -A -o wide
  save storage/pv.yaml            kubectl get pv -o yaml
  save storage/pvc.yaml           kubectl get pvc -A -o yaml
  save storage/sc.yaml            kubectl get sc -o yaml
  save config/configmaps.yaml     kubectl get cm -A --field-selector metadata.name!=kube-root-ca.crt -o yaml
  save config/secrets-list.txt    kubectl get secrets -A -o go-template='{{range .items}}{{.metadata.namespace}}/{{.metadata.name}}  [{{.type}}]  키: {{range $k,$v := .data}}{{$k}} {{end}}{{"\n"}}{{end}}'
  save security/rbac.txt          kubectl get serviceaccounts,roles,rolebindings -A
  save security/clusterrolebindings.txt kubectl get clusterrolebindings -o wide
  save operators/cnpg.yaml        kubectl get clusters.postgresql.cnpg.io,databases.postgresql.cnpg.io,poolers.postgresql.cnpg.io,backups.postgresql.cnpg.io,scheduledbackups.postgresql.cnpg.io -A -o yaml
  save operators/strimzi.yaml     kubectl get kafkas.kafka.strimzi.io,kafkanodepools.kafka.strimzi.io,kafkatopics.kafka.strimzi.io,kafkausers.kafka.strimzi.io -A -o yaml
  save operators/gpu.yaml         kubectl get clusterpolicies.nvidia.com -o yaml
  save events/warnings.txt        bash -c 'kubectl get events -A --field-selector type=Warning --sort-by=.lastTimestamp | tail -300'
  save events/all.txt             bash -c 'kubectl get events -A --sort-by=.lastTimestamp | tail -500'
  save metrics/top.txt            bash -c 'kubectl top nodes; echo; kubectl top pods -A --sort-by=memory | head -60'

  # 이미지 창고 ─────────────────────────────────────────
  if [ -n "$REGISTRY" ]; then
    mkdir -p "$OUT/registry"
    T curl -s "http://$REGISTRY/v2/_catalog?n=1000" > "$OUT/registry/catalog.json" 2>&1
    : > "$OUT/registry/tags.txt"
    for r in $(grep -o '"[^"]*"' "$OUT/registry/catalog.json" | tr -d '"' | grep -v '^repositories$' | head -300); do
      echo "$r  $(T curl -s "http://$REGISTRY/v2/$r/tags/list" | grep -o '"tags":\[[^]]*\]' | sed 's/"tags"://')" >> "$OUT/registry/tags.txt"
    done
  fi

  # 연결 시험 ──────────────────────────────────────────
  api=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null | sed -E 's#https?://##')
  {
    [ -n "$api" ] && printf '  - %s  %s → %s\n' "쿠버 API" "$api" "$(tcp "${api%:*}" "${api##*:}")"
    [ -n "$REGISTRY" ] && printf '  - %s  %s → %s\n' "이미지 창고" "$REGISTRY" "$(tcp "${REGISTRY%:*}" "${REGISTRY##*:}")"
    [ -n "$INGRESS_VIP" ] && printf '  - %s  %s → %s\n' "입구 가상 주소" "$INGRESS_VIP:443" "$(tcp "$INGRESS_VIP" 443)"
    [ -n "$INGRESS_VIP" ] && printf '  - %s  %s → %s\n' "입구 가상 주소 (http)" "$INGRESS_VIP:80" "$(tcp "$INGRESS_VIP" 80)"
    [ -n "$L4_VIP" ] && printf '  - %s  %s → %s\n' "L4" "$L4_VIP:443" "$(tcp "$L4_VIP" 443)"
    [ -n "$NFS_SERVER" ] && printf '  - %s  %s → %s\n' "스토리지 NFS" "$NFS_SERVER:2049" "$(tcp "$NFS_SERVER" 2049)"
    for hp in $EXTRA_TCP; do printf '  - %s  %s → %s\n' "추가" "$hp" "$(tcp "${hp%:*}" "${hp##*:}")"; done
    for n in $(k get nodes -o jsonpath='{range .items[*]}{.status.addresses[?(@.type=="InternalIP")].address}{" "}{end}'); do
      printf '  - %s  %s → %s\n' "서버 kubelet" "$n:10250" "$(tcp "$n" 10250)"
    done
    echo
    if [ -n "$INGRESS_VIP" ] && [ -n "$DOMAIN" ]; then
      echo "https://$DOMAIN/ (입구 $INGRESS_VIP 로 직접) → $(T curl -sk --resolve "$DOMAIN:443:$INGRESS_VIP" -o /dev/null -w '%{http_code}' "https://$DOMAIN/")"
      [ -n "$L4_VIP" ] && echo "https://$DOMAIN/ (L4 $L4_VIP 로) → $(T curl -sk --resolve "$DOMAIN:443:$L4_VIP" -o /dev/null -w '%{http_code}' "https://$DOMAIN/")"
      dns=$(getent hosts "$DOMAIN" | awk '{print $1}' | paste -sd' ' -)
      echo "DNS: $DOMAIN → ${dns:-(이 서버에서는 안 풀림 — 사용자 PC 의 hosts · 사내 DNS 로 확인)}"
      echo
      echo "입구 인증서:"
      cert=$(echo | T openssl s_client -connect "$INGRESS_VIP:443" -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -subject -issuer -dates 2>/dev/null)
      echo "$cert"
      echo "$cert" | grep -qi "TRAEFIK DEFAULT\|ingress-nginx\|Fake Certificate" && echo "⚠ 기관 인증서가 아니라 입구의 기본 인증서 — 브라우저에 보안 경고가 뜸"
    fi
  } > "$OUT/network/connectivity.txt" 2>&1

  # 배포 묶음 (SVN 사본) ─────────────────────────────────
  if [ -n "$BUNDLE_DIR" ] && [ -d "$BUNDLE_DIR" ]; then
    echo "[3/$STEPS] 배포 묶음 $BUNDLE_DIR 모으는 중..."
    mkdir -p "$OUT/bundle/files" "$OUT/bundle/rendered"
    ( cd "$BUNDLE_DIR" && find . -type f ! -path './.svn/*' ! -path './.git/*' ! -path './evidence/*' | sort ) > "$OUT/bundle/files.txt"
    ( cd "$BUNDLE_DIR" && (svn info 2>/dev/null || git log -1 2>/dev/null || echo "(svn · git 정보 없음)") ) | mask > "$OUT/bundle/version.txt"
    ( cd "$BUNDLE_DIR" && find . -type f ! -path './.svn/*' ! -path './.git/*' ! -path './evidence/*' \
        \( -name '*.yaml' -o -name '*.yml' -o -name '*.json' -o -name '*.sh' -o -name '*.py' -o -name 'Dockerfile*' \
           -o -name '*.template' -o -name '*.md' -o -name '*.conf' -o -name '*.example.env' -o -name '*.toml' \) \
        ! -name '*.key' ! -name '*.pem' -size -2M ) | while read -r f; do
      grep -q 'PRIVATE KEY' "$BUNDLE_DIR/$f" 2>/dev/null && continue
      mkdir -p "$OUT/bundle/files/$(dirname "$f")"
      mask < "$BUNDLE_DIR/$f" > "$OUT/bundle/files/$f"
    done
    ( cd "$BUNDLE_DIR" && find . -type f \( -name '*.env' ! -name '*.example.env' -o -name '*.key' -o -name '*.pem' \) ! -path './.svn/*' ) \
      | sed 's/^/뺀 파일 (비밀값 · 키): /' > "$OUT/bundle/excluded.txt"
    for kz in $(cd "$BUNDLE_DIR" && find . -name kustomization.yaml ! -path './.svn/*' | sort); do
      d=$(dirname "$kz"); n=$(echo "${d#./}" | tr '/' '_')
      T kubectl kustomize "$BUNDLE_DIR/$d" 2>&1 | mask > "$OUT/bundle/rendered/$n.yaml"
    done
  fi

  # ── 요약 ────────────────────────────────────────────
  [ -d "$BUNDLE_DIR" ] || echo "[3/$STEPS] 배포 묶음 $BUNDLE_DIR 없음 — 건너뜀"
  echo "[4/$STEPS] 요약 만드는 중..."
  rl=${ROLE_LABEL//./\\.}
  head_ "쿠버 · 서버"
  sum "  쿠버 버전: $(k get --raw /version | grep -o '"gitVersion": *"[^"]*"' | cut -d'"' -f4) · 서버 $(k get nodes --no-headers | wc -l) 대"
  k get nodes -o custom-columns="이름:.metadata.name,${rl:+역할라벨:.metadata.labels.$rl,}IP:.status.addresses[?(@.type==\"InternalIP\")].address,CPU:.status.capacity.cpu,메모리:.status.capacity.memory,GPU:.status.allocatable.nvidia\.com/gpu,kubelet:.status.nodeInfo.kubeletVersion,런타임:.status.nodeInfo.containerRuntimeVersion" | awk '{for(i=1;i<=NF;i++) if($i ~ /^[0-9]+Ki$/) $i=sprintf("%.0fGi", $i/1048576); print $0}' | column -t | sed 's/^/  /' >> "$SUM"
  sum ""
  k get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"  OS: "}{.status.nodeInfo.osImage}{" · 커널 "}{.status.nodeInfo.kernelVersion}{" · Ready="}{.status.conditions[?(@.type=="Ready")].status}{" · taint: "}{range .spec.taints[*]}{.key}={.value}:{.effect}{" "}{end}{"\n"}{end}' | sed 's/^/  /' >> "$SUM"

  head_ "설치된 구성 요소 (자동 감지)"
  pods_all=$(k get pods -A --no-headers)
  pods_live=$(echo "$pods_all" | awk '$4!="Completed" && $4!="Succeeded" && $2 !~ /^helm-install-/')
  crds=$(k get crd -o name)
  detect() {  # detect <이름> <파드 이름 패턴> [CRD 패턴]
    local label=$1 pat=$2 crd=${3:-} lines total run nss
    lines=$(echo "$pods_live" | grep -iE "$pat")
    total=$(echo -n "$lines" | grep -c . || true); run=$(echo -n "$lines" | grep -c " Running " || true)
    nss=$(echo -n "$lines" | awk '{print $1}' | sort -u | paste -sd',' -)
    if [ "${total:-0}" -gt 0 ]; then sum "  있음  $label — 파드 $run/$total Running (네임스페이스 $nss)"
    elif [ -n "$crd" ] && echo "$crds" | grep -qiE "$crd"; then sum "  일부  $label — 종류(CRD)만 있고 파드 없음"
    else sum "  없음  $label"; fi
  }
  if ! echo "$pods_live" | grep -qiE "canal|calico|cilium|flannel|kube-ovn|kindnet" && k get nodes -o jsonpath='{.items[0].metadata.annotations}' | grep -q flannel; then
    sum "  있음  네트워크(CNI) — k3s 내장 flannel (따로 파드 없이 k3s 안에서 동작)"
  else detect "네트워크(CNI)" "canal|calico|cilium|flannel|kube-ovn|kindnet"; fi
  detect "CoreDNS"                       "coredns"
  detect "입구 Traefik"                  "traefik"
  detect "입구 ingress-nginx"            "ingress-nginx|nginx-ingress"
  detect "가상 주소 kube-vip"            "kube-vip"
  detect "metrics-server (kubectl top)"  "metrics-server"
  detect "PostgreSQL 운영 장치 CNPG"     "cnpg|cloudnative-pg" "postgresql.cnpg.io"
  dbp=$(k get pods -A -l cnpg.io/instanceName --no-headers)
  if [ -n "$dbp" ]; then sum "  있음  PostgreSQL DB 파드 — $(echo "$dbp" | grep -c ' Running ')/$(echo "$dbp" | grep -c .) Running (CNPG DB, 네임스페이스 $(echo "$dbp" | awk '{print $1}' | sort -u | paste -sd, -))"
  else detect "PostgreSQL DB 파드" "postgres|db-general|pg-signal"; fi
  detect "Kafka 운영 장치 Strimzi"       "strimzi" "kafka.strimzi.io"
  kb=$(k get pods -A -l strimzi.io/broker-role=true --no-headers)
  if [ -n "$kb" ]; then sum "  있음  Kafka 브로커 — 파드 $(echo "$kb" | grep -c ' Running ')/$(echo "$kb" | grep -c .) Running (Strimzi 브로커 역할)"
  else detect "Kafka 브로커" "kafka-[0-9]|broker-[0-9]"; fi
  detect "Redis"                         "redis"
  detect "MinIO"                         "minio"
  detect "GPU 장치 (NVIDIA)"             "nvidia|gpu-operator|device-plugin" "nvidia.com"
  detect "모니터링 Prometheus"           "prometheus"
  detect "모니터링 Grafana"              "grafana"
  detect "로그 Loki"                     "loki|promtail|fluent"
  detect "Rancher"                       "^cattle-system|rancher"
  detect "cert-manager"                  "cert-manager"
  detect "스토리지 공급자(NFS · Longhorn 등)" "nfs-subdir|csi-nfs|nfs-provisioner|longhorn|local-path"
  detect "백업 Velero"                   "velero"

  head_ "배포 방식 (무엇으로 올리고 있나)"
  if echo "$crds" | grep -q "applications.argoproj.io"; then
    apps=$(k get applications.argoproj.io -A -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.source.repoURL}{.spec.sources[0].repoURL}{"\t"}{.spec.source.path}{.spec.source.chart}{.spec.sources[0].path}{.spec.sources[0].chart}{"\t"}{.spec.source.targetRevision}{.spec.sources[0].targetRevision}{"\t"}{.spec.destination.namespace}{"\t"}{.status.sync.status}{"\t"}{.status.health.status}{"\n"}{end}' | mask)
    sum "  ArgoCD: Application $(echo -n "$apps" | grep -c .) 개 (이름 ← 저장소 경로@브랜치 → 네임스페이스 · 동기화 · 상태)"
    echo "$apps" | head -40 | awk -F'\t' 'NF>1{printf "    %s ← %s %s@%s → %s · %s · %s\n", $1, $2, $3, ($4==""?"HEAD":$4), ($5==""?"-":$5), $6, $7}' >> "$SUM"
  else sum "  ArgoCD: 없음"; fi
  echo "$crds" | grep -q "kustomize.toolkit.fluxcd.io" && sum "  Flux: Kustomization $(k get kustomizations.kustomize.toolkit.fluxcd.io -A --no-headers | wc -l) 개"
  ci=$(echo "$pods_live" | grep -iE 'jenkins|teamcity|gitlab|gitea|tekton|drone|woodpecker|harbor|nexus|sonarqube|argo-workflows|buildkit|kaniko|svnserve' | awk '{print "    "$1"/"$2"  "$4}')
  sum "  클러스터 안의 빌드 · 배포 서버:"; sum "${ci:-    없음}"
  sum "  앱 (시스템 네임스페이스 빼고 · 준비 · 이미지 · 올린 방법 — kubectl 손작업 / ArgoCD / Helm / Rancher 화면):"
  awk -F'\t' '$1 !~ /^(kube-|cattle-|fleet-|rancher|cnpg-system|calico|tigera|metallb|longhorn|gpu-operator|nvidia|cert-manager|argocd|ingress|traefik|monitoring|local-path|velero|kubernetes-dashboard|strimzi|istio|linkerd|cilium|keda|external-secrets|sealed-secrets|kyverno|gatekeeper|ci$|cicd)/ && NF>3 {
      n = split($7, a, ","); how = ""; delete seen
      for (i = 1; i <= n; i++) { x = a[i]
        if (x ~ /^kubectl-client-side-apply|^kubectl$|^kubectl-apply/) x = "kubectl apply"; else if (x ~ /^kubectl-create/) x = "kubectl create"
        else if (x ~ /^kubectl-edit/) x = "kubectl edit"; else if (x ~ /^kubectl-set/) x = "kubectl set image"; else if (x ~ /^kubectl-(rollout|patch)/) x = "kubectl rollout/patch"
        else if (x ~ /argocd/) x = "ArgoCD"; else if (x ~ /^helm/) x = "Helm"; else if (x ~ /^(rancher|steve|Mozilla|agent)/) x = "Rancher 화면"
        else if (x ~ /kustomize-controller|helm-controller/) x = "Flux"; else if (x ~ /^deploy@/) x = "서버 자동 설치 폴더"; else continue
        if (!(x in seen)) { seen[x] = 1; how = how (how == "" ? "" : "+") x } }
      split($4, rr, "/"); img = $5; gsub(/\|[^ ]*/, "", img)
      printf "    %s/%s  준비 %s/%s  %s ← %s\n", $1, $3, (rr[1] == "" ? 0 : rr[1]), rr[2], img, (how == "" ? "알 수 없음" : how) }' "$OUT/workloads/managers.tsv" | head -60 > "$OUT/workloads/apps-how.txt"
  if [ -s "$OUT/workloads/apps-how.txt" ]; then cat "$OUT/workloads/apps-how.txt" >> "$SUM"; else sum "    없음 — 앱이 아직 한 번도 안 올라감"; fi

  head_ "네임스페이스별 파드 (전체 / Running / 그 밖)"
  echo "$pods_all" | awk '{t[$1]++; if($4=="Running"||$4=="Completed") r[$1]++; else b[$1]++} END{for(n in t) printf "  %-28s %4d %4d %4d\n", n, t[n], r[n]+0, b[n]+0}' | sort >> "$SUM"

  head_ "정상이 아닌 파드"
  probs=$(echo "$pods_all" | awk '{split($3,a,"/"); if(($4!="Running"&&$4!="Completed")||($4=="Running"&&a[1]!=a[2])) print "  "$1"/"$2"  "$4"  "$3"  재시작 "$5}')
  sum "${probs:-  없음}"

  head_ "외부 경로 (Ingress)"
  ing=$(k get ingress -A --no-headers)
  if [ -n "$ing" ]; then
    k get ingress -A -o custom-columns='네임스페이스:.metadata.namespace,이름:.metadata.name,클래스:.spec.ingressClassName,도메인:.spec.rules[*].host,경로:.spec.rules[*].http.paths[*].path,서비스:.spec.rules[*].http.paths[*].backend.service.name' | sed 's/^/  /' >> "$SUM"
  else sum "  없음"; fi
  sum "  IngressClass: $(k get ingressclass -o jsonpath='{range .items[*]}{.metadata.name}({.spec.controller}) {end}')"

  head_ "밖에서 들어오는 서비스 (LoadBalancer · NodePort)"
  lb=$(k get svc -A --no-headers | awk '$3=="LoadBalancer"||$3=="NodePort" {print "  "$1"/"$2"  "$3"  외부 "$5"  포트 "$6}')
  sum "${lb:-  없음}"

  head_ "스토리지"
  sum "  StorageClass:"; k get sc --no-headers | sed 's/^/    /' >> "$SUM" || true
  sum "  PV: $(k get pv --no-headers | wc -l) 개"
  k get pv -o jsonpath='{range .items[*]}{"    "}{.metadata.name}{"  "}{.spec.capacity.storage}{"  "}{.status.phase}{" → "}{.spec.claimRef.namespace}{"/"}{.spec.claimRef.name}{"  SC="}{.spec.storageClassName}{"  nfs="}{.spec.nfs.server}{":"}{.spec.nfs.path}{.spec.csi.volumeAttributes.server}{.spec.csi.volumeAttributes.share}{"\n"}{end}' | sed -E 's/  nfs=:$//; s/  SC=  / /' >> "$SUM"
  sum "  PVC:"; k get pvc -A -o custom-columns='네임스페이스:.metadata.namespace,이름:.metadata.name,상태:.status.phase,크기:.status.capacity.storage,SC:.spec.storageClassName' | sed 's/^/    /' >> "$SUM" || true

  head_ "DB (CNPG) · Kafka (Strimzi)"
  db=$(k get clusters.postgresql.cnpg.io -A -o custom-columns='네임스페이스:.metadata.namespace,이름:.metadata.name,인스턴스:.spec.instances,준비:.status.readyInstances,상태:.status.phase,이미지:.spec.imageName')
  if [ -n "$db" ]; then echo "$db" | sed 's/^/  /' >> "$SUM"; else sum "  CNPG DB 없음"; fi
  dbs=$(k get databases.postgresql.cnpg.io -A -o custom-columns='네임스페이스:.metadata.namespace,DB:.spec.name,소유자:.spec.owner,클러스터:.spec.cluster.name,적용:.status.applied')
  if [ "$(echo "$dbs" | grep -c .)" -gt 1 ]; then echo "$dbs" | sed 's/^/  /' >> "$SUM"; elif [ -n "$db" ]; then sum "  (Database 자원 없음 — DB 는 Cluster 만들 때 생긴 것만 있음)"; fi
  kf=$(k get kafkas.kafka.strimzi.io -A -o custom-columns='네임스페이스:.metadata.namespace,이름:.metadata.name,준비:.status.conditions[?(@.type=="Ready")].status,버전:.status.kafkaVersion')
  if [ -n "$kf" ]; then echo "$kf" | sed 's/^/  /' >> "$SUM"; else sum "  Kafka 없음"; fi
  np=$(k get kafkanodepools.kafka.strimzi.io -A -o custom-columns='네임스페이스:.metadata.namespace,이름:.metadata.name,대수:.spec.replicas,역할:.spec.roles')
  [ -n "$np" ] && echo "$np" | sed 's/^/  /' >> "$SUM"

  head_ "이미지 창고 ($REGISTRY)"
  if [ -s "$OUT/registry/tags.txt" ]; then
    sum "  이미지 $(wc -l < "$OUT/registry/tags.txt") 종 (전체 목록: registry/tags.txt)"
    awk '{repo=$1; t=$2; gsub(/[\[\]"]/,"",t); n=split(t,a,","); s=""; for(i=1;i<=n&&i<=5;i++) s=s (i>1?", ":"") a[i]; printf "  %-28s 태그 %d개 (%s%s)\n", repo, n, s, (n>5?" …":"")}' "$OUT/registry/tags.txt" | head -40 >> "$SUM"
  else sum "  응답 없음 또는 비어 있음 — $(head -c 200 "$OUT/registry/catalog.json" 2>/dev/null)"; fi

  head_ "연결 시험 (이 서버에서)"
  sed 's/^/  /' "$OUT/network/connectivity.txt" >> "$SUM"

  head_ "자원 사용"
  k top nodes | sed 's/^/  /' >> "$SUM" || sum "  kubectl top 안 됨 (metrics-server 없음)"
  sum "  요청 기준 할당 (서버별):"
  for n in $(k get nodes -o jsonpath='{.items[*].metadata.name}'); do
    a=$(k describe node "$n" | sed -n '/Allocated resources/,/Events/p' | awk '$1=="cpu"{c=$2" "$3} $1=="memory"{m=$2" "$3} $1=="nvidia.com/gpu"{g=$2} END{print "CPU "c" · 메모리 "m (g!=""?" · GPU "g:"")}')
    sum "    $n  $a"
  done

  head_ "최근 경고 이벤트 (마지막 25건, 전체: events/warnings.txt)"
  if grep -q "No resources found" "$OUT/events/warnings.txt" || [ ! -s "$OUT/events/warnings.txt" ]; then sum "  없음"; else tail -25 "$OUT/events/warnings.txt" | cut -c1-220 | sed 's/^/  /' >> "$SUM"; fi

  head_ "Secret · 설정값"
  sum "  Secret $(grep -c . "$OUT/config/secrets-list.txt") 개 (이름 · 종류 · 키 이름만: config/secrets-list.txt)"
  sum "  TLS 인증서 Secret: $(grep -c 'kubernetes.io/tls' "$OUT/config/secrets-list.txt") 개"
  grep 'kubernetes.io/tls' "$OUT/config/secrets-list.txt" | awk '{print "    "$1}' >> "$SUM"

  head_ "배포 묶음 (SVN 사본)"
  if [ -d "$OUT/bundle" ]; then
    sum "  위치 $BUNDLE_DIR · 파일 $(wc -l < "$OUT/bundle/files.txt") 개 · $(grep -m1 -E '^(Revision|commit)' "$OUT/bundle/version.txt" || echo '버전 정보 없음')"
    sum "  서비스 폴더: $(ls "$OUT/bundle/rendered" 2>/dev/null | sed 's/\.yaml$//; s/^k8s_services_//' | paste -sd' ' -)"
    bad_r=$(grep -l -iE '^error|Error:' "$OUT/bundle/rendered/"*.yaml 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.yaml$//; s/^k8s_services_//' | paste -sd' ' -)
    sum "  조립 실패: ${bad_r:-없음}"
    sum "  $(wc -l < "$OUT/bundle/excluded.txt") 개 파일은 비밀값 · 키라서 뺌 (bundle/excluded.txt)"
  elif [ -z "$BUNDLE_DIR" ]; then sum "  (배포 묶음 위치를 정하지 않아 건너뜀)"
  else sum "  $BUNDLE_DIR 없음 — SVN 배포 묶음을 이 위치에 두고 다시 돌리면 함께 모읍니다 (--bundle 로 위치 지정 가능)"; fi
fi

# ── 묶기 ────────────────────────────────────────────────
sum ""
sum "자세한 원본: 이 파일과 같은 폴더의 cluster/ workloads/ network/ storage/ config/ operators/ events/ metrics/ registry/ bundle/ node/"
[ "$MODE" = node ] && echo "[2/$STEPS] 묶는 중..."
tar -C "$OUT_DIR" -czf "$OUT.tar.gz" "$NAME" 2>/dev/null
# sudo 로 돌렸으면 결과를 접속한 사람 것으로 (비밀번호 없이 가져오고 지울 수 있게)
[ -n "${SUDO_USER:-}" ] && chown -R "$SUDO_USER" "$OUT" "$OUT.tar.gz" 2>/dev/null
echo
sed -n '1,45p' "$SUM"
echo "  ... (요약 전체는 결과 파일 안 00-summary.txt)"
echo
# 작업 서버 방식이면 작업 서버 주소, --node 면 이 서버 자신의 주소
if [ "$MODE" = node ]; then ADDR=$(hostname -I 2>/dev/null | awk '{print $1}' || ip -4 -o addr show scope global 2>/dev/null | awk '{sub(/\/.*/,"",$4); print $4; exit}'); else ADDR=${WORK_SERVER:-$(hostname -I 2>/dev/null | awk '{print $1}')}; fi
line
echo " 끝났습니다. 아래 파일 하나를 보내 주세요."
echo
echo "   보낼 파일:  $OUT.tar.gz  ($(du -h "$OUT.tar.gz" | cut -f1))"
echo
echo " 가져오는 법 — 이 서버에 접속했던 컴퓨터(VPN 컴퓨터)의 명령 창에서:"
echo "   scp root@${ADDR}:$OUT.tar.gz ."
echo
echo " 비밀번호 · 비밀값은 들어 있지 않습니다. 내부 주소가 들어 있으니 사내 메일로 보내 주세요."
line

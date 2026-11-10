#!/usr/bin/env bash
# 연습장 준비 — GC 인프라 담당의 "선행 작업"(가이드 11장)을 작게 흉내 낸다.
#   1) 클러스터  2) 이미지 창고(infra01:5000) + 노드가 docker.io 요청을 창고로 돌리게(미러)
#   3) 창고 시험  4) 서버 라벨  5) 입구(Traefik) · 공통 DB · DB 비밀번호 파일
#   6) 도메인 · 인증서  7) 빌드 도구  8) 작업 폴더
# 사용:
#   킬러코다: 자동 실행 (gc-deploy-lab/intro/background.sh)
#   내 PC(리눅스 · WSL2, x86_64, 도커 필요): sudo bash lab/setup.sh --mode kind
set -uo pipefail

LAB_DIR=$(cd "$(dirname "$0")/.." && pwd)
MODE=""
[ "${1:-}" = "--mode" ] && MODE=${2:-}
if [ -z "$MODE" ]; then
  if [ "$(hostname)" = controlplane ]; then MODE=killercoda; else MODE=kind; fi
fi

export HOME=/root
ECR=public.ecr.aws/docker/library
DOMAIN=ai.lab.example
STATUS=/root/.gc-lab-status
KIND_NAME=gc-lab
KIND_VERSION=v0.32.0
TMP=$(mktemp -d)

step() { echo; echo "== $*"; }
die()  { echo "준비 실패: $*"; echo "fail: $*" > "$STATUS"; exit 1; }
retry() { local n=$1 i; shift; for i in $(seq 1 "$n"); do "$@" && return 0; sleep 5; done; return 1; }

# 노드에서 명령 실행 / 노드에 파일 넣기 (킬러코다: ssh, kind: docker exec)
node_sh() {
  local n=$1; shift
  if [ "$MODE" = kind ]; then docker exec "$n" bash -c "$*"
  elif [ "$n" = "$(hostname)" ]; then bash -c "$*"
  else ssh -o StrictHostKeyChecking=no -o BatchMode=yes "$n" "$*"; fi
}
node_put() {
  local n=$1 src=$2 dst=$3
  node_sh "$n" "mkdir -p $(dirname "$dst")"
  if [ "$MODE" = kind ]; then docker cp "$src" "$n:$dst" >/dev/null
  elif [ "$n" = "$(hostname)" ]; then cp "$src" "$dst"
  else scp -q -o StrictHostKeyChecking=no "$src" "$n:$dst"; fi
}

rm -f "$STATUS"
[ "$(id -u)" = 0 ] || die "root 로 실행해야 합니다 (sudo bash lab/setup.sh)"
echo "연습장 준비 시작 — 방식: $MODE · 폴더: $LAB_DIR"

# ── 1. 클러스터 ────────────────────────────────────────────────
if [ "$MODE" = killercoda ]; then
  step "1. 클러스터 확인 (관리 서버 controlplane + 업무 서버 node01)"
  retry 60 kubectl get nodes >/dev/null 2>&1 || die "쿠버 API 가 응답하지 않음"
else
  step "1. 클러스터 만들기 (kind: 관리 서버 1 + 업무 서버 2)"
  command -v docker >/dev/null || die "도커가 필요합니다"
  [ "$(uname -m)" = x86_64 ] || echo "  주의: x86_64 가 아니면 --platform linux/amd64 로 만든 이미지가 돌지 않습니다"
  if ! command -v kind >/dev/null; then
    curl -fsSLo /usr/local/bin/kind "https://kind.sigs.k8s.io/dl/$KIND_VERSION/kind-linux-amd64" \
      && chmod +x /usr/local/bin/kind || die "kind 설치 실패"
  fi
  if ! command -v kubectl >/dev/null; then
    curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
      && chmod +x /usr/local/bin/kubectl || die "kubectl 설치 실패"
  fi
  if ! kind get clusters 2>/dev/null | grep -qx "$KIND_NAME"; then
    cat > "$TMP/kind.yaml" <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: $KIND_NAME
nodes:
  - role: control-plane
    extraPortMappings:
      - { containerPort: 80,  hostPort: 80,  listenAddress: "127.0.0.1" }
      - { containerPort: 443, hostPort: 443, listenAddress: "127.0.0.1" }
  - role: worker
  - role: worker
EOF
    kind create cluster --config "$TMP/kind.yaml" --wait 180s || die "kind 클러스터 생성 실패"
  fi
fi
kubectl wait --for=condition=Ready nodes --all --timeout=300s >/dev/null || die "노드가 Ready 가 아님"
NODES=$(kubectl get nodes -o jsonpath='{.items[*].metadata.name}')
CP=$(kubectl get nodes -l node-role.kubernetes.io/control-plane -o jsonpath='{.items[0].metadata.name}')
CP_IP=$(kubectl get node "$CP" -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')
APP_NODES=$(kubectl get nodes -l '!node-role.kubernetes.io/control-plane' -o jsonpath='{.items[*].metadata.name}')
if [ "$MODE" = kind ]; then VIP=127.0.0.1; else VIP=$CP_IP; fi
echo "  노드: $NODES · 관리 서버: $CP ($CP_IP) · 업무 서버: $APP_NODES"

# ── 2. 이미지 창고 연결 (미러) ──────────────────────────────────
step "2. 노드가 docker.io 요청을 이미지 창고(infra01:5000)로 받게 설정"
cat > "$TMP/hosts.toml" <<'EOF'
server = "https://registry-1.docker.io"

[host."http://infra01:5000"]
  capabilities = ["pull", "resolve"]
EOF
# containerd 가 certs.d 폴더를 읽도록 (이미 돼 있으면 건드리지 않음)
cat > "$TMP/fix-containerd.sh" <<'EOF'
f=/etc/containerd/config.toml
changed=0
if [ ! -f "$f" ]; then
  printf 'version = 2\n[plugins."io.containerd.grpc.v1.cri".registry]\n  config_path = "/etc/containerd/certs.d"\n' > "$f"; changed=1
elif grep -qE '^[[:space:]]*config_path[[:space:]]*=[[:space:]]*""' "$f"; then
  sed -i -E 's#^([[:space:]]*)config_path[[:space:]]*=[[:space:]]*""#\1config_path = "/etc/containerd/certs.d"#' "$f"; changed=1
elif grep -q 'config_path' "$f" || grep -qE '^version[[:space:]]*=[[:space:]]*3' "$f"; then
  :   # 이미 설정됨 (containerd 2.x 는 기본값에 certs.d 포함)
elif grep -q 'io.containerd.grpc.v1.cri".registry]' "$f"; then
  sed -i '/io.containerd.grpc.v1.cri".registry]/a\  config_path = "/etc/containerd/certs.d"' "$f"; changed=1
else
  printf '\n[plugins."io.containerd.grpc.v1.cri".registry]\n  config_path = "/etc/containerd/certs.d"\n' >> "$f"; changed=1
fi
[ $changed = 1 ] && systemctl restart containerd
echo "  $(hostname): $(grep -m1 config_path "$f" 2>/dev/null | sed 's/^[[:space:]]*//' || echo '기본값 사용')"
EOF
for n in $NODES; do
  node_put "$n" "$TMP/hosts.toml" /etc/containerd/certs.d/docker.io/hosts.toml || die "$n 미러 설정 실패"
  if [ "$MODE" = killercoda ]; then
    node_sh "$n" "grep -q ' infra01\$' /etc/hosts || echo '$CP_IP infra01' >> /etc/hosts"
    node_put "$n" "$TMP/fix-containerd.sh" /tmp/fix-containerd.sh
    node_sh "$n" "bash /tmp/fix-containerd.sh" || die "$n containerd 설정 실패"
  fi
done
kubectl wait --for=condition=Ready nodes --all --timeout=180s >/dev/null || die "containerd 재시작 뒤 노드가 Ready 가 아님"

# ── 3. 이미지 창고 + 시험 ──────────────────────────────────────
step "3. 이미지 창고 (infra01 역할, 포트 5000) 시작 · 시험"
if ! docker ps --format '{{.Names}}' | grep -qx infra01; then
  docker rm -f infra01 >/dev/null 2>&1
  if [ "$MODE" = kind ]; then
    docker run -d --restart=always --name infra01 --network kind -p 127.0.0.1:5000:5000 "$ECR/registry:2" >/dev/null
  else
    docker run -d --restart=always --name infra01 -p 5000:5000 "$ECR/registry:2" >/dev/null
  fi || die "이미지 창고 시작 실패"
fi
retry 20 curl -sf http://localhost:5000/v2/ >/dev/null || die "이미지 창고가 응답하지 않음"
docker pull -q "$ECR/busybox:1.36" >/dev/null \
  && docker tag "$ECR/busybox:1.36" localhost:5000/lab/lab-check:1 \
  && docker push localhost:5000/lab/lab-check:1 >/dev/null || die "시험 이미지 넣기 실패"
for n in $NODES; do
  retry 6 node_sh "$n" "crictl pull docker.io/lab/lab-check:1 >/dev/null 2>&1" \
    || die "$n 이 창고에서 이미지를 받지 못함 (미러 설정 확인)"
  echo "  $n: docker.io/lab/lab-check:1 → 창고에서 받기 정상"
done

# ── 4. 서버 라벨 ──────────────────────────────────────────────
step "4. 서버 라벨 — 업무 서버 = lab.io/role=app"
for n in $APP_NODES; do kubectl label node "$n" lab.io/role=app --overwrite >/dev/null; done
kubectl get nodes -L lab.io/role

# ── 5. 입구 · 공통 DB ─────────────────────────────────────────
step "5. 입구(Traefik) · 공통 DB · DB 비밀번호 파일"
kubectl apply -f "$LAB_DIR/lab/infra/traefik.yaml" >/dev/null || die "Traefik 설치 실패"
kubectl create namespace data-db --dry-run=client -o yaml | kubectl apply -f - >/dev/null
if kubectl -n data-db get secret db-general-sample >/dev/null 2>&1; then
  PW=$(kubectl -n data-db get secret db-general-sample -o jsonpath='{.data.password}' | base64 -d)
else
  PW=$(openssl rand -hex 12)
  kubectl -n data-db create secret generic db-general-sample --from-literal=password="$PW" >/dev/null
fi
kubectl apply -f "$LAB_DIR/lab/infra/db-general.yaml" >/dev/null || die "DB 설치 실패"
cat > /root/db-sample.txt <<EOF
# DB 담당이 보안 매체로 전달한 계정 (연습장용 — 실제로는 받은 뒤 바로 지움)
DB 이름: sample_db
계정: sample
비밀번호: $PW
주소(클러스터 안): db-general-rw.data-db.svc.cluster.local:5432
EOF
chmod 600 /root/db-sample.txt
kubectl -n traefik rollout status deploy/traefik --timeout=300s >/dev/null || die "Traefik 이 뜨지 않음"
kubectl -n data-db rollout status deploy/db-general --timeout=300s >/dev/null || die "DB 가 뜨지 않음"

# ── 6. 도메인 · 인증서 ───────────────────────────────────────
step "6. 도메인 $DOMAIN → 입구 $VIP · 연습용 인증서"
grep -q " $DOMAIN\$" /etc/hosts || echo "$VIP $DOMAIN" >> /etc/hosts
mkdir -p /root/lab-certs
if [ ! -f "/root/lab-certs/$DOMAIN.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=$DOMAIN" \
    -addext "subjectAltName=DNS:$DOMAIN" \
    -keyout "/root/lab-certs/$DOMAIN.key" -out "/root/lab-certs/$DOMAIN.crt" 2>/dev/null || die "인증서 만들기 실패"
fi
retry 24 bash -c "curl -sk -o /dev/null -w '%{http_code}' https://$DOMAIN/ | grep -q 404" \
  || die "입구(Traefik)가 443 에서 응답하지 않음"
echo "  https://$DOMAIN/ → 404 (아직 경로 없음 = 입구 정상)"

# ── 7. 빌드 도구 (인터넷 PC 역할) ─────────────────────────────
step "7. 빌드 도구 — docker buildx · mvn · podman"
if ! docker buildx version >/dev/null 2>&1; then
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq docker-buildx >/dev/null 2>&1 || apt-get install -y -qq docker-buildx-plugin >/dev/null 2>&1
fi
docker buildx version >/dev/null 2>&1 || die "docker buildx 가 없음"
if ! command -v mvn >/dev/null; then
  cat > /usr/local/bin/mvn <<EOF
#!/usr/bin/env bash
# 연습장용 mvn — 메이븐을 컨테이너로 실행한다 (실제 인터넷 PC 에서는 설치된 mvn 을 쓴다)
exec docker run --rm -v "\$PWD":/src -v /root/.m2:/root/.m2 -w /src -e MAVEN_OPTS=-Xmx384m $ECR/maven:3.9-eclipse-temurin-17 mvn "\$@"
EOF
  chmod +x /usr/local/bin/mvn
  docker pull -q "$ECR/maven:3.9-eclipse-temurin-17" >/dev/null
fi
docker pull -q "$ECR/eclipse-temurin:17-jre" >/dev/null
docker pull -q "$ECR/nginx:1.27-alpine" >/dev/null
command -v podman >/dev/null || echo "  podman 없음 — 적재 스크립트가 docker 로 대신합니다"
command -v shasum >/dev/null || die "shasum 이 없음"

# ── 8. 작업 폴더 ──────────────────────────────────────────────
step "8. 작업 폴더"
git config --global user.name lab
git config --global user.email lab@example.com
git config --global --add safe.directory '*'
[ -e /root/gc-k8s-lab ] || ln -s "$LAB_DIR" /root/gc-k8s-lab
rm -rf /root/gc-app-deploy && cp -r "$LAB_DIR/lab/gc-app-deploy" /root/gc-app-deploy
echo "  /root/gc-k8s-lab   — 소스 저장소 (git)"
echo "  /root/gc-app-deploy — 인터넷 PC 에 둔 배포 묶음 사본"

rm -rf "$TMP"
echo ok > "$STATUS"
echo
echo "연습장 준비 완료"

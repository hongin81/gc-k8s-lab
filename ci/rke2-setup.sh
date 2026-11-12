#!/usr/bin/env bash
# RKE2 시험 환경 — 운영 클러스터와 같은 종류로: RKE2 + Traefik · 이미지 창고 미러 · CNPG(DB) · Strimzi(Kafka) · Redis · MinIO · 샘플 서비스
# 설정 파일 곳곳에 가짜 비밀번호를 심어 둔다 (수집 결과에 새는지 보려고).
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
export PATH=$PATH:/var/lib/rancher/rke2/bin KUBECONFIG=/etc/rancher/rke2/rke2.yaml
ECR=public.ecr.aws/docker/library
say() { echo; echo "== $*"; }
waitfor() { local t=$1; shift; for i in $(seq 1 "$t"); do "$@" >/dev/null 2>&1 && return 0; sleep 5; done; echo "기다림 초과: $*"; return 1; }

say "1. 이미지 창고 infra01:5000"
echo "127.0.0.1 infra01 ai.lab.example" >> /etc/hosts
docker run -d --restart=always --name infra01 -p 5000:5000 $ECR/registry:2 >/dev/null

say "2. RKE2 설치 (Traefik 입구 · 미러 · 가짜 비밀번호 심기)"
mkdir -p /etc/rancher/rke2
cat > /etc/rancher/rke2/config.yaml <<'EOF'
token: leaktoken-rke2-7f3a9c
agent-token: leakagent-rke2-2b8d1e
write-kubeconfig-mode: "0600"
ingress-controller: traefik
node-label:
  - "lab.io/role=app"
EOF
cat > /etc/rancher/rke2/registries.yaml <<'EOF'
mirrors:
  docker.io:
    endpoint:
      - "http://infra01:5000"
configs:
  "infra01:5000":
    auth:
      username: labuser
      password: regpass-leak-999
EOF
curl -sfL https://get.rke2.io | INSTALL_RKE2_CHANNEL=stable sh - >/dev/null
systemctl enable --now rke2-server.service
waitfor 120 bash -c "kubectl get nodes | grep -q ' Ready'"
kubectl get nodes -o wide

say "3. 기본 디스크(local-path)"
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.31/deploy/local-path-storage.yaml >/dev/null
kubectl patch storageclass local-path -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}' >/dev/null
waitfor 60 kubectl -n local-path-storage rollout status deploy/local-path-provisioner --timeout=5s

say "4. CNPG + DB db-general (서비스 이름 db-general-rw)"
kubectl apply --server-side -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.27/releases/cnpg-1.27.1.yaml >/dev/null
waitfor 60 kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager --timeout=5s
kubectl create ns data-db
cat <<'EOF' | kubectl apply -f -
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: { name: db-general, namespace: data-db }
spec:
  instances: 1
  storage: { size: 1Gi }
---
apiVersion: postgresql.cnpg.io/v1
kind: Database
metadata: { name: sample-db, namespace: data-db }
spec: { name: sample_db, owner: app, cluster: { name: db-general } }
EOF

say "5. Strimzi + Kafka signal-kafka (1대, 시험용)"
kubectl create ns data-kafka
kubectl create -f 'https://strimzi.io/install/latest?namespace=data-kafka' -n data-kafka >/dev/null
waitfor 60 kubectl -n data-kafka rollout status deploy/strimzi-cluster-operator --timeout=5s
cat <<'EOF' | kubectl apply -f -
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaNodePool
metadata: { name: dual-role, namespace: data-kafka, labels: { strimzi.io/cluster: signal-kafka } }
spec: { replicas: 1, roles: [controller, broker], storage: { type: ephemeral } }
---
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata: { name: signal-kafka, namespace: data-kafka, annotations: { strimzi.io/node-pools: enabled, strimzi.io/kraft: enabled } }
spec:
  kafka:
    listeners: [ { name: plain, port: 9092, type: internal, tls: false } ]
    config: { offsets.topic.replication.factor: 1, transaction.state.log.replication.factor: 1, transaction.state.log.min.isr: 1, default.replication.factor: 1, min.insync.replicas: 1 }
  entityOperator: { topicOperator: {}, userOperator: {} }
EOF

say "6. Redis · MinIO"
kubectl create ns data-cache
kubectl -n data-cache create deployment redis --image=$ECR/redis:7-alpine >/dev/null
kubectl -n data-cache expose deployment redis --port 6379 >/dev/null
kubectl -n data-cache create secret generic minio-root --from-literal=MINIO_ROOT_USER=admin --from-literal=MINIO_ROOT_PASSWORD=miniopass-leak-555
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata: { name: minio, namespace: data-cache }
spec:
  selector: { matchLabels: { app: minio } }
  template:
    metadata: { labels: { app: minio } }
    spec:
      containers:
        - name: minio
          image: quay.io/minio/minio:latest
          args: [server, /data]
          envFrom: [ { secretRef: { name: minio-root } } ]
          env:
            - name: MINIO_BROWSER_LOGIN_PASSWORD
              value: plainenv-leak-444
---
apiVersion: v1
kind: Service
metadata: { name: minio, namespace: data-cache }
spec: { selector: { app: minio }, ports: [ { port: 9000 } ] }
EOF

say "7. 부가 설정에도 가짜 비밀번호 (RKE2 HelmChartConfig)"
cat <<'EOF' | kubectl apply -f -
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata: { name: rke2-traefik, namespace: kube-system }
spec:
  valuesContent: |-
    additionalArguments:
      - "--log.level=INFO"
    env:
      - name: DASHBOARD_PASSWORD
        value: helmpass-leak-333
EOF

say "8. 샘플 서비스 (이미지 → 창고 → 배포 묶음 /opt/deploy/gc-app-deploy)"
B=$REPO/lab/gc-app-deploy
( cd $REPO/lab/src/sample-api && mvn -q -DskipTests package && mkdir -p /tmp/ctx-api && cp target/*.jar /tmp/ctx-api/app.jar && cp $B/build/Dockerfile.was /tmp/ctx-api/ )
docker build -q -f /tmp/ctx-api/Dockerfile.was -t localhost:5000/lab/sample-api:t1 /tmp/ctx-api >/dev/null
mkdir -p /tmp/ctx-web && cp -R $REPO/lab/src/sample-web/dist /tmp/ctx-web/ && cp $B/build/Dockerfile.web-basepath $B/build/nginx-basepath.conf.template /tmp/ctx-web/
docker build -q --build-arg BASE_PATH=/sample/ -f /tmp/ctx-web/Dockerfile.web-basepath -t localhost:5000/lab/sample-web:t1 /tmp/ctx-web >/dev/null
docker push -q localhost:5000/lab/sample-api:t1 >/dev/null && docker push -q localhost:5000/lab/sample-web:t1 >/dev/null
mkdir -p /opt/deploy && rm -rf /opt/deploy/gc-app-deploy && cp -r $B /opt/deploy/gc-app-deploy
sed -i 's/newTag: CHANGE-ME/newTag: t1/' /opt/deploy/gc-app-deploy/k8s/services/sample/kustomization.yaml
echo "DB_PASSWORD=bundlesecret-leak-222" > /opt/deploy/gc-app-deploy/k8s/services/sample/secret.env
kubectl apply -f /opt/deploy/gc-app-deploy/k8s/services/sample/00-namespace.yaml
kubectl -n sample create secret generic sample-secret --from-literal=DB_PASSWORD=secretvalue-leak-111
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=ai.lab.example" -addext "subjectAltName=DNS:ai.lab.example" -keyout /tmp/tls.key -out /tmp/tls.crt 2>/dev/null
bash /opt/deploy/gc-app-deploy/scripts/create-tls.sh /tmp/tls.crt /tmp/tls.key
kubectl apply -k /opt/deploy/gc-app-deploy/k8s/services/sample
kubectl -n sample create configmap leak-cm --from-literal=API_TOKEN=cmtoken-leak-666 --from-literal=TZ=Asia/Seoul

say "9. 모두 뜰 때까지"
waitfor 120 bash -c "kubectl -n data-db get cluster db-general -o jsonpath='{.status.phase}' | grep -qi healthy" || true
waitfor 120 bash -c "kubectl -n data-kafka get kafka signal-kafka -o jsonpath='{.status.conditions[?(@.type==\"Ready\")].status}' | grep -q True" || true
kubectl -n sample rollout status deploy/sample-web --timeout=5m || true
kubectl -n sample rollout status deploy/sample-api --timeout=8m || true
kubectl get pods -A -o wide
echo "RKE2 시험 환경 준비 끝"

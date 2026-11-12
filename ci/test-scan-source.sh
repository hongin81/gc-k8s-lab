#!/usr/bin/env bash
# 소스 수집 시험: 가짜 비밀번호를 숨긴 시험 저장소 → 새지 않는지 · 잡아내야 할 것을 잡는지
set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
fail() { echo "시험 실패: $*"; exit 1; }
T=$(mktemp -d); R=$T/repos/legacy-app
mkdir -p $R/src/main/java/kr/x $R/src/main/resources $R/deploy $T/repos/web-app
cd $R && git init -q
cat > pom.xml <<'X'
<project><modelVersion>4.0.0</modelVersion><artifactId>legacy-app</artifactId><packaging>war</packaging>
<properties><java.version>11</java.version></properties><dependencies><dependency><artifactId>egovframework.rte.fdl</artifactId></dependency></dependencies></project>
X
cat > src/main/resources/application-prod.yml <<'X'
server:
  port: 8081
  servlet:
    context-path: /legacy
spring:
  datasource:
    url: jdbc:oracle:thin:@192.168.0.50:1521:ORCL
    password: oraclepw111
jwt:
  secret: ${JWT_SECRET:defaultjwt222}
logging:
  file:
    name: /var/log/legacy/app.log
X
printf 'DB_PW=envpw333\nAPI_KEY=apikey444\n' > .env
echo 'class Up { void s(){ new File("/data/upload/x.bin"); String u="http://apis.data.go.kr/x"; String password = "hardpass666"; } }' > src/main/java/kr/x/Up.java
printf '#!/bin/bash\nscp target/legacy.war root@192.168.0.60:/opt/tomcat/webapps/\nssh root@192.168.0.60 systemctl restart tomcat\nexport DB_PASSWORD=scriptpw777\n' > deploy/deploy.sh
openssl genrsa 2048 2>/dev/null > deploy/server.key
# 쿠버 yml — 일부러 틀리게: latest 태그 · 다른 창고 · 포트 안 맞음 · 없는 Service 로 가는 입구 · 서버 폴더 직접 · yml 에 비밀번호
mkdir -p k8s
cat > k8s/app.yaml <<'X'
apiVersion: apps/v1
kind: Deployment
metadata: { name: legacy-app, namespace: legacy }
spec:
  replicas: 2
  selector: { matchLabels: { app: legacy-app } }
  template:
    metadata: { labels: { app: legacy-app } }
    spec:
      containers:
        - name: app
          image: dev.registry.local:5000/legacy-app:latest
          ports: [{ containerPort: 8081 }]
          env:
            - name: DB_PASSWORD
              value: k8splain888
            - name: API_URL
              value: http://localhost:9000
      volumes:
        - name: data
          hostPath: { path: /data/legacy }
---
apiVersion: v1
kind: Service
metadata: { name: legacy-app, namespace: legacy }
spec:
  selector: { app: legacy-app }
  ports: [{ port: 80, targetPort: 9090 }]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: legacy, namespace: legacy }
spec:
  ingressClassName: nginx
  rules:
    - host: legacy.dev.local
      http:
        paths:
          - { path: /, pathType: Prefix, backend: { service: { name: legacy-web, port: { number: 80 } } } }
X
cat > k8s/secret.yaml <<'X'
apiVersion: v1
kind: Secret
metadata: { name: legacy-secret, namespace: legacy }
type: Opaque
data:
  DB_URL: c2VjcmV0eWFtbDk5OQ==
stringData:
  config.json: |
    {"key": "blockdata555"}
  OTHER: stringdata777
X
cat > k8s/argocd-app.yaml <<'X'
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: legacy-app, namespace: argocd }
spec:
  source: { repoURL: "https://git.example.local/legacy-gitops.git", path: k8s, targetRevision: main }
  destination: { server: "https://kubernetes.default.svc", namespace: legacy }
  syncPolicy: { automated: {} }
X
cat > Jenkinsfile <<'X'
pipeline { agent any
  stages { stage('build') { steps {
    sh 'docker build -t 192.168.0.70:5000/legacy-app:${BUILD_NUMBER} .'
    sh 'docker push 192.168.0.70:5000/legacy-app:${BUILD_NUMBER}'
    sh 'kubectl -n legacy set image deploy/legacy-app app=192.168.0.70:5000/legacy-app:${BUILD_NUMBER}'
  } } } }
X
mkdir -p ops && cat > ops/push-images.sh <<'X'
#!/bin/bash
docker login -u deploy -p loginpw444 192.168.0.70:5000
skopeo copy --dest-creds deploy:skopeopw555 docker-archive:/tmp/legacy.tar docker://192.168.0.70:5000/legacy-app:1.0
docker save -o /tmp/legacy.tar legacy-app:1.0
for n in node1 node2; do scp /tmp/legacy.tar root@$n:/tmp/ && ssh root@$n "ctr -n k8s.io images import /tmp/legacy.tar"; done
X
cd $T/repos/web-app && echo '{"name":"web-app","scripts":{"build":"vite build"},"devDependencies":{"vite":"5","react":"18"}}' > package.json
echo "export default { base: '/hub/' }" > vite.config.ts
# 이 저장소도 함께 (시험 파일 폴더 ci/ 는 가짜 비밀번호 목록이 들어 있으니 빼고)
cp -r "$REPO" $T/repos/gc-k8s-lab && rm -rf $T/repos/gc-k8s-lab/ci
cd $T && node "$REPO/site-kit/scan-source.mjs" $T/repos || fail "실행 실패"
F=$(ls $T/source-scan-*.txt) || fail "결과 파일 없음"
LEAKS="oraclepw111 defaultjwt222 envpw333 apikey444 hardpass666 scriptpw777 k8splain888 c2VjcmV0eWFtbDk5OQ== blockdata555 stringdata777 loginpw444 skopeopw555"
for leak in $LEAKS "$(sed -n 3p $R/deploy/server.key)"; do
  grep -qF -- "$leak" "$F" && fail "새어 나옴: ${leak:0:20}"
done
echo "  가짜 비밀번호 13가지 — 결과에 없음"
for want in "war → WAS" "egovframework" "server.port = 8081" "context-path = /legacy" "192.168.0.50" "apis.data.go.kr" "/data/upload/x.bin" \
            "/var/log/legacy/app.log" "서버로 복사: scp · ssh" "서버에서 실행: systemctl" "화면 base 경로 = '/hub/'" ".env: DB_PW, API_KEY" '${JWT_SECRET:***}' \
            "sample-api" "스프링부트 실행 jar" "Dockerfile.was" \
            "배포 도구: Jenkins · ArgoCD" "ArgoCD Application legacy-app: https://git.example.local/legacy-gitops.git k8s@main → 네임스페이스 legacy · 자동 동기화" \
            "ctr import (서버 containerd 에 직접 넣음)" "docker save/load" "skopeo 로 창고 사이 복사" "이미지 보내는 창고: 192.168.0.70:5000" "kubectl set image" \
            "이미지 태그가 latest" "비밀값이 yml 에 그대로 — DB_PASSWORD" "API_URL 가 localhost" "hostPath /data/legacy" \
            "포트 안 맞음: Service legacy-app 가 9090 로 보내는데 Deployment legacy-app 의 컨테이너 포트는 8081" \
            "Ingress legacy: Service legacy-web 가 저장소 yml 에 없음" "lab/gc-app-deploy/k8s/services/sample/ — kustomize · 네임스페이스 sample" \
            "Service sample-api 8080→http → Deployment sample-api" "저장소에 없는 Secret — 클러스터에 따로 만들어 둬야 함: sample-secret"; do
  grep -qF -- "$want" "$F" || fail "못 잡음: $want"
done
# 연습장 샘플 묶음에는 문제가 없어야 함
awk '/services\/sample\/ — kustomize/{on=1;next} /^    [^ ]/{on=0} on' "$F" | grep -q "문제  " && fail "샘플 묶음에 문제가 나옴"

echo "  운영 값을 넣은 사본으로 한 번 더 (창고 · 서버 라벨 · 입구 · 도메인 비교)"
sed 's#^const SITE = {.*#const SITE = { registry: "192.168.0.70:5000", mirrors: ["docker.io"], roleLabel: "lab.io/role", ingressClass: "traefik", domain: "ai.lab.example" };#' \
  "$REPO/site-kit/scan-source.mjs" > $T/scan-site.mjs
mkdir -p $T/site && cd $T/site && node $T/scan-site.mjs $T/repos >/dev/null || fail "운영 값 사본 실행 실패"
F2=$(ls $T/site/source-scan-*.txt)
for want in "이미지 주소 dev.registry.local:5000 — 운영 창고(192.168.0.70:5000)나 미러(docker.io)로 오지 않아" "입구 종류 nginx — 운영은 traefik" \
            "도메인 legacy.dev.local — 운영 도메인 ai.lab.example 과 다름" "서버 지정(nodeSelector lab.io/role) 없음" "192.168.0.70:5000 (운영 창고)"; do
  grep -qF -- "$want" "$F2" || fail "운영 값 비교 못 잡음: $want"
done
awk '/services\/sample\/ — kustomize/{on=1;next} /^    [^ ]/{on=0} on' "$F2" | grep -q "문제  " && fail "운영 값 사본: 샘플 묶음에 문제가 나옴"
for leak in $LEAKS; do grep -qF -- "$leak" "$F2" && fail "운영 값 사본에서 새어 나옴: $leak"; done
echo "  배포 yml 묶음만 있는 폴더 (.svn · 빌드 파일 없이 받아 둔 것) — 묶음 통째로 봐야 함"
mkdir -p $T/deploy-only && cp -r "$REPO/lab/gc-app-deploy" $T/deploy-only/ && mkdir -p $T/deploy-only/svc-x && cp -r $R/. $T/deploy-only/svc-x/
mkdir -p $T/d && cd $T/d && node "$REPO/site-kit/scan-source.mjs" $T/deploy-only > $T/d/console.txt || fail "묶음 폴더 실행 실패"
grep -q "저장소 2개를 찾았습니다" $T/d/console.txt || fail "묶음 폴더: 저장소 수가 틀림 ($(grep 찾았습니다 $T/d/console.txt))"
F3=$(ls $T/d/source-scan-*.txt)
grep -qF "scripts/load-images.sh" "$F3" || fail "묶음 폴더: 같은 묶음의 스크립트를 못 봄"
grep -qF "k8s/services/sample/ — kustomize · 네임스페이스 sample" "$F3" || fail "묶음 폴더: 서비스 yml 을 못 봄"
echo "소스 수집 시험 통과"

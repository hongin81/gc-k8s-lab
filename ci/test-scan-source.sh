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
cd $T/repos/web-app && echo '{"name":"web-app","scripts":{"build":"vite build"},"devDependencies":{"vite":"5","react":"18"}}' > package.json
echo "export default { base: '/hub/' }" > vite.config.ts
# 이 저장소도 함께 (시험 파일 폴더 ci/ 는 가짜 비밀번호 목록이 들어 있으니 빼고)
cp -r "$REPO" $T/repos/gc-k8s-lab && rm -rf $T/repos/gc-k8s-lab/ci
cd $T && node "$REPO/site-kit/scan-source.mjs" $T/repos || fail "실행 실패"
F=$(ls $T/source-scan-*.txt) || fail "결과 파일 없음"
for leak in oraclepw111 defaultjwt222 envpw333 apikey444 hardpass666 scriptpw777 "$(sed -n 3p $R/deploy/server.key)"; do
  grep -qF -- "$leak" "$F" && fail "새어 나옴: ${leak:0:20}"
done
echo "  가짜 비밀번호 7가지 — 결과에 없음"
for want in "war → WAS" "egovframework" "server.port = 8081" "context-path = /legacy" "192.168.0.50" "apis.data.go.kr" "/data/upload/x.bin" \
            "/var/log/legacy/app.log" "scp · ssh · systemctl" "화면 base 경로 = '/hub/'" ".env: DB_PW, API_KEY" '${JWT_SECRET:***}' \
            "sample-api" "스프링부트 실행 jar" "Dockerfile.was"; do
  grep -qF -- "$want" "$F" || fail "못 잡음: $want"
done
echo "소스 수집 시험 통과"

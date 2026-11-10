# 2. 이미지 만들기 (인터넷 PC 역할)

실제로는 **인터넷 PC** 에서 합니다. 연습장은 같은 서버의 docker 로 합니다.

### ① 태그 정하기 — `커밋 7자리-날짜`

커밋되지 않은 변경이 없어야 합니다 (감리: 이미지 ↔ 소스 추적).

```
cd ~/gc-k8s-lab
git status --short
TAG=$(git rev-parse --short HEAD)-$(date +%Y%m%d)
echo $TAG | tee ~/.lab-tag
```{{exec}}

`git status` 에 아무것도 안 나와야 합니다. 이 TAG 를 끝까지 씁니다 (`~/.lab-tag` 에도 적어 둠).

### ② WAS(스프링) 이미지

```
cd ~/gc-k8s-lab/lab/src/sample-api
mvn -q -DskipTests clean package
mkdir -p ~/ctx/sample-api && cp target/*.jar ~/ctx/sample-api/app.jar
cp ~/gc-app-deploy/build/Dockerfile.was ~/ctx/sample-api/
docker buildx build --platform linux/amd64 --build-arg JRE=17 \
  -f ~/ctx/sample-api/Dockerfile.was -t docker.io/lab/sample-api:$TAG --load ~/ctx/sample-api
```{{exec}}

연습장의 `mvn` 은 컨테이너로 돌아서 처음엔 1~2분 걸립니다.

### ③ 화면 이미지 — 외부 경로(base) `/sample/`

```
cd ~/gc-k8s-lab/lab/src/sample-web
mkdir -p ~/ctx/sample-web && rm -rf ~/ctx/sample-web/dist && cp -R dist ~/ctx/sample-web/
cp ~/gc-app-deploy/build/Dockerfile.web-basepath ~/gc-app-deploy/build/nginx-basepath.conf.template ~/ctx/sample-web/
docker buildx build --platform linux/amd64 --build-arg BASE_PATH=/sample/ \
  -f ~/ctx/sample-web/Dockerfile.web-basepath -t docker.io/lab/sample-web:$TAG --load ~/ctx/sample-web
```{{exec}}

실제로는 먼저 `npm ci && npm run build` 로 `dist/` 를 만듭니다 (Vite base 도 `/sample/`). 연습장은 미리 만든 `dist/` 를 씁니다.

### ④ 운영과 같은 조건으로 한 번 띄워 보기 — 읽기 전용 · root 아님

```
docker run -d --rm --name api-test --read-only --tmpfs /tmp \
  -e SERVER_SERVLET_CONTEXT_PATH=/sample-api -p 18085:8080 docker.io/lab/sample-api:$TAG
for i in $(seq 1 60); do curl -sf localhost:18085/sample-api/health && break; sleep 2; done; echo
docker rm -f api-test
```{{exec}}

`{"status":"ok"}` 가 나오면 통과입니다. `Read-only file system` 오류가 나면 앱이 쓰는 경로를 `/tmp` 아래로 바꿔야 합니다.

### ⑤ 반입용 파일로 저장

```
mkdir -p ~/out/$TAG && cd ~/out/$TAG
docker save -o sample-api.tar docker.io/lab/sample-api:$TAG
docker save -o sample-web.tar docker.io/lab/sample-web:$TAG
echo "docker.io/lab/sample-api:$TAG sample-api.tar" >  images.txt
echo "docker.io/lab/sample-web:$TAG sample-web.tar" >> images.txt
shasum -a 256 *.tar images.txt > SHA256SUMS && ls -lh
```{{exec}}

이 폴더(`~/out/<TAG>/`)가 반입 매체(USB)에 담기는 내용입니다. 맥(M 칩) 인터넷 PC 에서는 가이드대로 `docker save --platform linux/amd64` 를 붙입니다.

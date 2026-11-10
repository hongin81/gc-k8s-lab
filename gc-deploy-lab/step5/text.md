# 5. 적용 · 확인 (k8s-m1)

### 적용

```
cd /opt/deploy/gc-app-deploy
kubectl apply -k k8s/services/sample
kubectl -n sample rollout status deploy/sample-web --timeout=5m
kubectl -n sample rollout status deploy/sample-api --timeout=10m
```{{exec}}

`successfully rolled out` 이 두 번 나오면 성공입니다. API 는 스프링이 뜨는 데 1~2분 걸립니다.

### 어느 서버에 떴나

```
kubectl -n sample get pods -o wide
```{{exec}}

`STATUS Running` · `READY 1/1` · `NODE` 칸을 봅니다. 실제 운영은 업무 서버 w1 · w2 에 하나씩 갈리고, 연습장은 업무 서버가 1대라 node01 에 모두 뜹니다.

### 기동 로그 — 파일이 아니라 표준출력

```
kubectl -n sample logs deploy/sample-api --tail=15
```{{exec}}

가이드의 `logs -f` 는 계속 따라 보여 줍니다 (`Ctrl+C` 로 빠져나옴).

### 판정 + 증적 남기기

```
bash scripts/check-service.sh sample
```{{exec}}

### 사용자처럼 불러 보기

```
curl -sk https://ai.lab.example/sample-api/hello; echo
curl -sk https://ai.lab.example/sample/ | grep -o '<title>.*</title>'
```{{exec}}

DB 시간 · 계정이 나오면 **입구 → API → DB** 까지, 제목이 나오면 **입구 → 화면** 까지 연결된 것입니다.

DNS · L4 없이 클러스터 입구만 직접 확인할 때 (가이드 방식):

```
VIP=$(getent hosts ai.lab.example | awk '{print $1}')
curl -sk --resolve ai.lab.example:443:$VIP -o /dev/null -w '%{http_code}\n' https://ai.lab.example/sample-api/health
```{{exec}}

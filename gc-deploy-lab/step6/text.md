# 6. 고장 내고 고치기

가이드 **10장 문제 해결** 표 그대로입니다. 고장을 하나씩 내고 **증상 → 확인 → 조치** 순서로 고칩니다.
대부분 `kubectl get pods` 의 STATUS 와 `describe` 맨 아래 Events 로 원인이 보입니다.

```
cd /opt/deploy/gc-app-deploy
```{{exec}}

---

### 고장 1 — `ImagePullBackOff` : 이미지를 못 받음

```
bash ~/gc-k8s-lab/lab/break.sh 1
sleep 20; kubectl -n sample get pods
```{{exec}}

새 파드 1개는 `ImagePullBackOff`, **기존 파드 2개는 그대로 Running** 입니다. 새 파드가 준비되지 않으면 기존 파드를 내리지 않아서 서비스는 끊기지 않습니다.

확인 — 이미지 이름 · 태그, 창고에 그 태그가 있는지:

```
kubectl -n sample get events --sort-by=.lastTimestamp | grep -E "Failed|BackOff" | tail -3
curl -s http://localhost:5000/v2/lab/sample-api/tags/list; echo
```{{exec}}

조치 — 설정 파일의 태그로 다시 적용:

```
kubectl apply -k k8s/services/sample
kubectl -n sample rollout status deploy/sample-api --timeout=5m
```{{exec}}

---

### 고장 2 — `CreateContainerConfigError` : Secret 이 없음

```
bash ~/gc-k8s-lab/lab/break.sh 2
sleep 15; kubectl -n sample get pods
```{{exec}}

확인:

```
kubectl -n sample get events --sort-by=.lastTimestamp | grep -i "not found" | tail -3
```{{exec}}

조치 — 4단계 ①처럼 Secret 다시 만들기 (만들어지면 멈춰 있던 파드가 저절로 뜸):

```
cp k8s/services/sample/secret.example.env /root/secret.env
PW=$(awk -F': ' '/비밀번호/{print $2}' /root/db-sample.txt)
sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=$PW/" /root/secret.env
kubectl -n sample create secret generic sample-secret --from-env-file=/root/secret.env
shred -u /root/secret.env
kubectl -n sample rollout status deploy/sample-api --timeout=5m
```{{exec}}

---

### 고장 3 — `CrashLoopBackOff` : 떴다가 바로 죽기를 반복

설정값(ConfigMap)의 작업 폴더를 `/app/work` 로 바꾸고 재시작합니다.

```
bash ~/gc-k8s-lab/lab/break.sh 3
sleep 30; kubectl -n sample get pods
```{{exec}}

확인 — **죽기 전 로그** (`--previous`):

```
P=$(kubectl -n sample get pods -l app=sample-api --sort-by=.metadata.creationTimestamp -o name | tail -1)
kubectl -n sample logs $P --previous | grep -m1 -i "read-only"
```{{exec}}

`Read-only file system` — 앱 컨테이너는 읽기 전용이고, 쓰기는 `/tmp` 만 됩니다.

조치 — 설정 파일 값(`/tmp/work`)으로 다시 적용하고 **재시작**:

```
grep APP_WORK_DIR k8s/services/sample/21-sample-api.yaml
kubectl apply -k k8s/services/sample
kubectl -n sample rollout restart deploy/sample-api
kubectl -n sample rollout status deploy/sample-api --timeout=5m
```{{exec}}

ConfigMap 은 바뀌어도 이미 뜬 파드에 반영되지 않습니다. 그래서 재시작이 필요합니다 (가이드 8장).

---

### 고장 4 — `Pending` : 올라갈 서버를 못 찾음

화면(sample-web)의 서버 조건을 `lab.io/role=ai` 로 바꿉니다 (그런 서버 없음).

```
bash ~/gc-k8s-lab/lab/break.sh 4
sleep 10; kubectl -n sample get pods -o wide
```{{exec}}

확인:

```
kubectl -n sample get events --sort-by=.lastTimestamp | grep FailedScheduling | tail -1
kubectl get nodes -L lab.io/role
```{{exec}}

`didn't match Pod's node affinity/selector` — 실제 운영에서 서버 라벨 · taint 값이 설계와 다르면 이렇게 됩니다.

조치:

```
kubectl apply -k k8s/services/sample
kubectl -n sample rollout status deploy/sample-web --timeout=3m
```{{exec}}

---

### 고장 5 — 브라우저 `404` : 외부 경로 철자

외부 경로 `/sample-api` 를 `/sampel-api` 로 잘못 적습니다.

```
bash ~/gc-k8s-lab/lab/break.sh 5
sleep 5; curl -sk -o /dev/null -w '%{http_code}\n' https://ai.lab.example/sample-api/hello
```{{exec}}

확인 — 경로 → 서비스 표:

```
kubectl -n sample get ingress sample -o jsonpath='{range .spec.rules[*].http.paths[*]}{.path}{"  ->  "}{.backend.service.name}{"\n"}{end}'
```{{exec}}

조치:

```
kubectl apply -k k8s/services/sample
sleep 5; curl -sk -o /dev/null -w '%{http_code}\n' https://ai.lab.example/sample-api/hello
```{{exec}}

---

### 마지막 점검

```
bash scripts/check-service.sh sample
```{{exec}}

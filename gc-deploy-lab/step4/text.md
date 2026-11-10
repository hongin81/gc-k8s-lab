# 4. 비밀값 · 태그 · 미리보기 (k8s-m1)

```
cd /opt/deploy/gc-app-deploy
TAG=$(cat ~/.lab-tag); echo $TAG
```{{exec}}

### ① 네임스페이스 + 비밀값 Secret — 서비스 최초 1회

서식 파일을 복사합니다:

```
cp k8s/services/sample/secret.example.env /root/secret.env
cat /root/secret.env
```{{exec}}

실제로는 `vi /root/secret.env` 로 DB 담당에게 받은 값을 채웁니다. 연습장은 받은 파일에서 꺼내 넣습니다:

```
PW=$(awk -F': ' '/비밀번호/{print $2}' /root/db-sample.txt)
sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=$PW/" /root/secret.env
kubectl apply -f k8s/services/sample/00-namespace.yaml
kubectl -n sample create secret generic sample-secret --from-env-file=/root/secret.env
shred -u /root/secret.env
kubectl -n sample get secret
```{{exec}}

- 평문 파일 `secret.env` 는 만든 즉시 `shred -u` 로 지웁니다.
- Secret 값은 화면에 띄우지 않습니다 (`get secret -o yaml` 금지).

### ② 인증서 — 서비스 네임스페이스가 새로 생기면 한 번

```
bash scripts/create-tls.sh /root/lab-certs/ai.lab.example.crt /root/lab-certs/ai.lab.example.key
```{{exec}}

### ③ 이번 이미지 태그로 바꾸기 — `newTag`

실제로는 `vi k8s/services/sample/kustomization.yaml` 로 `CHANGE-ME` 를 이번 TAG 로 바꿉니다. 연습장은 한 줄로:

```
sed -i "s/newTag: CHANGE-ME/newTag: $TAG/" k8s/services/sample/kustomization.yaml
grep -A1 "name: docker.io" k8s/services/sample/kustomization.yaml
```{{exec}}

### ④ 적용 전 미리보기 — 아무것도 바꾸지 않음

```
kubectl diff -k k8s/services/sample | grep -E '^\+ ' | head -40
```{{exec}}

새로 생길 내용이 `+` 로 보입니다. 가이드처럼 `| less` 로 보면 전체를 넘겨 볼 수 있습니다 (`q` 로 나옴).

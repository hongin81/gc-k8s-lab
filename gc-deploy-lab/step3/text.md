# 3. 반입 → 이미지 창고에 넣기 (infra01 역할)

실제로는 반입 매체 → 관리망 PC → `scp` 로 **infra01**(`/opt/import`)과 **k8s-m1**(`/opt/deploy`)에 복사합니다. 연습장은 한 서버라 `cp` 로 합니다.

```
TAG=$(cat ~/.lab-tag)
mkdir -p /opt/import /opt/deploy
cp -r ~/out/$TAG /opt/import/
cp -r ~/gc-app-deploy /opt/deploy/
ls /opt/import/$TAG /opt/deploy/gc-app-deploy
```{{exec}}

설정 묶음(`gc-app-deploy`)은 처음 한 번 통째로, 이후엔 바뀐 서비스 폴더만 복사합니다.

### 창고에 넣기 — 체크섬 확인 → load → push → 확인까지 한 번에

```
bash /opt/deploy/gc-app-deploy/scripts/load-images.sh /opt/import/$TAG
```{{exec}}

스크립트 없이 손으로 하면 이렇습니다 (참고 — 위에서 이미 했으니 실행하지 않아도 됩니다):

```
podman load -i sample-api.tar
podman tag docker.io/lab/sample-api:<TAG> localhost:5000/lab/sample-api:<TAG>
podman push --tls-verify=false localhost:5000/lab/sample-api:<TAG>
```{{copy}}

### 창고에 들어갔나

```
curl -s http://localhost:5000/v2/lab/sample-api/tags/list; echo
curl -s http://localhost:5000/v2/lab/sample-web/tags/list; echo
```{{exec}}

> 설정 파일에는 `docker.io/lab/sample-api` 라고 적지만, 모든 노드가 `docker.io` 요청을 infra01 로 돌리게 되어 있어(미러) 인터넷으로 나가지 않습니다. 그래서 창고 안 경로는 `lab/sample-api` 입니다.

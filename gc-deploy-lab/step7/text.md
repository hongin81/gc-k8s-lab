# 7. 새 버전 배포 · 되돌리기

화면 글자를 `v1` → `v2` 로 바꿔 새 버전을 배포하고, 다시 직전 버전으로 되돌립니다.

### ① 소스 수정 · 커밋 → 새 태그 (인터넷 PC)

```
cd ~/gc-k8s-lab
cat ~/.lab-tag > ~/.lab-old-tag
sed -i 's/버전 v1/버전 v2/g' lab/src/sample-web/dist/index.html
git commit -qam "화면 v2"
TAG=$(git rev-parse --short HEAD)-$(date +%Y%m%d)
echo $TAG | tee ~/.lab-tag; echo "이전 태그: $(cat ~/.lab-old-tag)"
```{{exec}}

### ② 바뀐 화면 이미지만 다시 만들고 저장

```
cd ~/gc-k8s-lab/lab/src/sample-web
rm -rf ~/ctx/sample-web/dist && cp -R dist ~/ctx/sample-web/
docker buildx build --platform linux/amd64 --build-arg BASE_PATH=/sample/ \
  -f ~/ctx/sample-web/Dockerfile.web-basepath -t docker.io/lab/sample-web:$TAG --load ~/ctx/sample-web
mkdir -p ~/out/$TAG && cd ~/out/$TAG
docker save -o sample-web.tar docker.io/lab/sample-web:$TAG
echo "docker.io/lab/sample-web:$TAG sample-web.tar" > images.txt
shasum -a 256 *.tar images.txt > SHA256SUMS && ls -lh
```{{exec}}

### ③ 반입 · 창고에 넣기

```
cp -r ~/out/$TAG /opt/import/
bash /opt/deploy/gc-app-deploy/scripts/load-images.sh /opt/import/$TAG
```{{exec}}

### ④ 화면 태그만 바꿔 배포 — 파드를 하나씩 바꿈 (무중단)

```
cd /opt/deploy/gc-app-deploy
sed -i "/name: docker.io\/lab\/sample-web/{n;s/newTag: .*/newTag: $TAG/}" k8s/services/sample/kustomization.yaml
kubectl diff -k k8s/services/sample | grep -E '^[-+] .*image:'
kubectl apply -k k8s/services/sample
kubectl -n sample rollout status deploy/sample-web --timeout=3m
curl -sk https://ai.lab.example/sample/ | grep -o '버전 v[0-9]' | head -1
```{{exec}}

`버전 v2` 가 나오면 새 버전이 나간 것입니다.

### ⑤ 이력 보기 · 직전 버전으로 되돌리기

```
kubectl -n sample rollout history deploy/sample-web
kubectl -n sample rollout undo deploy/sample-web
kubectl -n sample rollout status deploy/sample-web --timeout=3m
curl -sk https://ai.lab.example/sample/ | grep -o '버전 v[0-9]' | head -1
```{{exec}}

`버전 v1` 로 돌아왔습니다.

### ⑥ 되돌린 뒤 설정 파일도 이전 태그로

**이걸 안 하면 다음 `apply` 때 다시 v2 로 갑니다.**

```
OLD_TAG=$(cat ~/.lab-old-tag)
sed -i "/name: docker.io\/lab\/sample-web/{n;s/newTag: .*/newTag: $OLD_TAG/}" k8s/services/sample/kustomization.yaml
kubectl diff -k k8s/services/sample >/dev/null && echo "설정 파일 = 지금 돌고 있는 상태 (차이 없음)" || echo "차이 있음 — 확인 필요"
bash scripts/check-service.sh sample
```{{exec}}

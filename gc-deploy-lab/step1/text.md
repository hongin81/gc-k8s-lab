# 1. 연습장 둘러보기 (k8s-m1 역할)

실제로는 관리망 PC 에서 `ssh root@<k8s-m1>` 으로 들어갑니다. 연습장에서는 이미 들어와 있습니다.

### 서버 확인 — 가이드: "먼저 대수부터 확인"

```
kubectl get nodes -L lab.io/role
```{{exec}}

- `controlplane` = 관리 서버 (업무 앱을 올리지 않음)
- `node01` = 업무 서버 (라벨 `lab.io/role=app` — 앱은 이 라벨이 붙은 서버에만 뜸)

### 이미지 창고 (infra01 역할)

```
curl -s http://localhost:5000/v2/_catalog; echo
```{{exec}}

준비 시험용 이미지 `lab/lab-check` 하나만 들어 있습니다.

### 인프라 담당이 미리 깔아 둔 것

```
kubectl get pods -A -o wide | grep -E "NAMESPACE|traefik|data-db"
```{{exec}}

- `traefik` — 외부 요청 입구 (가이드의 Ingress VIP)
- `data-db / db-general` — 공통 DB

내 서비스의 DB 계정은 DB 담당이 따로 전달합니다 (연습장은 파일로):

```
cat /root/db-sample.txt
```{{exec}}

### 배포 묶음 (gc-app-deploy) 구조

```
cd ~/gc-app-deploy && find . -type f | sort
```{{exec}}

| 폴더 | 내용 |
|---|---|
| `build/` | 이미지 만들 때 쓰는 Dockerfile (WAS · 화면) |
| `k8s/services/sample/` | **내 서비스 설정 파일** — 이번 연습의 주인공 |
| `scripts/` | 창고 적재 · 인증서 · 점검 스크립트 |

```
cat k8s/services/sample/kustomization.yaml
```{{exec}}

배포 때마다 바꾸는 것은 **`newTag` 한 줄뿐**입니다. 나머지 설정 파일은 서비스마다 이미 만들어 둡니다.

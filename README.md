# 쿠버네티스 배포 연습장

기존 서버 운영(jar 올리고 `systemctl restart`)만 해 본 개발자가 쿠버네티스 배포를 손에 익히는 연습장입니다.
「서비스배포가이드(개발자용)」 7장 순서 그대로 따라 합니다.

**이미지 만들기 → 반입 · 이미지 창고 적재 → Secret · 태그 · 미리보기 → 적용 · 확인 · 증적 → 고장 5가지 고치기 → 새 버전 · 되돌리기** (약 50분)

## 여는 방법

### 1) 브라우저 (설치 없음)

킬러코다: _연결 후 주소를 적습니다_

링크를 열면 브라우저 안에 쿠버 서버 2대가 뜨고, 왼쪽 설명의 회색 상자를 누르면 오른쪽 터미널에서 실행됩니다. 무료는 1시간 뒤 사라집니다.

### 2) 내 PC (리눅스 또는 윈도우 WSL2 우분투, x86_64, 도커 필요)

```bash
git clone https://github.com/hongin81/gc-k8s-lab && cd gc-k8s-lab
sudo bash lab/setup.sh --mode kind      # 연습장 준비 (3~5분)
```

그다음 `gc-deploy-lab/step1/text.md` 부터 차례로 명령을 따라 하면 됩니다.
내 PC 연습장에는 내 서비스 이미지를 올려 반입 전에 미리 확인해 볼 수 있습니다.

지우기: `sudo kind delete cluster --name gc-lab && sudo docker rm -f infra01`

## 연습장 구성

| 실제 운영 | 연습장 |
|---|---|
| 작업 서버 k8s-m1 | 터미널 (관리 서버) |
| 업무 서버 (업무 서버 라벨) | 라벨 `lab.io/role=app` 이 붙은 서버 |
| 이미지 창고 infra01 `:5000` + 노드의 docker.io 미러 | 같은 방식 (`infra01:5000`) |
| 입구 Traefik · 대표 도메인 | Traefik · `ai.lab.example` (연습용 인증서) |
| 공통 DB `db-general-rw.data-db.svc.cluster.local:5432` | 같은 주소 |

도메인 · 이미지 이름 · 라벨은 연습용 가짜 값입니다. 실제 값은 가이드 4 · 5장을 보세요.

## 폴더

| 경로 | 내용 |
|---|---|
| `gc-deploy-lab/` | 킬러코다 단계 설명 · 확인 스크립트 |
| `lab/setup.sh` | 연습장 준비 (인프라 담당 선행 작업 흉내) |
| `lab/break.sh` | 연습용 고장 내기 1~5 |
| `lab/gc-app-deploy/` | 배포 묶음 — `build/` Dockerfile, `k8s/services/sample/` 설정 파일, `scripts/` 적재 · 점검 |
| `lab/src/` | 샘플 서비스 소스 — 화면(nginx) · API(스프링부트 jar) |
| `ci/` · `.github/workflows/` | 자동 시험 — 설명서의 실행 상자를 그대로 처음부터 끝까지 돌림 |

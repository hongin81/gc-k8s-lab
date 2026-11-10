#!/usr/bin/env bash
# 반입한 이미지 tar 를 이미지 창고(infra01 :5000)에 넣는다.
# 사용: bash load-images.sh /opt/import/<TAG>
#   폴더 안: *.tar · images.txt("이미지이름 tar파일" 한 줄씩) · SHA256SUMS
# 순서: 체크섬 확인 → load → 창고 주소로 tag → push → 창고에 태그가 있는지 확인
set -euo pipefail

DIR=${1:?"반입 폴더를 주세요 (예: /opt/import/3ee0932-20261110)"}
REG=${REG:-localhost:5000}
cd "$DIR"

echo "== 1. 체크섬 확인"
sha256sum -c SHA256SUMS

if command -v podman >/dev/null 2>&1; then
  T=podman; PUSH_OPT=(--tls-verify=false)
else
  T=docker; PUSH_OPT=()
fi
echo "   (사용 도구: $T)"

while read -r image tarfile; do
  [ -z "${image:-}" ] && continue
  path=${image#docker.io/}          # lab/sample-api:TAG  — 창고 안 경로
  repo=${path%:*}
  tag=${path##*:}

  echo "== 2. 적재: $image  ($tarfile)"
  $T load -i "$tarfile" >/dev/null
  $T tag "$image" "$REG/$path"
  $T push "${PUSH_OPT[@]}" "$REG/$path" >/dev/null

  echo "== 3. 확인: $(curl -s "http://$REG/v2/$repo/tags/list")"
  if ! curl -s "http://$REG/v2/$repo/tags/list" | grep -q "\"$tag\""; then
    echo "실패: 창고에 $repo:$tag 가 없습니다" >&2
    exit 1
  fi
done < images.txt

echo "완료 — 창고에 모두 들어갔습니다."

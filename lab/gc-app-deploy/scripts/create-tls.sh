#!/usr/bin/env bash
# 도메인 인증서를 서비스 네임스페이스마다 Secret 으로 넣는다 (서비스 네임스페이스를 새로 만들면 다시 실행).
# 사용: bash scripts/create-tls.sh <인증서.crt> <개인키.key>
set -euo pipefail

CRT=${1:?"인증서 파일(.crt)을 주세요"}
KEY=${2:?"개인키 파일(.key)을 주세요"}
NAME=${TLS_SECRET:-ai-lab-tls}

for ns in $(kubectl get ns -l lab.io/service -o jsonpath='{.items[*].metadata.name}'); do
  kubectl -n "$ns" create secret tls "$NAME" --cert="$CRT" --key="$KEY" --dry-run=client -o yaml \
    | kubectl apply -f - >/dev/null
  echo "  $ns: $NAME 넣음"
done

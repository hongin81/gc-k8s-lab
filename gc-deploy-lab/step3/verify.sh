#!/bin/bash
# 창고에 이번 태그가 두 이미지 모두 있는지
TAG=$(cat /root/.lab-tag 2>/dev/null) || exit 1
for n in sample-api sample-web; do
  curl -s "http://localhost:5000/v2/lab/$n/tags/list" | grep -q "\"$TAG\"" || exit 1
done
test -d /opt/deploy/gc-app-deploy/k8s/services/sample

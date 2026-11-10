#!/usr/bin/env python3
"""첫 배포 시험 꾸러미 만들기 — 연습장에서 검증한 샘플 서비스 설정을 현장 값으로 바꿔 내보낸다.
사용: python3 site-kit/render-site.py <site.env> <이미지 폴더(images.txt 있는 곳)> <내보낼 폴더>
바꾸는 것: 서버 라벨 이름 · 도메인 · IngressClass · 인증서 Secret 이름 · 이미지 태그(newTag)
이미지 이름(docker.io/lab/sample-*)은 그대로 — 노드가 docker.io 요청을 현장 이미지 창고로 받으므로 그대로 동작한다.
"""
import pathlib
import re
import shutil
import sys

env_file, images_dir, out_dir = map(pathlib.Path, sys.argv[1:4])
repo = pathlib.Path(__file__).resolve().parent.parent
src = repo / "lab" / "gc-app-deploy"

env = {}
for line in env_file.read_text(encoding="utf-8").splitlines():
    m = re.match(r'^\s*([A-Z_]+)=(?:"([^"]*)"|(\S*))', line)
    if m:
        env[m.group(1)] = m.group(2) if m.group(2) is not None else m.group(3)

role_label = env["ROLE_LABEL"]
domain = env["DOMAIN"]
ingress_class = env.get("INGRESS_CLASS") or "traefik"
tls_secret = env.get("TLS_SECRET", "")

lines = (images_dir / "images.txt").read_text(encoding="utf-8").split()
tags = {img.rsplit(":", 1)[1] for img in lines[0::2]}
assert len(tags) == 1, f"images.txt 의 태그가 하나가 아님: {tags}"
tag = tags.pop()

if out_dir.exists():
    shutil.rmtree(out_dir)
svc_out = out_dir / "k8s" / "services" / "sample"
shutil.copytree(src / "k8s" / "services" / "sample", svc_out)
(out_dir / "scripts").mkdir(parents=True)
for s in ("load-images.sh", "check-service.sh"):
    shutil.copy2(src / "scripts" / s, out_dir / "scripts" / s)
shutil.copytree(images_dir, out_dir / "images" / tag)

for f in svc_out.glob("*.yaml"):
    t = f.read_text(encoding="utf-8")
    t = t.replace("lab.io/role", role_label)
    t = t.replace("ai.lab.example", domain)
    t = t.replace("ingressClassName: traefik", f"ingressClassName: {ingress_class}")
    if f.name == "30-ingress.yaml":
        if tls_secret:
            t = t.replace("ai-lab-tls", tls_secret)
        else:
            # 인증서 Secret 이 정해지지 않았으면 입구의 기본 인증서로 HTTPS (tls 칸 빼고 TLS 켜기)
            t = re.sub(r"  tls:\n    - hosts: \[[^\]]*\]\n      secretName: [^\n]*\n", "", t)
            t = t.replace(
                "    traefik.ingress.kubernetes.io/router.entrypoints: websecure\n",
                "    traefik.ingress.kubernetes.io/router.entrypoints: websecure\n"
                '    traefik.ingress.kubernetes.io/router.tls: "true"\n',
            )
    if f.name == "kustomization.yaml":
        t = t.replace("newTag: CHANGE-ME", f"newTag: {tag}")
    f.write_text(t, encoding="utf-8")

# check-service.sh 기본 도메인 · 입구 주소를 현장 값으로 (작업 서버에서는 도메인이 DNS 로 안 풀릴 수 있음)
cs = out_dir / "scripts" / "check-service.sh"
t = cs.read_text(encoding="utf-8").replace("ai.lab.example", domain)
vip = env.get("INGRESS_VIP", "")
if vip:
    old_vip = """VIP=${VIP:-$(getent hosts "$DOMAIN" | awk '{print $1; exit}')}"""
    assert old_vip in t
    t = t.replace(old_vip, "VIP=${VIP:-" + vip + "}")
cs.write_text(t, encoding="utf-8")

print(f"내보냄: {out_dir}  (태그 {tag})")

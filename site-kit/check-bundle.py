#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""배포 묶음 점검 (읽기 전용) — 서비스별 설정 파일이 지금 클러스터에 맞게 만들어져 있는지 확인한다.

사용 (작업 서버, root):
  python3 check-bundle.py <배포 묶음 폴더> [서비스 ...] [--env site.env] [--expect expect.tsv]
    <배포 묶음 폴더> : k8s/services/<서비스>/kustomization.yaml 가 있는 폴더 (예: /opt/deploy/gc-app-deploy)
    서비스 이름을 주면 그 서비스만, 안 주면 전부.

확인하는 것 (서비스마다):
  1 조립 · 사전 검사   kustomize 조립, 쿠버 서버 사전 검사(dry-run)
  2 이미지            태그가 채워졌는지, 이미지 창고에 그 태그가 있는지
  3 서버 조건 · 자원   nodeSelector 에 맞는 서버가 있는지, taint 를 견디는지, 요청 자원이 서버 크기 안인지
  4 포트              컨테이너 포트 ↔ 헬스체크 ↔ 서비스 targetPort ↔ 입구 경로, 앱 포트 환경변수
  5 비밀값 · 설정값     쓰는 Secret · ConfigMap(과 키)이 있는지 (값은 보지 않음)
  6 다른 서비스 주소   설정값 안의 <서비스>.<네임스페이스>.svc 주소의 서비스 · 포트가 있는지, 네트워크 정책
  7 입구 경로          IngressClass · 도메인 · 경로 겹침 · 인증서 Secret
  8 포트 닿는지        작업 서버에서 그 주소 · 포트로 실제 연결되는지
  9 가이드 카드        (expect.tsv 를 주면) 포트 · 외부 경로가 설계 문서와 같은지
결과: 화면 + <OUT_DIR>/bundle-check-<일시>/ (report.txt · rendered/) + .tar.gz (Secret 값 없음)
파이썬 3.6 이상 · kubectl 만 쓴다 (추가 설치 없음).
"""
import json
import os
import re
import socket
import subprocess
import sys
import tarfile
import time
import urllib.request
from collections import defaultdict

# ── 인자 ───────────────────────────────────────────────────────────
args = sys.argv[1:]
if not args or args[0] in ("-h", "--help"):
    print(__doc__)
    sys.exit(0)


def take_opt(name):
    if name in args:
        i = args.index(name)
        v = args[i + 1]
        del args[i:i + 2]
        return v
    return None


here = os.path.dirname(os.path.abspath(__file__))
env_file = take_opt("--env") or os.path.join(here, "site.env")
expect_file = take_opt("--expect") or (os.path.join(here, "expect.tsv") if os.path.exists(os.path.join(here, "expect.tsv")) else None)
bundle = os.path.abspath(args[0])
only = set(args[1:])

site = {}
if os.path.exists(env_file):
    for line in open(env_file, encoding="utf-8"):
        m = re.match(r'^\s*([A-Z_]+)=(?:"([^"]*)"|(\S*))', line)
        if m:
            site[m.group(1)] = m.group(2) if m.group(2) is not None else m.group(3)
REGISTRY = site.get("REGISTRY", "")
DOMAIN = site.get("DOMAIN", "")
INGRESS_VIP = site.get("INGRESS_VIP", "")
OUT_DIR = site.get("OUT_DIR", "/root")

# RKE2 기본 위치
if os.path.exists("/var/lib/rancher/rke2/bin/kubectl"):
    os.environ["PATH"] = os.environ.get("PATH", "") + ":/var/lib/rancher/rke2/bin"
if not os.environ.get("KUBECONFIG") and os.path.exists("/etc/rancher/rke2/rke2.yaml"):
    os.environ["KUBECONFIG"] = "/etc/rancher/rke2/rke2.yaml"

OUT = os.path.join(OUT_DIR, "bundle-check-" + time.strftime("%Y%m%d-%H%M%S"))
os.makedirs(os.path.join(OUT, "rendered"))
report = open(os.path.join(OUT, "report.txt"), "w", encoding="utf-8")
count = {"ok": 0, "bad": 0}
todo = []


def say(s=""):
    print(s)
    report.write(s + "\n")


def ok(s):
    say("    정상      " + s)
    count["ok"] += 1


def bad(s, fix="", svc=""):
    say("    문제      " + s)
    if fix:
        say("              → " + fix)
    count["bad"] += 1
    todo.append(("[" + svc + "] " if svc else "") + s + (" → " + fix if fix else ""))


def info(s):
    say("    참고      " + s)


def run(cmd, stdin=None):
    p = subprocess.run(cmd, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    return p.returncode, p.stdout, p.stderr


def kjson(*a):
    rc, out, _ = run(["kubectl"] + list(a) + ["-o", "json"])
    if rc != 0 or not out.strip():
        return []
    d = json.loads(out)
    return d.get("items", [d] if d.get("kind") != "List" else [])


# ── 클러스터 상태 읽기 (읽기 전용) ──────────────────────────────────
say("배포 묶음 점검 — " + time.strftime("%Y-%m-%d %H:%M") + " · 묶음 " + bundle)
say("읽기만 합니다. 아무것도 바꾸지 않습니다. Secret 은 이름과 키 이름만 봅니다.")

rc, _, err = run(["kubectl", "get", "--raw", "/version"])
if rc != 0:
    say("쿠버 API 에 연결 안 됨 — 작업 서버에서 root 로 실행하세요. (" + err.strip()[:200] + ")")
    sys.exit(1)

nodes = kjson("get", "nodes")
cluster_ns = {n["metadata"]["name"] for n in kjson("get", "ns")}
cluster_svc = {}
for s in kjson("get", "svc", "-A"):
    cluster_svc[(s["metadata"]["namespace"], s["metadata"]["name"])] = s
ingress_classes = {i["metadata"]["name"] for i in kjson("get", "ingressclass")}
storage_classes = {i["metadata"]["name"] for i in kjson("get", "sc")}
cluster_ing = kjson("get", "ingress", "-A")
cluster_netpol = kjson("get", "networkpolicy", "-A")
cluster_pvc = {(p["metadata"]["namespace"], p["metadata"]["name"]) for p in kjson("get", "pvc", "-A")}
# Secret · ConfigMap — 값은 꺼내지 않고 이름과 키만 (go-template)
TPL = '{{range .items}}{{.metadata.namespace}}/{{.metadata.name}}:{{range $k,$v := .data}}{{$k}},{{end}}{{"\\n"}}{{end}}'
cluster_secret, cluster_cm = {}, {}
for kind, store in (("secrets", cluster_secret), ("configmaps", cluster_cm)):
    rc, out, _ = run(["kubectl", "get", kind, "-A", "-o", "go-template=" + TPL])
    for line in out.splitlines():
        if ":" in line:
            ref, keys = line.split(":", 1)
            ns, name = ref.split("/", 1)
            store[(ns, name)] = set(k for k in keys.split(",") if k)


# 클러스터 내부 주소(ClusterIP)는 쿠버 서버 위에서만 닿는다 — 서버가 아니면 그 연결 확인은 건너뜀
ON_NODE = socket.gethostname().split(".")[0] in {n["metadata"]["name"].split(".")[0] for n in nodes}


def parse_qty(v):
    """쿠버 자원 표기 → 숫자 (CPU 는 코어, 메모리는 바이트)"""
    if v is None:
        return 0.0
    v = str(v)
    units = {"Ki": 1024, "Mi": 1024 ** 2, "Gi": 1024 ** 3, "Ti": 1024 ** 4,
             "K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12, "m": 1e-3}
    for u in sorted(units, key=len, reverse=True):
        if v.endswith(u):
            return float(v[:-len(u)]) * units[u]
    return float(v)


def human_mem(b):
    return "%.0fGi" % (b / 1024 ** 3) if b >= 1024 ** 3 else "%.0fMi" % (b / 1024 ** 2)


# ── 묶음 읽기 ──────────────────────────────────────────────────────
svc_root = os.path.join(bundle, "k8s", "services")
if not os.path.isdir(svc_root):
    say("배포 묶음 폴더에 k8s/services 가 없습니다: " + bundle)
    sys.exit(1)
services = sorted(d for d in os.listdir(svc_root) if os.path.exists(os.path.join(svc_root, d, "kustomization.yaml")))
if only:
    services = [s for s in services if s in only]
say("서비스: " + " ".join(services))

expect = defaultdict(dict)   # (서비스, 구성 요소) → {"port": .., "path": ..}
if expect_file:
    for line in open(expect_file, encoding="utf-8"):
        if line.startswith("#") or not line.strip():
            continue
        cols = line.rstrip("\n").split("\t")
        if len(cols) >= 3:
            expect[(cols[0], cols[1])] = {"port": cols[2].strip(), "path": cols[3].strip() if len(cols) > 3 else ""}

def parse_json_stream(text):
    """kubectl 이 내보내는 JSON — List 하나이거나, 객체 여러 개가 이어진 것 — 을 객체 목록으로"""
    dec, i, out = json.JSONDecoder(), 0, []
    while i < len(text):
        while i < len(text) and text[i].isspace():
            i += 1
        if i >= len(text):
            break
        obj, i = dec.raw_decode(text, i)
        out.extend(obj.get("items", []) if obj.get("kind") == "List" else [obj])
    return out


rendered = {}       # 서비스 → 객체 목록
render_err = {}
for svc in services:
    d = os.path.join(svc_root, svc)
    rc, y, err = run(["kubectl", "kustomize", d])
    if rc != 0:
        render_err[svc] = err.strip()
        continue
    open(os.path.join(OUT, "rendered", svc + ".yaml"), "w", encoding="utf-8").write(y)
    rc, j, err = run(["kubectl", "create", "--dry-run=client", "--validate=false", "-o", "json", "-f", "-"], stdin=y)
    if rc != 0:
        render_err[svc] = err.strip()
        continue
    rendered[svc] = parse_json_stream(j)

# 묶음 전체의 서비스 · 설정 (다른 서비스 주소 확인용)
bundle_svc, bundle_cm, bundle_secret_names, bundle_pvc, bundle_netpol = {}, {}, set(), set(), []
for svc, objs in rendered.items():
    for o in objs:
        ns = o["metadata"].get("namespace", "default")
        key = (ns, o["metadata"]["name"])
        if o["kind"] == "Service":
            bundle_svc[key] = o
        elif o["kind"] == "ConfigMap":
            bundle_cm[key] = o.get("data", {})
        elif o["kind"] == "Secret":
            bundle_secret_names.add(key)
        elif o["kind"] == "PersistentVolumeClaim":
            bundle_pvc.add(key)
        elif o["kind"] == "NetworkPolicy":
            bundle_netpol.append(o)

URL_RE = re.compile(r"([a-z0-9][a-z0-9-]*)\.([a-z0-9][a-z0-9-]*)\.svc(?:\.cluster\.local)?:(\d+)")
# 앱 설정값에 들어가면 안 되는 주소 — 현장 개발 서버 주소는 설정 파일 FORBIDDEN_HOSTS 로
FORBIDDEN = [re.escape(h) for h in site.get("FORBIDDEN_HOSTS", "").split()]
BAD_HOST_RE = re.compile("(" + "|".join(FORBIDDEN + [r"localhost", r"127\.0\.0\.1", r"\b192\.168\.\d+\.\d+", r"\b172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+"]) + ")")
PORT_ENV = ("PORT", "SERVER_PORT", "API_PORT", "APP_PORT", "HTTP_PORT")


def node_matches(sel):
    return [n for n in nodes if all(n["metadata"].get("labels", {}).get(k) == v for k, v in sel.items())]


def tolerates(tols, taint):
    for t in tols or []:
        if t.get("operator") == "Exists" and not t.get("key"):
            return True
        if t.get("key") != taint.get("key"):
            continue
        if t.get("effect") and t.get("effect") != taint.get("effect"):
            continue
        if t.get("operator") == "Exists" or t.get("value") == taint.get("value"):
            return True
    return False


def svc_port(svc_obj, port):
    for p in svc_obj["spec"].get("ports", []):
        if str(p.get("port")) == str(port) or p.get("name") == str(port):
            return p
    return None


def tcp_ok(host, port):
    try:
        with socket.create_connection((host, int(port)), timeout=3):
            return True
    except Exception:
        return False


all_paths = defaultdict(list)    # (host, path) → [네임스페이스/인그레스]
for i in cluster_ing:
    for r in i["spec"].get("rules", []):
        for p in (r.get("http") or {}).get("paths", []):
            all_paths[(r.get("host", ""), p.get("path", "/"))].append(i["metadata"]["namespace"] + "/" + i["metadata"]["name"])

reach_targets = {}   # (host, port) → 설명

# ── 서비스별 점검 ─────────────────────────────────────────────────
for svc in services:
    say("")
    say("━━━━ " + svc + " ━━━━")
    say("  [1] 조립 · 사전 검사")
    if svc in render_err:
        bad("설정 파일 조립 실패: " + render_err[svc][:300], "k8s/services/" + svc + " 의 yaml 문법 · kustomization.yaml 의 resources 목록", svc)
        continue
    objs = rendered[svc]
    kinds = defaultdict(int)
    for o in objs:
        kinds[o["kind"]] += 1
    ok("조립 성공 — " + ", ".join("%s %d" % kv for kv in sorted(kinds.items())))
    ns_names = {o["metadata"].get("namespace") for o in objs if o["kind"] != "Namespace"}
    ns_names.discard(None)
    if len(ns_names) > 1:
        bad("한 서비스가 네임스페이스 여러 개를 씀: " + ", ".join(sorted(ns_names)), "kustomization.yaml 의 namespace", svc)
    ns = sorted(ns_names)[0] if ns_names else "default"
    if ns in cluster_ns:
        rc, out, err = run(["kubectl", "apply", "--dry-run=server", "-k", os.path.join(svc_root, svc)])
        if rc == 0:
            ok("쿠버 서버 사전 검사(dry-run) 통과")
        else:
            bad("쿠버 서버 사전 검사 실패: " + err.strip().replace("\n", " / ")[:400], "오류 문구의 필드 · 정책(Pod Security 등) 확인", svc)
    else:
        info("네임스페이스 " + ns + " 가 아직 없음 (첫 배포 전) — 서버 사전 검사는 생략, 나머지는 설정 파일 기준")

    workloads = [o for o in objs if o["kind"] in ("Deployment", "StatefulSet", "DaemonSet")]
    services_in = {o["metadata"]["name"]: o for o in objs if o["kind"] == "Service"}
    cms_in = {o["metadata"]["name"]: o.get("data", {}) for o in objs if o["kind"] == "ConfigMap"}

    # 각 워크로드의 컨테이너 포트 표 (이름 → 번호)
    wl_ports = {}
    for w in workloads:
        pm = {}
        for c in w["spec"]["template"]["spec"].get("containers", []):
            for p in c.get("ports", []) or []:
                pm[str(p["containerPort"])] = p["containerPort"]
                if p.get("name"):
                    pm[p["name"]] = p["containerPort"]
        wl_ports[w["metadata"]["name"]] = pm

    for w in workloads:
        name = w["metadata"]["name"]
        spec = w["spec"]["template"]["spec"]
        say("  ── " + w["kind"] + " " + name + " (파드 " + str(w["spec"].get("replicas", 1)) + "개)")

        # 2 이미지
        for c in spec.get("containers", []) + spec.get("initContainers", []):
            img = c.get("image", "")
            repo, _, tag = img.rpartition(":") if ":" in img.split("/")[-1] else (img, "", "latest")
            if "@sha256" in img:
                ok("이미지 " + img + " (digest 고정)")
                continue
            if tag in ("CHANGE-ME", "latest", ""):
                bad("이미지 태그가 '" + (tag or "없음") + "': " + img, "kustomization.yaml 의 newTag 를 이번 태그(커밋7자리-날짜)로", svc)
                continue
            first = repo.split("/")[0]
            if "." in first or ":" in first:
                if first != "docker.io":
                    info("이미지 " + img + " — docker.io 가 아님: 창고 미러를 안 거칠 수 있음 (registries.yaml 확인)")
                    continue
                path = repo[len("docker.io/"):]
            else:
                path = repo
            if "/" not in path:
                path = "library/" + path
            if not REGISTRY:
                info("이미지 " + img + " — REGISTRY 설정이 없어 창고 확인 생략")
                continue
            try:
                body = urllib.request.urlopen("http://%s/v2/%s/tags/list" % (REGISTRY, path), timeout=5).read().decode()
                tags = json.loads(body).get("tags") or []
            except Exception:
                tags = None
            if tags is None:
                bad("이미지 창고에 " + path + " 가 없음 (" + img + ")", "인터넷 PC 에서 만든 이미지를 반입해 load-images.sh 로 적재", svc)
            elif tag in tags:
                ok("이미지 " + img + " — 창고에 있음")
            else:
                bad("창고에 " + path + ":" + tag + " 없음 (있는 태그: " + ", ".join(tags[-5:]) + ")", "태그 확인 · 그 태그로 반입 · 적재", svc)

        # 3 서버 조건 · 자원
        sel = spec.get("nodeSelector") or {}
        cand = node_matches(sel) if sel else list(nodes)
        if sel and not cand:
            bad("서버 조건 " + ", ".join("%s=%s" % kv for kv in sel.items()) + " 에 맞는 서버가 없음",
                "서버 라벨 확인 (인프라 담당) 또는 nodeSelector 값을 실제 라벨로", svc)
        elif sel:
            usable = [n for n in cand if all(tolerates(spec.get("tolerations"), t) for t in n["spec"].get("taints", []) or [] if t.get("effect") in ("NoSchedule", "NoExecute"))]
            if not usable:
                ts = {"%s=%s:%s" % (t.get("key"), t.get("value", ""), t.get("effect")) for n in cand for t in n["spec"].get("taints", []) or []}
                bad("조건에 맞는 서버(" + ", ".join(n["metadata"]["name"] for n in cand) + ")의 taint 를 못 견딤: " + ", ".join(sorted(ts)),
                    "tolerations 추가 (예: key=dedicated, value=ai, effect=NoSchedule)", svc)
                cand = []
            else:
                cand = usable
                ok("올라갈 서버: " + ", ".join(n["metadata"]["name"] for n in cand))
        else:
            info("서버 조건(nodeSelector) 없음 — 아무 서버에나 뜰 수 있음 (업무 서버 라벨 지정 권장)")
        if cand:
            req = defaultdict(float)
            for c in spec.get("containers", []):
                r = (c.get("resources") or {})
                for k, v in (r.get("requests") or {}).items():
                    req[k] += parse_qty(v)
                for k, v in (r.get("limits") or {}).items():
                    if k == "nvidia.com/gpu":
                        req[k] = max(req[k], parse_qty(v))
            if not any(c.get("resources", {}).get("requests") for c in spec.get("containers", [])):
                bad("자원 요청(requests)이 없음", "가이드 카드의 CPU · 메모리 요청~상한을 resources 에", svc)
            for k in ("cpu", "memory", "nvidia.com/gpu"):
                if req.get(k):
                    biggest = max(parse_qty(n["status"].get("allocatable", {}).get(k, 0)) for n in cand)
                    show = (human_mem(req[k]) if k == "memory" else ("%g" % req[k]))
                    if req[k] > biggest:
                        bad("요청 %s %s 이(가) 서버 최대 %s 보다 큼" % (k, show, human_mem(biggest) if k == "memory" else "%g" % biggest),
                            "요청을 줄이거나 다른 서버로", svc)
            if req.get("nvidia.com/gpu") and any(
                    parse_qty(n["status"].get("allocatable", {}).get("nvidia.com/gpu", 0)) >= req["nvidia.com/gpu"] for n in cand):
                ok("GPU %g 장 요청 — 받을 수 있는 서버 있음" % req["nvidia.com/gpu"])

        # 4 포트 · 헬스체크 · 앱 포트 환경변수
        pm = wl_ports[name]
        say("    포트: " + (", ".join(sorted({str(v) for v in pm.values()})) or "없음"))
        for c in spec.get("containers", []):
            for pk in ("startupProbe", "readinessProbe", "livenessProbe"):
                pr = c.get(pk)
                if not pr:
                    continue
                port = (pr.get("httpGet") or pr.get("tcpSocket") or {}).get("port")
                if port is not None and str(port) not in pm:
                    bad(pk + " 포트 " + str(port) + " 가 컨테이너 포트(" + ", ".join(sorted(set(str(v) for v in pm.values()))) + ")에 없음",
                        "헬스체크 port 를 컨테이너 포트로", svc)
            if not c.get("readinessProbe"):
                bad(c["name"] + " 준비 확인(readinessProbe) 없음 — 기동 중에도 요청이 들어감", "readinessProbe 추가 (가이드 services.json 의 health)", svc)
            envs = {}
            for e in c.get("env", []) or []:
                if "value" in e:
                    envs[e["name"]] = e["value"]
            for ef in c.get("envFrom", []) or []:
                cmn = (ef.get("configMapRef") or {}).get("name")
                if cmn:
                    envs.update(cms_in.get(cmn) or bundle_cm.get((ns, cmn)) or {})
            for k in PORT_ENV:
                v = envs.get(k)
                if v and v.isdigit() and v not in pm:
                    bad("앱 포트 설정 " + k + "=" + v + " 인데 컨테이너 포트는 " + ", ".join(sorted(set(str(x) for x in pm.values()))),
                        "둘 중 하나를 맞춤 (앱이 듣는 포트 = containerPort)", svc)
            # 5 비밀값 · 설정값
            for e in c.get("env", []) or []:
                vf = e.get("valueFrom") or {}
                for kind, store, label in (("secretKeyRef", cluster_secret, "Secret"), ("configMapKeyRef", cluster_cm, "ConfigMap")):
                    ref = vf.get(kind)
                    if not ref or ref.get("optional"):
                        continue
                    rn, rk = ref.get("name"), ref.get("key")
                    keys = store.get((ns, rn))
                    if keys is None and kind == "configMapKeyRef" and rn in cms_in:
                        keys = set(cms_in[rn].keys())
                    if keys is None:
                        bad(label + " " + ns + "/" + rn + " 없음 (" + e["name"] + " 가 씀)",
                            ("secret.example.env 서식으로 kubectl -n " + ns + " create secret generic " + rn + " --from-env-file=...") if label == "Secret" else "ConfigMap 을 묶음에 넣기", svc)
                    elif rk not in keys:
                        bad(label + " " + ns + "/" + rn + " 에 키 " + rk + " 없음 (있는 키: " + ", ".join(sorted(keys)) + ")", "키 이름 맞추기", svc)
                    else:
                        ok(label + " " + rn + "/" + rk + " 있음")
            for ef in c.get("envFrom", []) or []:
                sr = (ef.get("secretRef") or {})
                if sr.get("name") and not sr.get("optional") and (ns, sr["name"]) not in cluster_secret:
                    bad("Secret " + ns + "/" + sr["name"] + " 없음 (envFrom)", "secret.example.env 서식으로 생성", svc)
                cr = (ef.get("configMapRef") or {})
                if cr.get("name") and not cr.get("optional") and cr["name"] not in cms_in and (ns, cr["name"]) not in cluster_cm:
                    bad("ConfigMap " + ns + "/" + cr["name"] + " 없음 (envFrom)", "ConfigMap 을 묶음에 넣기", svc)
            # 6 다른 서비스 주소 · 금지 주소
            for k, v in envs.items():
                v = str(v)
                for m in URL_RE.finditer(v):
                    tn, tns, tp = m.group(1), m.group(2), m.group(3)
                    tgt = bundle_svc.get((tns, tn)) or cluster_svc.get((tns, tn))
                    where = "%s.%s:%s" % (tn, tns, tp)
                    if not tgt:
                        bad(k + " 의 주소 " + where + " — 그런 서비스가 묶음에도 클러스터에도 없음",
                            "서비스 이름 · 네임스페이스 철자, 또는 그 서비스가 아직 배포 전인지", svc)
                        continue
                    if not svc_port(tgt, tp):
                        ports = ", ".join(str(p.get("port")) for p in tgt["spec"].get("ports", []))
                        bad(k + " 의 주소 " + where + " — 서비스는 있지만 포트 " + tp + " 없음 (있는 포트: " + ports + ")", "부르는 쪽 포트를 맞춤", svc)
                        continue
                    ok(k + " → " + where + " 서비스 · 포트 있음")
                    if tns != ns:
                        pols = [p for p in bundle_netpol + cluster_netpol if p["metadata"].get("namespace") == tns and "Ingress" in (p["spec"].get("policyTypes") or ["Ingress"])]
                        if pols:
                            allowed = False
                            for p in pols:
                                for rule in p["spec"].get("ingress", []) or []:
                                    frm = rule.get("from")
                                    if not frm:
                                        allowed = True
                                    for f in frm or []:
                                        nsl = (f.get("namespaceSelector") or {})
                                        if nsl == {} and "namespaceSelector" in f:
                                            allowed = True
                                        if (nsl.get("matchLabels") or {}).get("kubernetes.io/metadata.name") == ns:
                                            allowed = True
                            if allowed:
                                ok("네트워크 정책: " + tns + " 가 " + ns + " 에서 오는 연결을 허용")
                            else:
                                bad("네트워크 정책: " + tns + " 가 " + ns + " 에서 오는 연결을 허용하지 않음 (" + k + ")",
                                    tns + " 쪽 정책의 허용 목록(allowFrom)에 " + ns + " 추가 — 상대 담당과 협의", svc)
                    cip = tgt["spec"].get("clusterIP")
                    if cip and cip != "None" and ON_NODE:
                        reach_targets[(cip, tp)] = where
                bh = BAD_HOST_RE.search(v)
                if bh:
                    bad(k + "=" + v[:80] + " — 개발 서버 · 사설 IP · localhost 주소가 들어 있음",
                        "다른 서비스는 <이름>.<네임스페이스>.svc.cluster.local 내부 주소로 (가이드 7장 ①)", svc)
        # 볼륨
        for vol in spec.get("volumes", []) or []:
            pvc = (vol.get("persistentVolumeClaim") or {}).get("claimName")
            if pvc and (ns, pvc) not in bundle_pvc and (ns, pvc) not in cluster_pvc:
                bad("디스크 요청(PVC) " + pvc + " 가 묶음에도 클러스터에도 없음", "PVC 를 묶음에 넣거나 인프라 담당에게 요청", svc)
        for c in spec.get("containers", []):
            sc = c.get("securityContext") or {}
            mounts = {m.get("mountPath") for m in c.get("volumeMounts", []) or []}
            if sc.get("readOnlyRootFilesystem") and "/tmp" not in mounts:
                bad(c["name"] + " 은 읽기 전용인데 /tmp 쓰기 폴더(emptyDir)가 없음", "/tmp 에 emptyDir 마운트", svc)

    # 서비스 → 파드 포트
    for sname, s in services_in.items():
        selr = s["spec"].get("selector") or {}
        tgt_wl = [w for w in workloads if all(w["spec"]["template"]["metadata"].get("labels", {}).get(k) == v for k, v in selr.items())]
        if not tgt_wl:
            bad("서비스 " + sname + " 의 selector " + json.dumps(selr) + " 에 맞는 파드가 없음", "selector 를 Deployment 의 파드 라벨과 같게", svc)
            continue
        for p in s["spec"].get("ports", []):
            tp = str(p.get("targetPort", p.get("port")))
            for w in tgt_wl:
                if tp not in wl_ports[w["metadata"]["name"]]:
                    bad("서비스 " + sname + " 포트 " + str(p.get("port")) + " → targetPort " + tp + " 가 " + w["metadata"]["name"] + " 컨테이너 포트(" +
                        ", ".join(sorted(set(str(v) for v in wl_ports[w["metadata"]["name"]].values()))) + ")에 없음", "targetPort 를 containerPort 로", svc)
                else:
                    ok("서비스 " + sname + ":" + str(p.get("port")) + " → " + w["metadata"]["name"] + ":" + str(wl_ports[w["metadata"]["name"]][tp]))

    # 7 입구 경로
    ings = [o for o in objs if o["kind"] == "Ingress"]
    if ings:
        say("  [7] 입구 경로")
    for i in ings:
        icn = i["spec"].get("ingressClassName") or (i["metadata"].get("annotations") or {}).get("kubernetes.io/ingress.class")
        if icn and icn not in ingress_classes:
            bad("IngressClass " + icn + " 가 클러스터에 없음 (있는 것: " + ", ".join(sorted(ingress_classes)) + ")", "ingressClassName 을 실제 이름으로", svc)
        elif icn:
            ok("IngressClass " + icn)
        for t in i["spec"].get("tls", []) or []:
            sn = t.get("secretName")
            if sn and (ns, sn) not in cluster_secret and (ns, sn) not in bundle_secret_names:
                bad("인증서 Secret " + ns + "/" + sn + " 없음", "create-tls.sh 로 이 네임스페이스에 인증서 넣기 (네임스페이스 만든 뒤)", svc)
        for r in i["spec"].get("rules", []):
            host = r.get("host", "")
            if DOMAIN and host != DOMAIN:
                bad("입구 도메인 " + (host or "(없음)") + " — 설계 도메인 " + DOMAIN + " 와 다름", "host 를 " + DOMAIN + " 로", svc)
            for p in (r.get("http") or {}).get("paths", []):
                path = p.get("path", "/")
                b = (p.get("backend") or {}).get("service") or {}
                bn = b.get("name")
                bp = (b.get("port") or {}).get("number") or (b.get("port") or {}).get("name")
                s = services_in.get(bn)
                if not s:
                    bad("경로 " + path + " → 서비스 " + str(bn) + " 가 이 묶음에 없음", "backend.service.name 철자", svc)
                elif not svc_port(s, bp):
                    bad("경로 " + path + " → " + bn + ":" + str(bp) + " — 서비스에 그 포트 없음", "backend 포트를 Service 포트로", svc)
                else:
                    ok("https://" + host + path + " → " + bn + ":" + str(bp))
                others = [x for x in all_paths.get((host, path), []) if not x.startswith(ns + "/")]
                if others:
                    bad("경로 " + path + " 를 다른 곳도 씀: " + ", ".join(others), "경로 이름 겹치지 않게 (가이드 2장 경로표)", svc)
                all_paths[(host, path)].append(ns + "/" + i["metadata"]["name"])
                if INGRESS_VIP and host:
                    reach_targets[(INGRESS_VIP, "443")] = "입구 " + host

    # 9 가이드 카드와 비교
    if expect:
        rows = [(k[1], v) for k, v in expect.items() if k[0] == svc]
        if rows:
            say("  [9] 가이드 서비스 카드와 비교")
        ing_paths = defaultdict(set)
        for i in ings:
            for r in i["spec"].get("rules", []):
                for p in (r.get("http") or {}).get("paths", []):
                    ing_paths[((p.get("backend") or {}).get("service") or {}).get("name")].add(p.get("path", "/").rstrip("/") or "/")
        for comp, ex in rows:
            w = next((w for w in workloads if w["metadata"]["name"] == comp), None)
            if not w:
                bad("가이드 카드의 구성 요소 " + comp + " 가 묶음에 없음", "설정 파일 추가 또는 카드 확인", svc)
                continue
            ports = {str(v) for v in wl_ports[comp].values()}
            if ex["port"] and ex["port"] not in ("-", "—") and ex["port"] not in ports:
                bad(comp + " 포트 " + ",".join(sorted(ports)) + " — 가이드 카드는 " + ex["port"], "설정 파일 또는 앱 포트를 카드대로", svc)
            elif ex["port"] not in ("-", "—", ""):
                ok(comp + " 포트 " + ex["port"] + " — 카드와 같음")
            want = [x.rstrip("/") or "/" for x in ex["path"].split() if x.startswith("/")]
            have = set()
            for sname, s in services_in.items():
                selr = s["spec"].get("selector") or {}
                if all(w["spec"]["template"]["metadata"].get("labels", {}).get(k) == v for k, v in selr.items()):
                    have |= ing_paths.get(sname, set())
            for wp in want:
                if wp not in have:
                    bad(comp + " 외부 경로 " + wp + " 가 입구 설정에 없음 (있는 것: " + (", ".join(sorted(have)) or "없음") + ")", "30-ingress.yaml 경로를 카드대로", svc)
                else:
                    ok(comp + " 외부 경로 " + wp + " — 카드와 같음")
            if not want and ex["path"] and have:
                bad(comp + " 는 카드상 내부 전용인데 외부 경로가 있음: " + ", ".join(sorted(have)), "외부 경로 빼기", svc)

# ── 8 포트가 실제로 닿는지 (작업 서버에서) ───────────────────────────
say("")
say("━━━━ 포트 연결 (이 서버에서 실제로 닿는지) ━━━━")
if not ON_NODE:
    info("이 컴퓨터는 쿠버 서버가 아님 — 클러스터 내부 주소 연결 확인은 생략 (작업 서버에서 돌리면 확인함)")
if REGISTRY:
    h, _, p = REGISTRY.partition(":")
    reach_targets[(h, p or "80")] = "이미지 창고"
for (h, p), what in sorted(reach_targets.items(), key=lambda x: x[1]):
    if tcp_ok(h, p):
        ok("%s %s:%s 연결됨" % (what, h, p))
    else:
        bad("%s %s:%s 연결 안 됨" % (what, h, p), "방화벽 · 서비스 상태 확인 (파드 안에서 다시 확인: kubectl exec ... -- nc -zv)")

# ── 요약 ─────────────────────────────────────────────────────────
say("")
say("================ 요약 ================")
say("정상 %d · 문제 %d" % (count["ok"], count["bad"]))
if todo:
    say("고칠 것:")
    for n, t in enumerate(todo, 1):
        say("  %d. %s" % (n, t))
report.close()
with tarfile.open(OUT + ".tar.gz", "w:gz") as t:
    t.add(OUT, arcname=os.path.basename(OUT))
print("")
print("결과 폴더: " + OUT)
print("보낼 파일: " + OUT + ".tar.gz  (Secret 값은 들어 있지 않음)")

#!/usr/bin/env node
// 소스 저장소 수집 (읽기 전용) — 개발 PC 에 받아 둔 소스를 훑어, 저장소 · 빌드 방식 · 포트 · 설정 · 지금 배포 방법 ·
// 쿠버로 옮길 때 걸릴 곳을 텍스트 파일 하나로 정리한다. 소스는 바꾸지 않는다.
//
// 쓰는 법 (윈도우 · 맥 · 리눅스, Node 18 이상 — 추가 설치 없음):
//   node scan-source.mjs <폴더> [폴더 ...]
//     <폴더>: 저장소 하나, 또는 저장소 여러 개가 들어 있는 상위 폴더 (아래 3단계까지 찾음)
//   예) node scan-source.mjs D:\work            (윈도우)
//       node scan-source.mjs ~/work/egov-main-platform ~/work/SeaWatch
// 결과: 실행한 폴더에 source-scan-<PC이름>-<일시>.txt  ← 이 파일 하나를 보내면 됨 (보내기 전에 열어 봐도 됨)
//
// 지키는 것: 읽기만 한다 · 비밀번호 · 토큰 · 키처럼 보이는 값은 *** 로 가린다 · .env 는 키 이름만 ·
//            개인키 파일은 가져오지 않는다 · 소스 코드 자체는 가져오지 않는다 · 비밀번호를 묻지 않는다.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// ==== 설정 — 받은 그대로 쓰면 됨 ====
const FORBIDDEN_HOSTS = [];   // 소스에 남아 있으면 안 되는 개발 서버 주소 (예: "dev.example.com")
const SITE = { registry: "", mirrors: ["docker.io"], roleLabel: "", ingressClass: "", domain: "" };   // 운영 클러스터 값 — 쿠버 yml 이 이 값과 맞는지 봄 (비어 있으면 그 비교는 건너뜀)
// ==== 설정 끝 ====

// ── 건너뛰는 폴더 ───────────────────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git", ".svn", ".idea", ".vscode", "out", ".gradle", ".next", ".nuxt",
  "coverage", "vendor", "obj", ".mvn", "logs", "log", "tmp", "temp", ".cache", "__pycache__", "venv", ".venv", "env", "site-packages",
  "uploads", "upload", "bower_components", "jspm_packages", ".terraform", ".pytest_cache", ".mypy_cache", ".tox"]);
const DOT_KEEP = new Set([".github", ".gitlab", ".circleci", ".gitea", ".woodpecker", ".teamcity", ".tekton", ".argocd"]);        // 자동 배포 설정이 있는 숨김 폴더는 봄
const TEST_DIRS = new Set(["test", "tests", "__tests__", "__mocks__", "__fixtures__", "fixtures", "e2e", "testdata", "test-data"]);
// 아래는 src 밖에서만 뺌 — src 안에서는 패키지 이름일 수 있음 (예: 전자정부 예제의 egovframework/example)
const LOOSE_DIRS = new Set(["mocks", "examples", "example", "spec", "specs", "samples", "sample"]);
const NOTE_DIRS = new Set(["docs", "doc", "document", "documents", "manual", "manuals", "proposal", "proposals", "report", "reports",
  "wiki", "notes", "experiments", "experiment", "poc", "sandbox", "playground", "scratch", "archive", "archives", "backup", "backups", "old"]);
const isBuildOutput = (dir, name) => name === "build" && ["build.gradle", "build.gradle.kts", "package.json"].some(f => exists(path.join(dir, f)));
const TEXT_EXT = new Set([".java", ".kt", ".groovy", ".scala", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".yml", ".yaml", ".properties", ".xml", ".json", ".conf", ".sh", ".bat", ".cmd", ".ps1", ".py", ".sql", ".env", ".toml",
  ".gradle", ".kts", ".html", ".jsp", ".service", ".ini", ".cfg", ".go", ".rb", ".php", ".cs", ".prisma"]);
const MAX_FILE = 1024 * 1024, MAX_FILES = 60000, MAX_COPY = 64 * 1024, MAX_COPY_TOTAL = 2 * 1024 * 1024;

const args = process.argv.slice(2).filter(a => !a.startsWith("-"));
if (!args.length || process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 15).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(args.length ? 0 : 1);
}

// ── 가리기 ─────────────────────────────────────────────────────────
const SW = "(pass(?:word|wd)?|pwd|[._-]pw|secret|token|[._-]key|apikey|credentials?|auth|identitytoken)";
const RE_KV = new RegExp(`([A-Za-z0-9_.-]*${SW}["']?[ \\t]*[:=][ \\t]*)("[^"]*"|'[^']*'|\\$\\{[^}\\n]*\\}|[^\\s,}]+)`, "gi");
const RE_NAMEVAL = new RegExp(`("name"\\s*:\\s*"[A-Za-z0-9_.-]*${SW}"\\s*,\\s*"value"\\s*:\\s*)"[^"]*"`, "gi");
// 한 줄 문자열 안에 줄바꿈이 \n 글자로 들어간 YAML (쿠버 마지막 적용 기록 등): name: DB_PASSWORD\n  value: x
const RE_NAMEESC = new RegExp(`(name:\\s*["']?[A-Za-z0-9_.-]*${SW}["']?(?:\\\\[nr])+\\s*value:\\s*)[^\\\\"]+`, "gi");
const RE_NAMELINE = new RegExp(`name:\\s*["']?[A-Za-z0-9_.-]*${SW}["']?\\s*$`, "i");
function maskValue(v) {
  const m = v.match(/^["']?\$\{([A-Za-z0-9_.-]+)(?::[^}]*)?\}["']?$/);   // ${DB_PASSWORD:기본값} → 환경변수 이름은 남김
  return m ? "${" + m[1] + ":***}" : "***";
}
const VALUE_SECRETS = [/\bAKIA[0-9A-Z]{16}\b/g, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g, /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, /\bAIza[0-9A-Za-z_-]{30,}/g, /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g, /\bglpat-[A-Za-z0-9_-]{20,}/g];
function mask(text) {
  for (const re of VALUE_SECRETS) text = text.replace(re, "***");
  const out = text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "*** 개인키 가림 ***")
    .replace(/(:\/\/[^:/@\s]+:)[^@/\s]+@/g, "$1***@")
    .replace(/(login[^#\n]*\s(?:-p|--password)[ =])\S+/g, "$1***").replace(/(--password[ =])\S+/g, "$1***").replace(/(-creds[ =][^:\s]+:)\S+/g, "$1***")   // docker login -p · skopeo --dest-creds 사용자:비밀번호
    .replace(RE_NAMEVAL, '$1"***"')
    .replace(RE_NAMEESC, "$1***")
    .replace(RE_KV, (all, k, _w, v) => k + maskValue(v));
  const lines = out.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (RE_NAMELINE.test(lines[i]) && /^\s*value:\s*\S/.test(lines[i + 1])) lines[i + 1] = lines[i + 1].replace(/(value:\s*).+/, "$1***");
  }
  return lines.join("\n");
}

// ── 도구 ─────────────────────────────────────────────────────────
const rel = (base, p) => path.relative(base, p).split(path.sep).join("/") || ".";
const readText = p => { try { const st = fs.statSync(p); if (st.size > MAX_FILE) return null; return fs.readFileSync(p, "utf8"); } catch { return null; } };
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const uniq = a => [...new Set(a.filter(x => x !== undefined && x !== null && x !== ""))];
function sh(cmd, argv, cwd) {
  const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", timeout: 20000, windowsHide: true, shell: process.platform === "win32" });
  return r.status === 0 ? (r.stdout || "").trim() : null;
}
function walk(dir, onFile, onSkip, depth = 0, state = { n: 0 }) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (state.n >= MAX_FILES) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const low = e.name.toLowerCase();
      if (SKIP_DIRS.has(e.name) || (e.name.startsWith(".") && !DOT_KEEP.has(e.name)) || isBuildOutput(dir, e.name)) continue;
      const inSrc = (path.sep + p).includes(path.sep + "src" + path.sep);       // 소스 폴더 안의 report · archive 등은 패키지 이름일 수 있어 건너뛰지 않음
      // 배포 폴더 안(k8s/services/sample 등)이나 kustomization 이 있는 폴더는 이름이 sample · example 이어도 봄
      const inDeploy = /[\/\\](k8s|kubernetes|deploy|deploys|deployment|deployments|manifests|helm|charts|kustomize|gitops|overlays)[\/\\]/i.test(p + path.sep)
        || ["kustomization.yaml", "kustomization.yml", "Chart.yaml"].some(f => exists(path.join(p, f)));
      if (TEST_DIRS.has(low) || (NOTE_DIRS.has(low) && !inSrc) || (LOOSE_DIRS.has(low) && !inSrc && !inDeploy)) { onSkip(p); continue; }
      if (depth < 20) walk(p, onFile, onSkip, depth + 1, state);
    } else if (e.isFile()) { state.n++; onFile(p, e.name); }
  }
}
const BUILD_FILES = ["pom.xml", "build.gradle", "build.gradle.kts", "package.json", "pyproject.toml", "requirements.txt", "setup.py"];
const DEPLOY_ONLY_MARKS = ["kustomization.yaml", "kustomization.yml", "Chart.yaml", "Jenkinsfile", "docker-compose.yml", "docker-compose.yaml", "compose.yaml", ".teamcity"];   // 배포 yml 만 모아 둔 폴더도 저장소로 봄
function isRepoRoot(d) { return exists(path.join(d, ".git")) || exists(path.join(d, ".svn")) || BUILD_FILES.concat(DEPLOY_ONLY_MARKS).some(f => exists(path.join(d, f))); }
function findRepos(start, depth = 0, out = []) {
  if (isRepoRoot(start)) { out.push(start); return out; }
  if (depth >= 3) return out;
  let ents; try { ents = fs.readdirSync(start, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) findRepos(path.join(start, e.name), depth + 1, out);
  return out;
}
const tag = (s, name) => { const m = s && s.match(new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`)); return m ? m[1] : null; };
const props = s => { const o = {}; const b = s.match(/<properties>([\s\S]*?)<\/properties>/)?.[1] || ""; for (const m of b.matchAll(/<([A-Za-z0-9_.-]+)>\s*([^<]*?)\s*<\/\1>/g)) o[m[1]] = m[2]; return o; };
const resolveProp = (v, pr) => v && v.replace(/\$\{([^}]+)\}/g, (a, k) => pr[k] ?? a);

// 아주 단순한 YAML 펼치기 (들여쓰기 기준) — a.b.c: 값
function flattenYaml(text) {
  const out = [], stack = [];
  for (const raw of text.split("\n")) {
    if (/^\s*(#|$)/.test(raw) || /^\s*-/.test(raw)) continue;
    if (/^---/.test(raw)) { stack.length = 0; continue; }
    const m = raw.match(/^(\s*)([^:#]+?):\s*(.*)$/); if (!m) continue;
    const ind = m[1].length; while (stack.length && stack[stack.length - 1].ind >= ind) stack.pop();
    stack.push({ ind, key: m[2].trim().replace(/^["']|["']$/g, "") });
    if (m[3] && !m[3].startsWith("#") && m[3] !== "|" && m[3] !== ">") out.push([stack.map(s => s.key).join("."), m[3].replace(/\s+#.*$/, "").trim()]);
  }
  return out;
}
const flattenProps = text => text.split("\n").filter(l => /^\s*[^#!\s][^=:]*[=:]/.test(l)).map(l => { const i = l.search(/[=:]/); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; });

// 쿠버 yml 읽기 — 쿠버 yml 에 쓰는 만큼만 (블록 · 목록 · [a, b] · {a: 1} · 따옴표 · | 여러 줄). 외부 라이브러리 없이.
function parseYamlDocs(text) {
  const docs = [];
  for (const chunk of String(text).replace(/\t/g, "  ").split(/^(?:---|\.\.\.)[^\n]*$/m)) {
    const raw = chunk.split(/\r?\n/); let i = 0;
    const sig = () => { while (i < raw.length && /^\s*(#.*)?$/.test(raw[i])) i++; return i < raw.length ? { ind: raw[i].match(/^ */)[0].length, t: raw[i].trim() } : null; };
    const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#\[{-][^:#]*?|-[^\s:#][^:#]*?)\s*:(?:\s+(.*)|\s*)$/;
    const unq = k => /^["']/.test(k) ? scalar(k) : k;
    const open = t => { let d = 0, q = null; for (const c of t.replace(/\s+#.*$/, "")) { if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === "[" || c === "{") d++; else if (c === "]" || c === "}") d--; } return d; };
    function blockScalar(head, ind) {
      const keep = /\|/.test(head), out = []; let min = null;
      while (i < raw.length) {
        const l = raw[i]; if (/^\s*$/.test(l)) { out.push(""); i++; continue; }
        const li = l.match(/^ */)[0].length; if (li <= ind) break;
        if (min === null) min = li; out.push(l.slice(Math.min(min, li))); i++;
      }
      while (out.length && out[out.length - 1] === "") out.pop();
      return (keep ? out.join("\n") : out.join(" ")) + (/-/.test(head) ? "" : "\n");
    }
    function value(rest, ind) {
      if (rest === undefined || rest === "" || /^#/.test(rest)) {
        const n = sig(); if (!n) return null;
        if (n.ind > ind) return node(n.ind);
        if (n.ind === ind && /^-(\s|$)/.test(n.t)) return seq(ind);
        return null;
      }
      rest = rest.replace(/^!\S+\s*/, "").replace(/^&\S+\s*/, "");
      if (/^[|>][+-]?\d*\s*(#.*)?$/.test(rest)) return blockScalar(rest, ind);
      if (/^[\[{]/.test(rest)) while (open(rest) > 0 && i < raw.length) rest += " " + raw[i++].trim().replace(/\s+#.*$/, "");   // 여러 줄에 걸친 [ ... ]
      else for (let n = sig(); n && n.ind > ind; n = sig()) { rest = rest.replace(/\s+#.*$/, "") + " " + n.t; i++; }   // 다음 줄로 이어지는 긴 글
      return scalar(rest);
    }
    function node(ind) { const n = sig(); if (!n) return null; return /^-(\s|$)/.test(n.t) ? seq(n.ind) : map(n.ind); }
    function map(ind) {
      const o = {};
      for (;;) {
        const n = sig(); if (!n || n.ind !== ind || /^-(\s|$)/.test(n.t)) break;
        const m = n.t.match(KEY); i++; if (!m) continue;
        o[unq(m[1])] = value(m[2], ind);
      }
      return o;
    }
    function seq(ind) {
      const a = [];
      for (;;) {
        const n = sig(); if (!n || n.ind !== ind || !/^-(\s|$)/.test(n.t)) break;
        const rest = n.t.replace(/^-\s*/, ""), sub = ind + (n.t.length - rest.length);
        if (!rest) { i++; const m = sig(); a.push(m && m.ind > ind ? node(m.ind) : null); continue; }
        if (KEY.test(rest) && !/^[\[{"']/.test(rest)) { raw[i] = " ".repeat(sub) + rest; a.push(map(sub)); continue; }
        i++; a.push(value(rest, ind));
      }
      return a;
    }
    const n = sig(); if (!n) continue;
    try { docs.push(node(n.ind)); } catch { docs.push(null); }
  }
  return docs;
}
// 한 줄 값: "따옴표" · '따옴표' · [목록] · {묶음} · 숫자 · 참/거짓 · 그냥 글자
function scalar(s) {
  s = String(s).trim();
  if (s[0] === "[" || s[0] === "{") { try { const st = { s, i: 0 }; return flow(st); } catch { return s; } }
  if (s[0] === '"') { const m = s.match(/^"((?:[^"\\]|\\.)*)"/); if (m) { try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; } } }
  if (s[0] === "'") { const m = s.match(/^'((?:[^']|'')*)'/); if (m) return m[1].replace(/''/g, "'"); }
  s = s.replace(/\s+#.*$/, "").trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
  if (/^(null|~)$/i.test(s) || s === "") return null;
  return s;
}
function flow(st) {
  const ws = () => { while (st.i < st.s.length && /\s/.test(st.s[st.i])) st.i++; };
  const atom = () => {
    ws(); const c = st.s[st.i];
    if (c === "[" || c === "{") return flow(st);
    if (c === '"' || c === "'") { const m = st.s.slice(st.i).match(c === '"' ? /^"((?:[^"\\]|\\.)*)"/ : /^'((?:[^']|'')*)'/); st.i += m[0].length; return scalar(m[0]); }
    const m = st.s.slice(st.i).match(/^[^,\]}]*/); st.i += m[0].length; const v = m[0].trim();
    return v.includes(": ") ? v : scalar(v);
  };
  ws(); const open = st.s[st.i++];
  if (open === "[") { const a = []; for (;;) { ws(); if (st.s[st.i] === "]") { st.i++; return a; } a.push(atom()); ws(); if (st.s[st.i] === ",") st.i++; else if (st.s[st.i] === "]") { st.i++; return a; } else throw 0; } }
  const o = {};
  for (;;) {
    ws(); if (st.s[st.i] === "}") { st.i++; return o; }
    const km = st.s.slice(st.i).match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[^:,}]+?)\s*:\s*/); if (!km) throw 0;
    st.i += km[0].length; o[scalar(km[1])] = atom(); ws();
    if (st.s[st.i] === ",") st.i++; else if (st.s[st.i] === "}") { st.i++; return o; } else throw 0;
  }
}

// Dockerfile 요약 — 베이스 이미지 · 포트 · 실행 사용자 · 실행 명령
function summarizeDockerfile(s) {
  const lines = s.replace(/\\\r?\n/g, " ").split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  const get = k => lines.filter(l => new RegExp(`^${k}\\s`, "i").test(l)).map(l => l.replace(new RegExp(`^${k}\\s+`, "i"), ""));
  const from = get("FROM").map(f => f.replace(/\s+as\s+\S+$/i, "").replace(/--platform=\S+\s+/i, ""));
  const user = get("USER").pop();
  const cmd = (get("ENTRYPOINT").pop() || "") + (get("CMD").length ? " " + get("CMD").pop() : "");
  return { from, expose: uniq(get("EXPOSE").flatMap(e => e.split(/\s+/))), user: user || null, cmd: cmd.trim(),
    health: get("HEALTHCHECK").length > 0, volume: get("VOLUME") };
}
// docker-compose 요약 — 서비스별 이미지 · 포트 · 서버 폴더 연결
function summarizeCompose(s) {
  const out = []; const lines = s.split(/\r?\n/);
  let inSvc = false, svcInd = -1, cur = null, key = null, keyInd = -1;
  for (const raw of lines) {
    if (/^\s*(#|$)/.test(raw)) continue;
    const ind = raw.match(/^\s*/)[0].length, t = raw.trim();
    if (ind === 0) { inSvc = /^services:\s*$/.test(t); cur = null; continue; }
    if (!inSvc) continue;
    if (svcInd < 0) svcInd = ind;
    if (ind === svcInd && /^[A-Za-z0-9_.-]+:\s*$/.test(t)) { cur = { name: t.slice(0, -1), image: null, build: null, ports: [], volumes: [], depends: [], cmd: null }; out.push(cur); key = null; continue; }
    if (!cur) continue;
    const kv = t.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv && !t.startsWith("-") && ind > svcInd && (keyInd < 0 || ind <= keyInd)) {
      keyInd = ind; key = kv[1]; const v = kv[2].replace(/\s+#.*$/, "");
      if (key === "image") cur.image = v.replace(/["']/g, "");
      if (key === "build") cur.build = v || "(설정 있음)";
      if (key === "command") cur.cmd = v.slice(0, 80);
      if (/^\[.*\]$/.test(v) && ["ports", "volumes", "depends_on"].includes(key)) {
        const items = v.slice(1, -1).split(",").map(x => x.trim().replace(/["']/g, "")).filter(Boolean);
        (key === "ports" ? cur.ports : key === "volumes" ? cur.volumes : cur.depends).push(...items);
      }
      continue;
    }
    const li = t.match(/^-\s*(.+)$/);
    if (li && key) {
      const v = li[1].replace(/\s+#.*$/, "").replace(/["']/g, "");
      if (key === "ports") cur.ports.push(v);
      if (key === "volumes") cur.volumes.push(v);
      if (key === "depends_on") cur.depends.push(v);
    } else if (key === "depends_on" && /^[A-Za-z0-9_.-]+:\s*$/.test(t)) cur.depends.push(t.slice(0, -1));
  }
  return out;
}

const KEY_RE = /(^|\.)(port|context-path|base-path|url|uri|host|hosts|bootstrap-servers|address|addresses|endpoint|location|profiles?\.active|issuer-uri|jwk-set-uri|base-url|baseurl|dir|directory|upload-dir|root)$/i;
const PRIVATE_IP = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b(?!\/\d)/;
const LOCAL_RE = /\b(localhost|127\.0\.0\.1)(:\d+)?\b/;
const URL_RE = /https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?/g;
const IGNORE_HOSTS = /(^|\.)(w3\.org|apache\.org|springframework\.org|json-schema\.org|xml\.org|sun\.com|oracle\.com|mybatis\.org|qos\.ch|eclipse\.org|openapis\.org|swagger\.io|xmlsoap\.org|jcp\.org|jboss\.org|reactjs\.org|react\.dev|vuejs\.org|vitejs\.dev|npmjs\.(com|org)|github\.com|githubusercontent\.com|mozilla\.org|purl\.org|opensource\.org|creativecommons\.org|ietf\.org|ecma-international\.org|java\.com|maven\.org|gradle\.org|nodejs\.org|typescriptlang\.org|eslint\.org|prettier\.io|jquery\.com|egovframe\.go\.kr|schema\.org|xmlns\.com|openxmlformats\.org|microsoft\.com\/office|tiles\.mapbox\.com|jakarta\.ee|thymeleaf\.org|java\.sun\.com|springdoc\.org|eclipse\.dev)$|^(schemas?|xmlns)\.|^(java|javax|jakarta|org|com)\.[a-z]+\.[a-z]+$(?<!\.(com|org|net|kr|go\.kr))|\.(invalid|test|example|localhost)$|^example\.(com|org|net)$/i;
// 내장(복사해 넣은) 외부 라이브러리 — 안의 주소는 앱이 부르는 주소가 아님
const VENDOR_RE = /(^|\/)(ckeditor[^/]*|tinymce|smarteditor[^/]*|se2|jquery[^/]*|bootstrap[^/]*|plugins?|vendors?|thirdparty|third-party|bower_components|fullcalendar|chartjs|datatables)\/(.+\/)?[^/]*\.(js|css|html)$|(^|\/)(jquery|bootstrap|ckeditor|lodash|moment|chart|d3|swiper|select2|datatables|underscore|backbone|angular|vue|react)[^/]*\.js$/i;
const COMMENT_RE = /^\s*(\/\/|\/\*|\*|<!--|<%--|#|--\s|;)/;
const INTERNAL_DOMAIN = /\.(local|internal|lan|corp|intra|intranet|home|localdomain|private)$/i;
const BUILD_CFG_FILE = /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|settings\.xml|gradle-wrapper\.properties|\.npmrc|\.yarnrc(\.yml)?|package\.json|libs\.versions\.toml|mvnw(\.cmd)?|gradlew(\.bat)?)$/;
const FILE_WRITE_RE = /(new\s+File(?:OutputStream|Writer)?\s*\(\s*"(\/[^"]+|[A-Za-z]:\\\\[^"]+)"|Paths\.get\s*\(\s*"(\/[^"]+)"|Path\.of\s*\(\s*"(\/[^"]+)"|fs\.(?:writeFile|appendFile|mkdir|createWriteStream)(?:Sync)?\s*\(\s*['"`](\/[^'"`]+)|open\(\s*['"](\/[^'"]+)['"]\s*,\s*['"][wa])/;
const DEPLOY_FILE_RE = /^(Dockerfile.*|.*\.dockerfile|docker-compose.*\.ya?ml|compose\.ya?ml|Jenkinsfile.*|\.gitlab-ci\.yml|azure-pipelines\.yml|bitbucket-pipelines\.yml|.*\.service|(deploy|build|start|stop|restart|run|install|release|startup|shutdown)[^/]*\.(sh|bat|cmd|ps1)|nginx[^/]*\.conf|kustomization\.ya?ml|Chart\.yaml|values[^/]*\.ya?ml|.*\.example\.env|\.env\.example|application[^/]*\.(ya?ml|properties)|bootstrap[^/]*\.(ya?ml|properties)|globals\.properties|vite\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s|nuxt\.config\.[jt]s|vue\.config\.js|ecosystem\.config\.[cm]?js|web\.xml|server\.xml|context\.xml|logback[^/]*\.xml|log4j2?[^/]*\.(xml|properties)|gunicorn[^/]*\.(py|conf)|uwsgi[^/]*\.ini|Procfile)$/i;
// 스크립트 · 자동 빌드 설정에서 찾는 배포 방식 [이름, 찾는 글, 묶음]
const DEPLOY_WORDS = [
  ["scp", /\bscp\b/, "서버로 복사"], ["rsync", /\brsync\b/, "서버로 복사"], ["ssh", /\bssh\s/, "서버로 복사"], ["FTP", /\bs?ftp\b/i, "서버로 복사"],
  ["systemctl", /systemctl\s+(restart|start|stop)/, "서버에서 실행"], ["java -jar", /nohup\s+java|java\s+(-[^\s]+\s+)*-jar/, "서버에서 실행"],
  ["WAS 에 war 복사", /webapps\/|\.war\b|standalone\/deployments|jeus|weblogic|jboss|wildfly/i, "서버에서 실행"], ["pm2", /\bpm2\b/, "서버에서 실행"],
  ["docker run/compose", /docker\s+run|docker[- ]compose|\bcompose\s+up/, "서버에서 실행"], ["ansible", /ansible/, "서버에서 실행"],
  ["docker build", /\b(docker|podman|nerdctl)\s+(buildx\s+)?build\b/, "이미지"], ["buildah/kaniko/jib (도커 없이 빌드)", /\bbuildah\s+(bud|build)|kaniko|\bjib:(build|dockerBuild)|\bjib(Docker)?Build\b/, "이미지"],
  ["이미지 창고로 push", /\b(docker|podman|nerdctl|buildah)\s+push\b/, "이미지"], ["skopeo 로 창고 사이 복사", /\bskopeo\s+(copy|sync)\b/, "이미지"],
  ["docker save/load (이미지를 파일로 옮김)", /\b(docker|podman|nerdctl)\s+(save|load)\b/, "이미지"],
  ["ctr import (서버 containerd 에 직접 넣음)", /\bctr\b[^\n]*\b(i|images?)\s+(import|load)\b/, "이미지"], ["crictl pull", /\bcrictl\s+pull\b/, "이미지"],
  ["kubectl apply", /\bkubectl\b[^\n]*\bapply\b/, "쿠버"], ["kubectl create/replace", /\bkubectl\b[^\n]*\b(create|replace)\s+(-f|--filename)/, "쿠버"],
  ["kubectl set image", /\bkubectl\b[^\n]*\bset\s+image\b/, "쿠버"], ["kubectl rollout", /\bkubectl\b[^\n]*\brollout\s+(restart|undo|status)/, "쿠버"],
  ["helm install/upgrade", /\bhelm\s+(upgrade|install)\b/, "쿠버"], ["kustomize edit set image", /kustomize\s+edit\s+set\s+image/, "쿠버"],
  ["argocd 명령", /\bargocd\s+(app|login|repo)\b/, "쿠버"], ["yml 의 태그를 고쳐 올림 (GitOps)", /sed\s+-i[^\n]*(newTag|image:)|\byq\b[^\n]*(\.image|newTag)/, "쿠버"],
  ["svn 받기/올리기", /\bsvn\s+(commit|ci|export|checkout|co|update|up|switch)\b/, "저장소"]];
// 자동 빌드 · 배포 설정 파일 → 도구 이름
const CI_FILES = [[/(^|\/)Jenkinsfile[^/]*$/, "Jenkins"], [/(^|\/)\.teamcity\//, "TeamCity"], [/(^|\/)\.gitlab-ci\.ya?ml$/, "GitLab CI"],
  [/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/, "GitHub Actions"], [/(^|\/)\.gitea\/workflows\//, "Gitea Actions"], [/(^|\/)bitbucket-pipelines\.yml$/, "Bitbucket"],
  [/(^|\/)azure-pipelines\.ya?ml$/, "Azure Pipelines"], [/(^|\/)\.drone\.ya?ml$/, "Drone"], [/(^|\/)\.woodpecker/, "Woodpecker"], [/(^|\/)\.circleci\//, "CircleCI"],
  [/(^|\/)\.tekton\//, "Tekton"], [/(^|\/)skaffold\.ya?ml$/, "Skaffold"]];
const isScriptFile = (rp, base) => /\.(sh|bash|bat|cmd|ps1)$/i.test(base) || /^(Makefile|justfile|Jenkinsfile.*)$/.test(base) || /(^|\/)\.teamcity\//.test(rp);
// 환경변수 참조 — 스프링 ${VAR} · Node process.env.X · Vite import.meta.env.X · 파이썬 os.getenv · 자바 System.getenv
const ENV_REF_RES = [/process\.env\.([A-Z][A-Z0-9_]+)/g, /process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g, /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
  /os\.(?:environ\.get|getenv)\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g, /os\.environ\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g, /System\.getenv\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /\benv\(\s*"([A-Z][A-Z0-9_]+)"\s*\)/g];
// 운영에서 어떤 프로필 · 모드로 도는지의 근거
const PROD_HINT_RES = [[/SPRING_PROFILES_ACTIVE["'\s]*[=:]\s*["']?([A-Za-z0-9_,-]+)/, "실행 환경변수"], [/-Dspring\.profiles\.active=([A-Za-z0-9_,-]+)/, "실행 옵션"],
  [/--spring\.profiles\.active=([A-Za-z0-9_,-]+)/, "실행 옵션"], [/\bNODE_ENV["'\s]*[=:]\s*["']?([a-z]+)/, "NODE_ENV"], [/\bAPP_ENV["'\s]*[=:]\s*["']?([a-z]+)/, "APP_ENV"]];
// 헬스체크 경로 후보
const HEALTH_RE = /@(?:Get|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']*(?:health|ping|status)[^"']*)["']|\.(?:get|route|head)\(\s*['"`]([^'"`]*(?:health|healthz|ping)[^'"`]*)['"`]|@\w+\.(?:get|route|api_route)\(\s*['"]([^'"]*(?:health|ping)[^'"]*)['"]/i;
const SECRETISH = /(PASS|PWD|(^|_)PW($|_)|SECRET|TOKEN|PRIVATE|CREDENTIAL|(^|_)KEY$|_KEY_|APIKEY|API_KEY|(^|_)AUTH$|AUTH_(TOKEN|KEY|SECRET|PASS))/i;
const isSecretName = n => SECRETISH.test(n) && !/(_NAME|_FILE|_PATH|_DIR|_REF|_URL|_URI|_HOST|_ENDPOINT|_TTL|_EXPIRE[SD]?|_EXPIRATION)$/i.test(n);   // DB_SECRET_NAME · JWT_SECRET_FILE 은 설정값
const NOT_APP_ENV = /^(NODE_ENV|PATH|HOME|PWD|USER|SHELL|LANG|TZ|CI|HOSTNAME|TERM|npm_.*|JAVA_HOME|DEBUG|VERBOSE|PORT_\d+|GITHUB_.*|RUNNER_.*)$/;
function addEnv(r, dir, name, where) {
  if (!name || NOT_APP_ENV.test(name) || name.length < 3) return;
  const key = dir + "\u0000" + name, e = r.envVars.get(key) || { dir, name, where: new Set() };
  e.where.add(where); r.envVars.set(key, e);
}
function noteEnvRefs(r, dir, v, rp, k) {
  for (const m of String(v).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}/g)) if (/^[A-Z0-9_]+$/.test(m[1])) addEnv(r, dir, m[1], rp);
}
// 설정 키로 연결 대상 알아보기 (DB · Redis · Kafka · 파일 저장소)
function noteConn(r, dir, k, v, profile, file) {
  const kinds = [[/(datasource\.(url|jdbc-url)|r2dbc\.url|^Globals\.[^.]*\.?Url$|^Globals\.Url$|database\.url|db\.url)$/i, "DB"], [/redis\.(host|url|cluster\.nodes)$/i, "Redis"],
    [/kafka\.bootstrap-servers$|kafka\.brokers$/i, "Kafka"], [/(minio|s3|object-?storage)\.(endpoint|url)$/i, "파일 저장소(S3 · MinIO)"],
    [/multipart\.location$|(file|upload)[.-]?(path|dir|root|store|location)$|fileStorePath$/i, "파일 저장 경로", v => /^(\/|[A-Za-z]:[\\/]|\.{1,2}\/|~|\$\{)/.test(v) && !/\.(properties|xml|ya?ml|json)$/i.test(v)], [/elasticsearch\.(uris|url|host)$/i, "검색엔진"]];
  for (const [re, kind, okv] of kinds) if (re.test(k) && v && (!okv || okv(v))) { r.conns.push({ dir, kind, value: mask(`x: ${v}`).replace(/^x:\s*/, ""), profile, file }); return; }
}
function dbKind(v) {
  const m = String(v).toLowerCase().match(/jdbc:(?:log4jdbc:|p6spy:)?(postgresql|mysql|mariadb|oracle|tibero|sqlserver|altibase|cubrid|goldilocks|h2|db2|hsqldb|derby|sqlite)|^(postgres(?:ql)?|mysql|mariadb|mongodb)/);
  return m ? (m[1] || m[2]).replace("postgres", "postgresql").replace("postgresqlql", "postgresql") : null;
}

// 코드 · 실행 명령 안의 포트: listen(3000) · PORT || 4000 · uvicorn --port 8000 · app.run(port=5000) · server.port=8081
const CODE_PORT_RE = /\.listen\(\s*(\d{2,5})\b|\bPORT\b[^\n]{0,40}?(?:\|\||\?\?|:-)\s*["']?(\d{2,5})\b|(?:uvicorn|gunicorn|hypercorn|flask|streamlit)[^\n]*?(?:--port|--bind\s+\S*:|-b\s+\S*:)[ =]?(\d{2,5})\b|\.run\([^)]*\bport\s*=\s*(\d{2,5})|--server\.port[ =](\d{2,5})/;
const PY_FW = ["fastapi", "flask", "django", "uvicorn", "gunicorn", "celery", "streamlit", "gradio", "torch", "tensorflow", "transformers", "vllm",
  "ultralytics", "opencv", "kafka", "confluent-kafka", "psycopg", "sqlalchemy", "redis", "minio", "boto3", "pandas", "langchain", "openai"];

const copied = { total: 0 };   // 모든 저장소의 사본 크기 합

// ── 저장소 하나 훑기 ─────────────────────────────────────────────────
function scanRepo(root) {
  const r = { root, name: path.basename(root), vcs: [], projects: [], configs: [], envFiles: [], deployFiles: [], dockerfiles: [], composes: [],
    deployWords: new Map(), deployTargets: [], skipped: [], springPorts: [], codePorts: [], files: 0,
    profiles: [], prodHints: [], envVars: new Map(), conns: [], health: [],
    k8s: [], kusts: [], helmTpl: new Set(), ci: new Map(), pushTo: new Map(),
    findings: { privateIp: [], local: [], forbidden: [], hosts: new Map(), internal: new Map(), buildHosts: new Set(), fileWrite: [], logFile: [], demo: [] } };
  if (exists(path.join(root, ".svn"))) {
    const info = sh("svn", ["info"], root);
    r.vcs.push(info ? "SVN · " + mask(info.split("\n").filter(l => /^(URL|Relative URL|Repository Root|Revision|Last Changed (Author|Rev|Date)):/.test(l)).join(" · "))
      : "SVN 작업 사본 (svn 명령이 없어 주소는 못 읽음 — 질문지로)");
  }
  if (exists(path.join(root, ".git"))) {
    const remote = sh("git", ["remote", "-v"], root), br = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], root);
    const last = sh("git", ["log", "-1", "--date=short", "--format=%h %cd"], root), dirty = sh("git", ["status", "--porcelain"], root);
    r.vcs.push("Git · " + mask((remote || "원격 없음").split("\n")[0].replace(/\s+\((fetch|push)\)$/, "").replace(/\t/, " ")) + " · 브랜치 " + (br || "?") +
      " · 마지막 커밋 " + (last || "?") + (dirty ? " · 커밋 안 된 변경 " + dirty.split("\n").length + "개" : ""));
  }
  if (!r.vcs.length) r.vcs.push("저장소 정보 없음 (.svn · .git 없음 — 압축본이거나 상위 폴더가 저장소)");

  walk(root, (p, base) => {
    r.files++;
    const rp = rel(root, p), ext = path.extname(base).toLowerCase(), dir = path.dirname(rp);
    // ── 프로젝트 (빌드 파일)
    if (base === "pom.xml") {
      const s = readText(p) || "";
      const parent = s.match(/<parent>[\s\S]*?<\/parent>/)?.[0] || "";
      const own = s.replace(parent, ""), pr = props(s);
      pr["project.artifactId"] = tag(own, "artifactId"); pr["project.version"] = tag(own, "version") || tag(parent, "version");
      pr["artifactId"] = pr["project.artifactId"]; pr["version"] = pr["project.version"];
      const deps = ["spring-boot-starter-web", "spring-boot-starter-webflux", "data-jpa", "mybatis", "postgresql", "mysql", "mariadb", "ojdbc", "tibero",
        "redis", "kafka", "egovframework", "spring-boot-starter-tomcat", "flyway", "liquibase", "minio", "aws-java-sdk", "elasticsearch", "actuator", "thymeleaf", "jsp", "jstl"]
        .filter(d => s.includes(d));
      r.projects.push({ dir, kind: "메이븐", name: tag(own, "artifactId"),
        boot: /spring-boot-starter-parent/.test(parent) ? tag(parent, "version") : resolveProp(s.match(/spring-boot[^<]*<\/artifactId>\s*<version>([^<]+)/)?.[1] || pr["spring-boot.version"] || null, pr),
        java: resolveProp(pr["java.version"] || pr["maven.compiler.release"] || pr["maven.compiler.source"] || tag(s, "release") || tag(s, "source"), pr),
        packaging: tag(own, "packaging") || "jar", finalName: resolveProp(tag(s, "finalName"), pr), modules: (s.match(/<module>[^<]+<\/module>/g) || []).length,
        bootPlugin: s.includes("spring-boot-maven-plugin"), egov: /egovframework/.test(s), deps });
    } else if (base === "build.gradle" || base === "build.gradle.kts") {
      const s = readText(p) || "";
      let boot = s.match(/org\.springframework\.boot['"]?\)?\s*version\s*['"]([^'"]+)/)?.[1] || null;
      if (!boot) for (const toml of [path.join(path.dirname(p), "gradle", "libs.versions.toml"), path.join(root, "gradle", "libs.versions.toml")]) {
        const t = readText(toml); const m = t && t.match(/spring-?boot\s*=\s*["']([^"']+)/i); if (m) { boot = m[1]; break; }
      }
      r.projects.push({ dir, kind: "그레이들", name: path.basename(path.dirname(p)) === "." ? r.name : path.basename(path.dirname(p)), boot,
        java: s.match(/(?:sourceCompatibility|targetCompatibility|languageVersion)\s*[=(]\s*(?:JavaVersion\.VERSION_|JavaLanguageVersion\.of\()?['"]?(\d+)/)?.[1]
          || s.match(/jvmToolchain\(\s*(\d+)/)?.[1] || null,
        packaging: /(id\s*\(?\s*['"]war['"]|apply\s+plugin:\s*['"]war['"]|\bbootWar\b)/.test(s) ? "war" : "jar",
        bootPlugin: /org\.springframework\.boot/.test(s), egov: /egovframework/.test(s),
        deps: ["postgresql", "mysql", "mariadb", "ojdbc", "tibero", "redis", "kafka", "mybatis", "data-jpa", "flyway", "minio", "egovframework", "actuator"].filter(d => s.includes(d)) });
    } else if (base === "package.json") {
      let j = {}; try { j = JSON.parse(readText(p) || "{}"); } catch { }
      const all = { ...(j.dependencies || {}), ...(j.devDependencies || {}) };
      const fw = ["vite", "react", "vue", "next", "nuxt", "@angular/core", "svelte", "express", "@nestjs/core", "fastify", "koa", "prisma", "typeorm", "pg", "ioredis", "kafkajs", "socket.io", "expo", "react-native", "electron"].filter(k => all[k]);
      r.projects.push({ dir, kind: "npm", name: j.name, scripts: j.scripts || {}, fw, node: j.engines?.node || null, workspaces: !!j.workspaces });
    } else if (base === "pyproject.toml" || base === "setup.py" || /^requirements[^/]*\.txt$/.test(base) || base === "Pipfile") {
      const s = (readText(p) || "").toLowerCase();
      const existing = r.projects.find(x => x.kind === "파이썬" && x.dir === dir);
      const fw = PY_FW.filter(f => new RegExp(`(^|[\\s"'\\[,])${f.replace(/[-]/g, "[-_]")}([\\s=<>~!\\["',;]|$)`, "m").test(s));
      const py = s.match(/requires-python\s*=\s*["']([^"']+)/)?.[1] || s.match(/python_requires\s*=\s*["']([^"']+)/)?.[1] || null;
      const name = s.match(/^\s*name\s*=\s*["']([^"']+)/m)?.[1] || null;
      if (existing) { existing.fw = uniq(existing.fw.concat(fw)); existing.py = existing.py || py; existing.name = existing.name || name; existing.files.push(base); }
      else r.projects.push({ dir, kind: "파이썬", name: name || path.basename(path.dirname(p)), fw, py, files: [base], workspace: /\[tool\.uv\.workspace\]|\[tool\.poetry\.group|\[workspace\]/.test(s) && !fw.length });
    }
    // ── 화면 base 경로 · 개발 서버 포트
    if (/^(vite|next|nuxt|vue)\.config\.[cm]?[jt]s$/.test(base)) {
      const s = readText(p) || "";
      const b = s.match(/\b(?:base|basePath|publicPath|baseURL)\s*:\s*([^,\n]+)/)?.[1]?.trim();
      const port = s.match(/\bport\s*:\s*(\d+)/)?.[1];
      r.configs.push({ file: rp, dir, items: [["화면 base 경로", b || "지정 안 됨 (/)"], ...(port ? [["개발 서버 포트", port]] : [])] });
    }
    // ── 스프링 · 전자정부 설정
    if (/^(application|bootstrap)[^/]*\.(ya?ml|properties)$/i.test(base) || /^globals\.properties$/i.test(base)) {
      const s = readText(p) || "";
      const kv = /\.properties$/i.test(base) ? flattenProps(s) : flattenYaml(s);
      const items = kv.filter(([k]) => KEY_RE.test(k) || /^logging\.file\.(name|path)$/.test(k) || /^Globals\./i.test(k) && /(Url|Port|Path|Dir|Host)/i.test(k))
        .slice(0, 40).map(([k, v]) => [k, mask(`${k}: ${v}`).replace(/^[^:]*:\s*/, "")]);
      r.configs.push({ file: rp, dir, items });
      const prof = /^globals\.properties$/i.test(base) ? "전자정부 Globals" : (base.match(/^(?:application|bootstrap)-([A-Za-z0-9_]+)\./i)?.[1] || "기본");
      r.profiles.push({ dir, profile: prof, file: rp });
      for (const [k, v] of kv) {
        if (/^logging\.file\.(name|path)$/.test(k)) r.findings.logFile.push([v, rp]);
        if (k === "server.port") r.springPorts.push({ dir, port: v, file: rp, profile: prof });
        if (/^spring\.profiles\.(active|default)$/.test(k)) r.prodHints.push({ dir, value: v, at: rp, how: "설정 파일 기본값" });
        if (/^spring\.config\.activate\.on-profile$|^spring\.profiles$/.test(k)) r.profiles.push({ dir, profile: v + " (한 파일 안)", file: rp });
        noteConn(r, dir, k, v, prof, rp);
        noteEnvRefs(r, dir, v, rp, k);
      }
    }
    // ── .env (키 이름만)
    if (/^\.env(\..+)?$/.test(base) && !/example|sample|template/i.test(base)) {
      const s = readText(p) || "";
      const keys = s.split("\n").map(l => l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]).filter(Boolean);
      r.envFiles.push({ file: rp, keys });
      r.profiles.push({ dir, profile: base, file: rp, envFile: true });
      for (const key of keys) addEnv(r, dir, key, rp);
    }
    // ── 쿠버 yml (apiVersion + kind 가 있는 yml · kustomization) — 읽어서 점검에 씀
    let isK8s = false;
    if (/\.ya?ml$/i.test(base)) {
      const s = readText(p);
      const kust = /^kustomization\.ya?ml$/i.test(base);
      if (s && (kust || (/^\s*apiVersion:\s*\S/m.test(s) && /^\s*kind:\s*\S/m.test(s)))) {
        isK8s = true;
        if (/\{\{/.test(s)) { if (/(^|\/)templates\//.test(rp)) r.helmTpl.add(dir.replace(/\/?templates(\/.*)?$/, "") || "."); }      // 헬름 틀은 값이 채워져야 읽힘
        else for (const d of parseYamlDocs(s)) {
          if (!d || typeof d !== "object" || Array.isArray(d)) continue;
          if (kust || d.kind === "Kustomization" && /kustomize\.config/.test(d.apiVersion || "")) r.kusts.push({ dir, file: rp, d });
          else if (d.kind && d.apiVersion) r.k8s.push({ dir, file: rp, d });
        }
      }
    }
    for (const [re, tool] of CI_FILES) if (re.test(rp)) r.ci.set(tool, (r.ci.get(tool) || []).concat(rp));
    // ── 배포 관련 파일 사본 · 요약
    const inDeployDir = (/(^|\/)(k8s|kubernetes|deploy|deploys|deployment|deployments|helm|charts|kustomize|manifests|gitops|argocd)\//i.test(rp) && /\.(ya?ml|conf|toml)$/i.test(base))
      || (/(^|\/)\.(github\/workflows|gitlab|circleci|gitea|woodpecker|teamcity|tekton)\//.test(rp) && /\.(ya?ml|kts|xml)$/i.test(base));
    const realEnv = /(^|[._-])env$|^\.env/i.test(base) && !/example|sample|template/i.test(base);
    const script = isScriptFile(rp, base);
    let s0 = null;
    if (script && !DEPLOY_FILE_RE.test(base)) { s0 = readText(p); if (!s0 || !DEPLOY_WORDS.some(([, re]) => re.test(s0))) s0 = false; }   // 이름이 달라도 배포 명령이 들어 있으면
    if ((DEPLOY_FILE_RE.test(base) || inDeployDir || isK8s || CI_FILES.some(([re]) => re.test(rp)) || s0) && !realEnv && !/\.(key|pem|p12|jks|pfx|keystore|truststore)$/i.test(base)) {
      const s = s0 || readText(p);
      copied.total += s ? Math.min(s.length, MAX_COPY) : 0;
      const body = s && isK8s ? maskSecretDocs(s) : s;
      const text = s === null ? "(1MB 넘어 생략)" : copied.total > MAX_COPY_TOTAL ? "(전체 사본 한도 2MB 를 넘어 이름만 적음)" :
        mask(body.length > MAX_COPY ? body.slice(0, MAX_COPY) + "\n... (64KB 뒤는 생략)" : body);
      r.deployFiles.push({ file: rp, text });
      if (s && /^Dockerfile|\.dockerfile$/i.test(base)) r.dockerfiles.push({ file: rp, dir, ...summarizeDockerfile(s) });
      if (s && /^(docker-compose.*|compose)\.ya?ml$/i.test(base)) r.composes.push({ file: rp, services: summarizeCompose(s) });
      if (s && (script || CI_FILES.some(([re]) => re.test(rp)) || /\.service$|compose[^/]*\.ya?ml$|Procfile/i.test(rp))) {
        for (const [w, re] of DEPLOY_WORDS) if (re.test(s)) r.deployWords.set(w, (r.deployWords.get(w) || []).concat(rp));
        for (const m of s.matchAll(/(?:scp|rsync|ssh)\b[^\n]*?@([A-Za-z0-9.-]+|\$\{?[A-Za-z_]+\}?)/g)) if (!/^\$/.test(m[1]) || /HOST|SERVER|NODE|TARGET|REMOTE|DEST|IP/i.test(m[1])) r.deployTargets.push(m[1]);
        notePushTargets(r, s, rp);
      }
    }
    // ── 소스 안의 주소 · 파일 쓰기 · 로그 파일 · 데모 로그인
    if (!TEXT_EXT.has(ext) && !/^Dockerfile|Jenkinsfile/.test(base)) return;
    if (/package-lock\.json|yarn\.lock|pnpm-lock|\.min\.js$|\.map$/.test(base) || ext === ".md") return;
    const s = readText(p); if (s === null) return;
    const buildCfg = BUILD_CFG_FILE.test(rp);
    if (VENDOR_RE.test(rp)) return;
    s.split("\n").forEach((line, i) => {
      if (line.length > 2000) return;
      const cp = line.match(CODE_PORT_RE); if (cp) { const v = cp.slice(1).find(Boolean); if (+v >= 80 && +v <= 65535) r.codePorts.push({ dir, port: v, at: `${rp}:${i + 1}` }); }
      // 주석 · 이름표 줄(xmlns · 스키마 · JSP taglib · TLD uri)은 접속 주소가 아님
      if (COMMENT_RE.test(line) || /xmlns|schemaLocation|DOCTYPE|<!ENTITY|<%@\s*taglib|<uri>|\btaglib\b/i.test(line)) return;
      const at = `${rp}:${i + 1}`, push = (arr, v) => { arr.push([v, at]); };
      if (!buildCfg) {
        const ip = line.match(PRIVATE_IP);
        if (ip && !/\.0$/.test(ip[1]) && !/version|\d+\.\d+\.\d+\.\d+\.\d+/i.test(line)) push(r.findings.privateIp, ip[1]);
        const lo = line.match(LOCAL_RE); if (lo) push(r.findings.local, lo[0]);
        for (const h of FORBIDDEN_HOSTS) if (h && line.includes(h)) push(r.findings.forbidden, h);
      }
      for (const m of line.matchAll(URL_RE)) {
        const host = m[1].toLowerCase();
        if (IGNORE_HOSTS.test(host) || /\.svc(\.cluster\.local)?$/.test(host) || PRIVATE_IP.test(host) || /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0)$/.test(host)) continue;
        if (buildCfg) { r.findings.buildHosts.add(host); continue; }
        const map = INTERNAL_DOMAIN.test(host) ? r.findings.internal : r.findings.hosts;
        const e = map.get(host) || { n: 0, at: [] }; e.n++; if (e.at.length < 2) e.at.push(at); map.set(host, e);
      }
      const fw = line.match(FILE_WRITE_RE); if (fw) push(r.findings.fileWrite, fw.slice(2).find(Boolean));
      if (!/(^|\/)(scripts?|tools?|hack|bin|devtools|seeds?|migrations?)\//.test(rp)) for (const re of ENV_REF_RES) for (const m of line.matchAll(re)) addEnv(r, dir, m[1], rp);   // 보조 스크립트의 환경변수는 앱 설정이 아님
      for (const [re, how] of PROD_HINT_RES) { const m = line.match(re); if (m) r.prodHints.push({ dir, value: m[1], at, how }); }
      const hm = line.match(HEALTH_RE); if (hm) r.health.push({ dir, path: hm.slice(1).find(Boolean), at });
      const xm = line.match(/<property\s+name="(?:url|jdbcUrl|jdbc-url)"\s+value="([^"]+)"/); if (xm) noteConn(r, dir, "datasource.url", xm[1], "XML 설정", rp);
      if (ext === ".prisma") { const pm = line.match(/provider\s*=\s*"(postgresql|mysql|sqlite|sqlserver|mongodb|cockroachdb)"/); if (pm) r.conns.push({ dir, kind: "DB", value: pm[1] + " (Prisma)", profile: "-", file: rp }); }
      const cm = line.match(/["'`]((?:postgres(?:ql)?|mysql|mariadb|mongodb|redis|amqp|kafka)(?:\+[a-z0-9]+)?:\/\/[^"'`\s]+)["'`]/i); if (cm && !/example|localhost:0|[%{]|placeholder|unused/.test(cm[1])) r.conns.push({ dir, kind: /redis/i.test(cm[1]) ? "Redis" : /kafka/i.test(cm[1]) ? "Kafka" : /amqp/i.test(cm[1]) ? "메시지(MQ)" : "DB", value: mask(cm[1]), profile: "코드", file: at });

      const lf = line.match(/logging\.file\.(name|path)\s*[:=]\s*(\S+)|<file>\s*([^<]+)<\/file>|fileName\s*=\s*"([^"]+)"|FileHandler\(\s*["']([^"']+)/);
      if (lf) push(r.findings.logFile, lf.slice(2).find(Boolean));
      if (/(demo|guest)[-_]?(login|user|account|id|password|pw)/i.test(line)) push(r.findings.demo, line.trim().slice(0, 60));
    });
  }, skipped => r.skipped.push(rel(root, skipped)));
  return r;
}

// Secret yml 의 data · stringData 값은 모두 가림 (키 이름만 남김)
function maskSecretDocs(text) {
  return text.split(/^(?=---)/m).map(doc => {
    if (!/^kind:\s*Secret\s*$/m.test(doc)) return doc;
    const out = []; let dataInd = -1, childInd = -1;
    for (const l of doc.split("\n")) {
      const ind = l.match(/^ */)[0].length;
      const m = l.match(/^(\s*)(data|stringData):\s*(.*)$/);
      if (m) { dataInd = ind; childInd = -1; out.push(m[3] ? `${m[1]}${m[2]}: { *** }` : l); if (m[3]) dataInd = -1; continue; }
      if (dataInd >= 0 && l.trim() && ind <= dataInd) dataInd = -1;
      if (dataInd < 0) { out.push(l); continue; }
      if (!l.trim()) continue;
      if (childInd < 0) childInd = ind;
      if (ind === childInd) out.push(l.replace(/^(\s*[^:]+:).*$/, "$1 ***"));
    }
    return out.join("\n");
  }).join("");
}
// 스크립트에서 이미지를 보내는 창고 주소 (docker push 192.168.0.10:5000/app · docker tag x ${REGISTRY}/app · skopeo copy … docker://창고/…)
function notePushTargets(r, s, rp) {
  const vars = {};
  for (const m of s.matchAll(/^\s*(?:export\s+|set\s+|\$)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?([^\s"';]+)/gm)) if (!(m[1] in vars)) vars[m[1]] = m[2];
  const sub = v => v.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}?/g, (a, k) => vars[k] && !/\$/.test(vars[k]) ? vars[k] : a);
  const IMG = /^["']?((?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?|[A-Za-z0-9-]+:\d+|localhost(?::\d+)?)\/[A-Za-z0-9._\/${}-]+)/;
  for (const line of s.split("\n")) {
    if (COMMENT_RE.test(line)) continue;
    const cands = [];
    for (const m of line.matchAll(/\b(?:docker|podman|nerdctl|buildah)\s+push\s+(?:-\S+\s+)*(\S+)/g)) cands.push(m[1]);                 // push <이미지>
    for (const m of line.matchAll(/\b(?:docker|podman|nerdctl|buildah)\s+tag\s+\S+\s+(\S+)/g)) cands.push(m[1]);                       // tag <원본> <새 이름>
    if (/\b(build|bud|buildx)\b/.test(line)) for (const m of line.matchAll(/\s(?:-t|--tag)[ =](\S+)/g)) cands.push(m[1]);           // build -t <이미지>
    for (const m of line.matchAll(/\bskopeo\s+(?:copy|sync)\b.*\s(?:docker:\/\/)?(\S+)\s*$/g)) cands.push(m[1]);                    // skopeo copy … <목적지>
    for (const c of cands) {
      const m = c.replace(/^docker:\/\//, "").match(IMG); if (!m) continue;
      let host = sub(m[1]).split("/")[0];
      if (/^\$/.test(host) && !/REG|HARBOR|NEXUS|HUB|REPO|IMAGE|ECR|GCR/i.test(host)) continue;     // 반복문 변수 등은 뺌
      if (/^(github\.com|gitlab\.com)$/.test(host)) continue;
      r.pushTo.set(host, uniq((r.pushTo.get(host) || []).concat(rp)));
    }
  }
}

// ── 쿠버 yml 점검 (저장소 안 yml 만 보고 판단 — 클러스터에 붙지 않음) ───────────
const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"]);
const podOf = d => (d.kind === "CronJob" ? d.spec?.jobTemplate?.spec?.template : d.spec?.template) || null;
const objs = a => (Array.isArray(a) ? a : []).filter(x => x && typeof x === "object");
function splitImage(img) {
  let s = String(img || ""), digest = "";
  const at = s.indexOf("@"); if (at > 0) { digest = s.slice(at + 1); s = s.slice(0, at); }
  const sl = s.indexOf("/"), first = s.slice(0, sl); let host = "";
  if (sl > 0 && (/[.:]/.test(first) || first === "localhost" || first.startsWith("$"))) { host = first; s = s.slice(sl + 1); }
  const c = s.lastIndexOf(":"); let tag = "";
  if (c > 0 && !s.slice(c).includes("/")) { tag = s.slice(c + 1); s = s.slice(0, c); }
  return { host, name: s, tag, digest };
}
// 이 폴더의 yml 을 다루는 kustomization (같은 폴더 · resources 로 가리킨 폴더)
function kustFor(r, dir) {
  return r.kusts.filter(k => {
    const res = [...(k.d.resources || []), ...(k.d.bases || []), ...(k.d.components || [])].filter(x => typeof x === "string" && !/^https?:|^git@|\?ref=/.test(x));
    return k.dir === dir || res.some(x => { const t = path.posix.normalize(path.posix.join(k.dir, x)); return (/\.ya?ml$/i.test(x) ? path.posix.dirname(t) : t) === dir; });
  });
}
function checkK8s(r) {
  const skipKinds = /^(CustomResourceDefinition|Application|ApplicationSet|AppProject|Kustomization|HelmRelease|GitRepository|Pipeline|Task|PipelineRun|TaskRun)$/;
  const docs = r.k8s.filter(x => !skipKinds.test(x.d.kind)).map(x => ({ ...x, ks: kustFor(r, x.dir) }));
  const nsOf = x => x.d.metadata?.namespace || x.ks.map(k => k.d.namespace).find(Boolean) || "";
  const nameOf = x => x.d.metadata?.name || (x.d.metadata?.generateName ? x.d.metadata.generateName + "*" : "?");
  const named = kinds => new Set(docs.filter(x => kinds.includes(x.d.kind)).map(nameOf));
  const secrets = named(["Secret", "SealedSecret", "ExternalSecret"]), cms = named(["ConfigMap"]), pvcs = named(["PersistentVolumeClaim"]);
  for (const k of r.kusts) { objs(k.d.secretGenerator).forEach(g => secrets.add(g.name)); objs(k.d.configMapGenerator).forEach(g => cms.add(g.name)); }
  const work = docs.filter(x => WORKLOAD_KINDS.has(x.d.kind) && podOf(x.d)?.spec);
  for (const w of work) objs(w.d.spec?.volumeClaimTemplates).forEach(t => pvcs.add(t.metadata?.name));
  const svcs = docs.filter(x => x.d.kind === "Service");
  const groups = new Map(), G = x => { if (!groups.has(x.dir)) groups.set(x.dir, { dir: x.dir, ks: x.ks.length > 0, ns: new Set(), lines: [], bad: [], note: [] }); const g = groups.get(x.dir); if (nsOf(x)) g.ns.add(nsOf(x)); return g; };
  const miss = { Secret: new Map(), ConfigMap: new Map(), PVC: new Map() };
  const need = (kind, set, n, who) => { if (n && !set.has(n)) miss[kind].set(n, uniq((miss[kind].get(n) || []).concat(who))); };
  const allowHost = h => !h || h.startsWith("$") || h === SITE.registry || SITE.mirrors.includes(h);
  const placeholder = t => /CHANGE|TODO|REPLACE|xxx|^\$|\$\{|\{\{|<.*>/i.test(t);
  const sameNs = (a, b) => !a || !b || a === b;
  // 같은 폴더 → 같은 kustomization 묶음 → 저장소 전체(같은 네임스페이스) 순서로 찾음 (기본본 · 배포본처럼 같은 이름이 여러 폴더에 있을 때)
  const near = (x, cands) => { const a = cands.filter(c => c.dir === x.dir); if (a.length) return a;
    const b = cands.filter(c => c.ks.some(k => x.ks.includes(k))); if (b.length) return b; return cands; };
  const portsTxt = cps => cps.map(c => c.containerPort + (c.name ? `(${c.name})` : "")).join(", ");

  for (const w of work) {
    const g = G(w), pod = podOf(w.d), ps = pod.spec, who = `${w.d.kind} ${nameOf(w)}`, ns = nsOf(w), long = !/Job/.test(w.d.kind);
    const ovs = w.ks.flatMap(k => objs(k.d.images));
    const descs = [];
    for (const c of objs(ps.containers)) {
      const cw = objs(ps.containers).length > 1 ? `${who}/${c.name}` : who;
      if (!c.image) { g.bad.push(`${cw}: 이미지 없음`); continue; }
      const im = splitImage(c.image), full = (im.host ? im.host + "/" : "") + im.name;
      const ov = ovs.filter(o => o.name === full || o.name === im.name || o.name === c.image);
      const nn = ov.find(o => o.newName), host = nn ? splitImage(nn.newName).host : im.host;
      const ovTags = uniq(ov.map(o => o.newTag != null ? String(o.newTag) : o.digest ? "digest" : "").filter(Boolean));
      const tags = ovTags.length ? ovTags : [im.digest ? "digest" : im.tag];
      const shown = (nn ? nn.newName : full) + ":" + (ovTags.length ? ovTags.join("/") + " (kustomize 가 정함)" : (im.tag || (im.digest ? "@digest" : "(태그 없음)")));
      if (tags.some(t => !t || t === "latest")) g.bad.push(`${cw}: 이미지 태그가 ${tags.includes("latest") ? "latest" : "없음(=latest)"} — 무엇이 떠 있는지 모르고 되돌리기 어려움 (저장 번호 같은 고정 태그로)`);
      else if (tags.some(placeholder)) g.note.push(`${cw}: 이미지 태그 ${tags.join("/")} — 배포할 때 채우는 자리`);
      if (SITE.registry && !allowHost(host)) g.bad.push(`${cw}: 이미지 주소 ${host} — 운영 창고(${SITE.registry})나 미러(${SITE.mirrors.join(", ")})로 오지 않아 폐쇄망에서 못 받음`);
      else if (!host && SITE.registry && !im.name.includes("/")) g.note.push(`${cw}: 창고 주소 없는 이미지 ${c.image} → 미러를 거쳐 창고의 library/${im.name} 을 찾음 (창고에 그 이름으로 넣어야 받힘)`);
      if (c.imagePullPolicy === "Never") g.note.push(`${cw}: imagePullPolicy Never — 서버마다 이미지를 직접 넣어 둔 것만 씀 (ctr import 방식, 서버가 바뀌면 못 뜸)`);
      const cps = objs(c.ports);
      const probeTxt = pr => !pr ? null : pr.httpGet ? `GET ${pr.httpGet.path || "/"}:${pr.httpGet.port}` : pr.tcpSocket ? `TCP ${pr.tcpSocket.port}` : pr.grpc ? `gRPC ${pr.grpc.port}` : pr.exec ? "명령 실행" : "?";
      for (const [pn, pr] of [["준비 확인", c.readinessProbe], ["살아 있음 확인", c.livenessProbe], ["시작 확인", c.startupProbe]]) {
        const pp = pr?.httpGet?.port ?? pr?.tcpSocket?.port; if (pp == null || !cps.length) continue;
        const okp = /^\d+$/.test(String(pp)) ? cps.some(x => +x.containerPort === +pp) : cps.some(x => x.name === pp);
        if (!okp) g.bad.push(`${cw}: ${pn} 포트 ${pp} 가 컨테이너 포트(${portsTxt(cps)})에 없음 — 확인이 계속 실패해 재시작 · 연결 안 됨`);
      }
      if (long && !c.readinessProbe) g.note.push(`${cw}: 준비 확인(readinessProbe) 없음 — 앱이 뜨는 중에도 요청이 들어가 오류가 남`);
      const res = c.resources || {};
      if (!res.requests && !res.limits) g.note.push(`${cw}: 자원 요청 · 한도(resources) 없음 — 한 서버에 몰리거나 메모리를 다 쓸 수 있음`);
      for (const e of objs(c.env)) {
        if (e.valueFrom) { need("Secret", secrets, e.valueFrom.secretKeyRef?.name, cw); need("ConfigMap", cms, e.valueFrom.configMapKeyRef?.name, cw); continue; }
        const v = e.value == null ? "" : String(e.value);
        if (isSecretName(e.name || "") && v && !/^\$\(|^\$\{/.test(v) && !/^(local|none|null|dummy|empty|changeme|change-me|x+|-|not-?needed|no-?key|placeholder|unused)$/i.test(v)) g.bad.push(`${cw}: 비밀값이 yml 에 그대로 — ${e.name} (Secret 으로 옮기기)`);
        else if (LOCAL_RE.test(v)) g.bad.push(`${cw}: ${e.name} 가 localhost — 쿠버에선 자기 파드 자신 (서비스 주소로)`);
        else if (PRIVATE_IP.test(v)) g.note.push(`${cw}: ${e.name} 에 사설 IP ${v.match(PRIVATE_IP)[1]} — 쿠버 안 서비스 주소로 바꿀지 확인`);
        else for (const h of FORBIDDEN_HOSTS) if (h && v.includes(h)) g.bad.push(`${cw}: ${e.name} 에 개발 서버 주소 ${h}`);
      }
      for (const ef of objs(c.envFrom)) { need("Secret", secrets, ef.secretRef?.name, cw); need("ConfigMap", cms, ef.configMapRef?.name, cw); }
      if (c.securityContext?.privileged) g.note.push(`${cw}: privileged — 서버 권한을 통째로 가짐`);
      const rp = probeTxt(c.readinessProbe), lim = res.limits ? `한도 ${[res.limits.cpu && "CPU " + res.limits.cpu, res.limits.memory && "메모리 " + res.limits.memory].filter(Boolean).join(" ")}` : res.requests ? "요청만" : "자원 지정 없음";
      descs.push(`이미지 ${shown} · 포트 ${portsTxt(cps) || "선언 없음"} · 준비 확인 ${rp || "없음"} · ${lim}`);
    }
    for (const v of objs(ps.volumes)) {
      if (v.hostPath) g.bad.push(`${who}: hostPath ${v.hostPath.path} — 서버 폴더를 직접 씀 (파드가 다른 서버로 가면 데이터가 없음 → PVC 로)`);
      if (v.nfs) g.note.push(`${who}: NFS 직접 연결 ${v.nfs.server}:${v.nfs.path} — 가능은 하나 보통 PVC 로`);
      need("PVC", pvcs, v.persistentVolumeClaim?.claimName, who); need("Secret", secrets, v.secret?.secretName, who); need("ConfigMap", cms, v.configMap?.name, who);
    }
    const sel = ps.nodeSelector || {}, aff = JSON.stringify(ps.affinity || {});
    const where = Object.entries(sel).map(([k, v]) => `${k}=${v}`).concat(aff.includes("nodeAffinity") ? ["nodeAffinity"] : []).join(", ");
    if (SITE.roleLabel && w.d.kind !== "DaemonSet" && !(SITE.roleLabel in sel) && !aff.includes(SITE.roleLabel))
      g.note.push(`${who}: 서버 지정(nodeSelector ${SITE.roleLabel}) 없음 — 아무 서버에나 뜸`);
    if (!ns) g.note.push(`${who}: 네임스페이스 지정 없음 — 올리는 사람이 고른 곳(보통 default)에 올라감`);
    const tol = objs(ps.tolerations).map(t => `${t.key || "*"}${t.value ? "=" + t.value : ""}`).join(", ");
    g.lines.push(`${who}${w.d.spec?.replicas != null ? " ×" + w.d.spec.replicas : ""}${ns ? " [" + ns + "]" : ""} — ${descs.join(" + ") || "컨테이너 없음"}` +
      `${where ? " · 서버 " + where : ""}${tol ? " · 허용 taint " + tol : ""}`);
  }
  const backend = (g, who, ns, sn, sp, from) => {
    const sv = near(from, svcs.filter(x => nameOf(x) === sn && sameNs(nsOf(x), ns)))[0];
    if (!sv) {
      if (work.some(w => nsOf(w) && nsOf(w) === ns)) g.bad.push(`${who}: Service ${sn} 가 저장소 yml 에 없음`);
      else g.note.push(`${who}: Service ${sn} 는 저장소 밖(헬름 · 따로 설치)에서 만드는 것으로 보임 — 클러스터에 있는지 확인`);
      return;
    }
    const ps = objs(sv.d.spec?.ports);
    if (sp != null && sp !== "" && !ps.some(p => +p.port === +sp || p.name === sp)) g.bad.push(`${who}: Service ${sn} 에 포트 ${sp} 없음 (있는 포트: ${ps.map(p => p.port + (p.name ? `(${p.name})` : "")).join(", ")})`);
  };
  for (const sv of svcs) {
    const g = G(sv), sel = sv.d.spec?.selector || {}, ns = nsOf(sv), who = `Service ${nameOf(sv)}`, type = sv.d.spec?.type || "ClusterIP";
    const ps = objs(sv.d.spec?.ports);
    if (!Object.keys(sel).length) { g.lines.push(`${who} — selector 없음 (밖의 주소를 직접 연결하는 용도)`); continue; }
    const tg = near(sv, work.filter(w => sameNs(nsOf(w), ns) && Object.entries(sel).every(([k, v]) => String(podOf(w.d)?.metadata?.labels?.[k]) === String(v))));
    if (!tg.length) (work.length ? g.bad : g.note).push(`${who}: 가리키는 파드가 저장소 yml 에 없음 (selector ${Object.entries(sel).map(([k, v]) => k + "=" + v).join(",")})`);
    for (const p of ps) {
      const tp = p.targetPort ?? p.port;
      for (const w of tg) {
        const cps = objs(podOf(w.d).spec.containers).flatMap(c => objs(c.ports));
        if (!cps.length) { g.note.push(`${w.d.kind} ${nameOf(w)}: 컨테이너 포트 선언 없음 — ${who} 가 ${tp} 로 보냄 (앱이 그 포트에서 듣는지 확인)`); continue; }
        const okp = /^\d+$/.test(String(tp)) ? cps.some(c => +c.containerPort === +tp) : cps.some(c => c.name === tp);
        if (!okp) g.bad.push(`포트 안 맞음: ${who} 가 ${tp} 로 보내는데 ${w.d.kind} ${nameOf(w)} 의 컨테이너 포트는 ${portsTxt(cps)}`);
      }
    }
    if (type === "NodePort" || type === "LoadBalancer") g.note.push(`${who}: ${type} — 입구(Ingress)를 거치지 않고 밖으로 바로 열림${ps.some(p => p.nodePort) ? " (서버 포트 " + ps.map(p => p.nodePort).filter(Boolean).join(",") + ")" : ""}`);
    g.lines.push(`${who}${type !== "ClusterIP" ? " (" + type + ")" : ""} ${ps.map(p => `${p.port}→${p.targetPort ?? p.port}`).join(", ")} → ${uniq(tg.map(w => w.d.kind + " " + nameOf(w))).join(", ") || "?"}`);
  }
  const hostOk = h => !SITE.domain || !h || h === SITE.domain || h.endsWith("." + SITE.domain);
  for (const ig of docs.filter(x => x.d.kind === "Ingress")) {
    const g = G(ig), ns = nsOf(ig), spec = ig.d.spec || {}, who = `Ingress ${nameOf(ig)}`, routes = [];
    if (/^extensions\/|networking\.k8s\.io\/v1beta1/.test(ig.d.apiVersion)) g.bad.push(`${who}: 옛 형식 ${ig.d.apiVersion} — 쿠버 1.22 부터 안 받음 (networking.k8s.io/v1 로)`);
    const cls = spec.ingressClassName || ig.d.metadata?.annotations?.["kubernetes.io/ingress.class"];
    if (SITE.ingressClass && cls && cls !== SITE.ingressClass) g.bad.push(`${who}: 입구 종류 ${cls} — 운영은 ${SITE.ingressClass}`);
    if (!cls) g.note.push(`${who}: ingressClassName 없음 — 기본 입구가 정해져 있어야 받힘${SITE.ingressClass ? " (운영: " + SITE.ingressClass + ")" : ""}`);
    for (const rule of objs(spec.rules)) {
      if (!hostOk(rule.host)) g.bad.push(`${who}: 도메인 ${rule.host} — 운영 도메인 ${SITE.domain} 과 다름`);
      for (const pt of objs(rule.http?.paths)) {
        const be = pt.backend || {}, sn = be.service?.name || be.serviceName, sp = be.service?.port?.number ?? be.service?.port?.name ?? be.servicePort;
        routes.push(`${rule.host || "*"}${pt.path || "/"} → ${sn}:${sp}`); if (sn) backend(g, who, ns, sn, sp, ig);
      }
    }
    for (const t of objs(spec.tls)) need("Secret", secrets, t.secretName, who + " (인증서)");
    g.lines.push(`${who}${cls ? " (" + cls + ")" : ""} ${routes.join(" · ") || "경로 없음"}`);
  }
  for (const ir of docs.filter(x => x.d.kind === "IngressRoute" && /traefik/.test(x.d.apiVersion))) {
    const g = G(ir), ns = nsOf(ir), who = `IngressRoute ${nameOf(ir)}`, routes = [];
    for (const rt of objs(ir.d.spec?.routes)) {
      for (const h of String(rt.match || "").matchAll(/Host\(\s*`([^`]+)`/g)) if (!hostOk(h[1])) g.bad.push(`${who}: 도메인 ${h[1]} — 운영 도메인 ${SITE.domain} 과 다름`);
      for (const sv of objs(rt.services)) { if (sv.kind && sv.kind !== "Service") continue; routes.push(`${rt.match} → ${sv.name}:${sv.port}`); backend(g, who, sv.namespace || ns, sv.name, sv.port, ir); }
    }
    if (ir.d.spec?.tls?.secretName) need("Secret", secrets, ir.d.spec.tls.secretName, who + " (인증서)");
    g.lines.push(`${who} (Traefik) ${routes.join(" · ") || "경로 없음"}`);
  }
  for (const pv of docs.filter(x => x.d.kind === "PersistentVolumeClaim")) {
    const g = G(pv); g.lines.push(`PVC ${nameOf(pv)} ${pv.d.spec?.resources?.requests?.storage || "?"} · 저장소 종류(StorageClass) ${pv.d.spec?.storageClassName || "기본값"}`);
  }
  const nBad = [...groups.values()].reduce((a, g) => a + uniq(g.bad).length, 0), nNote = [...groups.values()].reduce((a, g) => a + uniq(g.note).length, 0);
  return { groups: [...groups.values()].filter(g => g.lines.length || g.bad.length), miss, nBad, nNote, nWork: work.length };
}
// 자동 배포(GitOps) 설정 — ArgoCD · Flux · Tekton
const CI_SERVER_RE = /\b(teamcity|jenkins|gitlab|gitea|drone|woodpecker|harbor|nexus|sonarqube|argocd|argo-cd|tekton|concourse|bamboo|gocd|spinnaker|svnserve|subversion)\b/i;
const CI_SERVER_NAME = { teamcity: "TeamCity", jenkins: "Jenkins", gitlab: "GitLab", gitea: "Gitea", drone: "Drone", woodpecker: "Woodpecker", harbor: "Harbor(이미지 창고)",
  nexus: "Nexus(저장 창고)", sonarqube: "SonarQube", argocd: "ArgoCD", "argo-cd": "ArgoCD", tekton: "Tekton", concourse: "Concourse", bamboo: "Bamboo", gocd: "GoCD", spinnaker: "Spinnaker",
  svnserve: "SVN 서버", subversion: "SVN 서버" };
// 빌드 · 배포 서버를 띄우는 설정 — compose 서비스 · 쿠버 yml 의 이름 · 이미지 · ArgoCD 가 까는 헬름 차트
function ciServersOf(r) {
  const found = new Map(), add = (word, where) => { const n = CI_SERVER_NAME[word.toLowerCase()] || word; found.set(n, uniq((found.get(n) || []).concat(where))); };
  for (const c of r.composes) for (const sv of c.services) { const m = `${sv.name} ${sv.image || ""}`.match(CI_SERVER_RE); if (m) add(m[1], c.file); }
  for (const { d, file } of r.k8s) {
    const pod = podOf(d), imgs = objs(pod?.spec?.containers).map(c => c.image).join(" ");
    const hosts = objs(d.spec?.rules).map(x => x.host || "").join(" "), backs = JSON.stringify(d.spec?.rules || d.spec?.routes || "");
    const charts = objs(d.spec?.sources || [d.spec?.source]).map(x => x.chart || x.path || "").join(" ");
    const m = `${d.metadata?.name || ""} ${imgs} ${hosts} ${d.kind === "Ingress" || d.kind === "IngressRoute" ? backs : ""} ${d.kind === "Application" ? charts : ""}`.match(CI_SERVER_RE);
    if (m) add(m[1], `${file} (${d.kind} ${d.metadata?.name || ""})`);
  }
  return found;
}
function gitopsOf(r) {
  const out = [];
  for (const { d, file } of r.k8s) {
    const av = d.apiVersion || "", nm = d.metadata?.name || "?";
    if (/argoproj\.io/.test(av) && d.kind === "Application") {
      const srcs = objs(d.spec?.sources || [d.spec?.source]);
      out.push(`ArgoCD Application ${nm}: ${srcs.map(x => `${mask(String(x.repoURL || "?"))} ${x.path || x.chart || ""}@${x.targetRevision || "HEAD"}`).join(" + ")}${d.spec?.destination?.namespace ? " → 네임스페이스 " + d.spec.destination.namespace : ""}` +
        ` · ${d.spec?.syncPolicy?.automated ? "자동 동기화" : "손으로 동기화"} (${file})`);
    } else if (/argoproj\.io/.test(av) && d.kind === "ApplicationSet") out.push(`ArgoCD ApplicationSet ${nm} (${file})`);
    else if (/fluxcd\.io/.test(av) && /^(Kustomization|HelmRelease|GitRepository)$/.test(d.kind)) out.push(`Flux ${d.kind} ${nm} (${file})`);
    else if (/tekton\.dev/.test(av) && /^(Pipeline|Task)$/.test(d.kind)) out.push(`Tekton ${d.kind} ${nm} (${file})`);
  }
  return out;
}

// ── 프로젝트 판정 · 포트 ─────────────────────────────────────────────
function shapeOf(p) {
  if (p.kind === "npm") {
    const server = p.fw.some(f => ["express", "@nestjs/core", "fastify", "koa", "next", "nuxt", "socket.io"].includes(f)) || /\bnode\s+\S+\.(c|m)?js\b/.test(p.scripts.start || "");
    const front = p.fw.includes("vite") || /\b(vite\s+build|react-scripts\s+build|vue-cli-service\s+build|ng\s+build|webpack|parcel\s+build)\b/.test(p.scripts.build || "");
    const mono = p.workspaces || /\b(turbo|lerna|nx)\b/.test(p.scripts.build || "");
    if (p.fw.some(f => ["expo", "react-native"].includes(f))) return "모바일 앱 (쿠버 대상 아님)";
    if (p.fw.includes("electron")) return "데스크톱 앱 (쿠버 대상 아님)";
    return server ? "Node 서버" : front ? "정적 화면 (빌드 결과를 nginx 로)" : mono ? "여러 프로젝트 묶음의 최상위" : "라이브러리 · 도구";
  }
  if (p.kind === "파이썬" && p.sibling) return "보조 파이썬 (같은 폴더의 다른 프로젝트가 씀)";
  if (p.kind === "파이썬" && p.workspace) return "여러 프로젝트 묶음의 최상위";
  if (p.kind === "파이썬") {
    if (p.fw.some(f => ["fastapi", "flask", "django", "uvicorn", "gunicorn", "streamlit", "gradio"].includes(f))) return "파이썬 웹 서버";
    if (p.fw.some(f => ["celery", "kafka", "confluent-kafka"].includes(f))) return "파이썬 작업 처리기 (배치 · 메시지)";
    return "파이썬 (실행 형태 확인 필요)";
  }
  if (p.packaging === "war") return "war → WAS(톰캣 · JBoss 등)에 올리는 방식";
  if (p.packaging === "pom") return `상위 묶음 (모듈 ${p.modules}개)`;
  return p.bootPlugin ? "스프링부트 실행 jar" : "jar (실행 방식 확인 필요)";
}
const isRunnable = p => !/라이브러리|묶음|상위|보조/.test(shapeOf(p));
// 파일이 속한 프로젝트 = 그 파일 폴더를 감싸는 프로젝트 중 가장 깊은 것
function ownerDir(r, d) {
  let best = null, bestLen = -1;
  for (const p of r.projects) {
    const match = p.dir === "." || d === p.dir || d.startsWith(p.dir + "/");
    const len = p.dir === "." ? 0 : p.dir.length;
    if (match && len > bestLen) { best = p.dir; bestLen = len; }
  }
  return best;
}
function portsOf(r, p) {
  const out = [], run = [];
  const inDir = d => ownerDir(r, d) === p.dir;
  const devProf = x => /^(dev|devel|development|local|test|it)$/i.test(x || "");
  const sp = r.springPorts.filter(x => inDir(x.dir));
  if (p.kind.startsWith("메이븐") || p.kind === "그레이들") {
    if (sp.length) { out.push("설정 " + uniq(sp.map(x => x.port + (x.profile && x.profile !== "기본" ? `(${x.profile})` : ""))).join(" · ")); run.push(...sp.filter(x => !devProf(x.profile)).map(x => x.port)); }
    else if (p.bootPlugin && p.packaging !== "pom") { out.push("설정 없음 → 8080 (스프링 기본값)"); run.push("8080"); }
    else if (p.packaging === "war") out.push("WAS 설정에 따름 (톰캣 기본 8080)");
  }
  if (p.kind === "파이썬" && shapeOf(p) === "파이썬 웹 서버") {
    const cmds = r.dockerfiles.filter(d => inDir(d.dir)).map(d => d.cmd).join(" ") + " " + r.composes.flatMap(c => c.services.map(s => s.cmd || "")).join(" ");
    const has = re => re.test(cmds) || p.fw.some(f => re.test(f));
    if (!r.codePorts.some(x => inDir(x.dir))) {
      if (has(/fastapi|uvicorn|gunicorn|hypercorn/)) out.push("기본값 8000 (fastapi · uvicorn)");
      else if (has(/flask/)) out.push("기본값 5000 (flask)");
      else if (has(/django/)) out.push("기본값 8000 (django)");
      else if (has(/streamlit/)) out.push("기본값 8501 (streamlit)");
    }
  }
  const cps = uniq(r.codePorts.filter(x => inDir(x.dir)).map(x => x.port));
  if (cps.length && !(p.kind.startsWith("메이븐") || p.kind === "그레이들")) { out.push("코드 " + cps.slice(0, 4).join("/")); run.push(...cps); }
  if (p.kind === "npm") {
    const st = p.scripts.start || "";
    const m = st.match(/(?:-p|--port)[ =](\d+)/) || st.match(/PORT=(\d+)/);
    if (m) { out.push("start " + m[1]); run.push(m[1]); }
    else if (p.fw.includes("next")) { out.push("next 기본 3000"); if (!cps.length) run.push("3000"); }
    const vc = r.configs.find(c => inDir(c.dir) && c.items.some(([k]) => k === "개발 서버 포트"));
    if (vc && shapeOf(p).startsWith("정적")) out.push("개발 서버 " + vc.items.find(([k]) => k === "개발 서버 포트")[1] + " (운영엔 nginx)");
  }
  const df = r.dockerfiles.filter(d => inDir(d.dir) && d.expose.length);
  if (df.length) { out.push("Dockerfile EXPOSE " + uniq(df.flatMap(d => d.expose)).join("/")); run.push(...df.flatMap(d => d.expose).map(e => e.replace(/\/.*$/, ""))); }
  if (!out.length && shapeOf(p).startsWith("정적")) return "nginx 가 정함 (화면)";
  if (uniq(run.filter(x => /^\d+$/.test(x))).length > 1) out.push("⚠ 서로 다름 — 확인 필요");
  return out.join(" · ") || "-";
}

// 쿠버 yml 을 쓸 때 필요한 재료 — 프로필 · 연결 대상(DB 등) · 환경변수(ConfigMap / Secret) · 헬스체크
function materials(r, p) {
  const own = x => ownerDir(r, x.dir) === p.dir, out = [];
  const profs = uniq(r.profiles.filter(x => own(x) && !x.envFile).map(x => x.profile));
  const envFiles = uniq(r.profiles.filter(x => own(x) && x.envFile).map(x => x.profile));
  const hints = uniq(r.prodHints.filter(own).map(h => `${h.value} (${h.how} · ${String(h.at).split(":")[0]})`));
  if (profs.length || hints.length || envFiles.length)
    out.push(`프로필: ${profs.join(", ") || "-"}${envFiles.length ? " · .env 파일: " + envFiles.join(", ") : ""} · 실제로 켜는 것: ${hints.slice(0, 3).join(" / ") || "근거 못 찾음 (기본 프로필로 도는 것으로 보임)"}`);
  const cs = r.conns.filter(own);
  for (const kind of uniq(cs.map(c => c.kind))) {
    const vals = cs.filter(c => c.kind === kind);
    const t = kind === "DB" ? uniq(vals.map(c => dbKind(c.value)).filter(Boolean)).join(" · ") : "";
    const show = uniq(vals.map(c => c.value + (c.profile && !["-", "기본"].includes(c.profile) ? ` [${c.profile}]` : ""))).slice(0, 4);
    out.push(`${kind}${t ? " (" + t + ")" : ""}: ${show.join("  |  ")}${vals.length > 4 ? "  | …" : ""}`);
  }
  const envs = [...r.envVars.values()].filter(own).map(e => e.name);
  const build = uniq(envs.filter(n => /^(VITE_|NEXT_PUBLIC_|REACT_APP_)/.test(n)));
  const sec = uniq(envs.filter(n => isSecretName(n) && !build.includes(n)));
  const cfg = uniq(envs.filter(n => !isSecretName(n) && !build.includes(n)));
  const cut = (a, n) => a.slice(0, n).join(", ") + (a.length > n ? ` 외 ${a.length - n}개` : "");
  if (cfg.length) out.push(`환경변수 → ConfigMap: ${cut(cfg, 18)}`);
  if (sec.length) out.push(`환경변수 → Secret (이름만, 값은 안 담음): ${cut(sec, 18)}`);
  if (build.length) out.push(`빌드 때 들어가는 값 (이미지 만들 때 정해야 함): ${cut(build, 10)}`);
  const hs = uniq(r.health.filter(own).map(h => h.path));
  if ((p.deps || []).includes("actuator")) hs.unshift("/actuator/health (스프링 actuator)");
  out.push(`헬스체크 후보: ${hs.slice(0, 4).join(", ") || "못 찾음 → 기본 경로(/) 나 포트 연결로 확인"}`);
  return out;
}

// 파이썬이 다른 실행 프로젝트(npm · 자바)와 같은 폴더에 있으면 보조로 본다
function markSiblings(r) {
  // 같은 폴더에 메이븐 · 그레이들이 둘 다 있으면 하나로
  for (const g of r.projects.filter(x => x.kind === "그레이들")) {
    const m = r.projects.find(x => x.kind === "메이븐" && x.dir === g.dir);
    if (m) { m.kind = "메이븐 (그레이들도 있음)"; m.java = m.java || g.java; m.boot = m.boot || g.boot; g.dup = true; }
  }
  r.projects = r.projects.filter(x => !x.dup);
  // 자바 버전을 못 풀었으면 같은 프로젝트 Dockerfile 베이스 이미지에서 (temurin-17 · jdk17 · jre21 · openjdk:11 …)
  for (const p of r.projects) if ((p.kind.startsWith("메이븐") || p.kind === "그레이들") && (!p.java || /\$\{/.test(p.java))) {
    const img = r.dockerfiles.filter(d => ownerDir(r, d.dir) === p.dir).flatMap(d => d.from).join(" ");
    const m = img.match(/(?:temurin|jdk|jre|openjdk|java|corretto|zulu)[^0-9]{0,3}(\d{1,2})\b/i);
    p.java = m ? m[1] + " (Dockerfile 베이스 이미지 기준)" : (p.java ? "부모 설정에 있음 " + p.java : null);
  }
  for (const p of r.projects) if (p.kind === "파이썬" && !p.fw.some(f => ["fastapi", "flask", "django", "uvicorn", "gunicorn"].includes(f)))
    p.sibling = r.projects.some(o => o !== p && o.dir === p.dir && o.kind !== "파이썬");
}

// ── 보고서 쓰기 ─────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const outFile = path.resolve(`source-scan-${os.hostname().replace(/[^A-Za-z0-9_-]/g, "_")}-${stamp}.txt`);
const L = [];
const say = s => L.push(s);
const list = (arr, n = 6) => {
  const by = new Map(); for (const [v, at] of arr) { const e = by.get(v) || []; e.push(at); by.set(v, e); }
  return [...by.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, n).map(([v, ats]) => `${v} (${ats.length}곳, 예: ${uniq(ats).slice(0, 2).join(", ")})`);
};
const countMap = m => [...m.values()].reduce((a, e) => a + e.n, 0);
// "누구: 지적" 을 지적별로 묶음 → "지적 — 누구, 누구, …"
function groupMsgs(arr) {
  const by = new Map();
  for (const x of uniq(arr)) { const i = x.indexOf(": "), who = i > 0 ? x.slice(0, i) : "", msg = i > 0 ? x.slice(i + 2) : x; by.set(msg, (by.get(msg) || []).concat(who)); }
  return [...by.entries()].map(([msg, whos]) => whos.length === 1 ? (whos[0] ? `${whos[0]}: ${msg}` : msg) : `${msg} — ${whos.slice(0, 6).join(", ")}${whos.length > 6 ? ` 외 ${whos.length - 6}개` : ""}`);
}
const GROUPS = ["이미지", "쿠버", "서버로 복사", "서버에서 실행", "저장소"];
const wordsIn = (r, g) => DEPLOY_WORDS.filter(([w, , gg]) => gg === g && r.deployWords.has(w)).map(([w]) => w);
const toolsOf = r => uniq([...r.ci.keys(), ...r.gitops.map(x => x.split(" ")[0]), ...r.ciServers.keys()]);
const regNote = h => !SITE.registry ? "" : h === SITE.registry ? " (운영 창고)" : SITE.mirrors.includes(h) ? " (미러로 운영 창고에 감)" : /^\$/.test(h) ? "" : " (운영 창고 아님)";

console.log("소스 저장소 수집 — 읽기만 합니다 (소스를 바꾸지 않음) · 비밀번호처럼 보이는 값은 *** 로 가립니다");
const repos = [...new Set(args.flatMap(a => findRepos(path.resolve(a))))];
if (!repos.length) { console.log("저장소를 찾지 못했습니다. 소스를 받아 둔 폴더를 주세요. 예) node scan-source.mjs D:\\work"); process.exit(1); }
console.log(`저장소 ${repos.length}개를 찾았습니다.`);
const results = repos.map((root, i) => { process.stdout.write(`  [${i + 1}/${repos.length}] ${path.basename(root)} ... `); const r = scanRepo(root); markSiblings(r); r.kc = checkK8s(r); r.gitops = gitopsOf(r); r.ciServers = ciServersOf(r); console.log(`파일 ${r.files}개`); return r; });

say(`소스 저장소 수집 결과 — ${new Date().toLocaleString("ko-KR")} · PC ${os.hostname()} · ${os.platform()} · Node ${process.version}`);
say(`읽기만 했고, 소스 코드는 가져오지 않았습니다. 비밀번호 · 토큰 · 키처럼 보이는 값은 *** 로 가렸고, .env 파일은 키 이름만 적었습니다.`);
say(`이 PC 의 도구: git ${sh("git", ["--version"]) ? "있음" : "없음"} · svn ${sh("svn", ["--version", "--quiet"]) || "없음"} · java ${((spawnSync("java", ["-version"], { encoding: "utf8", shell: process.platform === "win32" }).stderr || "").split("\n")[0].match(/version "[^"]+"/) || ["없음"])[0]} · mvn ${sh("mvn", ["-v"])?.split("\n")[0]?.replace(/\s*\(.*$/, "") || "없음"} · docker ${sh("docker", ["--version"])?.replace(/, build.*$/, "") || "없음"}`);

// 한눈에 보기
say(""); say("════════ 한눈에 보기 ════════");
say("저장소 · 실행되는 프로젝트(형태 · 포트) · 지금 배포 방법 · 배포 도구 · 쿠버 yml 상태 · 쿠버로 옮길 때 확인할 곳 개수");
results.forEach((r, i) => {
  const run = r.projects.filter(isRunnable);
  const how = [r.dockerfiles.length ? "Dockerfile " + r.dockerfiles.length : "", r.composes.length ? "compose " + r.composes.length : "",
    ...GROUPS.map(g => wordsIn(r, g).length ? `[${g}] ${wordsIn(r, g).join(" · ")}` : ""),
    r.pushTo.size ? "→ 창고 " + [...r.pushTo.keys()].map(h => h + regNote(h)).join(", ") : ""].filter(Boolean).join(" · ") || "배포 파일 못 찾음";
  const f = r.findings;
  const issues = [f.privateIp.length && `사설 IP ${uniq(f.privateIp.map(x => x[0])).length}`, f.local.length && `localhost ${f.local.length}`,
    f.internal.size && `사내 도메인 ${f.internal.size}`, f.hosts.size && `인터넷 주소 ${f.hosts.size}`, f.forbidden.length && `개발 서버 ${f.forbidden.length}`,
    f.fileWrite.length && `파일 쓰기 ${f.fileWrite.length}`, f.logFile.length && `로그 파일 ${f.logFile.length}`].filter(Boolean).join(" · ") || "없음";
  say(`${i + 1}. ${r.name}  — ${/^SVN/.test(r.vcs[0]) ? "SVN" : /^Git/.test(r.vcs[0]) ? "Git" : "저장소 정보 없음"}`);
  if (!run.length) say(`   실행 프로젝트: 없음 (${r.projects.length ? "라이브러리 · 묶음만" : "빌드 파일 없음"})`);
  run.slice(0, 8).forEach(p => {
    const cs = r.conns.filter(c => ownerDir(r, c.dir) === p.dir);
    const dbs = uniq(cs.filter(c => c.kind === "DB").map(c => dbKind(c.value)).filter(Boolean));
    const conn = uniq(cs.map(c => c.kind === "DB" ? "DB " + (dbs.join("/") || "?") : c.kind)).join(" · ");
    say(`   - ${p.dir === "." ? "(최상위)" : p.dir}: ${shapeOf(p)} · 포트 ${portsOf(r, p)}${conn ? " · 연결 " + conn : ""}`);
  });
  if (run.length > 8) say(`   - … 외 ${run.length - 8}개`);
  say(`   지금 배포: ${how}`);
  say(`   배포 도구: ${toolsOf(r).join(" · ") || "없음 (자동 빌드 · GitOps 설정 못 찾음)"}`);
  say(`   쿠버 yml: ${r.kc.nWork ? `워크로드 ${r.kc.nWork}개 · 문제 ${r.kc.nBad} · 참고 ${r.kc.nNote}` : r.helmTpl.size ? "헬름 틀만 있음 (값을 채워야 읽힘)" : "없음 → 아래 '쿠버 yml 재료'로 새로 만들어야 함"}`);
  say(`   확인할 곳: ${issues}`);
});

results.forEach((r, i) => {
  say(""); say(`━━━━ [${i + 1}] ${r.name} ━━━━`);
  say(`  위치     : ${r.root}`);
  r.vcs.forEach(v => say(`  저장소   : ${v}`));
  say(`  파일     : ${r.files}개 (node_modules · target · dist · 업로드 폴더 등 제외)`);
  if (r.skipped.length) say(`  건너뛴 폴더(문서 · 시험 · 실험): ${r.skipped.slice(0, 12).join(", ")}${r.skipped.length > 12 ? ` 외 ${r.skipped.length - 12}개` : ""}`);
  say(`  프로젝트 :`);
  if (!r.projects.length) say(`    (빌드 파일 없음)`);
  if (r.projects.length > 40) say(`    (프로젝트가 ${r.projects.length}개라 앞 40개만 적음)`);
  for (const p of r.projects.slice(0, 40)) {
    if (p.kind === "npm") {
      say(`    - ${p.dir}/  npm · ${p.name || "-"} · ${p.fw.join(", ") || "프레임워크 못 찾음"}${p.node ? " · node " + p.node : ""} → ${shapeOf(p)}`);
      say(`        build=${p.scripts.build || "없음"}${p.scripts.start ? " · start=" + p.scripts.start : ""} · 포트 ${portsOf(r, p)}`);
    } else if (p.kind === "파이썬") {
      say(`    - ${p.dir}/  파이썬 · ${p.name || "-"}${p.py ? " · 파이썬 " + p.py : ""} · ${p.fw.join(", ") || "주요 패키지 못 찾음"} → ${shapeOf(p)}`);
      say(`        파일: ${p.files.join(", ")} · 포트 ${portsOf(r, p)}`);
    } else {
      say(`    - ${p.dir}/  ${p.kind} · ${p.name || "-"} · 스프링부트 ${p.boot || "-"} · 자바 ${p.java || "-"}${p.egov ? " · 전자정부 프레임워크" : ""} → ${shapeOf(p)}${p.finalName ? " · 결과 파일 이름 " + p.finalName : ""}`);
      say(`        포트 ${portsOf(r, p)}${p.deps.length ? " · 주요 의존: " + p.deps.join(", ") : ""}`);
    }
    if (isRunnable(p)) { say(`        ▸ 쿠버 yml 재료`); materials(r, p).forEach(l => say(`            ${l}`)); }
  }
  if (r.configs.length) {
    say(`  설정 파일 (포트 · 경로 · 주소만):`);
    for (const c of r.configs.slice(0, 20)) {
      if (!c.items.length) continue;
      say(`    - ${c.file}`);
      for (const [k, v] of c.items.slice(0, 15)) say(`        ${k} = ${v}`);
    }
  }
  if (r.envFiles.length) { say(`  .env 파일 (키 이름만):`); r.envFiles.forEach(e => say(`    - ${e.file}: ${e.keys.join(", ") || "(키 없음)"}`)); }

  say(`  지금 배포 방법:`);
  if (r.dockerfiles.length) {
    say(`    Dockerfile ${r.dockerfiles.length}개`);
    r.dockerfiles.slice(0, 10).forEach(d => say(`      - ${d.file}: 베이스 ${d.from.join(" → ") || "?"} · 포트 ${d.expose.join("/") || "없음"} · ` +
      `${d.user && !/^(root|0)(:|$)/.test(d.user) ? "사용자 " + d.user : "root 로 실행"}${d.health ? " · 헬스체크 있음" : ""}${d.volume.length ? " · VOLUME " + d.volume.join(" ") : ""}` +
      `${d.cmd ? " · 실행 " + mask(d.cmd).slice(0, 90) : ""}`));
  } else say(`    Dockerfile: 없음`);
  if (r.composes.length) {
    r.composes.forEach(c => {
      say(`    docker-compose ${c.file} — 서비스 ${c.services.length}개`);
      c.services.slice(0, 15).forEach(s => {
        const host = s.volumes.filter(v => /^(\.|\/|~|[A-Za-z]:\\|\$\{)/.test(v));
        say(`      - ${s.name}: ${s.image ? "이미지 " + s.image : s.build ? "직접 빌드(" + s.build + ")" : "?"}${s.ports.length ? " · 포트 " + s.ports.join(", ") : ""}` +
          `${host.length ? " · 서버 폴더 연결 " + host.slice(0, 3).join(", ") + (host.length > 3 ? " 외" : "") : ""}${s.volumes.length - host.length > 0 ? " · 이름 붙인 볼륨 " + (s.volumes.length - host.length) : ""}` +
          `${s.depends.length ? " · 의존 " + s.depends.join(",") : ""}`);
      });
    });
  } else say(`    docker-compose: 없음`);
  const files = r.deployFiles.map(d => d.file), pick = re => files.filter(f => re.test(f));
  const kube = pick(/(k8s|kubernetes|helm|charts|manifests|kustomiz|gitops|argocd)/i).filter(f => /\.ya?ml$/i.test(f));
  say(`    쿠버 설정(yml · kustomize · helm): ${kube.length ? kube.length + "개 — " + kube.slice(0, 6).join(", ") + (kube.length > 6 ? " 외" : "") : "없음"}`);
  say(`    자동 빌드 · 배포 설정 파일: ${[...r.ci.entries()].map(([t, fs]) => `${t} (${fs.slice(0, 3).join(", ")}${fs.length > 3 ? " 외" : ""})`).join(" · ") || "없음"}`);
  say(`    빌드 · 배포 서버를 띄우는 설정: ${[...r.ciServers.entries()].map(([t, fs]) => `${t} (${fs.slice(0, 2).join(", ")}${fs.length > 2 ? " 외" : ""})`).join(" · ") || "없음"}`);
  say(`    GitOps (ArgoCD · Flux): ${r.gitops.length ? "" : "없음"}`); r.gitops.slice(0, 10).forEach(x => say(`      - ${x}`));
  say(`    배포 · 실행 스크립트: ${pick(/\.(sh|bash|bat|cmd|ps1)$|(^|\/)(Makefile|justfile)$/i).join(", ") || "없음"}`);
  say(`    서비스 파일(systemd): ${pick(/\.service$/i).join(", ") || "없음"}`);
  say(`    WAS 설정(web.xml · server.xml · context.xml): ${pick(/(web|server|context)\.xml$/i).join(", ") || "없음"}`);
  say(`    스크립트에서 감지한 방식:${r.deployWords.size ? "" : " 없음"}`);
  for (const g of GROUPS) { const ws = wordsIn(r, g); if (ws.length) say(`      ${g}: ${ws.join(" · ")}  (${uniq(ws.flatMap(w => r.deployWords.get(w))).slice(0, 3).join(", ")})`); }
  if (r.pushTo.size) say(`      이미지 보내는 창고: ${[...r.pushTo.entries()].map(([h, fs]) => `${h}${regNote(h)} (${fs.slice(0, 2).join(", ")})`).join(" · ")}`);
  if (r.deployTargets.length) say(`      보내는 서버: ${uniq(r.deployTargets).slice(0, 5).join(", ")}`);

  say(`  쿠버 yml 점검 (저장소 안 yml 을 직접 읽어 봄 — 클러스터에는 붙지 않음${SITE.registry ? " · 운영 값과 비교: 창고 " + SITE.registry + (SITE.roleLabel ? " · 서버 라벨 " + SITE.roleLabel : "") + (SITE.ingressClass ? " · 입구 " + SITE.ingressClass : "") + (SITE.domain ? " · 도메인 " + SITE.domain : "") : ""}):`);
  if (!r.kc.groups.length && !r.helmTpl.size) say(`    쿠버 yml 없음 — 위 '쿠버 yml 재료'로 새로 만들어야 함`);
  for (const g of r.kc.groups.slice(0, 20)) {
    say(`    ${g.dir === "." ? "(최상위)" : g.dir + "/"}${g.ks ? " — kustomize" : ""}${g.ns.size ? " · 네임스페이스 " + [...g.ns].join(", ") : ""}`);
    g.lines.slice(0, 20).forEach(l => say(`      - ${l}`));
    if (g.lines.length > 20) say(`      - … 외 ${g.lines.length - 20}개`);
    const bad = groupMsgs(g.bad), note = groupMsgs(g.note);
    bad.slice(0, 15).forEach(l => say(`      문제  ${l}`));
    note.slice(0, 12).forEach(l => say(`      참고  ${l}`));
    if (note.length > 12) say(`      참고  … 외 ${note.length - 12}건`);
  }
  if (r.kc.groups.length > 20) say(`    … 폴더 ${r.kc.groups.length - 20}개 더`);
  for (const [k, label] of [["Secret", "Secret"], ["ConfigMap", "ConfigMap"], ["PVC", "디스크 요청(PVC)"]])
    if (r.kc.miss[k].size) say(`    저장소에 없는 ${label} — 클러스터에 따로 만들어 둬야 함: ${[...r.kc.miss[k].keys()].slice(0, 12).join(", ")}${r.kc.miss[k].size > 12 ? " 외" : ""}`);
  if (r.helmTpl.size) say(`    헬름 틀 (값을 채워 펼친 뒤에 점검 가능 — helm template): ${[...r.helmTpl].slice(0, 8).join(", ")}`);

  const f = r.findings;
  say(`  쿠버로 옮길 때 확인할 곳 (가이드 7장 ①):`);
  const show = (title, arr) => { const l = list(arr); say(`    ${title}: ${l.length ? "" : "없음"}`); l.forEach(x => say(`      - ${x}`)); };
  const showMap = (title, m) => { const hs = [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12); say(`    ${title}: ${hs.length ? "" : "없음"}`); hs.forEach(([h, e]) => say(`      - ${h} (${e.n}곳, 예: ${e.at.join(", ")})`)); };
  show("소스에 박힌 사설 IP", f.privateIp);
  show("localhost · 127.0.0.1 (환경변수 기본값 포함)", f.local);
  if (FORBIDDEN_HOSTS.length) show("개발 서버 주소", f.forbidden);
  showMap("사내 도메인 (쿠버 안 주소로 바꿀지 확인)", f.internal);
  showMap("인터넷 주소 (폐쇄망에서 안 됨 — 끄거나 내부로)", f.hosts);
  say(`    빌드 때만 쓰는 주소 (인터넷 PC 에서 빌드하므로 대개 문제없음): ${[...f.buildHosts].slice(0, 8).join(", ") || "없음"}`);
  show("파일 쓰기 · 절대 경로 (쿠버에서는 /tmp 나 디스크 요청(PVC)만 쓰기 가능)", f.fileWrite);
  show("로그 파일 (쿠버에서는 표준출력으로)", f.logFile);
  show("데모 · 게스트 로그인 흔적", f.demo);
});

say(""); say("════════ 배포 관련 파일 사본 (비밀번호처럼 보이는 값은 가림) ════════");
results.forEach((r, i) => r.deployFiles.forEach(d => { say(""); say(`──── [${i + 1}] ${r.name} / ${d.file}`); say(d.text); }));

fs.writeFileSync(outFile, L.join("\n"), "utf8");
console.log("");
console.log("════════════════════════════════════════════════════════════");
console.log(" 끝났습니다. 아래 파일 하나를 보내 주세요 (메모장으로 열어 내용을 먼저 봐도 됩니다).");
console.log(`   보낼 파일: ${outFile}  (${Math.round(fs.statSync(outFile).size / 1024)}KB)`);
console.log(" 내부 주소가 들어 있으니 사내 메일로 보내 주세요.");
console.log("════════════════════════════════════════════════════════════");

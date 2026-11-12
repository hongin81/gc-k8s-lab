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
// ==== 설정 끝 ====

// ── 건너뛰는 폴더 ───────────────────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git", ".svn", ".idea", ".vscode", "out", ".gradle", ".next", ".nuxt",
  "coverage", "vendor", "obj", ".mvn", "logs", "log", "tmp", "temp", ".cache", "__pycache__", "venv", ".venv", "env", "site-packages",
  "uploads", "upload", "bower_components", "jspm_packages", ".terraform", ".pytest_cache", ".mypy_cache", ".tox"]);
const DOT_KEEP = new Set([".github", ".gitlab", ".circleci", ".gitea", ".woodpecker"]);        // 자동 배포 설정이 있는 숨김 폴더는 봄
const TEST_DIRS = new Set(["test", "tests", "__tests__", "__mocks__", "__fixtures__", "fixtures", "e2e", "testdata", "test-data"]);
// 아래는 src 밖에서만 뺌 — src 안에서는 패키지 이름일 수 있음 (예: 전자정부 예제의 egovframework/example)
const LOOSE_DIRS = new Set(["mocks", "examples", "example", "spec", "specs", "samples", "sample"]);
const NOTE_DIRS = new Set(["docs", "doc", "document", "documents", "manual", "manuals", "proposal", "proposals", "report", "reports",
  "wiki", "notes", "experiments", "experiment", "poc", "sandbox", "playground", "scratch", "archive", "archives", "backup", "backups", "old"]);
const isBuildOutput = (dir, name) => name === "build" && ["build.gradle", "build.gradle.kts", "package.json"].some(f => exists(path.join(dir, f)));
const TEXT_EXT = new Set([".java", ".kt", ".groovy", ".scala", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".yml", ".yaml", ".properties", ".xml", ".json", ".conf", ".sh", ".bat", ".cmd", ".ps1", ".py", ".sql", ".env", ".toml",
  ".gradle", ".kts", ".html", ".jsp", ".service", ".ini", ".cfg", ".go", ".rb", ".php", ".cs"]);
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
      if (TEST_DIRS.has(low) || ((NOTE_DIRS.has(low) || LOOSE_DIRS.has(low)) && !inSrc)) { onSkip(p); continue; }
      if (depth < 20) walk(p, onFile, onSkip, depth + 1, state);
    } else if (e.isFile()) { state.n++; onFile(p, e.name); }
  }
}
const BUILD_FILES = ["pom.xml", "build.gradle", "build.gradle.kts", "package.json", "pyproject.toml", "requirements.txt", "setup.py"];
function isRepoRoot(d) { return exists(path.join(d, ".git")) || exists(path.join(d, ".svn")) || BUILD_FILES.some(f => exists(path.join(d, f))); }
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
const DEPLOY_WORDS = [["scp", /\bscp\b/], ["rsync", /\brsync\b/], ["ssh", /\bssh\s/], ["systemctl", /systemctl\s+(restart|start|stop)/],
  ["java -jar", /nohup\s+java|java\s+(-[^\s]+\s+)*-jar/], ["WAS 에 war 복사", /webapps\/|\.war\b|deployments\/|jeus|weblogic|jboss|wildfly/i],
  ["docker build", /docker\s+(buildx\s+)?build/], ["docker push", /docker\s+push/], ["docker run · compose", /docker\s+run|docker[- ]compose|\bcompose\s+up/],
  ["kubectl", /\bkubectl\b/], ["helm", /\bhelm\s/], ["pm2", /\bpm2\b/], ["ansible", /ansible/], ["FTP", /\bs?ftp\b/i], ["podman", /\bpodman\b/]];
// 코드 · 실행 명령 안의 포트: listen(3000) · PORT || 4000 · uvicorn --port 8000 · app.run(port=5000) · server.port=8081
const CODE_PORT_RE = /\.listen\(\s*(\d{2,5})\b|\bPORT\b[^\n]{0,40}?(?:\|\||\?\?|:-)\s*["']?(\d{2,5})\b|(?:uvicorn|gunicorn|hypercorn|flask|streamlit)[^\n]*?(?:--port|--bind\s+\S*:|-b\s+\S*:)[ =]?(\d{2,5})\b|\.run\([^)]*\bport\s*=\s*(\d{2,5})|--server\.port[ =](\d{2,5})/;
const PY_FW = ["fastapi", "flask", "django", "uvicorn", "gunicorn", "celery", "streamlit", "gradio", "torch", "tensorflow", "transformers", "vllm",
  "ultralytics", "opencv", "kafka", "confluent-kafka", "psycopg", "sqlalchemy", "redis", "minio", "boto3", "pandas", "langchain", "openai"];

const copied = { total: 0 };   // 모든 저장소의 사본 크기 합

// ── 저장소 하나 훑기 ─────────────────────────────────────────────────
function scanRepo(root) {
  const r = { root, name: path.basename(root), vcs: [], projects: [], configs: [], envFiles: [], deployFiles: [], dockerfiles: [], composes: [],
    deployWords: new Map(), deployTargets: [], skipped: [], springPorts: [], codePorts: [], files: 0,
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
        deps: ["postgresql", "mysql", "mariadb", "ojdbc", "tibero", "redis", "kafka", "mybatis", "data-jpa", "flyway", "minio", "egovframework"].filter(d => s.includes(d)) });
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
      for (const [k, v] of kv) {
        if (/^logging\.file\.(name|path)$/.test(k)) r.findings.logFile.push([v, rp]);
        if (k === "server.port") r.springPorts.push({ dir, port: v, file: rp });
      }
    }
    // ── .env (키 이름만)
    if (/^\.env(\..+)?$/.test(base) && !/example|sample|template/i.test(base)) {
      const s = readText(p) || "";
      r.envFiles.push({ file: rp, keys: s.split("\n").map(l => l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]).filter(Boolean) });
    }
    // ── 배포 관련 파일 사본 · 요약
    const inDeployDir = (/(^|\/)(k8s|kubernetes|deploy|deploys|deployment|deployments|helm|charts|kustomize|manifests|gitops|argocd)\//i.test(rp) && /\.(ya?ml|conf|toml)$/i.test(base))
      || (/(^|\/)\.(github\/workflows|gitlab|circleci|gitea|woodpecker)\//.test(rp) && /\.ya?ml$/i.test(base));
    const realEnv = /(^|[._-])env$|^\.env/i.test(base) && !/example|sample|template/i.test(base);
    if ((DEPLOY_FILE_RE.test(base) || inDeployDir) && !realEnv && !/\.(key|pem|p12|jks|pfx|keystore|truststore)$/i.test(base)) {
      const s = readText(p);
      copied.total += s ? Math.min(s.length, MAX_COPY) : 0;
      const text = s === null ? "(1MB 넘어 생략)" : copied.total > MAX_COPY_TOTAL ? "(전체 사본 한도 2MB 를 넘어 이름만 적음)" :
        mask(s.length > MAX_COPY ? s.slice(0, MAX_COPY) + "\n... (64KB 뒤는 생략)" : s);
      r.deployFiles.push({ file: rp, text });
      if (s && /^Dockerfile|\.dockerfile$/i.test(base)) r.dockerfiles.push({ file: rp, dir, ...summarizeDockerfile(s) });
      if (s && /^(docker-compose.*|compose)\.ya?ml$/i.test(base)) r.composes.push({ file: rp, services: summarizeCompose(s) });
      if (s && /\.(sh|bat|cmd|ps1)$|Jenkinsfile|gitlab-ci|workflows|\.service$|compose[^/]*\.ya?ml$|Procfile/i.test(rp)) {
        for (const [w, re] of DEPLOY_WORDS) if (re.test(s)) r.deployWords.set(w, (r.deployWords.get(w) || []).concat(rp));
        for (const m of s.matchAll(/(?:scp|rsync|ssh)\b[^\n]*?@([A-Za-z0-9.-]+|\$\{?[A-Za-z_]+\}?)/g)) r.deployTargets.push(m[1]);
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

      const lf = line.match(/logging\.file\.(name|path)\s*[:=]\s*(\S+)|<file>\s*([^<]+)<\/file>|fileName\s*=\s*"([^"]+)"|FileHandler\(\s*["']([^"']+)/);
      if (lf) push(r.findings.logFile, lf.slice(2).find(Boolean));
      if (/(demo|guest)[-_]?(login|user|account|id|password|pw)/i.test(line)) push(r.findings.demo, line.trim().slice(0, 60));
    });
  }, skipped => r.skipped.push(rel(root, skipped)));
  return r;
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
  const out = [];
  const inDir = d => ownerDir(r, d) === p.dir;
  const sp = r.springPorts.filter(x => inDir(x.dir)).map(x => x.port);
  if (p.kind.startsWith("메이븐") || p.kind === "그레이들") {
    if (sp.length) out.push("설정 " + uniq(sp).join("/"));
    else if (p.bootPlugin && p.packaging !== "pom") out.push("설정 없음 → 8080 (스프링 기본값)");
    else if (p.packaging === "war") out.push("WAS 설정에 따름 (톰캣 기본 8080)");
  }
  if (p.kind === "npm") {
    const st = p.scripts.start || "";
    const m = st.match(/(?:-p|--port)[ =](\d+)/) || st.match(/PORT=(\d+)/);
    if (m) out.push("start " + m[1]);
    else if (p.fw.includes("next")) out.push("next 기본 3000");
    const vc = r.configs.find(c => inDir(c.dir) && c.items.some(([k]) => k === "개발 서버 포트"));
    if (vc && shapeOf(p).startsWith("정적")) out.push("개발 서버 " + vc.items.find(([k]) => k === "개발 서버 포트")[1] + " (운영엔 nginx)");
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
  if (cps.length && !(p.kind.startsWith("메이븐") || p.kind === "그레이들")) out.push("코드 " + cps.slice(0, 4).join("/"));
  const df = r.dockerfiles.filter(d => inDir(d.dir) && d.expose.length);
  if (df.length) out.push("Dockerfile EXPOSE " + uniq(df.flatMap(d => d.expose)).join("/"));
  if (!out.length && shapeOf(p).startsWith("정적")) return "nginx 가 정함 (화면)";
  // 운영에서 듣는 포트 후보가 서로 다르면 표시 (개발 서버 포트 · 스프링 기본값 설명은 빼고 비교)
  const nums = uniq(out.filter(x => !/^개발 서버/.test(x)).flatMap(x => (x.replace(/\(.*?\)/g, "").match(/\b\d{2,5}\b/g) || [])));
  if (nums.length > 1) out.push("⚠ 서로 다름 — 확인 필요");
  return out.join(" · ") || "-";
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

console.log("소스 저장소 수집 — 읽기만 합니다 (소스를 바꾸지 않음) · 비밀번호처럼 보이는 값은 *** 로 가립니다");
const repos = [...new Set(args.flatMap(a => findRepos(path.resolve(a))))];
if (!repos.length) { console.log("저장소를 찾지 못했습니다. 소스를 받아 둔 폴더를 주세요. 예) node scan-source.mjs D:\\work"); process.exit(1); }
console.log(`저장소 ${repos.length}개를 찾았습니다.`);
const results = repos.map((root, i) => { process.stdout.write(`  [${i + 1}/${repos.length}] ${path.basename(root)} ... `); const r = scanRepo(root); markSiblings(r); console.log(`파일 ${r.files}개`); return r; });

say(`소스 저장소 수집 결과 — ${new Date().toLocaleString("ko-KR")} · PC ${os.hostname()} · ${os.platform()} · Node ${process.version}`);
say(`읽기만 했고, 소스 코드는 가져오지 않았습니다. 비밀번호 · 토큰 · 키처럼 보이는 값은 *** 로 가렸고, .env 파일은 키 이름만 적었습니다.`);
say(`이 PC 의 도구: git ${sh("git", ["--version"]) ? "있음" : "없음"} · svn ${sh("svn", ["--version", "--quiet"]) || "없음"} · java ${((spawnSync("java", ["-version"], { encoding: "utf8", shell: process.platform === "win32" }).stderr || "").split("\n")[0].match(/version "[^"]+"/) || ["없음"])[0]} · mvn ${sh("mvn", ["-v"])?.split("\n")[0]?.replace(/\s*\(.*$/, "") || "없음"} · docker ${sh("docker", ["--version"])?.replace(/, build.*$/, "") || "없음"}`);

// 한눈에 보기
say(""); say("════════ 한눈에 보기 ════════");
say("저장소 · 실행되는 프로젝트(형태 · 포트) · 지금 배포 방법 · 쿠버로 옮길 때 확인할 곳 개수");
results.forEach((r, i) => {
  const run = r.projects.filter(isRunnable);
  const how = uniq([...r.deployWords.keys(), r.dockerfiles.length ? "Dockerfile " + r.dockerfiles.length : "", r.composes.length ? "compose " + r.composes.length : ""]).join(" · ") || "배포 파일 못 찾음";
  const f = r.findings;
  const issues = [f.privateIp.length && `사설 IP ${uniq(f.privateIp.map(x => x[0])).length}`, f.local.length && `localhost ${f.local.length}`,
    f.internal.size && `사내 도메인 ${f.internal.size}`, f.hosts.size && `인터넷 주소 ${f.hosts.size}`, f.forbidden.length && `개발 서버 ${f.forbidden.length}`,
    f.fileWrite.length && `파일 쓰기 ${f.fileWrite.length}`, f.logFile.length && `로그 파일 ${f.logFile.length}`].filter(Boolean).join(" · ") || "없음";
  say(`${i + 1}. ${r.name}  — ${/^SVN/.test(r.vcs[0]) ? "SVN" : /^Git/.test(r.vcs[0]) ? "Git" : "저장소 정보 없음"}`);
  if (!run.length) say(`   실행 프로젝트: 없음 (${r.projects.length ? "라이브러리 · 묶음만" : "빌드 파일 없음"})`);
  run.slice(0, 8).forEach(p => say(`   - ${p.dir === "." ? "(최상위)" : p.dir}: ${shapeOf(p)} · 포트 ${portsOf(r, p)}`));
  if (run.length > 8) say(`   - … 외 ${run.length - 8}개`);
  say(`   지금 배포: ${how}`);
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
  say(`    자동 빌드 · 배포(Jenkins · GitLab · GitHub): ${pick(/Jenkinsfile|gitlab-ci|workflows|pipelines|circleci/i).join(", ") || "없음"}`);
  say(`    배포 · 실행 스크립트: ${pick(/\.(sh|bat|cmd|ps1)$/i).join(", ") || "없음"}`);
  say(`    서비스 파일(systemd): ${pick(/\.service$/i).join(", ") || "없음"}`);
  say(`    WAS 설정(web.xml · server.xml · context.xml): ${pick(/(web|server|context)\.xml$/i).join(", ") || "없음"}`);
  say(`    스크립트에서 감지한 방식: ${[...r.deployWords.keys()].join(" · ") || "없음"}${r.deployTargets.length ? " · 보내는 곳 " + uniq(r.deployTargets).slice(0, 5).join(", ") : ""}`);

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

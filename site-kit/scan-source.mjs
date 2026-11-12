#!/usr/bin/env node
// 소스 저장소 수집 (읽기 전용) — 개발 PC 에 받아 둔 소스를 훑어, 저장소 · 빌드 방식 · 설정 · 지금 배포 방법 ·
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
//            개인키 파일은 가져오지 않는다 · 비밀번호를 묻지 않는다.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// ==== 설정 — 받은 그대로 쓰면 됨 ====
const FORBIDDEN_HOSTS = [];   // 소스에 남아 있으면 안 되는 개발 서버 주소 (예: "dev.example.com")
// ==== 설정 끝 ====

const SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git", ".svn", ".idea", ".vscode", "out", ".gradle",
  ".next", ".nuxt", "coverage", "vendor", "obj", ".mvn", "logs", "tmp", ".cache", "__pycache__", "venv", ".venv"]);
// build 폴더는 빌드 결과물일 때만 건너뜀 (옆에 build.gradle · package.json 이 있을 때). 배포 묶음의 build/(Dockerfile)는 본다
const isBuildOutput = (dir, name) => name === "build" && ["build.gradle", "build.gradle.kts", "package.json"].some(f => exists(path.join(dir, f)));
const TEXT_EXT = new Set([".java", ".kt", ".groovy", ".scala", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".yml", ".yaml", ".properties", ".xml", ".json", ".conf", ".sh", ".bat", ".cmd", ".ps1", ".py", ".sql", ".env", ".toml",
  ".gradle", ".kts", ".html", ".jsp", ".service", ".ini", ".cfg"]);
const MAX_FILE = 1024 * 1024, MAX_FILES = 60000, MAX_COPY = 64 * 1024, MAX_COPY_TOTAL = 2 * 1024 * 1024;
// 숨김 폴더는 건너뛰되 자동 배포 설정이 있는 곳은 본다
const DOT_KEEP = new Set([".github", ".gitlab", ".circleci", ".gitea", ".woodpecker"]);
// 시험 · 예제 자료 폴더 (가짜 프로젝트 · 가짜 주소가 많아 판단을 흐림)
const TEST_DIRS = new Set(["test", "tests", "__tests__", "__mocks__", "__fixtures__", "fixtures", "e2e", "testdata", "test-data", "mocks", "examples", "example", "spec", "specs"]);

const args = process.argv.slice(2).filter(a => !a.startsWith("-"));
if (!args.length || process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 15).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(args.length ? 0 : 1);
}

// ── 가리기 ─────────────────────────────────────────────────────────
const SW = "(pass(?:word|wd)?|pwd|[._-]pw|secret|token|[._-]key|apikey|credentials?|auth|identitytoken)";
const RE_KV = new RegExp(`([A-Za-z0-9_.-]*${SW}["']?[ \\t]*[:=][ \\t]*)("[^"]*"|'[^']*'|\\$\\{[^}\\n]*\\}|[^\\s,}]+)`, "gi");
const RE_NAMEVAL = new RegExp(`("name"\\s*:\\s*"[A-Za-z0-9_.-]*${SW}"\\s*,\\s*"value"\\s*:\\s*)"[^"]*"`, "gi");
const RE_NAMELINE = new RegExp(`name:\\s*["']?[A-Za-z0-9_.-]*${SW}["']?\\s*$`, "i");
function maskValue(v) {
  const m = v.match(/^["']?\$\{([A-Za-z0-9_.-]+)(?::[^}]*)?\}["']?$/);   // ${DB_PASSWORD:기본값} → 환경변수 이름은 남김
  return m ? "${" + m[1] + ":***}" : "***";
}
const VALUE_SECRETS = [/\bAKIA[0-9A-Z]{16}\b/g, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g, /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, /\bAIza[0-9A-Za-z_-]{30,}/g, /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g, /\bglpat-[A-Za-z0-9_-]{20,}/g];
function mask(text) {
  for (const re of VALUE_SECRETS) text = text.replace(re, "***");
  let out = text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "*** 개인키 가림 ***")
    .replace(/(:\/\/[^:/@\s]+:)[^@/\s]+@/g, "$1***@")
    .replace(RE_NAMEVAL, '$1"***"')
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
function sh(cmd, argv, cwd) {
  const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", timeout: 20000, windowsHide: true, shell: process.platform === "win32" });
  return r.status === 0 ? (r.stdout || "").trim() : null;
}
function walk(dir, onFile, depth = 0, maxDepth = 20, state = { n: 0 }) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (state.n >= MAX_FILES) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const skip = SKIP_DIRS.has(e.name) || TEST_DIRS.has(e.name.toLowerCase()) || (e.name.startsWith(".") && !DOT_KEEP.has(e.name)) || isBuildOutput(dir, e.name);
      if (!skip && depth < maxDepth) walk(p, onFile, depth + 1, maxDepth, state);
    }
    else if (e.isFile()) { state.n++; onFile(p, e.name); }
  }
}
const BUILD_FILES = ["pom.xml", "build.gradle", "build.gradle.kts", "package.json"];
function isRepoRoot(d) { return exists(path.join(d, ".git")) || exists(path.join(d, ".svn")) || BUILD_FILES.some(f => exists(path.join(d, f))); }
function findRepos(start, depth = 0, out = []) {
  if (isRepoRoot(start)) { out.push(start); return out; }
  if (depth >= 3) return out;
  let ents; try { ents = fs.readdirSync(start, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) findRepos(path.join(start, e.name), depth + 1, out);
  return out;
}
const tag = (s, name) => { const m = s.match(new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`)); return m ? m[1] : null; };

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

const KEY_RE = /(^|\.)(port|context-path|base-path|url|uri|host|hosts|bootstrap-servers|address|addresses|endpoint|file|path|location|profiles?\.active|issuer-uri|jwk-set-uri|base-url|baseurl)$/i;
const PRIVATE_IP = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/;
const LOCAL_RE = /\b(localhost|127\.0\.0\.1)(:\d+)?\b/;
const URL_RE = /https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?/g;
const IGNORE_HOSTS = /(^|\.)(w3\.org|apache\.org|springframework\.org|json-schema\.org|xml\.org|sun\.com|oracle\.com|mybatis\.org|qos\.ch|eclipse\.org|openapis\.org|swagger\.io|example\.(com|org|net)|schemas\.|xmlsoap\.org|jcp\.org|jboss\.org|reactjs\.org|vuejs\.org|vitejs\.dev|npmjs\.(com|org)|github\.com|githubusercontent\.com|mozilla\.org|purl\.org|opensource\.org|creativecommons\.org|ietf\.org|ecma-international\.org|java\.com|maven\.org|gradle\.org|nodejs\.org|typescriptlang\.org|eslint\.org|prettier\.io|jquery\.com|egovframe\.go\.kr)$/i;
const FILE_WRITE_RE = /(new\s+File(?:OutputStream|Writer)?\s*\(\s*"(\/[^"]+|[A-Za-z]:\\\\[^"]+)"|Paths\.get\s*\(\s*"(\/[^"]+)"|Path\.of\s*\(\s*"(\/[^"]+)"|fs\.(?:writeFile|appendFile|mkdir|createWriteStream)(?:Sync)?\s*\(\s*['"`](\/[^'"`]+))/;
const DEPLOY_FILE_RE = /^(Dockerfile.*|.*\.dockerfile|docker-compose.*\.ya?ml|compose\.ya?ml|Jenkinsfile.*|\.gitlab-ci\.yml|azure-pipelines\.yml|bitbucket-pipelines\.yml|.*\.service|(deploy|build|start|stop|restart|run|install|release)[^/]*\.(sh|bat|cmd|ps1)|nginx[^/]*\.conf|kustomization\.ya?ml|Chart\.yaml|values[^/]*\.ya?ml|.*\.example\.env|\.env\.example|application[^/]*\.(ya?ml|properties)|bootstrap[^/]*\.(ya?ml|properties)|vite\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s|nuxt\.config\.[jt]s|vue\.config\.js|ecosystem\.config\.[cm]?js|web\.xml|server\.xml|context\.xml|logback[^/]*\.xml|log4j2?[^/]*\.xml)$/i;
const DEPLOY_WORDS = [["scp", /\bscp\b/], ["rsync", /\brsync\b/], ["ssh", /\bssh\s/], ["systemctl", /systemctl\s+(restart|start|stop)/],
  ["nohup java -jar", /nohup\s+java|java\s+-jar/], ["톰캣 · WAS 에 war 복사", /webapps|\.war\b|deployments\/|jeus|weblogic|jboss|wildfly/i],
  ["docker build", /docker\s+(buildx\s+)?build/], ["docker push", /docker\s+push/], ["docker run · compose", /docker\s+run|docker[- ]compose/],
  ["kubectl", /\bkubectl\b/], ["helm", /\bhelm\s/], ["pm2", /\bpm2\b/], ["ansible", /ansible/], ["FTP", /\bs?ftp\b/i]];

const copied = { total: 0 };   // 모든 저장소의 사본 크기 합

// ── 저장소 하나 훑기 ─────────────────────────────────────────────────
function scanRepo(root) {
  const r = { root, name: path.basename(root), vcs: [], projects: [], configs: [], envFiles: [], deployFiles: [], deployWords: new Map(),
    findings: { privateIp: [], local: [], forbidden: [], hosts: new Map(), fileWrite: [], logFile: [], demo: [] }, files: 0 };
  // 저장소 종류 · 주소
  if (exists(path.join(root, ".svn"))) {
    const info = sh("svn", ["info"], root);
    r.vcs.push(info ? "SVN · " + mask(info.split("\n").filter(l => /^(URL|Relative URL|Repository Root|Revision|Last Changed (Author|Rev|Date)):/.test(l)).join(" · ")) : "SVN 작업 사본 (svn 명령이 없어 주소는 못 읽음 — 질문지로)");
  }
  if (exists(path.join(root, ".git"))) {
    const remote = sh("git", ["remote", "-v"], root), br = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], root);
    const last = sh("git", ["log", "-1", "--date=short", "--format=%h %cd %s"], root), dirty = sh("git", ["status", "--porcelain"], root);
    r.vcs.push("Git · " + mask((remote || "원격 없음").split("\n")[0]) + " · 브랜치 " + (br || "?") + " · 마지막 " + (last || "?") +
      (dirty ? " · 커밋 안 된 변경 " + dirty.split("\n").length + "개" : ""));
  }
  if (!r.vcs.length) r.vcs.push("저장소 정보 없음 (.svn · .git 없음 — 압축본이거나 상위 폴더가 저장소)");

  walk(root, (p, base) => {
    r.files++;
    const rp = rel(root, p), ext = path.extname(base).toLowerCase();
    // 프로젝트 (빌드 파일)
    if (base === "pom.xml") {
      const s = readText(p) || "";
      const parent = s.match(/<parent>[\s\S]*?<\/parent>/)?.[0] || "";
      const deps = ["spring-boot-starter-web", "spring-boot-starter-webflux", "data-jpa", "mybatis", "postgresql", "mysql", "mariadb", "ojdbc", "tibero",
        "redis", "kafka", "egovframework", "spring-boot-starter-tomcat", "flyway", "liquibase", "minio", "aws-java-sdk", "elasticsearch", "actuator"]
        .filter(d => s.includes(d));
      r.projects.push({ dir: path.dirname(rp), kind: "메이븐", name: tag(s.replace(parent, ""), "artifactId"),
        boot: /spring-boot-starter-parent/.test(parent) ? tag(parent, "version") : (s.match(/spring-boot[^<]*<\/artifactId>\s*<version>([^<]+)/)?.[1] || null),
        java: tag(s, "java.version") || tag(s, "maven.compiler.release") || tag(s, "maven.compiler.source") || tag(s, "release"),
        packaging: tag(s.replace(parent, ""), "packaging") || "jar", finalName: tag(s, "finalName"), modules: (s.match(/<module>[^<]+<\/module>/g) || []).length,
        bootPlugin: s.includes("spring-boot-maven-plugin"), deps });
    } else if (base === "build.gradle" || base === "build.gradle.kts") {
      const s = readText(p) || "";
      r.projects.push({ dir: path.dirname(rp), kind: "그레이들", name: path.basename(path.dirname(p)),
        boot: s.match(/org\.springframework\.boot['"]?\)?\s*version\s*['"]([^'"]+)/)?.[1] || null,
        java: s.match(/(?:sourceCompatibility|languageVersion)\s*[=(]\s*(?:JavaVersion\.VERSION_|JavaLanguageVersion\.of\()?['"]?(\d+)/)?.[1] || null,
        packaging: /\bwar\b/.test(s) ? "war" : "jar", bootPlugin: /org\.springframework\.boot/.test(s), deps: [] });
    } else if (base === "package.json" && !rp.includes("node_modules")) {
      let j = {}; try { j = JSON.parse(readText(p) || "{}"); } catch { }
      const all = { ...(j.dependencies || {}), ...(j.devDependencies || {}) };
      const fw = ["vite", "react", "vue", "next", "nuxt", "@angular/core", "svelte", "express", "@nestjs/core", "fastify", "koa", "prisma", "typeorm", "pg", "ioredis", "kafkajs"].filter(k => all[k]);
      r.projects.push({ dir: path.dirname(rp), kind: "npm", name: j.name, scripts: j.scripts || {}, fw, node: j.engines?.node || null, workspaces: !!j.workspaces });
    }
    // 화면 base 경로
    if (/^(vite|next|nuxt|vue)\.config\.[cm]?[jt]s$/.test(base)) {
      const s = readText(p) || "";
      const base_ = s.match(/\b(?:base|basePath|publicPath|baseURL)\s*:\s*([^,\n]+)/)?.[1]?.trim();
      const port = s.match(/\bport\s*:\s*(\d+)/)?.[1];
      r.configs.push({ file: rp, items: [["화면 base 경로", base_ || "지정 안 됨 (/)"], ...(port ? [["개발 서버 포트", port]] : [])] });
    }
    // 스프링 설정
    if (/^(application|bootstrap)[^/]*\.(ya?ml|properties)$/i.test(base)) {
      const s = readText(p) || "";
      const kv = /\.properties$/i.test(base) ? flattenProps(s) : flattenYaml(s);
      const items = kv.filter(([k]) => KEY_RE.test(k) || /^logging\.file\.(name|path)$/.test(k)).slice(0, 40).map(([k, v]) => [k, mask(`${k}: ${v}`).replace(/^[^:]*:\s*/, "")]);
      r.configs.push({ file: rp, items });
      for (const [k, v] of kv) if (/^logging\.file\.(name|path)$/.test(k)) r.findings.logFile.push([v, rp]);
    }
    // .env (키 이름만)
    if (/^\.env(\..+)?$/.test(base) && !/example|sample|template/i.test(base)) {
      const s = readText(p) || "";
      r.envFiles.push({ file: rp, keys: s.split("\n").map(l => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]).filter(Boolean) });
    }
    // 배포 관련 파일 사본
    const inDeployDir = (/(^|\/)(k8s|kubernetes|deploy|deploys|deployment|deployments|helm|charts|kustomize|manifests|gitops|argocd)\//i.test(rp) && /\.(ya?ml|conf|toml)$/i.test(base))
      || (/(^|\/)\.(github\/workflows|gitlab|circleci|gitea|woodpecker)\//.test(rp) && /\.ya?ml$/i.test(base));
    const realEnv = /(^|[._-])env$|^\.env/i.test(base) && !/example|sample|template/i.test(base);   // 진짜 비밀값 파일은 사본을 가져오지 않음
    if ((DEPLOY_FILE_RE.test(base) || inDeployDir) && !realEnv && !/\.(key|pem|p12|jks|pfx|keystore|truststore)$/i.test(base)) {
      const s = readText(p);
      {
        copied.total += s ? Math.min(s.length, MAX_COPY) : 0;
        const text = s === null ? "(1MB 넘어 생략)" : copied.total > MAX_COPY_TOTAL ? "(전체 사본 한도 2MB 를 넘어 이름만 적음)" :
          mask(s.length > MAX_COPY ? s.slice(0, MAX_COPY) + "\n... (64KB 뒤는 생략)" : s);
        r.deployFiles.push({ file: rp, text });
        if (s && /\.(sh|bat|cmd|ps1)$|Jenkinsfile|gitlab-ci|workflows|\.service$|docker-compose|compose\.ya?ml/i.test(rp))
          for (const [w, re] of DEPLOY_WORDS) if (re.test(s)) r.deployWords.set(w, (r.deployWords.get(w) || []).concat(rp));
      }
    }
    // 소스 안의 주소 · 파일 쓰기 · 로그 파일 · 데모 로그인
    if (!TEXT_EXT.has(ext) && !/^Dockerfile|Jenkinsfile/.test(base)) return;
    if (/package-lock\.json|yarn\.lock|pnpm-lock|\.min\.js$/.test(base)) return;
    const s = readText(p); if (s === null) return;
    s.split("\n").forEach((line, i) => {
      if (line.length > 2000) return;
      const at = `${rp}:${i + 1}`, push = (arr, v) => { arr.push([v, at]); };
      const ip = line.match(PRIVATE_IP); if (ip && !/version|\d+\.\d+\.\d+\.\d+\.\d+/i.test(line)) push(r.findings.privateIp, ip[0]);
      const lo = line.match(LOCAL_RE); if (lo && !/test/i.test(rp)) push(r.findings.local, lo[0]);
      for (const h of FORBIDDEN_HOSTS) if (h && line.includes(h)) push(r.findings.forbidden, h);
      for (const m of line.matchAll(URL_RE)) {
        const host = m[1].toLowerCase();
        if (IGNORE_HOSTS.test(host) || /\.svc(\.cluster\.local)?$/.test(host) || PRIVATE_IP.test(host) || host === "localhost") continue;
        const e = r.findings.hosts.get(host) || { n: 0, at: [] }; e.n++; if (e.at.length < 2) e.at.push(at); r.findings.hosts.set(host, e);
      }
      const fw = line.match(FILE_WRITE_RE); if (fw) push(r.findings.fileWrite, fw.slice(2).find(Boolean));
      const lf = line.match(/logging\.file\.(name|path)\s*[:=]\s*(\S+)|<file>\s*([^<]+)<\/file>|fileName\s*=\s*"([^"]+)"/); if (lf) push(r.findings.logFile, lf.slice(2).find(Boolean));
      if (/(demo|guest)[-_]?(login|user|account|id|password|pw)/i.test(line) && !/test/i.test(rp)) push(r.findings.demo, line.trim().slice(0, 60));
    });
  });
  return r;
}

// ── 보고서 쓰기 ─────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const outFile = path.resolve(`source-scan-${os.hostname().replace(/[^A-Za-z0-9_-]/g, "_")}-${stamp}.txt`);
const L = [];
const say = s => L.push(s);
const list = (arr, n = 5) => {
  const by = new Map(); for (const [v, at] of arr) { const e = by.get(v) || []; e.push(at); by.set(v, e); }
  return [...by.entries()].slice(0, n).map(([v, ats]) => `${v} (${ats.length}곳, 예: ${ats.slice(0, 2).join(", ")})`);
};

console.log("소스 저장소 수집 — 읽기만 합니다 (소스를 바꾸지 않음) · 비밀번호처럼 보이는 값은 *** 로 가립니다");
const repos = [...new Set(args.flatMap(a => findRepos(path.resolve(a))))];
if (!repos.length) { console.log("저장소를 찾지 못했습니다. 소스를 받아 둔 폴더를 주세요. 예) node scan-source.mjs D:\\work"); process.exit(1); }
console.log(`저장소 ${repos.length}개를 찾았습니다.`);

say(`소스 저장소 수집 결과 — ${new Date().toLocaleString("ko-KR")} · PC ${os.hostname()} · ${os.platform()} · Node ${process.version}`);
say(`읽기만 했고, 비밀번호 · 토큰 · 키처럼 보이는 값은 *** 로 가렸습니다. .env 파일은 키 이름만 적었습니다.`);
say(`이 PC 의 도구: git ${sh("git", ["--version"]) ? "있음" : "없음"} · svn ${sh("svn", ["--version", "--quiet"]) || "없음"} · java ${((spawnSync("java", ["-version"], { encoding: "utf8", shell: process.platform === "win32" }).stderr || "").split("\n")[0].match(/version "[^"]+"/) || ["없음"])[0]} · mvn ${sh("mvn", ["-v"])?.split("\n")[0] || "없음"} · docker ${sh("docker", ["--version"]) || "없음"}`);
say("");
say("저장소 목록");
const results = repos.map((root, i) => { process.stdout.write(`  [${i + 1}/${repos.length}] ${path.basename(root)} ... `); const r = scanRepo(root); console.log(`파일 ${r.files}개`); return r; });
results.forEach((r, i) => say(`  ${i + 1}. ${r.name}  (${r.root})`));

results.forEach((r, i) => {
  say(""); say(`━━━━ [${i + 1}] ${r.name} ━━━━`);
  say(`  위치     : ${r.root}`);
  r.vcs.forEach(v => say(`  저장소   : ${v}`));
  say(`  파일     : ${r.files}개 (node_modules · target · dist 등 제외)`);
  say(`  프로젝트 :`);
  if (!r.projects.length) say(`    (빌드 파일 없음)`);
  if (r.projects.length > 40) say(`    (프로젝트가 ${r.projects.length}개라 앞 40개만 적음)`);
  for (const p of r.projects.slice(0, 40)) {
    if (p.kind === "npm") {
      const run = p.scripts.start ? "start=" + p.scripts.start : "";
      say(`    - ${p.dir}/  npm · ${p.name || "-"} · ${p.fw.join(", ") || "프레임워크 못 찾음"}${p.node ? " · node " + p.node : ""}`);
      const server = p.fw.some(f => ["express", "@nestjs/core", "fastify", "koa", "next", "nuxt"].includes(f)) || /\bnode\s+\S+\.(c|m)?js\b/.test(p.scripts.start || "");
      const front = p.fw.some(f => ["vite", "react", "vue", "@angular/core", "svelte"].includes(f));
      const mono = p.workspaces || /\b(turbo|lerna|nx)\b/.test(p.scripts.build || "");
      const shape = server ? "Node 서버로 실행" : front ? "정적 화면(빌드 결과를 nginx 로)" : mono ? "여러 프로젝트 묶음의 최상위" : "라이브러리 · 도구 (직접 실행 안 함)";
      say(`        build=${p.scripts.build || "없음"}${run ? " · " + run : ""}  → ${shape}`);
    } else {
      const shape = p.packaging === "war" ? "war → WAS(톰캣 · JBoss 등)에 올리는 방식" : (p.bootPlugin ? "스프링부트 실행 jar" : p.packaging === "pom" ? "상위 묶음(모듈 " + p.modules + "개)" : "jar (실행 방식 확인 필요)");
      say(`    - ${p.dir}/  ${p.kind} · ${p.name || "-"} · 스프링부트 ${p.boot || "-"} · 자바 ${p.java || "-"} · ${shape}${p.finalName ? " · 결과 파일 이름 " + p.finalName : ""}`);
      if (p.deps.length) say(`        주요 의존: ${p.deps.join(", ")}`);
    }
  }
  if (r.configs.length) {
    say(`  설정 파일 (포트 · 경로 · 주소만):`);
    for (const c of r.configs.slice(0, 20)) {
      say(`    - ${c.file}`);
      for (const [k, v] of c.items.slice(0, 15)) say(`        ${k} = ${v}`);
    }
  }
  if (r.envFiles.length) { say(`  .env 파일 (키 이름만):`); r.envFiles.forEach(e => say(`    - ${e.file}: ${e.keys.join(", ") || "(키 없음)"}`)); }
  say(`  지금 배포 방법 (찾은 파일):`);
  const kinds = r.deployFiles.map(d => d.file);
  const pick = re => kinds.filter(f => re.test(f));
  say(`    Dockerfile: ${pick(/Dockerfile|\.dockerfile$/i).join(", ") || "없음"}`);
  say(`    docker-compose: ${pick(/compose[^/]*\.ya?ml$/i).join(", ") || "없음"}`);
  const kube = pick(/(k8s|kubernetes|helm|charts|manifests|kustomiz|gitops|argocd)/i).filter(f => /\.ya?ml$/i.test(f));
  say(`    쿠버 설정(yml · kustomize · helm): ${kube.length ? kube.length + "개 — " + kube.slice(0, 8).join(", ") + (kube.length > 8 ? " 외" : "") : "없음"}`);
  say(`    자동 빌드 · 배포 설정(Jenkins · GitLab · GitHub): ${pick(/Jenkinsfile|gitlab-ci|workflows|pipelines/i).join(", ") || "없음"}`);
  say(`    배포 · 실행 스크립트: ${pick(/\.(sh|bat|cmd|ps1)$/i).join(", ") || "없음"}`);
  say(`    서비스 파일(systemd): ${pick(/\.service$/i).join(", ") || "없음"}`);
  say(`    스크립트 안에서 감지한 방식: ${[...r.deployWords.keys()].join(" · ") || "없음"}`);
  const f = r.findings;
  say(`  쿠버로 옮길 때 확인할 곳 (가이드 7장 ①):`);
  const show = (title, arr) => { const l = list(arr); say(`    ${title}: ${l.length ? "" : "없음"}`); l.forEach(x => say(`      - ${x}`)); };
  show("소스에 박힌 사설 IP", f.privateIp);
  show("localhost · 127.0.0.1", f.local);
  if (FORBIDDEN_HOSTS.length) show("개발 서버 주소", f.forbidden);
  const hosts = [...f.hosts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15);
  say(`    인터넷 주소 호출(폐쇄망에서 안 됨 — 끄거나 내부로): ${hosts.length ? "" : "없음"}`);
  hosts.forEach(([h, e]) => say(`      - ${h} (${e.n}곳, 예: ${e.at.join(", ")})`));
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

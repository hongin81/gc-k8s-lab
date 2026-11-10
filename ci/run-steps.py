#!/usr/bin/env python3
"""킬러코다 단계 설명서(text.md)의 실행 상자({{exec}})를 사람이 누르는 순서 그대로 한 셸에서 돌리고,
단계마다 CHECK(verify.sh)를 확인한다. 하나라도 실패하면 거기서 멈춘다.
사용: sudo python3 ci/run-steps.py gc-deploy-lab
"""
import json
import pathlib
import subprocess
import sys

import re

scenario = pathlib.Path(sys.argv[1]).resolve()
index = json.loads((scenario / "index.json").read_text(encoding="utf-8"))

# 실행 상자: ```...```{{exec}} (안에 ``` 없음) 또는 `한 줄`{{exec}}
BOX = re.compile(
    r"```[a-z]*\n(?P<block>(?:(?!```)[\s\S])*?)```\{\{exec[^}]*\}\}"
    r"|`(?P<inline>[^`\n]+)`\{\{exec[^}]*\}\}"
)

lines = ["export HOME=/root", "cd /root"]
for step in index["details"]["steps"]:
    title = step["title"]
    text = (scenario / step["text"]).read_text(encoding="utf-8")
    lines.append(f'echo; echo "################ {title} ################"')
    for n, m in enumerate(BOX.finditer(text), 1):
        cmd = (m.group("block") or m.group("inline")).rstrip("\n")
        lines.append(f'echo; echo "---- 실행 상자 {n} ----"')
        lines.append(cmd)
    verify = scenario / step["verify"]
    lines.append(
        f'if bash "{verify}"; then echo "CHECK 통과: {title}"; '
        f'else echo "CHECK 실패: {title}"; exit 1; fi'
    )
lines.append('echo; echo "모든 단계 통과"')

script = pathlib.Path("/tmp/lab-steps.sh")
script.write_text("\n".join(lines) + "\n", encoding="utf-8")
sys.exit(subprocess.run(["bash", str(script)], stdin=subprocess.DEVNULL).returncode)

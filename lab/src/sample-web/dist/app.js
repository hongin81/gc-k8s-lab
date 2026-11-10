// API 는 상대경로로만 부른다 (도메인 · 개발 서버 주소를 넣지 않는다)
document.getElementById('btn').addEventListener('click', async () => {
  const out = document.getElementById('out');
  out.textContent = '부르는 중...';
  try {
    const res = await fetch('/sample-api/hello');
    out.textContent = res.status + '\n' + JSON.stringify(await res.json(), null, 2);
  } catch (e) {
    out.textContent = '오류: ' + e;
  }
});

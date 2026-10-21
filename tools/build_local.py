import re, sys
src = open('takubiyori.html').read()
h = src
def rep(a, b):
    global h
    assert h.count(a) == 1, a[:80]
    h = h.replace(a, b)

# 1) data layer -> localStorage
i = h.index('  // ---------- 共有データに接続 ----------')
j = h.index('  window.__takubiyori = ')
h = h[:i] + '''  // ---------- スマホ内に保存 ----------
  (() => {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (d) for (const col of ["polls", "sessions", "scenarios"]) S[col] = Array.isArray(d[col]) ? d[col] : [];
    } catch { status("保存データを読み込めませんでした。", true); }
    S.scenarios.forEach((s) => (s.segments = Array.isArray(s.segments) ? s.segments : parseSpec(s.spec)));
    sortAll(); renderAll();
  })();

''' + h[j:]
rep('''  async function addDoc(col, data) {
    if (S.db) { const ref = await S.db.collection(col).add(data); upsertLocal(col, ref.id, data); return ref.id; }
    const id = "local-" + Math.random().toString(36).slice(2); upsertLocal(col, id, data); return id;
  }
  async function setDoc(col, id, data) { if (S.db) await S.db.collection(col).doc(id).set(data); upsertLocal(col, id, data); }
  async function delDoc(col, id) { if (S.db) await S.db.collection(col).doc(id).delete(); S[col] = S[col].filter((x) => x.id !== id); }''',
'''  const STORE_KEY = "takubiyori.v1";
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ polls: S.polls, sessions: S.sessions, scenarios: S.scenarios })); }
    catch { status("このスマホに保存できませんでした。プライベートブラウズを使っていないか確認してください。", true); }
  }
  async function addDoc(col, data) { const id = "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); upsertLocal(col, id, data); persist(); return id; }
  async function setDoc(col, id, data) { upsertLocal(col, id, data); persist(); }
  async function delDoc(col, id) { S[col] = S[col].filter((x) => x.id !== id); persist(); }''')

# 2) .ics: normal browser download
rep('''    host.innerHTML = `<div class="small muted">ファイルを保存できない環境です。''', '''    try {
      const url = URL.createObjectURL(new Blob([icsText(list)], { type: "text/calendar" }));
      const a = document.createElement("a"); a.href = url; a.download = /^[\x20-\x7e]+$/.test(filename) ? filename : `takubiyori_${Date.now().toString(36)}.ics`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return;
    } catch {}
    host.innerHTML = `<div class="small muted">ファイルを保存できない環境です。''')

# 3) clipboard button
rep('''<textarea id="imp-quick" placeholder="伝助で「卓日和にコピー」したら、ここを長押し → ペースト。それだけで読み込みます（同じ名前の表は新しい回答に更新）"></textarea>''',
'''<button type="button" class="primary big" id="clip-go">コピーした伝助を読み込む</button><textarea id="imp-quick" placeholder="ボタンが使えない時は、ここを長押し → ペースト（同じ名前の表は新しい回答に更新）"></textarea>''')
rep('''    $("#imp-go")?.addEventListener("click", () => doImport());''', '''    $("#imp-go")?.addEventListener("click", () => doImport());
    $("#clip-go")?.addEventListener("click", async () => {
      try {
        const v = await navigator.clipboard.readText();
        if (!v.trim()) { $("#quick-msg").textContent = "クリップボードが空です。伝助のページで「卓日和にコピー」を押してから読み込んでください。"; return; }
        if (!/\\t/.test(v)) { $("#quick-msg").textContent = "クリップボードの中身が伝助の表ではありませんでした。伝助のページで「卓日和にコピー」を押してください。"; return; }
        doImport(v);
      } catch { $("#quick-msg").textContent = "クリップボードを読めませんでした。下の欄に長押しで貼り付けてください。"; }
    });''')

# 4) backup footer
rep('''  <section class="panel" id="panel-scenarios" hidden></section>
</div>''', '''  <section class="panel" id="panel-scenarios" hidden></section>
  <details class="backup small">
    <summary>データのバックアップ</summary>
    <div class="muted">データはこのスマホのブラウザの中だけに保存されています。機種変更やブラウザのデータ削除の前にバックアップを保存してください。</div>
    <div class="row"><button type="button" id="bk-save">バックアップを保存</button><label class="btn">バックアップから復元<input type="file" id="bk-load" accept=".json,application/json" hidden></label></div>
    <div id="bk-msg"></div>
  </details>
</div>''')
rep('''  document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));''', '''  document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("#bk-save").addEventListener("click", () => {
    const d = new Date();
    const url = URL.createObjectURL(new Blob([JSON.stringify({ app: "takubiyori", version: 1, savedAt: d.toISOString(), polls: S.polls, sessions: S.sessions, scenarios: S.scenarios }, null, 1)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `takubiyori_backup_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  $("#bk-load").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.app !== "takubiyori") throw new Error();
      for (const col of ["polls", "sessions", "scenarios"]) S[col] = Array.isArray(d[col]) ? d[col] : [];
      sortAll(); persist(); renderAll();
      $("#bk-msg").textContent = `復元しました（調整表 ${S.polls.length}・セッション ${S.sessions.length}・シナリオ ${S.scenarios.length}）`;
    } catch { $("#bk-msg").textContent = "卓日和のバックアップファイルではありませんでした。"; }
    e.target.value = "";
  });''')
rep('''.quick { display: grid; gap: 4px; }''', '''.quick { display: grid; gap: 6px; }
button.big { font-size: 15px; padding: 10px 14px; justify-content: center; }
.backup { display: grid; gap: 6px; border-top: 1px solid var(--line); padding-top: 12px; }''')

# 5) remove claude-only meta, wrap as full document
h = h.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
head = '''<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#1f6f5c">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="卓日和">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231f6f5c'/%3E%3Ctext x='32' y='44' font-size='34' text-anchor='middle' fill='white' font-family='sans-serif'%3E卓%3C/text%3E%3C/svg%3E">
<style>[hidden]{display:none!important} :root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)} body{margin:0;font-size:14px}</style>
'''
t_end = h.index('</style>') + len('</style>')
h = head + h[:t_end] + '\n</head>\n<body>\n' + h[t_end:] + '\n</body>\n</html>\n'
open(sys.argv[1], 'w').write(h)

(function () {
  var $ = function (id) { return document.getElementById(id); };
  function show(cls, t) { var m = $("msg"); m.className = cls; m.textContent = t; }
  chrome.storage.local.get(["nv_client_id", "nv_client_secret"], function (v) {
    $("nv-id").value = v.nv_client_id || "";
    if (v.nv_client_secret) $("nv-secret").placeholder = "저장됨 (바꾸려면 새로 입력)";
  });
  /* 입력칸 값을 저장. 성공하면 cb(true) */
  function saveInputs(cb) {
    var id = $("nv-id").value.trim(), sec = $("nv-secret").value.replace(/\s+/g, ""), o = { nv_client_id: id };
    if (!id) { show("err", "애플리케이션 ID를 입력해주세요."); cb(false); return; }
    if (sec) {
      if (!/^\$2[aby]\$\d\d\$.{20,}/.test(sec)) { show("err", "시크릿 형식이 아닙니다. 커머스API센터의 '애플리케이션 시크릿'을 그대로 복사해 넣어주세요. (보통 $2a$ 로 시작)"); cb(false); return; }
      o.nv_client_secret = sec;
    }
    chrome.storage.local.get(["nv_client_secret"], function (v) {
      if (!sec && !v.nv_client_secret) { show("err", "애플리케이션 시크릿을 입력해주세요."); cb(false); return; }
      chrome.storage.local.set(o, function () {
        var e = chrome.runtime.lastError;
        if (e) { show("err", "저장 실패: " + e.message); cb(false); return; }
        $("nv-secret").value = ""; $("nv-secret").placeholder = "저장됨 (바꾸려면 새로 입력)"; cb(true);
      });
    });
  }
  $("save").onclick = function () { saveInputs(function (ok) { if (ok) show("ok", "✓ 저장했습니다. '연결 테스트'로 확인해보세요."); }); };
  $("test").onclick = function () {
    saveInputs(function (ok) { if (ok) runTest(); });
  };
  function runTest() {
    show("inf", "저장 완료 · 확인 중…");
    chrome.runtime.sendMessage({ type: "nvTest" }, function (r) {
      var e = chrome.runtime.lastError;
      if (e) { show("err", "오류: " + e.message); return; }
      if (r && r.ok) show("ok", "✓ 연결 성공 — 토큰 발급 완료" + (r.data && r.data.note ? "\n" + r.data.note : ""));
      else show("err", "연결 실패: " + ((r && r.error) || "알 수 없는 오류"));
    });
  }
  $("clear").onclick = function () {
    if (!confirm("저장된 스마트스토어 ID와 시크릿을 지울까요?")) return;
    chrome.storage.local.remove(["nv_client_id", "nv_client_secret", "nv_token"], function () { $("nv-id").value = ""; $("nv-secret").placeholder = "$2a$..."; show("inf", "지웠습니다."); });
  };
})();

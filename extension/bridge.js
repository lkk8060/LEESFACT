/* LEESFACT 페이지 <-> 확장프로그램 연결 다리. 페이지가 보낸 요청만 확장으로 전달합니다. */
(function () {
  var VERSION = chrome.runtime.getManifest().version;
  try { document.documentElement.setAttribute("data-lf-ext", VERSION); } catch (e) {}
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var m = ev.data;
    if (!m || m.__lf !== "req") return;
    chrome.runtime.sendMessage({ type: m.type, payload: m.payload || {} }, function (res) {
      var err = chrome.runtime.lastError;
      window.postMessage({
        __lf: "res", id: m.id,
        ok: !err && !!(res && res.ok),
        data: res && res.data,
        error: err ? err.message : (res && res.error) || "",
        code: res && res.code || ""
      }, window.location.origin);
    });
  });
  window.postMessage({ __lf: "hello", version: VERSION }, window.location.origin);
})();

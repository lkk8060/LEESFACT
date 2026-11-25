/* LEESFACT — KREAM 판매 상세 응답 복사 (MAIN world, document_start, kream.co.kr/my/* 에서만)
   KREAM 화면이 스스로 받은 '판매 상세(/api/m/asks/{번호})' 응답만 이 탭 메모리에 잠깐 보관합니다.
   요청을 새로 만들거나 바꾸지 않으며, 다른 곳으로 보내지 않습니다(확장이 같은 탭에서 읽은 뒤 지움). */
(function () {
  if (window.__LF_KR_HOOK) return;
  window.__LF_KR_HOOK = 1;
  window.__LF_KR_CAP = {};
  var RX = /^https:\/\/api\.kream\.co\.kr\/api\/m\/asks\/(\d+)(?:[/?]|$)/;
  var of = window.fetch;
  if (typeof of !== "function") return;
  window.fetch = function (input, init) {
    var p = of.apply(this, arguments);
    try {
      var u = typeof input === "string" ? input : (input && input.url) || String(input);
      var m = RX.exec(u);
      if (m) {
        var id = m[1];
        p.then(function (r) {
          try {
            var st = r.status;
            r.clone().text().then(function (t) {
              var j = null; try { j = JSON.parse(t); } catch (e) {}
              window.__LF_KR_CAP[id] = { status: st, body: j, at: Date.now() };
            }, function () { window.__LF_KR_CAP[id] = { status: st, body: null, at: Date.now() }; });
          } catch (e) {}
        }, function () { window.__LF_KR_CAP[id] = { status: 0, body: null, at: Date.now() }; });
      }
    } catch (e) {}
    return p;
  };
})();

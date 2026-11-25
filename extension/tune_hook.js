/* LEESFACT — TUNE 주문 데이터 받아보기 (tune.kr 페이지 안에서 실행, 읽기 전용)
   TUNE 화면이 스스로 불러오는 주문내역 응답(Shopify)을 복사해 확장으로 넘깁니다.
   요청을 새로 보내거나 토큰을 읽지 않습니다. */
(function () {
  if (window.__lfTuneHook) return;
  window.__lfTuneHook = 1;
  var of = window.fetch;
  if (typeof of !== "function") return;
  window.fetch = function (input, init) {
    var p = of.apply(this, arguments);
    try {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var body = init && init.body;
      if (/myshopify\.com\/api\/[^/]+\/graphql/.test(url) && typeof body === "string" && /orders\s*\(/.test(body)) {
        var q = (body.match(/query\s+(\w+)/) || [])[1] || "";
        p.then(function (res) {
          return res.clone().json().then(function (j) {
            var o = j && j.data && j.data.customer && j.data.customer.orders;
            if (o) window.postMessage({ __lfTune: "orders", q: q, orders: o }, window.location.origin);
          });
        }).catch(function () {});
      }
    } catch (e) {}
    return p;
  };
})();

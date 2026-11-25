/* LEESFACT — tune.kr 페이지에서 받은 주문 데이터를 확장 백그라운드로 전달 */
(function () {
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var m = ev.data;
    if (!m || m.__lfTune !== "orders" || !m.orders) return;
    try { chrome.runtime.sendMessage({ type: "tuneCapture", payload: { q: m.q, orders: m.orders } }); } catch (e) {}
  });
})();

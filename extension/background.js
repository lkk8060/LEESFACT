/* LEESFACT 구매내역 연동 — 백그라운드
   - LEESFACT 페이지(lkk8060.github.io)에서 온 요청만 처리합니다.
   - 무신사에는 조회(GET)만 합니다. 주문/취소/결제 등 어떤 변경 요청도 보내지 않습니다.
   - 1차: 확장에서 직접 조회 (브라우저 로그인 쿠키 사용)
     2차: 실패하면 무신사 탭(없으면 백그라운드로 잠깐 열기) 안에서 같은 조회를 실행 */

var ALLOWED_ORIGIN = "https://lkk8060.github.io";

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  var from = (sender && (sender.origin || sender.url)) || "";
  if (from.indexOf(ALLOWED_ORIGIN) !== 0) {
    sendResponse({ ok: false, error: "허용되지 않은 페이지" });
    return false;
  }
  handle(msg).then(
    function (data) { sendResponse({ ok: true, data: data }); },
    function (e) { sendResponse({ ok: false, error: String((e && e.message) || e), code: (e && e.code) || "" }); }
  );
  return true;
});

async function handle(msg) {
  var p = (msg && msg.payload) || {};
  if (msg.type === "ping") {
    return { version: chrome.runtime.getManifest().version, sites: ["musinsa"] };
  }
  if (msg.type === "orders") {
    if (p.site === "musinsa") return musinsaOrders(p.from, p.to);
    var e = new Error("아직 지원하지 않는 사이트입니다: " + p.site); e.code = "UNSUPPORTED"; throw e;
  }
  throw new Error("알 수 없는 요청: " + msg.type);
}

function checkDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ""))) throw new Error("날짜 형식 오류: " + d);
  return d;
}

async function musinsaOrders(from, to) {
  from = checkDate(from); to = checkDate(to);
  try {
    var rows = await collectMusinsa(from, to);
    return { site: "musinsa", mode: "direct", rows: rows, at: new Date().toISOString() };
  } catch (e) {
    console.warn("[LEESFACT] 직접 조회 실패 → 무신사 탭에서 재시도", e);
  }
  var rows2 = await runInMusinsaTab(from, to);
  return { site: "musinsa", mode: "tab", rows: rows2, at: new Date().toISOString() };
}

async function runInMusinsaTab(from, to) {
  var tabs = await chrome.tabs.query({ url: "https://www.musinsa.com/*" });
  var tab = tabs && tabs[0], created = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: "https://www.musinsa.com/order/order-list", active: false });
    created = true;
    await waitTabComplete(tab.id, 20000);
  }
  try {
    var res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: collectMusinsa,
      args: [from, to]
    });
    var r = res && res[0];
    if (!r) throw new Error("무신사 탭에서 결과를 받지 못했습니다.");
    if (r.error) throw new Error(r.error.message || String(r.error));
    return r.result;
  } catch (e) {
    var m = String((e && e.message) || e);
    if (/LOGIN/.test(m)) { var le = new Error("무신사 로그인이 필요합니다. 이 크롬에서 무신사에 로그인한 뒤 다시 시도해주세요."); le.code = "LOGIN"; throw le; }
    throw e;
  } finally {
    if (created) { try { await chrome.tabs.remove(tab.id); } catch (e) {} }
  }
}

function waitTabComplete(tabId, ms) {
  return new Promise(function (resolve) {
    var done = false;
    function fin() { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(l); resolve(); }
    function l(id, info) { if (id === tabId && info.status === "complete") fin(); }
    chrome.tabs.onUpdated.addListener(l);
    setTimeout(fin, ms);
  });
}

/* ⚠ 이 함수는 무신사 탭 안에서도 그대로 실행되므로 바깥 변수/함수를 쓰면 안 됩니다. */
async function collectMusinsa(from, to) {
  function num(v) { var n = Number(String(v == null ? "" : v).replace(/[^\d.-]/g, "")); return isFinite(n) ? n : 0; }
  async function J(u) {
    var r = await fetch(u, { credentials: "include", headers: { accept: "application/json" } });
    if (r.status === 401 || r.status === 403) throw new Error("LOGIN " + r.status);
    if (!r.ok) throw new Error("HTTP " + r.status + " " + u);
    var t = await r.text();
    try { return JSON.parse(t); } catch (e) { throw new Error("LOGIN (JSON 아님)"); }
  }
  async function pool(items, n, fn) {
    var i = 0, out = new Array(items.length);
    async function w() { while (i < items.length) { var k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; } } }
    var ws = []; for (var x = 0; x < n; x++) ws.push(w());
    await Promise.all(ws);
    return out;
  }

  // 1) 주문 목록 (페이지 넘김)
  var base = "https://api.musinsa.com/api2/claim/store/mypage/integration/order?size=15&searchText=&startDate=" + from + "&endDate=" + to;
  var orders = [], seen = {}, on = "", off = "";
  for (var p = 0; p < 60; p++) {
    var j = await J(base + (p ? "&onlineOffset=" + encodeURIComponent(on) + "&offlineOffset=" + encodeURIComponent(off) : ""));
    if (!j || !j.meta || j.meta.result !== "SUCCESS") throw new Error("LOGIN " + ((j && j.meta && j.meta.message) || "조회 실패"));
    var d = j.data || [], added = 0;
    for (var a = 0; a < d.length; a++) { var o = d[a]; if (o && o.orderNo && !seen[o.orderNo]) { seen[o.orderNo] = 1; orders.push(o); added++; } }
    if (!d.length || !added) break;
    if (j.meta.onlineOffset === on && j.meta.offlineOffset === off) break;
    on = j.meta.onlineOffset || ""; off = j.meta.offlineOffset || "";
    if ((!on || on === "0") && (!off || off === "0")) break;
  }
  orders = orders.filter(function (o) { return o.isOnline !== false; });

  // 2) 주문별 적립금 사용액 (주문 상세)
  var points = {};
  await pool(orders, 3, async function (o) {
    var v = await J("https://www.musinsa.com/order-service/my/order/get_order_view/" + o.orderNo);
    var info = (v && v.orderInfo) || {};
    points[o.orderNo] = num(info.use_point_amt);
  });

  // 3) 상품 정보 (품번/카테고리/정가)
  var gnos = [], gseen = {};
  orders.forEach(function (o) { (o.orderOptionList || []).forEach(function (x) { if (x.goodsNo && !gseen[x.goodsNo]) { gseen[x.goodsNo] = 1; gnos.push(x.goodsNo); } }); });
  var goods = {};
  await pool(gnos, 4, async function (g) {
    var v = await J("https://goods-detail.musinsa.com/api2/goods/" + g);
    var dd = (v && v.data) || {};
    goods[g] = {
      styleNo: String(dd.styleNo || "").trim(),
      cat1: (dd.category && dd.category.categoryDepth1Name) || "",
      cat2: (dd.category && dd.category.categoryDepth2Name) || "",
      normalPrice: num(dd.goodsPrice && dd.goodsPrice.normalPrice)
    };
  });

  // 4) 행 만들기 (주문 옵션 1개 = 1행)
  var rows = [];
  orders.forEach(function (o) {
    var opts = o.orderOptionList || [];
    var paidSum = opts.reduce(function (s, x) { return s + num(x.receiveAmount); }, 0);
    var pt = points[o.orderNo] || 0, ptLeft = pt;
    opts.forEach(function (x, idx) {
      var paid = num(x.receiveAmount);
      var share = 0;
      if (pt > 0) {
        share = idx === opts.length - 1 ? ptLeft : (paidSum > 0 ? Math.round(pt * paid / paidSum) : Math.round(pt / opts.length));
        ptLeft -= share;
      }
      var opt = String(x.goodsOption || x.originGoodsOption || "").trim();
      var parts = opt.split("·");
      var sizeRaw = parts.length > 1 ? parts[parts.length - 1].trim() : opt;
      var color = parts.length > 1 ? parts.slice(0, -1).join(" ").trim() : "";
      var size = sizeRaw, m;
      if ((m = sizeRaw.match(/\[(\d{2,3})\]/))) size = m[1];
      else if ((m = sizeRaw.match(/^(\d{2,3})(?:\D|$)/))) size = m[1];
      else size = sizeRaw.replace(/\s*\(.*?\)\s*/g, "").toUpperCase() || "FREE";
      if (/^\d+$/.test(size)) size = String(parseInt(size, 10));
      if (size === "0" || /^(ONE|ONESIZE|OS|F|FREE|FREESIZE|O\/S)$/.test(size)) size = "FREE";
      var g = goods[x.goodsNo] || {};
      var dt = String(o.orderDatetime || "");
      rows.push({
        site: "musinsa",
        key: "ms_" + x.orderOptionNo,
        orderNo: String(o.orderNo),
        orderOptionNo: String(x.orderOptionNo),
        orderDatetime: dt,
        date: dt.slice(0, 10),
        brand: x.brandName || "",
        goodsNo: x.goodsNo,
        goodsName: x.goodsName || "",
        styleNo: g.styleNo || "",
        cat1: g.cat1 || "",
        cat2: g.cat2 || "",
        normalPrice: g.normalPrice || 0,
        option: opt,
        color: color,
        size: size,
        quantity: num(x.quantity) || 1,
        paid: paid,
        point: share,
        orderState: num(x.orderState),
        claimState: num(x.claimState),
        stateText: x.orderStateText || "",
        image: x.goodsImage ? (String(x.goodsImage).indexOf("//") === 0 ? "https:" + x.goodsImage : x.goodsImage) : "",
        url: "https://www.musinsa.com/products/" + x.goodsNo
      });
    });
  });
  return rows;
}

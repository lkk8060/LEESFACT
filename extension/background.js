/* LEESFACT 구매내역 연동 — 백그라운드
   - LEESFACT 페이지(lkk8060.github.io)에서 온 요청만 처리합니다.
   - 무신사에는 조회(GET)만 합니다. 주문/취소/결제 등 어떤 변경 요청도 보내지 않습니다.
   - 1차: 확장에서 직접 조회 (브라우저 로그인 쿠키 사용)
     2차: 실패하면 무신사 탭(없으면 백그라운드로 잠깐 열기) 안에서 같은 조회를 실행 */

var ALLOWED_ORIGIN = "https://lkk8060.github.io";

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  var from = (sender && (sender.origin || sender.url)) || "";
  if (msg && msg.type === "tuneCapture") {           /* tune.kr 탭에서 받은 주문 데이터 */
    if (from.indexOf("https://tune.kr") === 0) tuneCaptured(msg.payload || {});
    return false;
  }
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
    return { version: chrome.runtime.getManifest().version, sites: ["musinsa", "tune"] };
  }
  if (msg.type === "orders") {
    if (p.site === "musinsa") return musinsaOrders(p.from, p.to);
    if (p.site === "tune") return tuneOrders(p.from, p.to);
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

  // 2) 주문별 적립금 사용액·카드 즉시할인 (주문 상세)
  //    즉시할인 = 결제금액(recv_amt) - 즉시 할인가(without_recv_amt_promotion_discount_amt)
  //    적립금 = point_amt (use_point_amt + pre_point_amt 선적립 사용 포함)
  var points = {}, instant = {};
  await pool(orders, 3, async function (o) {
    var v = await J("https://www.musinsa.com/order-service/my/order/get_order_view/" + o.orderNo);
    var info = (v && v.orderInfo) || {};
    points[o.orderNo] = num(info.point_amt) || (num(info.use_point_amt) + num(info.pre_point_amt));
    var recv = num(info.recv_amt), after = num(info.without_recv_amt_promotion_discount_amt);
    var inst = (recv > 0 && after > 0 && after < recv) ? recv - after : num(info.promotion_discount_amt);
    inst += num(info.affiliateCardDiscountAmount) && !(after > 0 && after < recv) ? num(info.affiliateCardDiscountAmount) : 0;
    instant[o.orderNo] = Math.max(0, inst);
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
    var pt = points[o.orderNo] || 0, ptLeft = pt, ins = instant[o.orderNo] || 0, insLeft = ins;
    opts.forEach(function (x, idx) {
      var paid = num(x.receiveAmount);
      var share = 0;
      if (pt > 0) {
        share = idx === opts.length - 1 ? ptLeft : (paidSum > 0 ? Math.round(pt * paid / paidSum) : Math.round(pt / opts.length));
        ptLeft -= share;
      }
      var cardDc = 0;
      if (ins > 0) {
        cardDc = idx === opts.length - 1 ? insLeft : (paidSum > 0 ? Math.round(ins * paid / paidSum) : Math.round(ins / opts.length));
        insLeft -= cardDc;
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
        cardDc: cardDc,
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


/* ===================== TUNE (tune.kr, Shopify) =====================
   TUNE 화면은 로그인할 때 주문 전체(최대 250건)를 Shopify에서 한 번에 받는다.
   확장은 tune.kr 주문내역 페이지를 백그라운드 탭으로 잠깐 열고, 그 화면이 받은 응답을 tune_hook.js로 복사해 온다.
   (요청을 새로 보내거나 로그인 토큰을 읽지 않음) */
var TUNE_WAIT = [];
function tuneCaptured(p) {
  var w = TUNE_WAIT.slice();
  w.forEach(function (f) { try { f(p); } catch (e) {} });
}
function tuneHasLines(o) {
  var nodes = ((o && o.edges) || []).map(function (e) { return e.node; }).concat((o && o.nodes) || []);
  return nodes.some(function (n) { return n && n.lineItems; }) || nodes.length === 0;
}
async function tuneOrders(from, to) {
  from = checkDate(from); to = checkDate(to);
  var got = null, best = null, done;
  var finished = new Promise(function (r) { done = r; });
  function onCap(p) {
    if (!p || !p.orders) return;
    if (tuneHasLines(p.orders)) { got = p; done(); }
    else if (!best) best = p;
  }
  TUNE_WAIT.push(onCap);
  var tab = await chrome.tabs.create({ url: "https://tune.kr/account/order-history", active: false });
  var timer = setTimeout(function () { done(); }, 35000);
  try {
    await finished;
  } finally {
    clearTimeout(timer);
    TUNE_WAIT = TUNE_WAIT.filter(function (f) { return f !== onCap; });
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
  }
  var cap = got || best;
  if (!cap) {
    var le = new Error("TUNE 주문내역을 받지 못했습니다. 이 크롬에서 tune.kr에 로그인돼 있는지 확인한 뒤 다시 시도해주세요.");
    le.code = "LOGIN"; throw le;
  }
  var rows = parseTune(cap.orders, from, to);
  return { site: "tune", mode: "capture", rows: rows, at: new Date().toISOString() };
}

function parseTune(orders, from, to) {
  function amt(v) { if (v == null) return 0; var x = typeof v === "object" ? v.amount : v; var n = Number(String(x).replace(/[^\d.-]/g, "")); return isFinite(n) ? Math.round(n) : 0; }
  function list(c) { if (!c) return []; return (c.edges || []).map(function (e) { return e.node; }).concat(c.nodes || []); }
  function kst(iso) { var t = Date.parse(iso || ""); if (!isFinite(t)) return ""; return new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " "); }
  function sizeOf(v, title) {
    var raw = "";
    var so = (v && v.selectedOptions) || [];
    for (var i = 0; i < so.length; i++) if (/size|사이즈/i.test(so[i].name || "")) { raw = so[i].value; break; }
    if (!raw) raw = (v && v.title) || "";
    raw = String(raw).trim();
    var m;
    if ((m = raw.match(/^(\d{2,3})(?:\D|$)/))) return String(parseInt(m[1], 10));
    var s = raw.replace(/\s*\(.*?\)\s*/g, "").toUpperCase();
    if (!s || /^(OS|O\/S|ONE ?SIZE|FREE|F|DEFAULT TITLE)$/.test(s)) return "FREE";
    return s;
  }
  function rawSize(v) {
    var so = (v && v.selectedOptions) || [];
    for (var i = 0; i < so.length; i++) if (/size|사이즈/i.test(so[i].name || "")) return String(so[i].value || "").trim();
    return String((v && v.title) || "").trim();
  }
  function styleOf(sku, size, raw) {
    sku = String(sku || "").trim();
    if (!sku) return "";
    var cands = [raw, String(raw || "").replace(/\s*\(.*?\)\s*/g, ""), size, "OS", "FREE", "ONESIZE"];
    for (var i = 0; i < cands.length; i++) {
      var c = String(cands[i] || "").trim();
      if (!c) continue;
      var re = new RegExp("[-_ /]" + c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");
      var s2 = sku.replace(re, "");
      if (s2 && s2 !== sku) return s2;
    }
    return sku;
  }
  var rows = [];
  list(orders).forEach(function (o) {
    if (!o) return;
    var dt = kst(o.processedAt), date = dt.slice(0, 10);
    if (!date || date < from || date > to) return;
    var name = String(o.name || o.orderNumber || "").replace(/^#/, "");
    var lines = list(o.lineItems);
    var L = lines.map(function (n, idx) {
      var orig = amt(n.originalTotalPrice);
      var disc = n.discountedTotalPrice != null ? amt(n.discountedTotalPrice) : orig;
      var alloc = (n.discountAllocations || []).reduce(function (s, a) { return s + amt(a.allocatedAmount); }, 0);
      return { n: n, idx: idx, orig: orig, disc: disc, alloc: alloc, fin: orig - alloc };
    });
    /* 주문 할인 후 상품 합계 = subtotalPrice (없으면 결제금액 - 배송비) */
    var target = amt(o.subtotalPrice) || (amt(o.totalPrice) - amt(o.totalShippingPrice));
    var sumA = L.reduce(function (s, x) { return s + x.fin; }, 0);
    var est = false;
    if (!(target > 0 && Math.abs(sumA - target) <= L.length)) {
      /* 상품별 배분 값이 없거나 합계가 안 맞으면: 상품별 할인가 합계와 주문 금액 차이를 상품 금액 비율로 나눔(추정) */
      var base = L.reduce(function (s, x) { return s + x.disc; }, 0), resid = base - target, left = resid;
      L.forEach(function (x, i) {
        var share = 0;
        if (target > 0 && resid > 0) { share = i === L.length - 1 ? left : Math.round(resid * x.disc / (base || 1)); left -= share; }
        x.fin = x.disc - share;
      });
      est = target > 0 && resid > 0;
    }
    var cancel = !!o.canceledReason || /VOIDED/.test(o.financialStatus || "");
    var shipped = /^(FULFILLED)$/.test(o.fulfillmentStatus || "");
    var ret = o.returnStatus && o.returnStatus.value ? String(o.returnStatus.value) : "";
    var seen = {};
    L.forEach(function (x) {
      var n = x.n, v = n.variant || {}, prod = v.product || {};
      var qty = Number(n.quantity) || 1;
      var cur = n.currentQuantity != null ? Number(n.currentQuantity) : qty;
      var size = sizeOf(v, n.title);
      var vid = String(v.id || "").replace(/\D/g, "") || ("i" + x.idx);
      var key = "tn_" + name + "_" + vid; if (seen[key]) key += "_" + x.idx; seen[key] = 1;
      var orderState = shipped ? 40 : 20, claimState = 0, stateText = shipped ? "발송 완료" : "상품 준비 중";
      if (cancel) { claimState = 90; stateText = "취소 완료"; }
      else if (cur <= 0) { claimState = 61; stateText = "반품 완료"; }
      else if (cur < qty) { claimState = 41; stateText = "부분 반품 (" + (qty - cur) + "/" + qty + ")"; }
      rows.push({
        site: "tune",
        key: key,
        orderNo: name,
        orderOptionNo: key,
        orderDatetime: dt,
        date: date,
        brand: prod.vendor || "",
        goodsNo: prod.handle || "",
        goodsName: n.title || prod.title || "",
        styleNo: styleOf(v.sku, size, rawSize(v)),
        sku: v.sku || "",
        cat1: /shoe|sneaker|신발|스니커즈/i.test(prod.productType || "") ? "신발" : (prod.productType || ""),
        cat2: "",
        normalPrice: amt(v.compareAtPrice) || amt(v.price),
        option: v.title || "",
        color: "",
        size: size,
        quantity: qty,
        paid: x.fin,
        cardDc: 0,
        point: 0,
        lineOrig: x.orig,
        orderDc: x.orig - x.fin,
        priceEst: est,
        orderState: orderState,
        claimState: claimState,
        stateText: stateText,
        returnNote: ret,
        image: (v.image && (v.image.url || v.image.src)) || "",
        url: prod.handle ? "https://tune.kr/products/" + prod.handle : ""
      });
    });
  });
  return rows;
}

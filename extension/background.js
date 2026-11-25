/* LEESFACT 구매내역 연동 — 백그라운드
   - LEESFACT 페이지(lkk8060.github.io)에서 온 요청만 처리합니다.
   - 무신사에는 조회(GET)만 합니다. 주문/취소/결제 등 어떤 변경 요청도 보내지 않습니다.
   - 1차: 확장에서 직접 조회 (브라우저 로그인 쿠키 사용)
     2차: 실패하면 무신사 탭(없으면 백그라운드로 잠깐 열기) 안에서 같은 조회를 실행 */

var ALLOWED_ORIGIN = "https://lkk8060.github.io";
try { importScripts("bcrypt.min.js"); } catch (e) { console.warn("[LEESFACT] bcrypt 로드 실패", e); }

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  var from = (sender && (sender.origin || sender.url)) || "";
  if (msg && msg.type === "tuneCapture") {           /* tune.kr 탭에서 받은 주문 데이터 */
    if (from.indexOf("https://tune.kr") === 0) tuneCaptured(msg.payload || {});
    return false;
  }
  var extPage = !!(sender && sender.id === chrome.runtime.id && String(sender.url || "").indexOf(chrome.runtime.getURL("")) === 0);
  if (extPage && msg && msg.type === "nvTest") {   /* 확장 설정 화면 (탭으로 열려도 허용) */
    nvToken(true).then(function () { sendResponse({ ok: true, data: { note: "이 PC IP에서 스마트스토어 API 호출이 허용돼 있습니다." } }); },
      function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    return true;
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
    var cr = await chrome.storage.local.get(["nv_client_id", "nv_client_secret"]);
    return { version: chrome.runtime.getManifest().version, sites: ["musinsa", "tune"], sales: ["naver", "kream"], naverReady: !!(cr.nv_client_id && cr.nv_client_secret) };
  }
  if (msg.type === "orders") {
    if (p.site === "musinsa") return musinsaOrders(p.from, p.to);
    if (p.site === "tune") return tuneOrders(p.from, p.to);
    var e = new Error("아직 지원하지 않는 사이트입니다: " + p.site); e.code = "UNSUPPORTED"; throw e;
  }
  if (msg.type === "sales") {
    if (p.site === "naver") return nvSales(p.from, p.to);
    if (p.site === "kream") return krSales(p);
    var e2 = new Error("아직 지원하지 않는 판매처입니다: " + p.site); e2.code = "UNSUPPORTED"; throw e2;
  }
  if (msg.type === "openOptions") { chrome.runtime.openOptionsPage(); return { opened: true }; }
  if (msg.type === "nv") return nvOp(p.op, p.params || {});
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


/* ===================== 네이버 스마트스토어 (커머스API) =====================
   - ID/시크릿은 확장 설정 화면에서 입력 → chrome.storage.local (이 PC에만 저장)
   - 토큰: client_secret_sign = base64(bcrypt(client_id + "_" + timestamp, 시크릿))
   - 매출: 구매확정(PURCHASE_DECIDED)된 상품주문만 조회 → 반품/취소된 주문은 자연히 빠짐
   - 조회만 함 (발송처리·주문확인 등 변경 요청 없음) */
var NV = "https://api.commerce.naver.com/external";
function nvSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function nvErr(status, j) {
  var code = (j && j.code) || "", m = (j && (j.message || j.error_description)) || ("HTTP " + status);
  if (/IP_NOT_ALLOWED/.test(code)) m = "이 PC의 IP가 커머스API센터 'API 호출 IP'에 등록돼 있지 않습니다. (" + m + ")";
  else if (status === 401 || /AUTH|TOKEN|CLIENT/i.test(code)) m = "인증 실패 — 애플리케이션 ID/시크릿을 확인해주세요. (" + m + ")";
  var e = new Error("스마트스토어: " + m); e.code = code || ("HTTP" + status); return e;
}
async function nvToken(force) {
  var c = await chrome.storage.local.get(["nv_client_id", "nv_client_secret", "nv_token"]);
  if (!c.nv_client_id || !c.nv_client_secret) { var e = new Error("스마트스토어 ID/시크릿이 없습니다. 확장프로그램 설정에서 입력해주세요."); e.code = "NOCRED"; throw e; }
  if (!force && c.nv_token && c.nv_token.id === c.nv_client_id && c.nv_token.exp > Date.now() + 60000) return c.nv_token.v;
  var bc = self.dcodeIO && self.dcodeIO.bcrypt;
  if (!bc) throw new Error("서명 라이브러리(bcrypt)를 불러오지 못했습니다.");
  var ts = String(Date.now() - 3000);
  var sign = btoa(bc.hashSync(c.nv_client_id + "_" + ts, c.nv_client_secret));
  var body = new URLSearchParams({ client_id: c.nv_client_id, timestamp: ts, client_secret_sign: sign, grant_type: "client_credentials", type: "SELF" });
  var r = await fetch(NV + "/v1/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  var j = {}; try { j = await r.json(); } catch (x) {}
  if (!r.ok || !j.access_token) throw nvErr(r.status, j);
  await chrome.storage.local.set({ nv_token: { v: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000, id: c.nv_client_id } });
  return j.access_token;
}
async function nvCall(method, path, body) {
  var tok = await nvToken(false);
  for (var t = 0; t < 4; t++) {
    var r = await fetch(NV + path, { method: method, headers: Object.assign({ Authorization: "Bearer " + tok }, body ? { "content-type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401 && t === 0) { tok = await nvToken(true); continue; }
    if (r.status === 429) { await nvSleep(1200 * (t + 1)); continue; }
    var j = {}; try { j = await r.json(); } catch (x) {}
    if (!r.ok) throw nvErr(r.status, j);
    return j;
  }
  throw new Error("스마트스토어: 요청이 너무 많아 잠시 후 다시 시도해주세요.");
}
function nvKst(ms) { return new Date(ms + 9 * 3600 * 1000).toISOString().replace("Z", "+09:00"); }
/* 기간 안에 상태가 바뀐 상품주문번호 (type 없으면 모든 변경) — 하루 단위 창 */
async function nvChangedIds(from, to, type) {
  var start = Date.parse(from + "T00:00:00+09:00"), end = Date.parse(to + "T23:59:59.999+09:00");
  var now = Date.now(); if (end > now) end = now;
  var ids = {}, order = [];
  for (var t = start; t <= end; t += 24 * 3600 * 1000) {
    var wEnd = Math.min(t + 24 * 3600 * 1000 - 1, end);
    var qFrom = nvKst(t), seq = "";
    for (var guard = 0; guard < 50; guard++) {
      var q = "lastChangedFrom=" + encodeURIComponent(qFrom) + "&lastChangedTo=" + encodeURIComponent(nvKst(wEnd)) + (type ? "&lastChangedType=" + type : "") + (seq ? "&moreSequence=" + encodeURIComponent(seq) : "");
      var j = await nvCall("GET", "/v1/pay-order/seller/product-orders/last-changed-statuses?" + q);
      var d = (j && j.data) || {};
      (d.lastChangeStatuses || []).forEach(function (x) { if (x && x.productOrderId && !ids[x.productOrderId]) { ids[x.productOrderId] = 1; order.push(String(x.productOrderId)); } });
      if (d.more && d.more.moreFrom) { qFrom = d.more.moreFrom; seq = d.more.moreSequence || ""; await nvSleep(250); } else break;
    }
    await nvSleep(250);
  }
  return order;
}
async function nvDetails(ids) {
  var details = [];
  for (var i = 0; i < ids.length; i += 300) {
    var jj = await nvCall("POST", "/v1/pay-order/seller/product-orders/query", { productOrderIds: ids.slice(i, i + 300) });
    details = details.concat((jj && jj.data) || []);
    await nvSleep(250);
  }
  return details;
}
async function nvSales(from, to) {
  from = checkDate(from); to = checkDate(to);
  var order = await nvChangedIds(from, to, "PURCHASE_DECIDED");
  var details = await nvDetails(order);
  return { site: "naver", rows: details.map(nvRow).filter(Boolean), count: order.length, at: new Date().toISOString() };
}
function nvRow(d) {
  var po = (d && d.productOrder) || {}, o = (d && d.order) || {};
  if (!po.productOrderId) return null;
  function n(v) { var x = Number(v); return isFinite(x) ? Math.round(x) : 0; }
  function kst(iso) { var t = Date.parse(iso || ""); if (!isFinite(t)) return ""; return new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " "); }
  var fee = 0, feeParts = {};
  Object.keys(po).forEach(function (k) { if (/Commission$/i.test(k) && isFinite(Number(po[k]))) { fee += Number(po[k]); feeParts[k] = Number(po[k]); } });
  fee = Math.round(fee);
  var paid = n(po.totalPaymentAmount), settle = po.expectedSettlementAmount != null ? n(po.expectedSettlementAmount) : paid - fee;
  var opt = String(po.productOption || "").trim(), sizeRaw = opt, m;
  if (opt.indexOf(":") >= 0) { var parts = opt.split("/"); var sp = parts.filter(function (x) { return /사이즈|size|SIZE/i.test(x); })[0] || parts[parts.length - 1]; sizeRaw = sp.split(":").slice(1).join(":").trim(); }
  var size = sizeRaw;
  if ((m = sizeRaw.match(/\((\d{2,3})\)/))) size = m[1];
  else if ((m = sizeRaw.match(/^(\d{2,3})(?:\D|$)/))) size = m[1];
  else size = sizeRaw.toUpperCase() || "FREE";
  var dt = kst(po.decisionDate || po.lastChangedDate || o.paymentDate);
  return {
    site: "naver", key: "nv_" + po.productOrderId, productOrderId: String(po.productOrderId), orderNo: String(o.orderId || po.orderId || ""),
    decisionDatetime: dt, date: dt.slice(0, 10), orderDatetime: kst(o.orderDate || o.paymentDate),
    productName: po.productName || "", option: opt, size: size,
    codes: [po.optionManageCode, po.sellerProductCode, po.sellerCustomCode1, po.sellerCustomCode2].filter(function (x) { return x && String(x).trim(); }).map(String),
    productId: String(po.productId || ""), quantity: n(po.quantity) || 1,
    paid: paid, fee: fee, settle: settle, feeParts: feeParts,
    status: po.productOrderStatus || "", claimType: po.claimType || "", claimStatus: po.claimStatus || ""
  };
}


/* ===================== 스마트스토어 조회 모음 (읽기 전용) =====================
   op: orders | products | settle | qnas | inquiries | raw
   각 결과는 { op, rows:[원본 객체...], at, note } — 페이지가 표·엑셀로 펼침 */
function nvDays(from, to) { return Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1; }
async function nvOp(op, p) {
  var at = new Date().toISOString();
  if (op === "orders") {
    var from = checkDate(p.from), to = checkDate(p.to);
    if (nvDays(from, to) > 31) throw new Error("주문 현황은 한 번에 31일까지만 조회할 수 있습니다.");
    var ids = await nvChangedIds(from, to, "");
    var det = await nvDetails(ids);
    return { op: op, rows: det, at: at };
  }
  if (op === "products") {
    var rows = [], page = 1, total = 1;
    for (; page <= total && page <= 40; page++) {
      var body = { page: page, size: 500 };
      if (p.statuses && p.statuses.length) body.productStatusTypes = p.statuses;
      var j = await nvCall("POST", "/v1/products/search", body);
      var cs = (j && j.contents) || [];
      cs.forEach(function (c) {
        var chs = c.channelProducts || [];
        if (!chs.length) rows.push({ originProductNo: c.originProductNo });
        chs.forEach(function (ch) { rows.push(Object.assign({ originProductNo: c.originProductNo }, ch)); });
      });
      total = Number(j && j.totalPages) || 1;
      await nvSleep(300);
    }
    return { op: op, rows: rows, at: at };
  }
  if (op === "settle") {
    var f = checkDate(p.from), t2 = checkDate(p.to), kind = p.kind === "case" ? "case" : "daily";
    var out = [], pg = 1, more = true;
    for (; more && pg <= 50; pg++) {
      var jj = await nvCall("GET", "/v1/pay-settle/settle/" + kind + "?startDate=" + f + "&endDate=" + t2 + "&pageNumber=" + pg + "&pageSize=1000");
      var el = (jj && (jj.elements || jj.data || jj.contents)) || [];
      if (!Array.isArray(el) && el && Array.isArray(el.elements)) el = el.elements;
      out = out.concat(Array.isArray(el) ? el : []);
      var tp = jj && (jj.pagination ? jj.pagination.totalPages : jj.totalPages);
      more = tp ? pg < tp : (Array.isArray(el) && el.length >= 1000);
      await nvSleep(300);
    }
    return { op: op, rows: out, at: at, note: kind };
  }
  if (op === "qnas") {
    var qf = checkDate(p.from), qt = checkDate(p.to), qrows = [], qp = 1, qtot = 1;
    for (; qp <= qtot && qp <= 30; qp++) {
      var qs = "fromDate=" + encodeURIComponent(qf + "T00:00:00.000+09:00") + "&toDate=" + encodeURIComponent(qt + "T23:59:59.999+09:00") + "&page=" + qp + "&size=100" + (p.unanswered ? "&answered=false" : "");
      var qj = await nvCall("GET", "/v1/contents/qnas?" + qs);
      var qc = (qj && (qj.contents || qj.data)) || [];
      qrows = qrows.concat(qc);
      qtot = Number(qj && qj.totalPages) || 1;
      await nvSleep(300);
    }
    return { op: op, rows: qrows, at: at };
  }
  if (op === "inquiries") {
    var inf = checkDate(p.from), intt = checkDate(p.to), irows = [], ip = 1, itot = 1;
    for (; ip <= itot && ip <= 30; ip++) {
      var iq = "startSearchDate=" + inf + "&endSearchDate=" + intt + "&page=" + ip + "&size=200" + (p.unanswered ? "&answered=false" : "");
      var ij = await nvCall("GET", "/v1/pay-user/inquiries?" + iq);
      var ic = (ij && (ij.content || ij.contents || ij.data)) || [];
      irows = irows.concat(ic);
      itot = Number(ij && ij.totalPages) || 1;
      await nvSleep(300);
    }
    return { op: op, rows: irows, at: at };
  }
  if (op === "raw") {   /* 조회 전용: GET만, /v1 아래 경로만 */
    var path = String(p.path || "");
    if (!/^\/v\d\/[A-Za-z0-9\/_\-]+(\?[^#\s]*)?$/.test(path)) throw new Error("경로 형식 오류: /v1/... 로 시작하는 조회 경로만 됩니다.");
    var rj = await nvCall("GET", path);
    var arr = Array.isArray(rj) ? rj : (rj && (rj.data || rj.contents || rj.elements || rj.content));
    return { op: op, rows: Array.isArray(arr) ? arr : [rj], at: at, raw: rj };
  }
  throw new Error("알 수 없는 스마트스토어 조회: " + op);
}

/* ===================== KREAM 판매내역 (v1.4.0) =====================
   - 작은 KREAM 창(포커스 없음)을 열어 '판매 내역 > 종료' 화면을 KREAM 자신이 그리게 하고,
     목록은 화면에 그려진 내용으로, 판매 상세는 KREAM 화면 이동($router)으로 받은 화면 데이터에서 읽습니다.
   - API 직접 호출·헤더 흉내·토큰 사용 없음. 버튼(판매/입찰/취소 등)은 절대 누르지 않습니다.
   - 차단 방지: 상세 1건마다 4~7초 간격, 1회 최대 60건, 실행 간 최소 3분, 응답 없음 2번이면 즉시 중단 후 1시간 쉼.
   - 정산완료 건은 확장 저장소에 보관해 다음부터 다시 읽지 않음. 주소·전화·계좌·카드 등 개인정보는 저장하지 않음. */
var KR_RUN = false;
function krSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function krRand(a, b) { return a + Math.floor(Math.random() * (b - a)); }
function krErr(code, m) { var e = new Error(m); e.code = code; return e; }

async function krExec(tabId, func, args) {
  var r = await chrome.scripting.executeScript({ target: { tabId: tabId }, world: "MAIN", func: func, args: args || [] });
  var x = r && r[0];
  if (!x) throw new Error("KREAM 창에서 결과를 받지 못했습니다.");
  if (x.error) throw new Error(x.error.message || String(x.error));
  return x.result;
}

/* ⚠ KREAM 창 안에서 실행 — 바깥 변수 사용 금지. 화면에 그려진 '종료' 목록을 읽고, 필요하면 아래로 스크롤(사람이 넘기는 속도) */
async function krListStep(from, to, maxScroll) {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function parse() {
    var out = [], seen = {};
    document.querySelectorAll('a[href*="/my/selling/"]').forEach(function (a) {
      var m = (a.getAttribute("href") || "").match(/\/my\/selling\/(\d+)/); if (!m || seen[m[1]]) return; seen[m[1]] = 1;
      var L = String(a.innerText || "").split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
      var date = "", di = -1;
      for (var i = 0; i < L.length; i++) { var d = L[i].match(/^(\d{2})\/(\d{2})\/(\d{2})$/); if (d) { date = "20" + d[1] + "-" + d[2] + "-" + d[3]; di = i; break; } if (L[i] === "-" && i >= 1 && di < 0) { di = i; break; } }
      out.push({ id: m[1], name: L[0] || "", opt: di > 1 ? L[1] : "", date: date, status: di >= 0 ? L.slice(di + 1).join(" ") : L.slice(2).join(" ") });
    });
    return out;
  }
  if (location.pathname.indexOf("/login") === 0) return { login: false };
  var t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (parse().length || /종료된 판매 내역이 없|내역이 없습니다/.test(document.body.innerText || "")) break; if (location.pathname.indexOf("/login") === 0) return { login: false }; await sleep(500); }
  var rows = parse(), scrolls = 0;
  while (scrolls < maxScroll) {
    var dated = rows.filter(function (r) { return r.date; }), tail = dated.slice(-5);
    if (tail.length && tail.every(function (r) { return r.date < from; })) break;
    var n0 = rows.length;
    window.scrollTo(0, document.documentElement.scrollHeight);
    scrolls++;
    var grew = false;
    for (var k = 0; k < 16; k++) { await sleep(500); rows = parse(); if (rows.length > n0) { grew = true; break; } }
    if (!grew) break;
    await sleep(2500 + Math.floor(Math.random() * 1500));
  }
  return { login: true, scrolls: scrolls, total: rows.length, rows: rows.filter(function (r) { return r.date && r.date >= from && r.date <= to; }) };   /* 취소 등 날짜 없는 건 제외 */
}

/* ⚠ KREAM 창 안에서 실행 — 판매 상세 화면으로 이동(KREAM 화면 자신의 이동)하고,
   kream_hook.js가 복사해 둔 그 화면의 상세 응답에서 필요한 항목만 꺼냄 (첫 이동은 화면 저장값으로도 확인) */
async function krDetailStep(id) {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function v(x) { return x && typeof x === "object" ? Number(x.value) || 0 : Number(x) || 0; }
  function pick(d) {
    var pb = d.price_breakdown || {}, pr = d.product || {}, rel = pr.release || {}, br = pr.brand || {};
    return {
      id: String(d.id), oid: d.oid || "", price: Number(d.price) || Number(pb.price) || 0, isInstant: !!d.is_instant,
      option: d.option || (d.product_option && d.product_option.name) || "", status: d.status || "", statusText: d.status_display || "",
      created: d.date_created || "", traded: (d.transaction && d.transaction.date_created) || "", paid: d.date_paid || "",
      shipment: d.shipment_method || "", txType: d.transaction_type || "",
      feeProc: v(pb.processing_fee), feeAuth: v(pb.authentication_fee), payout: Number(pb.total_payout) || 0,
      penalty: (d.penalty && Number(d.penalty.amount)) || 0,
      name: rel.translated_name || rel.name || "", en: rel.name || "", style: rel.style_code || "", brand: br.name || "",
      category: rel.shop_category_name || rel.category || "", productId: rel.id || d.product_id || ""
    };
  }
  var app = document.querySelector("#__nuxt") && document.querySelector("#__nuxt").__vue_app__;
  if (!app) return { err: "NOAPP" };
  if (!window.__LF_KR_HOOK) return { err: "NOHOOK" };
  var g = app.config.globalProperties, CAP = window.__LF_KR_CAP || {};
  delete CAP[id];
  function cur() { try { return g.$pinia.state.value.my.myAskDetail; } catch (e) { return null; } }
  try { await g.$router.push("/my/selling/" + id); } catch (e) {}
  for (var t = 0; t < 60; t++) {
    if (location.pathname.indexOf("/login") === 0) return { err: "LOGIN" };
    var c = CAP[id];
    if (c) {
      delete CAP[id];
      if (c.status === 401) return { err: "LOGIN" };
      if (c.status !== 200) return { err: "HTTP", status: c.status };
      var b = c.body; if (b && !b.price_breakdown && b.data && b.data.price_breakdown) b = b.data;
      if (b && String(b.id) === String(id)) return { d: pick(b) };
      return { err: "SHAPE" };
    }
    var d = cur();
    if (d && String(d.id) === String(id) && d.price_breakdown) return { d: pick(d) };
    await sleep(250);
  }
  return { err: "TIMEOUT" };
}

function krKst(iso, len) { var t = Date.parse(iso || ""); if (!isFinite(t)) return ""; return new Date(t + 9 * 3600 * 1000).toISOString().slice(0, len || 16).replace("T", " "); }
function krRow(l, d) {
  d = d || {};
  var price = d.price || 0, settle = d.payout || 0;
  var type = !d.id ? "" : d.shipment && d.shipment !== "normal" ? (/inventory|storage|keep/i.test(d.shipment) ? "보관판매" : d.shipment) : "일반판매";
  return {
    key: "kr_" + l.id, site: "kream", askId: l.id, oid: d.oid || "", detail: !!d.id,
    date: (d.paid ? krKst(d.paid, 10) : "") || l.date || "", paidDatetime: krKst(d.paid), saleDate: krKst(d.traded || d.created),
    productName: d.name || l.name, en: d.en || "", brand: d.brand || "", category: d.category || "",
    codes: d.style ? String(d.style).split("/").map(function (s) { return s.trim(); }).filter(function (s) { return s && s !== "-"; }) : [],
    style: d.style || "", size: d.option || l.opt || "", quantity: 1,
    type: type + (d.id ? (d.isInstant ? " · 즉시판매" : " · 판매입찰") : ""), status: d.statusText || l.status || "", statusCode: d.status || "",
    listStatus: l.status || "",
    price: price, feeProc: d.feeProc || 0, feeAuth: d.feeAuth || 0, penalty: d.penalty || 0,
    fee: d.id && settle > 0 ? price - settle : 0, settle: settle, settled: !!(d.paid && settle > 0)
  };
}

async function krSales(p) {
  var from = checkDate(p.from), to = checkDate(p.to);
  var maxNew = Math.max(1, Math.min(150, Number(p.max) || 60));
  if (KR_RUN) throw krErr("BUSY", "이미 KREAM 판매내역을 읽는 중입니다. 끝날 때까지 기다려주세요.");
  var st = await chrome.storage.local.get(["kr_cache", "kr_block_until", "kr_last_run"]);
  var now = Date.now();
  if ((st.kr_block_until || 0) > now) throw krErr("BLOCK", "KREAM 응답이 없어 쉬는 중입니다 (" + new Date(st.kr_block_until).toLocaleTimeString("ko-KR") + " 이후 다시 시도). 평소 크롬에서 KREAM 마이페이지가 정상으로 열리는지 확인해주세요.");
  if (now - (st.kr_last_run || 0) < 180000) {
    var wait = Math.ceil((180000 - (now - st.kr_last_run)) / 1000);
    throw krErr("WAIT", "KREAM 보호를 위해 3분 간격으로만 불러옵니다. " + wait + "초 뒤에 다시 눌러주세요.");
  }
  KR_RUN = true;
  await chrome.storage.local.set({ kr_last_run: now });
  var cache = st.kr_cache || {}, win = null, tabId = null, list = [], fetched = 0, pending = 0, stopped = "", scrolls = 0, total = 0;
  try {
    win = await chrome.windows.create({ url: "https://kream.co.kr/my/selling?tab=finished", type: "popup", focused: false, width: 460, height: 760 });
    tabId = win.tabs && win.tabs[0] && win.tabs[0].id;
    if (!tabId) { var ts = await chrome.tabs.query({ windowId: win.id }); tabId = ts[0] && ts[0].id; }
    await waitTabComplete(tabId, 30000);
    await krSleep(2500);
    var L = await krExec(tabId, krListStep, [from, to, 30]);
    if (!L || L.login === false) throw krErr("LOGIN", "KREAM 로그인이 필요합니다. 이 크롬에서 kream.co.kr에 로그인한 뒤 다시 시도해주세요.");
    list = L.rows || []; scrolls = L.scrolls; total = L.total;
    var need = list.filter(function (r) {
      if (/취소|거부|불합격|실패|만료/.test(r.status)) return false;
      var c = cache[r.id]; return !(c && c.status === "payout_completed" && c.paid);
    });
    pending = need.length;
    var fails = 0;
    for (var i = 0; i < need.length && fetched < maxNew; i++) {
      await krSleep(krRand(4000, 7000));
      var res = await krExec(tabId, krDetailStep, [need[i].id]);
      if (res && res.d) { cache[res.d.id] = res.d; fetched++; pending--; fails = 0; if (fetched % 5 === 0) await chrome.storage.local.set({ kr_cache: cache }); continue; }
      var code = res && res.err;
      if (code === "LOGIN") { stopped = "LOGIN"; break; }
      if (code === "NOHOOK" || code === "NOAPP" || code === "SHAPE") { stopped = code; break; }
      if (code === "HTTP") {   /* 403·429·5xx 등 → 즉시 멈추고 6시간 쉼 */
        stopped = "BLOCK"; await chrome.storage.local.set({ kr_block_until: Date.now() + 6 * 3600000, kr_block_status: res.status }); break;
      }
      fails++;
      if (fails >= 2) {
        stopped = "BLOCK";
        await chrome.storage.local.set({ kr_block_until: Date.now() + 3600000 });
        break;
      }
      await krSleep(10000);
      i--;   /* 같은 건 한 번 더 */
    }
  } catch (e) {
    if (e && e.code) throw e;
    if (/No tab|closed|Frame|removed/i.test(String(e && e.message))) stopped = "CLOSED";
    else throw e;
  } finally {
    KR_RUN = false;
    var keys = Object.keys(cache);
    if (keys.length > 4000) { keys.sort(function (a, b) { return String(cache[a].paid || cache[a].created).localeCompare(String(cache[b].paid || cache[b].created)); }); keys.slice(0, keys.length - 4000).forEach(function (k) { delete cache[k]; }); }
    await chrome.storage.local.set({ kr_cache: cache });
    if (win) { try { await chrome.windows.remove(win.id); } catch (e) {} }
  }
  var rows = list.map(function (l) { return krRow(l, cache[l.id]); });
  return { site: "kream", rows: rows, at: new Date().toISOString(), fetched: fetched, pending: pending, stopped: stopped, listed: total, scrolls: scrolls };
}

/* QuetDoc QRcode — Quét mã & ghi nhận dữ liệu (có đăng nhập phân quyền)
 * Static app: mọi dữ liệu lưu ở localStorage của trình duyệt, không gửi đi đâu.
 * - Mỗi mã chỉ ghi nhận 1 lần duy nhất; quét trùng -> cảnh báo "Đã được quét", bỏ qua.
 * - Phân quyền: admin (quản lý tài khoản) / user (chỉ quét + xem bản ghi của mình).
 */
"use strict";

const STORE_KEY = "quetdoc_qrcode_v1";
const DUP_COOLDOWN_MS = 2500;
const PAGE_SIZE = 50;
const TZ = "Asia/Ho_Chi_Minh";

/* ---------------- Supabase (đồng bộ cloud đa thiết bị) ---------------- */
const SUPABASE_URL = "https://cdxoaoemnidwuzentxrc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_IIXJQBX31Krk32yyU1Fp2Q_4BlwGJKx";
const EMAIL_DOMAIN = "quetdoc.local"; // user1 -> user1@quetdoc.local (email nội bộ)
const emailOf = (u) => String(u || "").trim().toLowerCase() + "@" + EMAIL_DOMAIN;

let supa = null;       // Supabase client
let rtChannel = null;  // kênh realtime
let reloadTimer = null;

// Đợi thư viện supabase-js (nạp async, không chặn trang). Ném lỗi nếu quá lâu.
async function ensureSupa() {
  if (supa) return supa;
  for (let i = 0; i < 40; i++) {
    try {
      if (typeof window.supabase !== "undefined" && window.supabase.createClient) {
        supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        return supa;
      }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Không tải được thư viện kết nối máy chủ. Kiểm tra mạng rồi tải lại trang.");
}

/* ---------------- state ---------------- */
const state = {
  records: [],          // [{id, content, format, scannedAt, session, note, userId, username}]
  dupSkipped: 0,        // số lượt quét trùng đã bỏ qua
  dash: null,           // v5.4: cache số liệu dashboard {rows, at}
  settings: { session: "", note: "", sound: true, sizeUK: "", pairs: 6 },
  me: null,             // user đang đăng nhập {id, username, role}
  scanning: false,
  videoWatch: null,     // v6.3: watchdog iOS — hẹn giờ kiểm tra video có lên hình không
  cameras: [],
  cameraId: null,
  camManual: false,     // true khi user tự chọn camera trong dropdown
  realFacing: "",       // facingMode THỰC TẾ đọc từ camera track ("environment"/"user")
  displayNames: {},     // v6.5: username (lowercase) -> tên NV/mã NV cho cột "Người quét"
  torchOn: false,
  lastContent: "",
  lastAt: 0,
  page: 0,
  filterText: "",
  filterDate: "",
  directives: {},       // (giữ tương thích) thay bằng master bên dưới
  master: {},           // master data đơn hàng: { "AE2608622": {po, rows:[...]} }
  masterRows: [],       // mảng dòng master_orders cho bảng admin
  masterReady: false,   // true khi đã tải master thành công
  packing: [],          // v5.0: mảng khoảng packing_ranges
  packingByChi: new Map(), // v5.0: chi_thi -> [ranges] (tra cứu O(1) khi quét)
  packingReady: false,  // true khi đã tải packing thành công
};

let html5Qr = null;

/* ---------------- helpers ---------------- */
const $ = (id) => document.getElementById(id);
const norm = (s) => String(s == null ? "" : s).trim().toUpperCase();

/* LocalStorage an toàn: một số trình duyệt (máy công ty, chế độ chặn site data)
 * ném lỗi khi chạm vào localStorage. Bọc lại để app KHÔNG BAO GIỜ chết với trang đen. */
let storageOK = true;
const safeLS = {
  get(k) { try { return window.localStorage.getItem(k); } catch (e) { storageOK = false; return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { storageOK = false; } },
  del(k) { try { window.localStorage.removeItem(k); } catch (e) { storageOK = false; } },
};

function fmtTime(iso) {
  try { return new Date(iso).toLocaleString("vi-VN", { timeZone: TZ, hour12: false }); }
  catch (e) { return iso; }
}
function todayStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
}
function fmtTimeOnly(iso) {
  try { return new Date(iso).toLocaleTimeString("vi-VN", { timeZone: TZ, hour12: false }); }
  catch (e) { return ""; }
}
/* Tem thùng giày: số thùng VD "AE260821060012" -> chỉ thị = 9 ký tự đầu (2 chữ + 7 số) */
function parseChiThi(content) {
  const m = String(content || "").trim().match(/^([A-Za-z]{2}\d{7})/);
  return m ? m[1].toUpperCase() : "";
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function toast(msg, kind) {
  const box = $("toasts");
  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = ".3s"; }, 2600);
  setTimeout(() => el.remove(), 3000);
  while (box.children.length > 4) box.firstChild.remove();
}
function beep(ok) {
  if (!state.settings.sound) return;
  try {
    const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine"; o.frequency.value = ok ? 880 : 320;
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.25);
  } catch (e) { /* bỏ qua nếu trình duyệt chặn audio */ }
}
function beepDup() { beep(false); setTimeout(() => beep(false), 200); }

/* ---------------- storage: cài đặt trên máy (phiên, ghi chú, âm thanh) ----------------
 * Bản ghi quét giờ lưu trên Supabase (đồng bộ đa thiết bị), không còn trong localStorage. */
function loadStore() {
  try {
    const raw = safeLS.get(STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.dupSkipped === "number") state.dupSkipped = data.dupSkipped;
    if (data.settings && typeof data.settings === "object") {
      state.settings = Object.assign(state.settings, data.settings);
    }
  } catch (e) { console.warn("Không đọc được cài đặt cũ:", e); }
}
function saveStore() {
  safeLS.set(STORE_KEY, JSON.stringify({
    dupSkipped: state.dupSkipped, settings: state.settings, v: 3,
  }));
}

/* ---------------- auth (Supabase Auth - đồng bộ đa thiết bị) ---------------- */
// Người dùng vẫn gõ tên ngắn (user1); app tự đổi thành email nội bộ user1@quetdoc.local
const isAdmin = () => !!(state.me && state.me.role === "admin");

async function afterAuth(sb, user) {
  const uname = String(user.email || "").split("@")[0].toLowerCase();
  const role = uname === "admin" ? "admin" : "user";
  try {
    await sb.from("profiles").upsert({ id: user.id, username: uname, role }, { onConflict: "id" });
  } catch (e) { console.warn("upsert profile:", e.message); }
  let prof = null;
  try {
    const r = await sb.from("profiles").select("username,role").eq("id", user.id).single();
    prof = r.data || null;
  } catch (e) {}
  state.me = { id: user.id, username: (prof && prof.username) || uname, role: (prof && prof.role) || role };
  $("loginPass").value = "";
  subscribeRealtime(sb);
  toast("Xin chào, " + state.me.username + "! Dữ liệu đồng bộ trực tiếp.", "ok");
  await enterApp();
}

async function doLogin() {
  const name = $("loginUser").value.trim();
  const pass = $("loginPass").value;
  const err = $("loginErr");
  err.textContent = "";
  if (!name || !pass) { err.textContent = "Nhập tên đăng nhập và mật khẩu."; return; }
  let sb;
  try { sb = await ensureSupa(); }
  catch (e) { err.textContent = e.message; return; }
  err.textContent = "Đang đăng nhập…";
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email: emailOf(name), password: pass });
    if (error || !data.user) { err.textContent = "Sai tên đăng nhập hoặc mật khẩu."; return; }
    err.textContent = "";
    await afterAuth(sb, data.user);
  } catch (e) {
    err.textContent = "Không kết nối được máy chủ: " + (e.message || e);
  }
}
function doLogout() {
  try { stopScan(); } catch (e) {}
  try {
    if (supa) {
      if (rtChannel) { supa.removeChannel(rtChannel); rtChannel = null; }
      supa.auth.signOut().catch(() => {});
    }
  } catch (e) {}
  state.me = null;
  state.records = [];
  state.directives = {};
  state.master = {}; state.masterRows = []; state.masterReady = false;
  state.packing = []; state.packingByChi = new Map(); state.packingReady = false;
  $("viewApp").classList.add("hidden");
  $("viewLogin").classList.remove("hidden");
  $("loginUser").value = "";
  $("loginErr").textContent = "";
}
async function enterApp() {
  if (!state.me) { doLogout(); return; }
  $("viewLogin").classList.add("hidden");
  $("viewApp").classList.remove("hidden");
  $("chipName").textContent = state.me.username;
  const rc = $("chipRole");
  rc.textContent = state.me.role === "admin" ? "Quản trị" : "Nhân viên";
  rc.className = "role " + state.me.role;
  const admin = isAdmin();
  $("adminPanel").classList.toggle("hidden", !admin);
  $("masterPanel").classList.toggle("hidden", !admin);
  $("packingPanel").classList.toggle("hidden", !admin);
  $("btnClear").innerHTML = admin ? "🗑 Xóa tất cả" : "🗑 Xóa bản ghi của tôi";
  $("dataHint").textContent = admin
    ? "Bạn đang xem toàn bộ bản ghi của mọi tài khoản — đồng bộ trực tiếp. Bấm vào ô PO / Size để sửa."
    : "Bạn chỉ xem được các mã do chính mình quét. Bấm vào ô PO / Size để sửa.";
  state.page = 0;
  renderHead();
  loadDisplayNames(); // v6.5: mapping tên NV cho cột "Người quét" (không chặn UI)
  try {
    await loadRecords();
    await loadMaster();
    await loadPacking(); // v5.0: khoảng thùng -> size (tra cứu khi quét)
    if (admin) await loadAccounts();
  } catch (e) {
    toast("Không tải được dữ liệu: " + (e.message || e), "err");
  }
  refreshSession(); // v5.3: đối chiếu phiên quét với dữ liệu vừa tải + bật/tắt nút quét
  refreshDashboard(); // v5.4: tải số liệu dashboard (không chặn UI)
  if (admin) renderUserSummary(); // v6.7: tổng hợp theo nhân viên (không chặn UI)
}

/* ---------------- realtime: tự cập nhật khi máy khác quét ---------------- */
function subscribeRealtime(sb) {
  try {
    if (rtChannel) sb.removeChannel(rtChannel);
    rtChannel = sb.channel("quetdoc-records")
      .on("postgres_changes", { event: "*", schema: "public", table: "records" }, () => scheduleReload())
      .subscribe();
  } catch (e) {}
}
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { loadRecords().catch(() => {}); }, 600);
}

/* ---------------- modal ---------------- */
let modalOkFn = null;
function openModal(title, bodyHTML, okLabel, onOk) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = bodyHTML;
  $("modalOk").textContent = okLabel || "Đồng ý";
  modalOkFn = onOk;
  $("modal").classList.remove("hidden");
  const first = $("modalBody").querySelector("input");
  if (first) setTimeout(() => first.focus(), 50);
}
function closeModal() { $("modal").classList.add("hidden"); modalOkFn = null; }

// v4.4: Size mỗi thùng mỗi khác (UK 3.0-9.0), không có trong QR -> công nhân
// chạm chọn 1 lần trên pad, size "dính" cho các mã quét tiếp theo tới khi đổi.
const SIZES_UK = ["3.0","3.5","4.0","4.5","5.0","5.5","6.0","6.5","7.0","7.5","8.0","8.5","9.0"];
function currentSizeStr() {
  const s = state.settings.sizeUK;
  return s ? s + "-" + (state.settings.pairs ?? 6) : "";
}
function renderSizePad() {
  const wrap = $("sizePad");
  if (!wrap) return;
  wrap.innerHTML = SIZES_UK.map((s) =>
    "<button class='szbtn" + (state.settings.sizeUK === s ? " active" : "") +
    "' data-size='" + s + "'>" + s + "</button>").join("") +
    "<button class='szbtn clear' data-size='' title='Bỏ chọn'>✖</button>";
  wrap.querySelectorAll(".szbtn").forEach((b) =>
    b.addEventListener("click", () => {
      state.settings.sizeUK = b.getAttribute("data-size");
      saveStore(); renderSizePad();
    }));
  renderPairs();
}
function renderPairs() {
  const v = $("pairsVal"), pv = $("sizePreview");
  if (v) v.textContent = state.settings.pairs ?? 6;
  if (pv) {
    const s = currentSizeStr();
    pv.textContent = s ? ("→ các mã sắp quét sẽ ghi: " + s) : "→ chưa chọn size (mã quét sẽ trống size)";
  }
}
function bumpPairs(d) {
  const p = Math.min(20, Math.max(0, (state.settings.pairs ?? 6) + d));
  state.settings.pairs = p;
  saveStore(); renderPairs();
}

/* ---------------- records (Supabase - dữ liệu chung đa thiết bị) ---------------- */
const rowToRec = (r) => {
  const content = r.content || "";
  return {
    id: r.id, content, format: r.format || "QR",
    scannedAt: r.scanned_at, session: r.session || "", note: r.note || "",
    userId: r.user_id, username: r.username || "",
    // Chỉ thị là DẪN XUẤT của số thùng -> tự suy ra khi cột DB trống
    // (bản ghi cũ, hoặc ghi lúc server chưa chạy migration v4.0).
    // Nhờ vậy bảng, tìm kiếm và xuất Excel/CSV luôn có Chỉ thị.
    chiThi: r.chi_thi || parseChiThi(content), po: r.po || "", size: r.size || "",
  };
};

// Cột đọc/ghi bản ghi. Server chưa chạy migration v4.0 -> tự hạ về bản cũ,
// app vẫn quét/ghi bình thường (thiếu Chỉ thị/PO/Size cho tới khi chạy migration).
const REC_FULL_COLS = "id,content,format,session,note,user_id,username,scanned_at,chi_thi,po,size";
const REC_LEGACY_COLS = "id,content,format,session,note,user_id,username,scanned_at";
let schemaV4 = true;

async function loadRecords() {
  if (!supa || !state.me) return;
  const cols = schemaV4 ? REC_FULL_COLS : REC_LEGACY_COLS;
  let q = await supa.from("records").select(cols)
    .order("scanned_at", { ascending: false }).limit(500);
  if (q.error && schemaV4 && /chi_thi|schema cache/i.test(q.error.message || "")) {
    // Server chưa chạy migration v4.0 -> đọc kiểu cũ, app vẫn chạy
    schemaV4 = false;
    q = await supa.from("records").select(REC_LEGACY_COLS)
      .order("scanned_at", { ascending: false }).limit(500);
  }
  if (q.error) throw q.error;
  const server = (q.data || []).map(rowToRec);
  const serverNorms = new Set(server.map((r) => norm(r.content)));
  // Giữ lại các bản đang đồng bộ nền (pending) mà server chưa có
  const pendings = state.records.filter((r) => r.pending && !serverNorms.has(norm(r.content)));
  state.records = server.concat(pendings);
  state.records.sort((a, b) => new Date(b.scannedAt) - new Date(a.scannedAt));
  state.page = 0;
  renderAll();
  // Tự vá chi_thi còn trống trong DB (bản ghi cũ / ghi lúc chưa migration):
  // chạy nền, không chặn UI; dừng ngay khi gặp lỗi (VD hết quyền).
  if (schemaV4 && q.data) {
    const missing = q.data
      .filter((d) => !d.chi_thi && parseChiThi(d.content || "") && (isAdmin() || d.user_id === state.me.id))
      .slice(0, 200);
    if (missing.length) {
      (async () => {
        for (const d of missing) {
          const { error } = await supa.from("records").update({ chi_thi: parseChiThi(d.content) }).eq("id", d.id);
          if (error) break;
        }
      })();
    }
  }
}

/* ---------------- v4.6: OCR tự đọc size từ tem ----------------
 * QR tem thùng chỉ chứa số thùng (không có size), và audit 239 dòng thật
 * chứng minh size không suy ra được từ số thùng. Nhưng dòng "UK 5.0-6" in
 * rõ trên tem -> sau mỗi lần quét camera, chụp khung hình và OCR vùng trên
 * của tem để tự điền size. Chỉ điền khi size còn trống (không ghi đè pad
 * do người dùng chọn). Chạy nền, không chặn lần quét tiếp theo. */
let ocrWorkerP = null;
const pendingSizes = {}; // content -> { size: "5.0-6", auto: true/false } (size đang chờ vá vào bản ghi)
let ocrSeq = 0; // tăng mỗi lần quét -> job OCR của mã cũ tự hủy

function loadTessScript() {
  return new Promise((res, rej) => {
    if (window.Tesseract) return res();
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    s.onload = () => res();
    s.onerror = () => rej(new Error("load"));
    document.head.appendChild(s);
  });
}

async function ensureOCR() {
  if (state.settings.ocr === false) return null;
  try {
    if (!ocrWorkerP) {
      ocrWorkerP = (async () => {
        await loadTessScript();
        const w = await Tesseract.createWorker("eng");
        await w.setParameters({
          tessedit_char_whitelist: "UKuk0123456789.-–— ",
          tessedit_pageseg_mode: "6",
        });
        return w;
      })();
    }
    return await ocrWorkerP;
  } catch (e) {
    ocrWorkerP = null; // cho lần quét sau thử tải lại
    return null;
  }
}

// Chụp vùng trên của khung hình (nơi in "UK X.X-Y"), giới hạn 800px cho nhanh
function captureSizeCrop() {
  const video = document.querySelector("#reader video");
  if (!video || !video.videoWidth) return null;
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.min(1, 800 / vw);
  const cw = Math.round(vw * scale), ch = Math.round(vh * 0.42 * scale);
  const cv = document.createElement("canvas");
  cv.width = cw; cv.height = ch;
  cv.getContext("2d").drawImage(video, 0, 0, vw, vh * 0.42, 0, 0, cw, ch);
  return cv;
}

function parseSizeText(text) {
  const m = /UK\s*(\d+(?:\.\d+)?)\s*[-–—]\s*(\d{1,2})/i.exec(text || "");
  if (!m) return null;
  return parseFloat(m[1]).toFixed(1) + "-" + m[2];
}

function setOcrStatus(msg) {
  const el = $("ocrStatus");
  if (el) el.textContent = msg || "";
}

async function ocrFillSize(content) {
  const mySeq = ++ocrSeq;
  const rec0 = state.records.find((r) => r.content === content);
  if (!rec0 || rec0.size) return; // pad đã có size -> không tốn OCR
  const crop = captureSizeCrop(); // chụp NGAY khung hình lúc vừa quét
  if (!crop) { setOcrStatus("🤖 không chụp được khung hình camera."); return; }
  setOcrStatus("🤖 đang tải thư viện OCR…");
  if (Object.keys(pendingSizes).length > 300) { for (const k in pendingSizes) delete pendingSizes[k]; }
  const worker = await ensureOCR();
  if (mySeq !== ocrSeq) return; // đã quét mã mới hơn -> bỏ job cũ
  if (!worker) { setOcrStatus("🤖 không tải được thư viện OCR — chạm chọn size bên dưới."); return; }
  setOcrStatus("🤖 đang đọc size từ tem…");
  let sizeStr = null;
  try {
    const { data } = await worker.recognize(crop);
    if (mySeq !== ocrSeq) return;
    if ((data.confidence || 0) >= 45) sizeStr = parseSizeText(data.text);
  } catch (e) { setOcrStatus("🤖 lỗi khi đọc size."); return; }
  if (!sizeStr) { setOcrStatus("🤖 không đọc được size — chạm chọn size bên dưới."); return; }
  pendingSizes[content] = { size: sizeStr, auto: true };
  applyPendingSize(content);
}

// Vá size đang chờ vào bản ghi (từ OCR hoặc từ dải chọn size trong banner).
// Được gọi sau khi OCR/chọn xong và sau khi insert nền hoàn tất (đề phòng
// xong trước khi server trả về). OCR (auto) không ghi đè size đã có;
// chọn tay luôn ghi đè (dùng để sửa).
function applyPendingSize(content) {
  const p = pendingSizes[content];
  if (!p) return;
  const rec = state.records.find((r) => r.content === content);
  if (!rec) return;
  if (p.auto && rec.size) { delete pendingSizes[content]; return; }
  rec.size = p.size;
  rec.ocrSize = !!p.auto;
  setOcrStatus(p.auto ? "🤖 đã đọc size: " + p.size + " ✓" : "");
  renderAll();
  if (!rec.pending && !String(rec.id).startsWith("tmp_") && supa && schemaV4) {
    supa.from("records").update({ size: p.size }).eq("id", rec.id).then(() => {}).catch(() => {});
    delete pendingSizes[content];
  }
  // nếu vẫn pending: addRecord sẽ gọi applyPendingSize lại sau khi insert xong
}

// Ghi 1 bản ghi, tự hạ cấp khi server chưa có cột v4.0 (chưa chạy migration)
async function insertRecord(payload) {
  const cols = schemaV4 ? REC_FULL_COLS : REC_LEGACY_COLS;
  let body = payload;
  if (!schemaV4) {
    const { chi_thi, po, size, ...rest } = payload;
    body = rest;
  }
  let r = await supa.from("records").insert(body).select(cols).single();
  if (r.error && schemaV4 && /chi_thi|schema cache/i.test(r.error.message || "")) {
    schemaV4 = false;
    const { chi_thi, po, size, ...rest } = payload;
    r = await supa.from("records").insert(rest).select(REC_LEGACY_COLS).single();
    if (r.data) { r.data.chi_thi = payload.chi_thi; r.data.po = payload.po; r.data.size = payload.size; }
  }
  return r;
}

async function addRecord(content, format) {
  if (!state.me || !supa) { toast("Bạn cần đăng nhập để quét.", "err"); return; }
  content = String(content || "").trim();
  if (!content) { toast("Mã quét rỗng, bỏ qua.", "warn"); return; }

  const now = Date.now();
  if (content === state.lastContent && now - state.lastAt < DUP_COOLDOWN_MS) return; // chống camera quét dính 2 lần
  state.lastContent = content; state.lastAt = now;

  // kiểm tra nhanh trên bản sao local trước (kể cả bản đang đồng bộ)
  const dupLocal = state.records.find((r) => norm(r.content) === norm(content));
  if (dupLocal) { showDupBox(dupLocal, content); return; }

  // Tem thùng giày: tự tách chỉ thị từ số thùng.
  // v5.0: tra packing list (khoảng thùng -> size/số đôi/PO) — nguồn chuẩn,
  // đã kiểm chứng trên dữ liệu thật (AE2608506: P=91, Q=546).
  // Không có packing -> PO từ master, size từ pad chọn (cũ).
  const chiThi = parseChiThi(content);
  const pack = packingLookup(chiThi, content);
  const po = (pack && pack.po) || masterPO(chiThi);
  const packSize = packSizeStr(pack);
  // v5.3: cảnh báo khi mã quét lệch phiên đã khai báo (vẫn ghi nhận)
  const sr = sessionResolved();
  if (sr.chiFull && chiThi && chiThi !== sr.chiFull)
    toast("⚠ Mã thuộc chỉ thị " + chiThi + ", khác chỉ thị phiên (" + sr.chiFull + ") — vẫn ghi nhận.", "warn");
  if (sr.poFull && po && po !== sr.poFull)
    toast("⚠ PO của mã (" + po + ") khác PO phiên (" + sr.poFull + ") — vẫn ghi nhận.", "warn");
  if (chiThi && !po && state.masterReady && !masterWarned.has(chiThi)) {
    masterWarned.add(chiThi);
    toast("Chỉ thị " + chiThi + " chưa có trong master data — PO để trống. Admin bổ sung đơn hàng.", "warn");
  }

  // Ghi nhận TỨC THÌ (optimistic): hiện lên bảng + kêu beep ngay,
  // đồng bộ lên server ở nền để không chặn lần quét tiếp theo.
  const tempId = "tmp_" + uid();
  const rec = {
    id: tempId, content, format: format || "QR",
    scannedAt: new Date().toISOString(),
    session: sessionLabel(), note: state.settings.note.trim(),
    userId: state.me.id, username: state.me.username,
    chiThi, po, size: packSize || currentSizeStr(),
    pending: true,
  };
  state.records.unshift(rec);
  state.page = 0;
  // v5.4: cập nhật dashboard ngay (không chờ tải lại DB)
  if (state.dash && state.dash.rows) state.dash.rows.unshift({
    content: rec.content, chiThi: rec.chiThi, scannedAt: rec.scannedAt,
    session: rec.session, username: rec.username, size: rec.size,
  });
  renderAll();
  showOkBox(rec);
  beep(true);

  // v4.6: OCR tự đọc "UK X.X-Y" trên tem (chỉ quét camera, chạy nền, không chặn quét tiếp)
  if (format !== "Nhập tay" && format !== "Ảnh") ocrFillSize(content).catch(() => {});

  try {
    const { data, error } = await insertRecord({
      content,
      format: rec.format,
      session: rec.session,
      note: rec.note,
      user_id: rec.userId,
      username: rec.username,
      chi_thi: chiThi,
      po: rec.po,
      size: rec.size,
    });
    if (error) throw error;
    // Thay bản tạm bằng bản server trả về (có id + giờ chuẩn)
    const i = state.records.findIndex((r) => r.id === tempId);
    const fresh = rowToRec(data);
    if (i >= 0) state.records[i] = fresh; else state.records.unshift(fresh);
    applyPendingSize(content); // v4.6+: vá size đang chờ nếu đã xong trong lúc insert bay
    renderAll();
  } catch (e) {
    delete pendingSizes[content];
    state.records = state.records.filter((r) => r.id !== tempId);
    const msg = (e && e.message) || "không rõ";
    if (e && (e.code === "23505" || e.status === 409)) {
      // 23505 = unique index records_content_uniq: máy khác đã quét mã này trước
      try { await loadRecords(); } catch (_) {}
      showDupBox(state.records.find((r) => norm(r.content) === norm(content)) || null, content);
      return;
    }
    renderAll();
    showErrBox(content, msg);
  }
}

// Banner "đã ghi nhận" — gọi ngay khi quét được, không chờ mạng
function showOkBox(rec, silent) {
  const box = $("lastscan");
  box.classList.remove("show"); void box.offsetWidth;
  box.classList.remove("dup");
  box.innerHTML = "✅ <b>Đã ghi nhận:</b><br>" +
    "<code>" + esc(rec.content) + "</code><br><span class='muted'>" + esc(rec.format) + " · " + fmtTime(rec.scannedAt) + "</span>" +
    (rec.chiThi ? "<br><span class='muted'>Chỉ thị <b>" + esc(rec.chiThi) + "</b>" +
      (rec.po ? " · PO " + esc(rec.po) : "") +
      (rec.size ? " · Size " + esc(rec.size) + (isPackSize(rec) ? " 📦" : "") : "") + "</span> " : "") +
    stripHTML(rec);
  box.classList.add("show");
  bindStrip(box);
  if (!silent) toast("Đã ghi nhận mã mới.", "ok");
}

// v4.8: dải chọn size 1 chạm ngay trong banner quét — không cần cuộn xuống pad.
// Chạm là gán size cho đúng thùng vừa quét (không đụng sticky pad).
function stripHTML(rec) {
  const cur = (rec.size || "").split("-")[0];
  let btns = "";
  for (let s = 3; s <= 9.01; s += 0.5) {
    const v = s.toFixed(1);
    btns += "<button class='szbtn" + (cur === v ? " active" : "") + "' data-strip-size='" + v + "'>" + v + "</button>";
  }
  return "<div class='szstrip'><span class='seclabel'>Size thùng vừa quét — chạm 1 lần:</span>" +
    "<div class='sizepad' data-strip='" + esc(rec.content) + "'>" + btns + "</div></div>";
}

function bindStrip(box) {
  const pad = box.querySelector("[data-strip]");
  if (!pad) return;
  const content = pad.getAttribute("data-strip");
  pad.querySelectorAll("[data-strip-size]").forEach((b) =>
    b.addEventListener("click", () => setStripSize(content, b.getAttribute("data-strip-size"))));
}

function setStripSize(content, sizeUK) {
  const sizeStr = sizeUK + "-" + (state.settings.pairs ?? 6);
  pendingSizes[content] = { size: sizeStr, auto: false };
  applyPendingSize(content);
  const rec = state.records.find((r) => r.content === content);
  if (rec) showOkBox(rec, true); // vẽ lại banner: hiện size + nút active, không toast lại
}

function showDupBox(dup, content) {
  const box = $("lastscan");
  box.classList.remove("show"); void box.offsetWidth;
  state.dupSkipped = (state.dupSkipped || 0) + 1;
  saveStore(); renderStats();
  box.classList.add("dup");
  box.innerHTML = "⚠️ <b>Đã được quét</b> — mã này đã ghi nhận trước đó nên bỏ qua.<br>" +
    "<code>" + esc(content) + "</code><br><span class='muted'>" +
    (dup ? "Ghi nhận lần đầu: " + fmtTime(dup.scannedAt) + (dup.username ? " · bởi <b>" + esc(dName(dup.username)) + "</b>" : "") // v6.5
         : "Máy chủ đã có mã này.") + "</span>";
  box.classList.add("show");
  beepDup();
  toast("Đã được quét — bỏ qua mã trùng.", "warn");
}

function showErrBox(content, msg) {
  const box = $("lastscan");
  box.classList.remove("show"); void box.offsetWidth;
  box.classList.remove("dup");
  box.innerHTML = "❌ <b>Lỗi ghi nhận:</b><br><code>" + esc(content) + "</code><br>" +
    "<span class='muted'>" + esc(msg) + "</span>";
  box.classList.add("show");
  toast("Lỗi ghi nhận: " + msg, "err");
}

function deleteRecord(id) {
  const rec = state.records.find((r) => r.id === id);
  if (!rec) return;
  if (rec.pending) { toast("Mã đang đồng bộ, đợi 1-2 giây rồi xóa.", "warn"); return; }
  if (!isAdmin() && rec.userId !== state.me.id) { toast("Bạn chỉ được xóa bản ghi của mình.", "err"); return; }
  openModal("Xóa bản ghi",
    "<p>Xóa mã <code>" + esc(rec.content) + "</code> khỏi dữ liệu chung?</p>",
    "Xóa", async () => {
      const { error } = await supa.from("records").delete().eq("id", id);
      closeModal();
      if (error) { toast("Lỗi xóa: " + error.message, "err"); return; }
      state.records = state.records.filter((r) => r.id !== id);
      renderAll();
      toast("Đã xóa bản ghi.", "ok");
    });
}
function clearAll() {
  const mine = visibleRecords();
  if (!mine.length) return;
  const label = isAdmin() ? "toàn bộ " + state.records.length + " bản ghi của mọi tài khoản"
                          : mine.length + " bản ghi của bạn";
  openModal("Xóa dữ liệu", "<p>Xóa " + esc(label) + "? Hành động này không thể hoàn tác.</p>", "Xóa", async () => {
    let error = null;
    if (isAdmin()) {
      const r = await supa.from("records").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      error = r.error;
    } else {
      const r = await supa.from("records").delete().eq("user_id", state.me.id);
      error = r.error;
    }
    closeModal();
    if (error) { toast("Lỗi xóa: " + error.message, "err"); return; }
    state.page = 0;
    try { await loadRecords(); } catch (e) {}
    toast("Đã xóa dữ liệu.", "ok");
  });
}

/* ---------------- filter / render ---------------- */
function visibleRecords() {
  if (!state.me) return [];
  if (isAdmin()) return state.records;
  return state.records.filter((r) => r.userId === state.me.id);
}
function filteredRecords() {
  const q = state.filterText.trim().toLowerCase();
  return visibleRecords().filter((r) => {
    if (q && !(r.content.toLowerCase().includes(q) ||
               (r.chiThi || "").toLowerCase().includes(q) ||
               (r.po || "").toLowerCase().includes(q) ||
               (r.size || "").toLowerCase().includes(q) ||
               (r.note || "").toLowerCase().includes(q) ||
               (r.session || "").toLowerCase().includes(q) ||
               (r.username || "").toLowerCase().includes(q))) return false;
    if (state.filterDate) {
      const d = new Date(r.scannedAt).toLocaleDateString("en-CA", { timeZone: TZ });
      if (d !== state.filterDate) return false;
    }
    return true;
  });
}

function refreshReportBtn() {
  const b = $("btnExportReport");
  if (b) b.disabled = !state.packingReady || !state.packing.length; // v5.0: cần packing list
}
/* v5.3: PHIÊN QUÉT bắt buộc — loại pallet (Kiểm/Nhập/Xuất) + số pallet +
 * 4 số cuối chỉ thị/PO. Nhập đủ mới bật nút quét; chỉ thị/PO được đối chiếu
 * với packing/master (trùng nhiều -> chọn tay); mã quét lệch phiên -> cảnh báo. */
function getSession() {
  return state.settings.sess || (state.settings.sess =
    { type: "", pallet: "", chi: "", po: "", chiPick: "", poPick: "" });
}
function knownDirectives() {
  const s = new Set();
  if (state.packingByChi) state.packingByChi.forEach((_, k) => s.add(k));
  Object.keys(state.master || {}).forEach((k) => s.add(k));
  return [...s].sort();
}
function knownPOs() {
  const s = new Set();
  (state.packing || []).forEach((r) => { if (r.po) s.add(r.po); });
  Object.values(state.master || {}).forEach((m) => { if (m.po) s.add(m.po); });
  return [...s].sort();
}
const sessDataReady = () => (state.packingReady && state.packing.length > 0) || state.masterReady;
function sessionResolved() {
  // Đối chiếu 4 số cuối với dữ liệu đã biết. Chưa có dữ liệu -> chấp nhận
  // 4 số (không chặn quét offline), chỉ bỏ cảnh báo lệch phiên.
  const s = getSession();
  const ready = sessDataReady();
  let chiFull = "", poFull = "", chiOpts = [], poOpts = [];
  if (s.chi.length === 4 && ready) {
    chiOpts = knownDirectives().filter((c) => c.endsWith(s.chi));
    if (chiOpts.length === 1) chiFull = chiOpts[0];
    else if (chiOpts.length > 1 && chiOpts.includes(s.chiPick)) chiFull = s.chiPick;
  }
  if (s.po.length === 4 && ready) {
    poOpts = knownPOs().filter((p) => String(p).split("-")[0].endsWith(s.po));
    if (poOpts.length === 1) poFull = poOpts[0];
    else if (poOpts.length > 1 && poOpts.includes(s.poPick)) poFull = s.poPick;
  }
  return { chiFull, poFull, chiOpts, poOpts, ready };
}
function sessionStatus() {
  const s = getSession();
  const r = sessionResolved();
  const miss = [];
  if (!s.type) miss.push("loại pallet");
  if (!s.pallet || !(+s.pallet >= 1)) miss.push("số pallet");
  if (s.chi.length !== 4) miss.push("4 số cuối chỉ thị");
  else if (r.ready && !r.chiFull) miss.push(r.chiOpts.length > 1
    ? "chọn chỉ thị (" + r.chiOpts.length + " kết quả khớp)"
    : "chỉ thị khớp (" + s.chi + " không có trong packing/master)");
  if (s.po.length !== 4) miss.push("4 số cuối PO");
  else if (r.ready && !r.poFull) miss.push(r.poOpts.length > 1
    ? "chọn PO (" + r.poOpts.length + " kết quả khớp)"
    : "PO khớp (" + s.po + " không có trong packing/master)");
  return { ok: !miss.length, miss, r };
}
function sessionLabel() {
  const s = getSession();
  return (s.type + " " + s.pallet).trim(); // VD "Kiểm 1"
}
function renderSessPick(wrapId, selId, opts, cur, onPick) {
  const wrap = $(wrapId), sel = $(selId);
  if (!wrap || !sel) return;
  if (opts.length > 1) {
    wrap.classList.remove("hidden");
    sel.innerHTML = '<option value="">— Chọn —</option>' + opts.map((o) =>
      '<option value="' + esc(o) + '"' + (o === cur ? " selected" : "") + ">" + esc(o) + "</option>").join("");
    sel.onchange = (e) => onPick(e.target.value);
  } else wrap.classList.add("hidden");
}
function refreshSession() {
  const s = getSession();
  s.type = $("sessType").value;
  s.pallet = $("sessPallet").value.trim();
  s.chi = $("sessChi").value.replace(/\D/g, "").slice(-4);
  s.po = $("sessPo").value.replace(/\D/g, "").slice(-4);
  const st = sessionStatus();
  renderSessPick("sessChiPickWrap", "sessChiPick", st.r.chiOpts, s.chiPick,
    (v) => { s.chiPick = v; saveStore(); updateScanGate(); });
  renderSessPick("sessPoPickWrap", "sessPoPick", st.r.poOpts, s.poPick,
    (v) => { s.poPick = v; saveStore(); updateScanGate(); });
  saveStore();
  updateScanGate();
  if (state.scanning && !st.ok) { // đang quét mà phiên hết hiệu lực -> dừng
    stopScan();
    toast("Phiên quét chưa đủ thông tin — đã dừng camera.", "warn");
  }
}
function updateScanGate() {
  const st = sessionStatus();
  const s = getSession();
  [["btnStart", true], ["btnFromFile", false], ["btnManualAdd", false]].forEach(([id, isStart]) => {
    const b = $(id);
    if (b) b.disabled = !st.ok || (isStart && state.scanning);
  });
  const h = $("sessHint");
  if (h) {
    h.className = "sesshint " + (st.ok ? "ok" : "miss");
    if (st.ok) {
      h.innerHTML = "✓ Phiên: <b>" + esc(s.type) + " · pallet " + esc(s.pallet) + "</b>" +
        (st.r.chiFull ? " · " + esc(st.r.chiFull) : "") +
        (st.r.poFull ? " · PO " + esc(st.r.poFull) : "");
    } else {
      h.textContent = "⚠ Chưa quét được — còn thiếu: " + st.miss.join(", ");
    }
  }
}
function renderAll() {
  if (!state.me) { doLogout(); return; }
  renderStats(); renderTable(); scheduleSummary(); // v6.7
  const n = visibleRecords().length;
  $("btnExportXlsx").disabled = $("btnExportCsv").disabled = $("btnExportJson").disabled = $("btnClear").disabled = !n;
  refreshReportBtn();
}

/* ---- v6.7: TỔNG HỢP THEO NHÂN VIÊN (chỉ admin, theo ngày) ----
 * Mỗi user 1 dòng: Kiểm/Nhập/Xuất (số thùng · số đôi), số pallet (phiên quét
 * khác nhau), tổng thùng, tổng đôi + dòng TỔNG CỘNG. Số liệu tải đủ cả ngày
 * từ server (không phụ thuộc 500 dòng đang hiển thị). */
function parseSessType(sess) {
  // Bỏ dấu trước khi so khớp (kiểm/kiềm/ể/ế... đều về "kiem")
  const s = String(sess || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (s.startsWith("kiem")) return "kiểm";
  if (s.startsWith("nhap")) return "nhập";
  if (s.startsWith("xuat")) return "xuất";
  return "khác";
}
// Gom bản ghi 1 ngày -> [{user, types:{kiểm/nhập/xuất/khác:{boxes,pairs}}, pallets:Set, boxes, pairs}]
// Tách hàm thuần để test (harness v6.7); boxPairs/dName/norm/parseChiThi truyền từ ngoài khi test.
function summarizeDay(rows) {
  const seen = new Set();
  const byUser = new Map();
  const mk = () => ({ boxes: 0, pairs: 0 });
  (rows || []).forEach((r) => {
    const k = norm(r.content || "");
    if (!k || seen.has(k)) return; // mỗi số thùng chỉ đếm 1 lần
    seen.add(k);
    const u = (r.username || "").trim() || "(không tên)";
    if (!byUser.has(u)) byUser.set(u, { user: u, types: { "kiểm": mk(), "nhập": mk(), "xuất": mk(), "khác": mk() }, pallets: new Set(), boxes: 0, pairs: 0 });
    const g = byUser.get(u);
    const t = parseSessType(r.session);
    const ct = (r.chi_thi || parseChiThi(r.content || "")).toUpperCase();
    const pairs = boxPairs(ct, r.content, r.size);
    g.types[t].boxes++; g.types[t].pairs += pairs;
    g.boxes++; g.pairs += pairs;
    const sess = (r.session || "").trim();
    if (sess) g.pallets.add(sess);
  });
  return [...byUser.values()].sort((a, b) => dName(a.user).localeCompare(dName(b.user), "vi"));
}
function sumCell(t) {
  return t.boxes ? "<b>" + fmtNum(t.boxes) + "</b> · " + fmtNum(t.pairs) : "<span class='muted'>—</span>";
}
/* v6.8.1: định dạng số hiển thị ở phạm vi toàn cục.
 * (Trước đây sumCell/renderUserSummary gọi "num" — nhưng num chỉ là const
 * cục bộ trong renderDashboard/packing form -> ReferenceError "num is not defined".) */
function fmtNum(n) { return (+n || 0).toLocaleString("vi-VN"); }
async function renderUserSummary() {
  const body = $("sumBody");
  if (!body || !isAdmin()) return;
  const inp = $("sumDate");
  if (inp && !inp.value) inp.value = todayStr();
  const day = inp ? inp.value : todayStr();
  const dayLabel = esc(day.split("-").reverse().join("/"));
  body.innerHTML = "<tr><td colspan='7' class='muted'>Đang tải số liệu ngày " + dayLabel + "…</td></tr>";
  try { // v6.7.1: mọi lỗi đều hiện rõ + bấm ↻ thử lại, không bao giờ kẹt ở "Đang tải"
    const rows = await fetchDayRecords(day);
    const users = summarizeDay(rows);
    if (!users.length) {
      body.innerHTML = "<tr><td colspan='7' class='muted'>Ngày này chưa có bản ghi nào.</td></tr>";
      return;
    }
    const tot = { "kiểm": { boxes: 0, pairs: 0 }, "nhập": { boxes: 0, pairs: 0 }, "xuất": { boxes: 0, pairs: 0 }, boxes: 0, pairs: 0, pallets: new Set() };
    const html = users.map((g) => {
      ["kiểm", "nhập", "xuất"].forEach((t) => { tot[t].boxes += g.types[t].boxes; tot[t].pairs += g.types[t].pairs; });
      tot.boxes += g.boxes; tot.pairs += g.pairs;
      g.pallets.forEach((p) => tot.pallets.add(g.user + "‖" + p));
      return "<tr><td><b>" + esc(dName(g.user)) + "</b></td>" +
        "<td>" + sumCell(g.types["kiểm"]) + "</td>" +
        "<td>" + sumCell(g.types["nhập"]) + "</td>" +
        "<td>" + sumCell(g.types["xuất"]) + "</td>" +
        "<td><b>" + fmtNum(g.pallets.size) + "</b></td>" +
        "<td><b>" + fmtNum(g.boxes) + "</b></td>" +
        "<td><b>" + fmtNum(g.pairs) + "</b></td></tr>";
    }).join("");
    body.innerHTML = html +
      "<tr class='sum-total'><td><b>TỔNG CỘNG</b></td>" +
      "<td>" + sumCell(tot["kiểm"]) + "</td><td>" + sumCell(tot["nhập"]) + "</td><td>" + sumCell(tot["xuất"]) + "</td>" +
      "<td><b>" + fmtNum(tot.pallets.size) + "</b></td><td><b>" + fmtNum(tot.boxes) + "</b></td><td><b>" + fmtNum(tot.pairs) + "</b></td></tr>";
  } catch (e) {
    body.innerHTML = "<tr><td colspan='7'>⚠ Không tải được số liệu ngày " + dayLabel + ": " +
      esc((e && e.message) || e) + "<br><span class='muted'>Bấm nút ↻ phía trên để thử lại.</span></td></tr>";
  }
}
function shiftSumDate(d) {
  const inp = $("sumDate");
  const dt = new Date((inp.value || todayStr()) + "T00:00:00+07:00");
  dt.setDate(dt.getDate() + d);
  inp.value = dt.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
  renderUserSummary();
}
// Tự refresh khi có bản ghi mới và đang xem đúng hôm nay (debounce)
let sumTimer = null;
function scheduleSummary() {
  if (!isAdmin()) return;
  const inp = $("sumDate");
  if (!inp || typeof inp.closest !== "function" || inp.closest(".hidden")) return;
  if ((inp.value || todayStr()) !== todayStr()) return;
  clearTimeout(sumTimer);
  sumTimer = setTimeout(() => { renderUserSummary().catch(() => {}); }, 800);
}

/* v5.4: DASHBOARD sản lượng — số thùng, số đôi, pallet, người quét,
 * biểu đồ theo ngày, tiến độ chỉ thị (ngày xuất/quốc gia từ master). */
function boxPairs(chiThi, content, sizeStr) {
  const p = packingLookup(chiThi, content);
  if (p && +p.doi_thung > 0) return +p.doi_thung;
  const m = /(\d+(?:\.\d+)?)-(\d+)/.exec(sizeStr || "");
  return m ? +m[2] : 0;
}
async function loadDashRows() {
  // Tải toàn bộ bản ghi (cột nhẹ) để tính dashboard — phân trang 1000.
  if (!supa || !state.me) return [];
  const cols = schemaV4 ? "content,chi_thi,scanned_at,session,username,size" : "content,scanned_at,session,username";
  const all = [];
  try {
    for (let from = 0; ; from += 1000) {
      let q = supa.from("records").select(cols).order("scanned_at", { ascending: false }).range(from, from + 999);
      if (!isAdmin()) q = q.eq("user_id", state.me.id);
      const { data, error } = await q;
      if (error) throw error;
      (data || []).forEach((d) => all.push({
        content: d.content || "",
        chiThi: d.chi_thi || parseChiThi(d.content || ""),
        scannedAt: d.scanned_at, session: d.session || "",
        username: d.username || "", size: d.size || "",
      }));
      if (!data || data.length < 1000 || all.length >= 20000) break;
    }
  } catch (e) { console.warn("Không tải được số liệu dashboard:", e.message); }
  return all;
}
function computeDash(rows) {
  const seen = new Map(); // dedupe theo mã thùng
  rows.forEach((r) => { const k = norm(r.content); if (k && !seen.has(k)) seen.set(k, r); });
  const t = todayStr();
  let pairs = 0, today = 0;
  const pallets = new Set(), users = new Set(), byDay = new Map(), byUser = new Map(), byChi = new Map();
  seen.forEach((r) => {
    const pr = boxPairs(r.chiThi, r.content, r.size);
    pairs += pr;
    if (r.session && r.session.trim()) pallets.add(r.session.trim());
    if (r.username) users.add(r.username);
    const day = new Date(r.scannedAt).toLocaleDateString("en-CA", { timeZone: TZ });
    if (day === t) today++;
    byDay.set(day, (byDay.get(day) || 0) + 1);
    const u = r.username || "(không tên)";
    const ur = byUser.get(u) || { n: 0, pairs: 0, pallets: new Set(), last: "" };
    ur.n++; ur.pairs += pr;
    if (r.session && r.session.trim()) ur.pallets.add(r.session.trim());
    if (!ur.last || r.scannedAt > ur.last) ur.last = r.scannedAt;
    byUser.set(u, ur);
    const c = (r.chiThi || "").toUpperCase() || "(lạ)";
    const cr = byChi.get(c) || { n: 0, pairs: 0 };
    cr.n++; cr.pairs += pr;
    byChi.set(c, cr);
  });
  return { total: rows.length, boxes: seen.size, pairs, today,
    pallets: pallets.size, users: users.size, byDay, byUser, byChi };
}
function dirPlan(chi) {
  // Kế hoạch từ packing + thông tin đơn hàng từ master
  let plan = 0, po = "";
  (state.packingByChi.get(chi) || []).forEach((r) => { plan += +r.so_thung || 0; if (!po && r.po) po = r.po; });
  const m = state.master[chi];
  if (m && m.po && !po) po = m.po;
  const mr = m && m.rows && m.rows[0];
  return { plan, po, quocGia: (mr && mr.quoc_gia) || "", ngayXuat: (mr && mr.ngay_xuat_kd) || "" };
}
function renderDashboard(d) {
  const num = (n) => (+n || 0).toLocaleString("vi-VN");
  const kpis = [
    ["var(--blue)", "Số thùng đã quét", num(d.boxes), "mã duy nhất"],
    ["var(--emerald)", "Sản lượng đôi", num(d.pairs), "tổng số đôi"],
    ["var(--amber)", "Số pallet", num(d.pallets), "phiên quét khác nhau"],
    ["#a78bfa", "Người quét", num(d.users), "tài khoản tham gia"],
    ["#38bdf8", "Hôm nay", num(d.today), "thùng quét hôm nay"],
    ["var(--red)", "Bỏ qua trùng", num(state.dupSkipped || 0), "mã đã quét trước đó"],
  ];
  $("dashKpis").innerHTML = kpis.map(([c, l, v, h]) =>
    '<div class="dkpi"><i style="background:' + c + '"></i><div class="l">' + l +
    '</div><div class="v">' + v + '</div><div class="h">' + h + "</div></div>").join("");
  // Biểu đồ 14 ngày gần nhất
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 864e5);
    const k = dt.toLocaleDateString("en-CA", { timeZone: TZ });
    days.push({ k, label: k.slice(8) + "/" + k.slice(5, 7), v: d.byDay.get(k) || 0 });
  }
  const max = Math.max(1, ...days.map((x) => x.v));
  $("dashChart").innerHTML = days.map((x) =>
    '<div class="bar" title="' + x.k + ": " + x.v + ' thùng"><div class="barv' + (x.v ? "" : " zero") +
    '" style="height:' + Math.max(x.v ? 4 : 2, Math.round(x.v / max * 100)) + '%"></div>' +
    '<div class="barl">' + x.label + "</div></div>").join("");
  // Theo người quét
  const users = [...d.byUser.entries()].sort((a, b) => b[1].n - a[1].n);
  $("dashUsers").querySelector("tbody").innerHTML = users.length ? users.map(([u, r]) =>
    "<tr><td><b>" + esc(dName(u)) + "</b></td><td>" + num(r.n) + "</td><td>" + num(r.pairs) + // v6.5
    "</td><td>" + num(r.pallets.size) + "</td><td class='muted'>" + fmtTime(r.last) + "</td></tr>").join("")
    : '<tr><td colspan="5" class="muted">Chưa có số liệu.</td></tr>';
  // Theo chỉ thị: tiến độ vs kế hoạch packing + ngày xuất/quốc gia từ master
  const dirs = [...d.byChi.entries()].sort((a, b) => b[1].n - a[1].n);
  $("dashDirs").querySelector("tbody").innerHTML = dirs.length ? dirs.map(([c, r]) => {
    const pl = dirPlan(c);
    const pct = pl.plan > 0 ? Math.min(100, Math.round(r.n / pl.plan * 100)) : 0;
    return "<tr><td><b>" + esc(c) + "</b></td><td>" + esc(pl.po || "—") + "</td><td>" + esc(pl.quocGia || "—") +
      "</td><td class='muted'>" + esc(pl.ngayXuat || "—") + "</td><td>" + num(r.n) + " / " + (pl.plan ? num(pl.plan) : "?") +
      "</td><td><div class='prog" + (pct >= 100 ? " full" : "") + "' title='" + pct + "%'><div style='width:" + pct + "%'></div></div></td>" +
      "<td>" + num(r.pairs) + "</td></tr>";
  }).join("") : '<tr><td colspan="7" class="muted">Chưa có số liệu.</td></tr>';
  const at = new Date().toLocaleTimeString("vi-VN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("dashNote").textContent = "Tính trên " + num(d.total) + " lượt quét (" + num(d.boxes) + " mã duy nhất)" +
    (isAdmin() ? "" : " — tài khoản của bạn") + " · cập nhật lúc " + at + ".";
}
async function refreshDashboard() {
  const note = $("dashNote");
  if (note) note.textContent = "Đang tải số liệu…";
  const rows = await loadDashRows();
  state.dash = { rows, at: Date.now() };
  renderDashboard(computeDash(rows));
}
function renderStats() {
  // v5.4: dashboard dùng cache — tránh tải lại DB mỗi lần render bảng
  if (state.dash && state.dash.rows) renderDashboard(computeDash(state.dash.rows));
}

function renderHead() {
  const admin = isAdmin();
  $("theadRow").innerHTML = "<tr><th>#</th><th>Chỉ thị</th><th>PO</th><th>Size</th><th>Số thùng</th>" +
    "<th>Giờ quét</th><th>Số pallet</th>" + (admin ? "<th>Người quét</th>" : "") + "<th></th></tr>";
  $("userSummary").classList.toggle("hidden", !admin); // v6.7: tổng hợp theo NV chỉ admin
}

function renderTable() {
  const admin = isAdmin();
  const list = filteredRecords();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  const slice = list.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);
  const cols = admin ? 9 : 8;

  const body = $("tbody");
  if (!slice.length) {
    body.innerHTML = '<tr><td colspan="' + cols + '"><div class="empty">' +
      (visibleRecords().length ? "Không tìm thấy bản ghi phù hợp bộ lọc." : "Chưa có bản ghi nào. Hãy quét mã đầu tiên 📷") +
      "</div></td></tr>";
  } else {
    body.innerHTML = slice.map((r, i) => {
      const n = state.page * PAGE_SIZE + i + 1;
      return "<tr>" +
        "<td class='muted'>" + n + "</td>" +
        "<td><b>" + esc(r.chiThi || "—") + "</b></td>" +
        "<td class='editable' data-edit='po' data-id='" + r.id + "' title='Bấm để sửa PO'>" + esc(r.po || "—") + "</td>" +
        "<td class='editable' data-edit='size' data-id='" + r.id + "' title='Bấm để sửa Size'>" + esc(r.size || "—") + (r.ocrSize && r.size ? " <span title='Tự đọc từ tem (OCR)'>🤖</span>" : "") + (isPackSize(r) ? " <span title='Tự tra từ packing list'>📦</span>" : "") + "</td>" +
        "<td class='content'><code style='font-size:12px'>" + esc(r.content) + "</code>" +
          (r.note ? "<br><span class='muted'>" + esc(r.note) + "</span>" : "") + "</td>" +
        "<td class='muted' style='white-space:nowrap'>" + fmtTime(r.scannedAt) + "</td>" +
        "<td>" + esc(r.session || "") + "</td>" +
        (admin ? "<td><b>" + esc(dName(r.username)) + "</b></td>" : "") + // v6.5
        "<td><button class='small danger' data-del='" + r.id + "'>Xóa</button></td>" +
        "</tr>";
    }).join("");
  }
  body.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => deleteRecord(b.getAttribute("data-del"))));
  body.querySelectorAll("[data-edit]").forEach((td) =>
    td.addEventListener("click", () => beginEditCell(td.getAttribute("data-id"), td.getAttribute("data-edit"), td)));

  $("recCount").textContent = list.length;
  $("pageInfo").textContent = "Trang " + (state.page + 1) + "/" + pages + " · " + list.length + " bản ghi";
  $("btnPrev").disabled = state.page <= 0;
  $("btnNext").disabled = state.page >= pages - 1;
}

/* Sửa PO/Size ngay trên bảng (bấm vào ô). Chủ bản ghi hoặc admin mới được sửa. */
function beginEditCell(recId, field, td) {
  const rec = state.records.find((r) => r.id === recId);
  if (!rec) return;
  if (rec.pending) { toast("Mã đang đồng bộ, đợi 1-2 giây rồi sửa.", "warn"); return; }
  if (!isAdmin() && rec.userId !== state.me.id) { toast("Bạn chỉ được sửa bản ghi của mình.", "err"); return; }
  const label = field === "po" ? "PO" : "Size";
  const cur = rec[field] || "";
  td.innerHTML = "";
  const inp = document.createElement("input");
  inp.value = cur; inp.placeholder = label; inp.setAttribute("aria-label", label);
  inp.style.width = "110px";
  td.appendChild(inp); inp.focus(); inp.select();
  let done = false;
  const commit = async (save) => {
    if (done) return; done = true;
    const v = inp.value.trim();
    if (save && v !== cur) {
      const patch = {}; patch[field] = v;
      const { error } = await supa.from("records").update(patch).eq("id", recId);
      if (error) { toast("Lỗi lưu: " + error.message, "err"); }
      else { rec[field] = v; if (field === "size") rec.ocrSize = false; toast("Đã cập nhật " + label + ".", "ok"); }
    }
    renderTable();
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit(true);
    if (e.key === "Escape") commit(false);
    e.stopPropagation();
  });
  inp.addEventListener("blur", () => commit(true));
  inp.addEventListener("click", (e) => e.stopPropagation());
}

/* ---------------- danh sách tài khoản (admin quản lý) ----------------
 * - Hiện toàn bộ user1..user5 (+admin): tài khoản chưa đăng nhập lần nào
 *   hiện "chưa kích hoạt".
 * - Admin bấm vào ô Tên nhân viên / Mã NV để sửa (display_name); tên đăng
 *   nhập giữ nguyên để không gãy đăng nhập.
 * - Admin đổi mật khẩu tài khoản khác qua RPC admin_set_password (cần chạy
 *   migration-v6.2.sql). User thường chỉ đổi được MK của mình ở khung
 *   "Tài khoản của tôi". */
const EXPECTED_USERS = ["admin", "user1", "user2", "user3", "user4", "user5"];

// Dựng danh sách hiển thị: hợp nhất tài khoản kỳ vọng + profiles thật.
// Tách hàm thuần để test được (harness v6.2).
function buildRoster(profiles) {
  const byName = {};
  (profiles || []).forEach((u) => { byName[String(u.username).toLowerCase()] = u; });
  const names = [...new Set([...EXPECTED_USERS, ...Object.keys(byName)])];
  const rank = (n) => n === "admin" ? -1 : (/^user(\d+)$/.exec(n) ? +RegExp.$1 : 99);
  names.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  return names.map((n) => ({ username: n, profile: byName[n] || null }));
}

/* ---- v6.5: mapping tên nhân viên vào cột "Người quét" ----
 * displayNames: username (viết thường) -> display_name (Tên NV/Mã NV).
 * Admin đọc được tất cả (policy profiles_admin_select); user thường chỉ đọc
 * được dòng của mình (profiles_self) — nhưng bản ghi họ thấy cũng chỉ của họ
 * nên vẫn mapping đúng. Chỗ nào chưa có tên thì giữ nguyên username. */
async function loadDisplayNames() {
  if (!supa) return;
  try {
    const { data } = await supa.from("profiles").select("username,display_name");
    const m = {};
    (data || []).forEach((p) => {
      const dn = (p.display_name || "").trim();
      if (dn && p.username) m[String(p.username).toLowerCase()] = dn;
    });
    state.displayNames = m;
  } catch (e) {}
}
// Tên hiển thị cho "Người quét": tên NV nếu có, không thì username gốc
function dName(u) {
  u = (u || "").trim();
  if (!u) return "—";
  return state.displayNames[u.toLowerCase()] || u;
}
async function loadAccounts() {
  if (!isAdmin() || !supa) return;
  const body = $("usersBody");
  try {
    const { data, error } = await supa.from("profiles")
      .select("id,username,role,display_name,created_at").order("username");
    if (error) throw error;
    // v6.5: dựng lại map tên NV sau khi admin sửa (đổi tên xong là báo cáo dùng ngay)
    const m = {};
    (data || []).forEach((p) => {
      const dn = (p.display_name || "").trim();
      if (dn && p.username) m[String(p.username).toLowerCase()] = dn;
    });
    state.displayNames = m;
    const counts = {};
    state.records.forEach((r) => { if (r.userId) counts[r.userId] = (counts[r.userId] || 0) + 1; });
    const meId = state.me && state.me.id;
    body.innerHTML = buildRoster(data).map(({ username, profile: u }) => {
      if (!u)
        return "<tr><td><b>" + esc(username) + "</b> <span class='badge dup'>chưa kích hoạt</span></td>" +
          "<td colspan='5' class='muted'>Chưa có tài khoản — tạo trong Supabase Dashboard → Authentication → Users, rồi đăng nhập 1 lần.</td></tr>";
      const me = meId && u.id === meId;
      return "<tr><td><b>" + esc(u.username) + "</b>" + (me ? " <span class='badge new'>bạn</span>" : "") + "</td>" +
        "<td class='editable' data-dn-uid='" + u.id + "' title='Bấm để sửa tên nhân viên / mã NV'>" +
          esc(u.display_name || "—") + "</td>" +
        "<td>" + (u.role === "admin" ? "<span class='role admin'>Quản trị</span>" : "<span class='role user'>Nhân viên</span>") + "</td>" +
        "<td class='muted'>" + fmtTime(u.created_at) + "</td>" +
        "<td class='muted'>" + (counts[u.id] || 0) + "</td>" +
        "<td><button class='small' data-pw-user='" + esc(u.username) + "'>Đổi MK</button></td></tr>";
    }).join("");
    body.querySelectorAll("[data-dn-uid]").forEach((td) =>
      td.addEventListener("click", () => beginEditDisplayName(td.getAttribute("data-dn-uid"), td)));
    body.querySelectorAll("[data-pw-user]").forEach((b) =>
      b.addEventListener("click", () => adminResetPassword(b.getAttribute("data-pw-user"))));
  } catch (e) {
    body.innerHTML = "<tr><td colspan='6' class='muted'>Không tải được danh sách tài khoản.</td></tr>";
  }
}

/* Admin sửa tên nhân viên / mã NV (bấm vào ô). */
function beginEditDisplayName(uid, td) {
  if (!isAdmin()) return;
  const cur = td.textContent.trim() === "—" ? "" : td.textContent.trim();
  td.innerHTML = "";
  const inp = document.createElement("input");
  inp.value = cur; inp.placeholder = "Tên nhân viên / mã NV"; inp.setAttribute("aria-label", "Tên nhân viên / mã NV");
  inp.style.width = "100%"; inp.style.minHeight = "36px";
  td.appendChild(inp); inp.focus(); inp.select();
  let done = false;
  const commit = async (save) => {
    if (done) return; done = true;
    const v = inp.value.trim();
    if (save && v !== cur) {
      const { error } = await supa.from("profiles").update({ display_name: v || null }).eq("id", uid);
      if (error) toast("Lỗi lưu: " + error.message, "err");
      else toast("Đã cập nhật tên hiển thị.", "ok");
    }
    loadAccounts();
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit(true);
    if (e.key === "Escape") commit(false);
    e.stopPropagation();
  });
  inp.addEventListener("blur", () => commit(true));
  inp.addEventListener("click", (e) => e.stopPropagation());
}

/* Admin đặt lại mật khẩu tài khoản khác (cần migration-v6.2.sql). */
function adminResetPassword(username) {
  if (!isAdmin()) return;
  openModal("Đổi mật khẩu — " + username,
    '<div class="field"><label for="mNewPass">Mật khẩu mới (từ 6 ký tự)</label>' +
    '<input type="password" id="mNewPass" autocomplete="new-password"></div>' +
    '<p class="sec-hint" style="margin:8px 0 0">Tài khoản <b>' + esc(username) + '</b> sẽ dùng mật khẩu mới từ lần đăng nhập sau.</p>',
    "Đổi mật khẩu", async () => {
      const p = $("mNewPass").value;
      if (!p || p.length < 6) { toast("Mật khẩu mới phải từ 6 ký tự trở lên.", "warn"); return; }
      const { error } = await supa.rpc("admin_set_password", { p_username: username, p_new_password: p });
      if (error) {
        const hint = /function/i.test(error.message) ? " (chưa chạy migration-v6.2.sql?)" : "";
        toast("Lỗi đổi mật khẩu: " + error.message + hint, "err");
        return;
      }
      closeModal();
      toast("Đã đổi mật khẩu cho " + username + ".", "ok");
    });
}

/* ---------------- master data đơn hàng (file ĐƠN ĐẶT HÀNG TVS chuẩn) ----------------
 * 1 dòng = 1 (đơn hàng/chỉ thị, size). PO cố định theo đơn hàng.
 * Khi quét: tự tách chỉ thị từ số thùng -> tra PO từ master này. */
let warnedNoMaster = false;
const masterWarned = new Set(); // chỉ thị lạ đã cảnh báo trong phiên (tránh spam)
async function loadMaster() {
  state.master = {}; state.masterRows = []; state.masterReady = false;
  if (!supa) return;
  try {
    const { data, error } = await supa.from("master_orders")
      .select("don_hang,size,po,mau,so_doi,so_thung,quoc_gia,ngay_xuat_kd,dot_dat_hang")
      .order("don_hang").order("size");
    if (error) throw error;
    state.masterRows = data || [];
    (data || []).forEach((d) => {
      const m = state.master[d.don_hang] || (state.master[d.don_hang] = { po: "", rows: [] });
      if (!m.po && d.po) m.po = d.po;
      m.rows.push(d);
    });
    state.masterReady = true;
  } catch (e) {
    console.warn("Không tải được master data:", e.message);
    // Bảng chưa tồn tại = chưa chạy migration v4.5 -> nhắc admin 1 lần/phiên
    if (isAdmin() && !warnedNoMaster && /master_orders|schema cache|does not exist/i.test(e.message || "")) {
      warnedNoMaster = true;
      toast("Chưa có bảng Master data. Hãy chạy file docs/migration-v4.5.sql trong Supabase SQL Editor.", "warn");
    }
  }
  if (isAdmin()) renderMaster();
  refreshSession(); // v5.3: đối chiếu lại phiên quét khi master đổi
}
function masterPO(chiThi) {
  const m = chiThi && state.master[chiThi];
  return m ? m.po || "" : "";
}
function renderMaster() {
  const body = $("masterBody");
  if (!body) return;
  const q = (($("masterSearch") && $("masterSearch").value) || "").trim().toLowerCase();
  const rows = state.masterRows.filter((d) =>
    !q || (d.don_hang || "").toLowerCase().includes(q) || (d.po || "").toLowerCase().includes(q));
  const orders = new Set(state.masterRows.map((d) => d.don_hang)).size;
  $("masterCount").textContent = state.masterRows.length + " dòng · " + orders + " đơn hàng" +
    (q ? " · khớp lọc: " + rows.length : "");
  if (!rows.length) {
    body.innerHTML = "<tr><td colspan='7' class='muted'>" +
      (state.masterRows.length ? "Không khớp tìm kiếm." : "Chưa có dữ liệu. Bấm “📥 Import CSV”.") + "</td></tr>";
    return;
  }
  const show = rows.slice(0, 100);
  body.innerHTML = show.map((d) => {
    const key = d.don_hang + "|" + d.size;
    return "<tr><td><b>" + esc(d.don_hang) + "</b></td><td>" + esc(d.po || "—") + "</td>" +
      "<td>" + esc(d.mau || "—") + "</td><td>" + esc(d.size || "—") + "</td>" +
      "<td>" + (d.so_doi ?? "—") + "</td><td>" + (d.so_thung ?? "—") + "</td>" +
      "<td style='white-space:nowrap'><button class='small' data-medit='" + esc(key) + "'>Sửa</button> " +
      "<button class='small danger' data-mdel='" + esc(key) + "'>Xóa</button></td></tr>";
  }).join("") + (rows.length > 100
    ? "<tr><td colspan='7' class='muted'>…còn " + (rows.length - 100) + " dòng, hãy tìm kiếm để thu hẹp.</td></tr>" : "");
  body.querySelectorAll("[data-medit]").forEach((b) =>
    b.addEventListener("click", () => { const k = b.getAttribute("data-medit").split("|"); masterForm(k[0], k[1]); }));
  body.querySelectorAll("[data-mdel]").forEach((b) =>
    b.addEventListener("click", () => { const k = b.getAttribute("data-mdel").split("|"); masterDelete(k[0], k[1]); }));
}
/* Thêm / sửa 1 dòng master (đơn hàng + size là khóa) */
function masterForm(donHang, size) {
  const isNew = !donHang;
  const d = (!isNew && (state.masterRows.find((r) => r.don_hang === donHang && r.size === size))) || {};
  openModal(isNew ? "Thêm dòng master" : "Sửa " + donHang + " / " + size,
    "<div class='field'><label>Đơn hàng (chỉ thị)</label>" +
    "<input id='mDonHang' value='" + esc(donHang || "") + "'" + (isNew ? "" : " disabled") +
    " placeholder='VD: AE2608622' style='text-transform:uppercase'></div>" +
    "<div class='field'><label>Size</label>" +
    "<input id='mSize2' value='" + esc(size || "") + "'" + (isNew ? "" : " disabled") +
    " placeholder='VD: UK 5'></div>" +
    "<div class='field'><label>PO</label><input id='mPo2' value='" + esc(d.po || "") + "' placeholder='VD: 0903165517-1'></div>" +
    "<div class='field'><label>Màu</label><input id='mMau' value='" + esc(d.mau || "") + "' placeholder='VD: LC1785'></div>" +
    "<div class='rowflex'><div class='field inline'><label>Số đôi</label><input id='mSoDoi' type='number' value='" + (d.so_doi ?? "") + "'></div>" +
    "<div class='field inline'><label>Số thùng</label><input id='mSoThung' type='number' value='" + (d.so_thung ?? "") + "'></div></div>" +
    "<div class='field'><label>Quốc gia</label><input id='mQg' value='" + esc(d.quoc_gia || "") + "'></div>" +
    "<div class='rowflex'><div class='field inline'><label>Ngày xuất KD</label><input id='mNgay' value='" + esc(d.ngay_xuat_kd || "") + "'></div>" +
    "<div class='field inline'><label>Đợt đặt hàng</label><input id='mDot' value='" + esc(d.dot_dat_hang || "") + "'></div></div>",
    "Lưu", async () => {
      const k = (donHang || $("mDonHang").value).trim().toUpperCase();
      const s = (size || $("mSize2").value).trim().toUpperCase();
      if (!k || !s) { toast("Thiếu Đơn hàng hoặc Size.", "warn"); return; }
      const row = {
        don_hang: k, size: s,
        po: $("mPo2").value.trim(), mau: $("mMau").value.trim().toUpperCase(),
        so_doi: parseInt($("mSoDoi").value, 10) || 0, so_thung: parseInt($("mSoThung").value, 10) || 0,
        quoc_gia: $("mQg").value.trim().toUpperCase(), ngay_xuat_kd: $("mNgay").value.trim(),
        dot_dat_hang: $("mDot").value.trim(), updated_at: new Date().toISOString(),
      };
      const { error } = await supa.from("master_orders").upsert(row, { onConflict: "don_hang,size" });
      closeModal();
      if (error) { toast("Lỗi lưu master: " + error.message, "err"); return; }
      await loadMaster();
      await backfillPoFromMaster();
      toast("Đã lưu " + k + " / " + s + ".", "ok");
    });
}
function masterDelete(donHang, size) {
  openModal("Xóa dòng master",
    "<p>Xóa <b>" + esc(donHang) + " / " + esc(size) + "</b> khỏi master data? Các bản ghi đã quét giữ nguyên.</p>",
    "Xóa", async () => {
      const { error } = await supa.from("master_orders").delete().eq("don_hang", donHang).eq("size", size);
      closeModal();
      if (error) { toast("Lỗi xóa: " + error.message, "err"); return; }
      await loadMaster();
      toast("Đã xóa.", "ok");
    });
}
/* Đọc CSV đơn hàng: chịu BOM, CRLF, cột có ngoặc kép; map cột theo tên tiếng Việt */
function parseOrderCSV(text) {
  text = text.replace(/^\uFEFF/, "");
  const rows = [];
  let cur = [""], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur[cur.length - 1] += '"'; i++; } else inQ = false; }
      else cur[cur.length - 1] += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") cur.push("");
    else if (c === "\n") { rows.push(cur); cur = [""]; }
    else if (c === "\r") { /* bỏ qua, \n sẽ tách dòng */ }
    else cur[cur.length - 1] += c;
  }
  if (cur.length > 1 || cur[0] !== "") rows.push(cur);
  if (!rows.length) return { rows: [] };
  const norm = (s) => (s || "").trim().toLowerCase();
  const header = rows[0].map(norm);
  const alias = {
    don_hang: ["đơn hàng", "don hang", "mã lệnh", "ma lenh", "chỉ thị", "chi thi", "order"],
    po: ["po"],
    mau: ["màu", "mau", "color"],
    size: ["size"],
    so_doi: ["số đôi", "so doi", "số lượng đôi"],
    so_thung: ["số thùng", "so thung", "số lượng thùng"],
    quoc_gia: ["quốc gia", "quoc gia", "nước", "country"],
    ngay_xuat_kd: ["ngày xuất kd", "ngay xuat kd"],
    dot_dat_hang: ["đợt đặt hàng", "dot dat hang"],
  };
  const col = {};
  Object.keys(alias).forEach((k) => { col[k] = header.findIndex((h) => alias[k].indexOf(h) >= 0); });
  if (col.don_hang < 0 || col.size < 0) return { rows: [], error: "Thiếu cột Đơn hàng hoặc Size." };
  const out = [];
  for (const r of rows.slice(1)) {
    const dh = (r[col.don_hang] || "").trim().toUpperCase();
    const sz = (r[col.size] || "").trim().toUpperCase();
    if (!dh || !sz) continue;
    const num = (k) => {
      const v = parseInt(((col[k] >= 0 && r[col[k]]) || "").replace(/[^\d-]/g, ""), 10);
      return isNaN(v) ? 0 : v;
    };
    const str = (k) => (col[k] >= 0 ? (r[col[k]] || "").trim() : "");
    out.push({
      don_hang: dh, size: sz, po: str("po"), mau: str("mau").toUpperCase(),
      so_doi: num("so_doi"), so_thung: num("so_thung"),
      quoc_gia: str("quoc_gia").toUpperCase(), ngay_xuat_kd: str("ngay_xuat_kd"),
      dot_dat_hang: str("dot_dat_hang"), updated_at: new Date().toISOString(),
    });
  }
  return { rows: out };
}
async function importMasterCSV(file) {
  if (!file) return;
  const parsed = parseOrderCSV(await file.text());
  if (parsed.error) { toast(parsed.error, "err"); return; }
  if (!parsed.rows.length) { toast("File không có dòng dữ liệu hợp lệ.", "warn"); return; }
  if (!confirm("Import " + parsed.rows.length + " dòng vào master data? Dòng trùng (đơn hàng + size) sẽ được ghi đè.")) return;
  toast("Đang import " + parsed.rows.length + " dòng…", "");
  try {
    for (let i = 0; i < parsed.rows.length; i += 200) {
      const { error } = await supa.from("master_orders")
        .upsert(parsed.rows.slice(i, i + 200), { onConflict: "don_hang,size" });
      if (error) throw error;
    }
    await loadMaster();
    await backfillPoFromMaster();
    toast("Import xong " + parsed.rows.length + " dòng master data.", "ok");
  } catch (e) {
    toast("Lỗi import: " + (e.message || e), "err");
  }
}
/* Vá PO cho các bản ghi quét đang trống PO mà master đã có (tối đa 200/lần) */
async function backfillPoFromMaster() {
  if (!schemaV4 || !supa) return;
  try {
    const { data, error } = await supa.from("records").select("id,chi_thi").eq("po", "").limit(200);
    if (error || !data || !data.length) return;
    const byChi = {};
    data.forEach((r) => {
      const po = masterPO(r.chi_thi);
      if (po) (byChi[r.chi_thi] || (byChi[r.chi_thi] = { po: po, ids: [] })).ids.push(r.id);
    });
    for (const k of Object.keys(byChi)) {
      await supa.from("records").update({ po: byChi[k].po }).in("id", byChi[k].ids);
    }
    if (Object.keys(byChi).length) { try { await loadRecords(); } catch (e) {} }
  } catch (e) { /* không chặn */ }
}


/* ---------------- v5.0: packing list (khoảng thùng -> size/số đôi) ----------------
 * File PACKING_LIST_CLP_TVS chuẩn: mỗi chỉ thị có các khoảng thùng liên tục
 * [thung_tu, thung_den], mỗi khoảng cố định 1 size + số đôi/thùng + PO.
 * Số thứ tự thùng = phần số sau ký tự "6" ở đuôi mã QR, CỘNG 1
 * (tem in 0-index "…60000" = thùng đầu, packing list đánh 1-index;
 * VD "AE260850660003" -> 4; "AD260000861537" -> 1538).
 * ĐÃ KIỂM CHỨNG khớp báo cáo mẫu cũ trên dữ liệu thật:
 * AE2608506 -> P=92 thùng, Q=552 đôi (11/22/26/16/12/5 theo từng khoảng).
 * Khi quét: size/PO tự điền CHÍNH XÁC từ packing — không cần OCR/pad. */
let warnedNoPacking = false;
const PACK_CACHE_KEY = "quetdoc_packing_v1";

async function loadPacking() {
  state.packing = []; state.packingByChi = new Map(); state.packingReady = false;
  if (!supa) return;
  try {
    // v5.0: phân trang .range() vì Supabase mặc định giới hạn 1000 dòng/lần
    const all = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supa.from("packing_ranges")
        .select("chi_thi,size,doi_thung,so_thung,tong_doi,thung_tu,thung_den,po,art")
        .order("chi_thi").order("thung_tu")
        .range(from, from + PAGE - 1);
      if (error) throw error;
      all.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    setPacking(all);
    try { safeLS.set(PACK_CACHE_KEY, JSON.stringify({ at: Date.now(), rows: all })); } catch (_) {}
  } catch (e) {
    console.warn("Không tải được packing list:", e.message);
    try { // rớt mạng -> dùng cache cũ để vẫn tra được khi quét
      const raw = safeLS.get(PACK_CACHE_KEY);
      if (raw) { const c = JSON.parse(raw); if (c.rows && c.rows.length) setPacking(c.rows); }
    } catch (_) {}
    if (isAdmin() && !warnedNoPacking && !state.packing.length &&
        /packing_ranges|schema cache|does not exist/i.test(e.message || "")) {
      warnedNoPacking = true;
      toast("Chưa có bảng Packing list. Hãy chạy file docs/migration-v5.0.sql trong Supabase SQL Editor.", "warn");
    }
  }
  if (isAdmin()) renderPacking();
  refreshReportBtn(); // v5.1.1: bật nút báo cáo ngay khi packing tải xong
  backfillPackingSizes(); // v5.2.2: vá size/PO cho bản ghi quét lúc chưa có packing
  refreshSession(); // v5.3: đối chiếu lại phiên quét khi packing đổi
}
function setPacking(rows) {
  state.packing = rows;
  const m = new Map();
  rows.forEach((r) => {
    if (!m.has(r.chi_thi)) m.set(r.chi_thi, []);
    m.get(r.chi_thi).push(r);
  });
  state.packingByChi = m;
  state.packingReady = true;
}
/* Đuôi QR sau ký tự "6": SỐ IN TRÊN TEM, bắt đầu từ 000 (0-index).
 * Packing list đánh từ 1 -> số packing = tail + 1 (đã kiểm chứng khớp báo cáo mẫu cũ:
 * AE2608506 cho đúng 11/22/26/16/12/5, P=92, Q=552). Đuôi lạ -> null. */
function boxTail(content, chiThi) {
  const tail = String(content || "").slice(String(chiThi || "").length);
  const m = /^6(\d+)$/.exec(tail);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
/* Số thứ tự thùng theo packing list (1-index) = tail + 1, dùng để tra khoảng. */
function boxSeq(content, chiThi) {
  const t = boxTail(content, chiThi);
  return t == null ? null : t + 1;
}
/* Tra khoảng packing chứa thùng vừa quét -> {size, doi_thung, po, ...} | null */
function packingLookup(chiThi, content) {
  if (!chiThi || !state.packingReady) return null;
  const n = boxSeq(content, chiThi);
  if (n == null) return null;
  const arr = state.packingByChi.get(chiThi);
  if (!arr) return null;
  for (const r of arr) if (r.thung_tu <= n && n <= r.thung_den) return r;
  return null;
}
/* Size chuẩn "X.0-Y" từ packing (khớp định dạng pad/OCR/strip để badge so sánh được) */
function packSizeStr(p) {
  if (!p) return "";
  const s = parseFloat(p.size);
  return (isNaN(s) ? String(p.size) : s.toFixed(1)) + "-" + (p.doi_thung == null ? 6 : p.doi_thung);
}
/* Bản ghi có size trùng khớp packing không? (để hiện badge 📦; sửa tay -> mất badge) */
function isPackSize(rec) {
  if (!rec || !rec.size) return false;
  const p = packingLookup(rec.chiThi, rec.content);
  return !!p && packSizeStr(p) === rec.size;
}
/* v5.2.2: tự vá size/PO cho bản ghi cũ còn trống từ packing list
 * (quét lúc packing chưa nạp / trước khi có mapping chuẩn).
 * Chỉ điền khi đang trống — không ghi đè size tay/OCR/PO đã có. */
async function backfillPackingSizes() {
  if (!supa || !state.me || !state.packingReady || !state.packing.length) return;
  let filled = 0;
  for (const rec of state.records) {
    if (rec.pending || String(rec.id).startsWith("tmp_")) continue;
    if (rec.size && rec.po) continue;
    const p = packingLookup(rec.chiThi, rec.content);
    if (!p) continue;
    const upd = {};
    if (!rec.size) { rec.size = packSizeStr(p); upd.size = rec.size; }
    if (!rec.po && p.po) { rec.po = p.po; upd.po = rec.po; }
    if (!Object.keys(upd).length) continue;
    filled++;
    supa.from("records").update(upd).eq("id", rec.id).then(() => {}).catch(() => {});
  }
  if (filled) {
    renderAll();
    toast("Đã tự điền size/PO từ packing list cho " + filled + " bản ghi cũ 📦", "ok");
  }
}

/* ---- admin: quản lý packing list ---- */
function renderPacking() {
  const body = $("packingBody");
  if (!body) return;
  const q = (($("packingSearch") && $("packingSearch").value) || "").trim().toLowerCase();
  const rows = state.packing.filter((r) =>
    !q || (r.chi_thi || "").toLowerCase().includes(q) || (r.po || "").toLowerCase().includes(q));
  $("packingCount").textContent = state.packing.length + " khoảng · " +
    state.packingByChi.size + " chỉ thị" + (q ? " · khớp lọc: " + rows.length : "");
  if (!rows.length) {
    body.innerHTML = "<tr><td colspan='9' class='muted'>" +
      (state.packing.length ? "Không khớp tìm kiếm." : "Chưa có dữ liệu. Chạy migration-v5.0.sql hoặc bấm “📥 Import Excel”.") + "</td></tr>";
    return;
  }
  const show = rows.slice(0, 100);
  body.innerHTML = show.map((r) => {
    const key = r.chi_thi + "|" + r.thung_tu + "|" + r.thung_den;
    return "<tr><td><b>" + esc(r.chi_thi) + "</b></td><td>" + esc(r.size) + "</td>" +
      "<td>" + (r.doi_thung ?? "—") + "</td><td>" + (r.so_thung ?? "—") + "</td>" +
      "<td>" + r.thung_tu + "</td><td>" + r.thung_den + "</td>" +
      "<td>" + esc(r.po || "—") + "</td><td>" + esc(r.art || "—") + "</td>" +
      "<td style='white-space:nowrap'><button class='small' data-pedit='" + esc(key) + "'>Sửa</button> " +
      "<button class='small danger' data-pdel='" + esc(key) + "'>Xóa</button></td></tr>";
  }).join("") + (rows.length > 100
    ? "<tr><td colspan='9' class='muted'>…còn " + (rows.length - 100) + " khoảng, hãy tìm kiếm để thu hẹp.</td></tr>" : "");
  body.querySelectorAll("[data-pedit]").forEach((b) =>
    b.addEventListener("click", () => { const k = b.getAttribute("data-pedit").split("|"); packingForm(k[0], k[1], k[2]); }));
  body.querySelectorAll("[data-pdel]").forEach((b) =>
    b.addEventListener("click", () => { const k = b.getAttribute("data-pdel").split("|"); packingDelete(k[0], k[1], k[2]); }));
}
/* Thêm / sửa 1 khoảng packing (khóa = chỉ thị + thùng từ + thùng đến) */
function packingForm(chiThi, tu, den) {
  const isNew = !chiThi;
  const r = (!isNew && state.packing.find((x) =>
    x.chi_thi === chiThi && String(x.thung_tu) === String(tu) && String(x.thung_den) === String(den))) || {};
  const dis = isNew ? "" : " disabled";
  openModal(isNew ? "Thêm khoảng packing" : "Sửa " + chiThi + " [" + tu + "–" + den + "]",
    "<div class='rowflex'><div class='field inline'><label>Chỉ thị</label>" +
    "<input id='pChiThi' value='" + esc(chiThi || "") + "'" + dis + " placeholder='VD: AE2608506' style='text-transform:uppercase'></div>" +
    "<div class='field inline'><label>Size</label><input id='pSize' value='" + esc(r.size || "") + "' placeholder='VD: 5'></div></div>" +
    "<div class='rowflex'><div class='field inline'><label>Thùng từ</label>" +
    "<input id='pTu' type='number' min='1' value='" + (tu || "") + "'" + dis + "></div>" +
    "<div class='field inline'><label>Thùng đến</label>" +
    "<input id='pDen' type='number' min='1' value='" + (den || "") + "'" + dis + "></div></div>" +
    "<div class='rowflex'><div class='field inline'><label>Số đôi/thùng</label>" +
    "<input id='pDoi' type='number' min='0' value='" + (r.doi_thung ?? 6) + "'></div>" +
    "<div class='field inline'><label>Số thùng (để trống = tự tính)</label>" +
    "<input id='pSoThung' type='number' min='0' value='" + (r.so_thung ?? "") + "'></div></div>" +
    "<div class='rowflex'><div class='field inline'><label>PO</label>" +
    "<input id='pPo' value='" + esc(r.po || "") + "'></div>" +
    "<div class='field inline'><label>Art#</label>" +
    "<input id='pArt' value='" + esc(r.art || "") + "'></div></div>",
    "Lưu", async () => {
      const ct = (chiThi || $("pChiThi").value).trim().toUpperCase();
      const t = parseInt(chiThi ? tu : $("pTu").value, 10);
      const d = parseInt(chiThi ? den : $("pDen").value, 10);
      const sz = $("pSize").value.trim();
      if (!ct || !sz || !(t >= 1) || !(d >= t)) { toast("Kiểm tra lại Chỉ thị / Size / khoảng thùng.", "warn"); return; }
      const doi = parseInt($("pDoi").value, 10);
      const stRaw = parseInt($("pSoThung").value, 10);
      const st = isNaN(stRaw) ? (d - t + 1) : stRaw;
      const row = {
        chi_thi: ct, size: sz, doi_thung: isNaN(doi) ? 6 : doi,
        so_thung: st, tong_doi: st * (isNaN(doi) ? 6 : doi),
        thung_tu: t, thung_den: d,
        po: $("pPo").value.trim(), art: $("pArt").value.trim().toUpperCase(),
        updated_at: new Date().toISOString(),
      };
      const { error } = await supa.from("packing_ranges")
        .upsert(row, { onConflict: "chi_thi,thung_tu,thung_den" });
      closeModal();
      if (error) { toast("Lỗi lưu packing: " + error.message, "err"); return; }
      await loadPacking();
      toast("Đã lưu khoảng " + ct + " [" + t + "–" + d + "].", "ok");
    });
}
function packingDelete(chiThi, tu, den) {
  openModal("Xóa khoảng packing",
    "<p>Xóa khoảng <b>" + esc(chiThi) + " [" + esc(tu) + "–" + esc(den) + "]</b>? Các bản ghi đã quét giữ nguyên.</p>",
    "Xóa", async () => {
      const { error } = await supa.from("packing_ranges").delete()
        .eq("chi_thi", chiThi).eq("thung_tu", tu).eq("thung_den", den);
      closeModal();
      if (error) { toast("Lỗi xóa: " + error.message, "err"); return; }
      await loadPacking();
      toast("Đã xóa.", "ok");
    });
}
/* Import packing list từ Excel (.xlsx): tự tìm sheet + dòng header
 * ("Mã chỉ thị", "Số thùng từ"...), thay thế dữ liệu theo từng chỉ thị. */
async function importPackingXlsx(file) {
  if (!file) return;
  if (typeof XLSX === "undefined") { toast("Chưa tải được thư viện Excel. Kiểm tra mạng rồi thử lại.", "err"); return; }
  let wb;
  try { wb = XLSX.read(await file.arrayBuffer(), { type: "array" }); }
  catch (e) { toast("Không đọc được file Excel.", "err"); return; }
  const normH = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9à-ỹ]/g, "");
  const alias = {
    chi_thi: ["mãchỉthị", "machithi", "chỉthị", "chithi", "mãlệnh", "malenh"],
    size: ["size"],
    doi_thung: ["sốđôi/thùng", "sốđôithùng", "sodoithung", "đôithùng", "doithung", "sốđôi", "sodoi"],
    so_thung: ["sốthùng", "sothung"],
    tong_doi: ["tổngsốđôi", "tongsodoi", "tổngđôi", "tongdoi"],
    thung_tu: ["sốthùngtừ", "sốthungtừ", "sothungtu", "thùngtừ", "thungtu", "từ", "tu"],
    thung_den: ["sốthùngđến", "sốthungđến", "sothungden", "thùngđến", "thungden", "đến", "den"],
    po: ["po#", "po"],
    art: ["art#", "art"],
  };
  let parsed = null;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
    for (let hi = 0; hi < Math.min(10, grid.length); hi++) {
      const cols = {};
      grid[hi].forEach((cell, ci) => {
        const h = normH(cell);
        if (!h) return;
        for (const k of Object.keys(alias)) {
          if (cols[k] == null && alias[k].indexOf(h) >= 0) cols[k] = ci;
        }
      });
      if (cols.chi_thi != null && cols.thung_tu != null && cols.thung_den != null) {
        const out = [];
        for (let r = hi + 1; r < grid.length; r++) {
          const row = grid[r];
          const ct = String(row[cols.chi_thi] || "").trim().toUpperCase();
          const t = parseInt(row[cols.thung_tu], 10), d = parseInt(row[cols.thung_den], 10);
          if (!ct || !(t >= 1) || !(d >= t)) continue;
          const num = (k, fb) => {
            if (cols[k] == null) return fb;
            const v = parseInt(String(row[cols[k]]).replace(/[^\d-]/g, ""), 10);
            return isNaN(v) ? fb : v;
          };
          const sz = cols.size != null ? String(row[cols.size]).trim() : "";
          if (!sz) continue;
          const doi = num("doi_thung", 6), st = num("so_thung", d - t + 1);
          out.push({
            chi_thi: ct, size: sz, doi_thung: doi, so_thung: st,
            tong_doi: cols.tong_doi != null ? num("tong_doi", st * doi) : st * doi,
            thung_tu: t, thung_den: d,
            po: cols.po != null ? String(row[cols.po] || "").trim() : "",
            art: cols.art != null ? String(row[cols.art] || "").trim().toUpperCase() : "",
            updated_at: new Date().toISOString(),
          });
        }
        if (out.length) { parsed = out; break; }
      }
    }
    if (parsed) break;
  }
  if (!parsed || !parsed.length) { toast("Không tìm thấy bảng packing hợp lệ trong file (cần cột Mã chỉ thị, Số thùng từ/đến).", "err"); return; }
  const dirs = [...new Set(parsed.map((r) => r.chi_thi))];
  if (!confirm("Import " + parsed.length + " khoảng của " + dirs.length + " chỉ thị? Dữ liệu packing cũ của các chỉ thị này sẽ được THAY THẾ.")) return;
  toast("Đang import " + parsed.length + " khoảng…", "");
  try {
    for (let i = 0; i < dirs.length; i += 200) {
      const { error } = await supa.from("packing_ranges").delete().in("chi_thi", dirs.slice(i, i + 200));
      if (error) throw error;
    }
    for (let i = 0; i < parsed.length; i += 200) {
      const { error } = await supa.from("packing_ranges")
        .upsert(parsed.slice(i, i + 200), { onConflict: "chi_thi,thung_tu,thung_den" });
      if (error) throw error;
    }
    await loadPacking();
    toast("Import xong " + parsed.length + " khoảng packing (" + dirs.length + " chỉ thị).", "ok");
  } catch (e) {
    toast("Lỗi import: " + (e.message || e), "err");
  }
}

/* ---------------- v5.0: báo cáo sản lượng ----------------
 * Đúng mẫu packing list: mỗi khoảng thùng 1 dòng; đếm số thùng DUY NHẤT
 * đã quét nằm trong [thung_tu, thung_den] (P), số đôi đã quét Q = P × doi_thùng.
 * Dòng còn thiếu (Còn lại > 0) được tô đỏ để dễ phát hiện. */
function openReportModal() {
  // v5.5: lọc theo nghiệp vụ (Kiểm/Nhập/Xuất) — mặc định lấy loại pallet
  // đang chọn ở phiên quét trên màn hình quét (mapping từ ô khởi tạo).
  const curType = (getSession().type || "");
  const opts = [["", "Tất cả"], ["Kiểm", "Kiểm"], ["Nhập", "Nhập"], ["Xuất", "Xuất"]];
  openModal("📊 Báo cáo sản lượng",
    "<div class='field'><label>Ngày báo cáo</label><input type='date' id='rpDate' value='" + todayStr() + "'></div>" +
    "<div class='field'><label>Nghiệp vụ</label><select id='rpType'>" +
    opts.map(([v, l]) => "<option value='" + v + "'" + (v === curType ? " selected" : "") + ">" + l + "</option>").join("") +
    "</select></div>" +
    "<div class='field'><label>Lọc số pallet (để trống = tất cả)</label>" +
    "<input id='rpPallet' placeholder='VD: NK'></div>" +
    "<p class='sec-hint'>Mỗi khoảng thùng 1 dòng theo đúng mẫu packing list. " +
    (isAdmin() ? "Báo cáo tính trên toàn bộ bản ghi." : "Báo cáo chỉ tính các mã do bạn quét.") + "</p>",
    "Xuất Excel", async () => {
      const day = $("rpDate").value || todayStr();
      const typeQ = ($("rpType").value || "").trim().toLowerCase();
      const pq = ($("rpPallet").value || "").trim().toLowerCase();
      closeModal();
      await exportReport(day, pq, typeQ);
    });
}
/* Lấy toàn bộ bản ghi của 1 ngày (giờ VN) trực tiếp từ server —
 * không phụ thuộc giới hạn 500 dòng đang hiển thị trên bảng. */
/* v6.7.1: bọc timeout cho promise — Supabase JS không có timeout mặc định,
 * request kẹt (mạng công ty/proxy) sẽ treo await vĩnh viễn. */
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error("Hết thời gian chờ " + label + " (" + Math.round(ms / 1000) + "s). Hãy bấm ↻ thử lại.")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
async function fetchDayRecords(day) {
  const t0 = new Date(day + "T00:00:00+07:00");
  const t1 = new Date(t0); t1.setDate(t1.getDate() + 1);
  const full = "content,chi_thi,session,scanned_at,username,size"; // v6.7
  const legacy = "content,session,scanned_at,username";
  // v6.7.1: thử cột đầy đủ trước; server báo thiếu cột -> lùi về legacy (như loadRecords)
  for (const cols of schemaV4 ? [full, legacy] : [legacy]) {
    try {
      return await fetchDayPage(t0, t1, cols);
    } catch (e) {
      if (schemaV4 && cols === full && /chi_thi|size|schema cache|column/i.test(e.message || "")) continue;
      throw e;
    }
  }
}
async function fetchDayPage(t0, t1, cols) {
  let all = [], from = 0;
  for (;;) {
    let q = supa.from("records").select(cols)
      .gte("scanned_at", t0.toISOString()).lt("scanned_at", t1.toISOString())
      .order("scanned_at").range(from, from + 999);
    if (!isAdmin()) q = q.eq("user_id", state.me.id);
    const { data, error } = await withTimeout(q, 20000, "tải số liệu ngày");
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return all;
}
function computeReport(dayRows) {
  const seen = new Map(); // dedupe: mỗi số thùng chỉ đếm 1 lần
  dayRows.forEach((r) => { const k = norm(r.content || ""); if (k && !seen.has(k)) seen.set(k, r); });
  const byChi = new Map();
  seen.forEach((r) => {
    const ct = (r.chi_thi || parseChiThi(r.content || "")).toUpperCase();
    if (!ct) return;
    if (!byChi.has(ct)) byChi.set(ct, []);
    byChi.get(ct).push(r);
  });
  const rows = [], noPack = [];
  [...byChi.keys()].sort().forEach((ct) => {
    const ranges = state.packingByChi.get(ct);
    const list = byChi.get(ct);
    if (!ranges || !ranges.length) { noPack.push({ chi_thi: ct, count: list.length }); return; }
    ranges.forEach((rg) => {
      let p = 0;
      const boxSet = new Set(); // lưu SỐ IN TRÊN TEM (0-index) để hiển thị cột M
      const userSet = new Set(); // v5.6: người quét của khoảng này
      for (const r of list) {
        const t = boxTail(r.content, ct);
        if (t == null) continue;
        const n = t + 1; // số packing (1-index) để tra khoảng
        if (rg.thung_tu <= n && n <= rg.thung_den) {
          p++; boxSet.add(t);
          const u = (r.username || "").trim();
          if (u) userSet.add(u);
        }
      }
      const boxes = [...boxSet].sort((a, b) => a - b);
      rows.push({ rg: rg, p: p, q: p * (rg.doi_thung || 0), left: (rg.so_thung || 0) - p,
        boxes: boxes, users: [...userSet].sort().map(dName).join(", ") }); // v6.5: tên NV thay vì user1
    });
  });
  return { rows: rows, noPack: noPack, totalScans: seen.size };
}
/* ---- v5.0: BÁO CÁO NHẬP KHO đúng mẫu xưởng ----
 * Mẫu: STT | Mã chỉ thị | Po# | Art# | SIZE | Tổng số đôi | Số đôi/thùng |
 * Số thùng | Số thùng từ | Số thùng đến | đếm số thùng | số lượng
 * - "đếm số thùng" (P) = số thùng đã quét nằm trong khoảng (đã dedupe mã trùng)
 * - "số lượng" (Q) = P × Số đôi/thùng
 * - Chỉ hiện khoảng có quét (P > 0), đúng mẫu báo cáo cũ của xưởng.
 * - Mapping số thùng: QR 0-index + 1 = packing 1-index (đã kiểm chứng khớp mẫu cũ). */
/* v6.8: tên sheet báo cáo theo nghiệp vụ (trước đây cứng "Báo cáo nhập kho") */
function reportSheetName(typeQ) {
  return { "kiểm": "Báo cáo kiểm kho", "nhập": "Báo cáo nhập kho", "xuất": "Báo cáo xuất kho" }[typeQ] || "Báo cáo nhập kho";
}
/* v6.8: gom các dòng báo cáo theo chỉ thị + tính tổng nhóm (để chèn dòng "Tổng" đúng mẫu xưởng) */
function groupReportRows(rows) {
  const groups = new Map();
  (rows || []).forEach((it) => {
    const ct = it.rg.chi_thi;
    if (!groups.has(ct)) groups.set(ct, { chi_thi: ct, items: [], sP: 0, sQ: 0 });
    const gr = groups.get(ct);
    gr.items.push(it); gr.sP += it.p; gr.sQ += it.q;
  });
  return [...groups.values()];
}
/* v6.8: chuỗi cột M "số thứ tự thùng": "048,049,050,051 = 4 thùng" (số in trên tem) */
function boxListStr(boxes) {
  return boxes.length
    ? boxes.map((n) => String(n).padStart(3, "0")).join(",") + " = " + boxes.length + " thùng"
    : "";
}
async function exportReport(day, palletQ, typeQ) {
  if (!state.packingReady || !state.packing.length) {
    toast("Chưa có packing list. Admin hãy chạy migration-v5.0.sql hoặc import Excel packing.", "warn"); return;
  }
  if (!(await ensureExcelJS())) {
    toast("Chưa tải được thư viện Excel (cần mạng). Thử lại.", "err"); return;
  }
  toast("Đang tính báo cáo ngày " + day + "…", "");
  let dayRows;
  try { dayRows = await fetchDayRecords(day); }
  catch (e) { toast("Không tải được bản ghi: " + (e.message || e), "err"); return; }
  // v5.5: lọc nghiệp vụ theo loại pallet của phiên quét ("Kiểm 1", "Nhập 2", "Xuất 3")
  if (typeQ) dayRows = dayRows.filter((r) => (r.session || "").toLowerCase().startsWith(typeQ));
  if (palletQ) dayRows = dayRows.filter((r) => (r.session || "").toLowerCase().includes(palletQ));
  const rep = computeReport(dayRows);
  const rows = rep.rows.filter((it) => it.p > 0); // đúng mẫu xưởng: chỉ khoảng có quét
  if (!rows.length && !rep.noPack.length) { toast("Ngày " + day + " chưa có bản ghi nào.", "warn"); return; }

  const YELLOW = "FFFFFF00", GREEN = "FFC6EFCE";
  const headers = ["STT", "Mã chỉ thị", "Po#", "Art#", "SIZE", "Tổng số đôi",
    "Số đôi/thùng", "Số thùng", "Số thùng từ", "Số thùng đến",
    "đếm số thùng", "số lượng", "số thứ tự thùng", "Người quét"];
  const NC = headers.length;
  const wb = new ExcelJS.Workbook();
  wb.creator = "QuetDoc QRcode";
  const ws = wb.addWorksheet(reportSheetName(typeQ)); // v6.8: tên sheet theo nghiệp vụ
  ws.columns = [{ width: 6 }, { width: 16 }, { width: 18 }, { width: 12 }, { width: 10 },
                { width: 14 }, { width: 14 }, { width: 12 }, { width: 14 }, { width: 14 },
                { width: 14 }, { width: 12 }, { width: 44 }, { width: 16 }]; // v6.8: cột M rộng như mẫu
  // Tiêu đề + tổng ở góc phải (đúng mẫu): tổng luôn nằm dưới 2 cột đếm (K, L)
  const dstr = day.split("-").reverse().join("/");
  ws.mergeCells(1, 1, 1, 10);
  const tc = ws.getCell(1, 1);
  // v5.5: tiêu đề + tên file theo nghiệp vụ
  const KIND = { "kiểm": ["BÁO CÁO KIỂM KHO", "Bao_Cao_Kiem_Kho"],
    "nhập": ["BÁO CÁO NHẬP KHO", "Bao_Cao_Nhap_Kho"],
    "xuất": ["BÁO CÁO XUẤT KHO", "Bao_Cao_Xuat_Kho"] }[typeQ] ||
    ["BÁO CÁO NHẬP KHO", "Bao_Cao_Nhap_Kho"];
  tc.value = KIND[0] + " : " + dstr + (palletQ ? " · pallet: " + palletQ : "");
  tc.font = { name: "Arial", size: 14, bold: true };
  tc.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 26;
  let sP = 0, sQ = 0;
  rows.forEach((it) => { sP += it.p; sQ += it.q; });
  const tp = ws.getCell(1, 11), tq = ws.getCell(1, 12);
  tp.value = sP; tq.value = sQ;
  [tp, tq].forEach((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: YELLOW } };
    c.font = { name: "Arial", size: 12, bold: true };
    c.alignment = { horizontal: "center", vertical: "middle" };
    c.border = xlBorder();
  });
  // Header vàng
  ws.addRow(headers);
  const hr = ws.getRow(2);
  for (let c = 1; c <= NC; c++) {
    const cell = hr.getCell(c);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: YELLOW } };
    cell.font = { name: "Arial", size: 11, bold: true, color: { argb: "FF0F172A" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = xlBorder();
  }
  hr.height = 22;
  // v6.8: đúng mẫu xưởng — gom theo chỉ thị, chèn dòng "Tổng" cam sau mỗi nhóm;
  // 3 cột K/L/M (đếm số thùng, số lượng, số thứ tự thùng) tô xanh.
  const ORANGE = "FFF59E0B";
  let stt = 0;
  groupReportRows(rows).forEach((gr) => {
    gr.items.forEach((it) => {
      stt++;
      const g = it.rg;
      const boxStr = boxListStr(it.boxes);
      const row = ws.addRow([stt, g.chi_thi, g.po || "", g.art || "",
        +g.size || g.size, g.tong_doi || 0, g.doi_thung || 0, g.so_thung || 0,
        g.thung_tu, g.thung_den, it.p, it.q, boxStr, it.users || ""]);
      row.eachCell((cell, cn) => {
        xlBodyCell(cell, cn !== 3 && cn !== 4 && cn !== 14); // v5.6: cột N tên người quét căn trái
        if (cn >= NC - 3 && cn <= NC - 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
        if (cn === NC - 1) cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      });
      if (boxStr.length > 40) row.height = Math.max(18, Math.ceil(boxStr.length / 40) * 15);
    });
    // Dòng "Tổng" của chỉ thị (nền cam) — đúng mẫu
    const tr = ws.addRow([]);
    ws.mergeCells(tr.number, 1, tr.number, 10);
    const cT = tr.getCell(1);
    cT.value = "Tổng";
    cT.font = { name: "Arial", size: 11, bold: true, color: { argb: "FF0F172A" } };
    cT.alignment = { horizontal: "center", vertical: "middle" };
    const cK = tr.getCell(11), cL = tr.getCell(12);
    cK.value = gr.sP; cL.value = gr.sQ;
    [cK, cL].forEach((c) => {
      c.font = { name: "Arial", size: 11, bold: true, color: { argb: "FF0F172A" } };
      c.alignment = { horizontal: "center", vertical: "middle" };
    });
    for (let c = 1; c <= NC; c++) {
      const cell = tr.getCell(c);
      cell.border = xlBorder();
      if (c <= 12) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ORANGE } };
    }
    tr.height = 20;
  });
  if (rep.noPack.length) {
    const ws2 = wb.addWorksheet("Chưa có packing");
    ws2.columns = [{ width: 8 }, { width: 18 }, { width: 16 }];
    ws2.mergeCells(1, 1, 1, 3);
    const t2 = ws2.getCell(1, 1);
    t2.value = "CÁC CHỈ THỊ CHƯA CÓ PACKING LIST (" + dstr + ")";
    t2.font = { name: "Arial", size: 13, bold: true };
    t2.alignment = { horizontal: "center", vertical: "middle" };
    ws2.addRow(["STT", "Chỉ thị", "Số mã quét"]);
    xlHeaderRow(ws2, 2, 3);
    rep.noPack.forEach((x, i) => {
      const row = ws2.addRow([i + 1, x.chi_thi, x.count]);
      row.eachCell((cell, cn) => xlBodyCell(cell, cn !== 2));
    });
  }
  const stamp = day.replace(/-/g, "") + "_" +
    new Date().toLocaleTimeString("vi-VN", { timeZone: TZ, hour12: false }).replace(/:/g, "");
  xlDownload(await wb.xlsx.writeBuffer(), KIND[1] + "_" + stamp + ".xlsx");
  toast("Đã xuất " + KIND[0].toLowerCase() + " (" + rows.length + " khoảng, " + sP + " thùng, " + sQ + " đôi).", "ok");
}

/* Xóa TOÀN BỘ bản ghi quét của mọi tài khoản (chỉ admin).
 * Yêu cầu gõ đúng cụm xác nhận để tránh bấm nhầm. */
function adminWipeAll() {
  if (!isAdmin()) { toast("Chỉ quản trị viên được xóa toàn bộ dữ liệu.", "err"); return; }
  openModal("⚠️ Xóa TOÀN BỘ dữ liệu quét",
    "<p>Hành động này sẽ xóa <b>vĩnh viễn</b> toàn bộ bản ghi quét của <b>mọi tài khoản</b>. Không thể hoàn tác.</p>" +
    "<div class='field'><label>Gõ <b>XÓA HẾT</b> để xác nhận</label>" +
    "<input id='mWipeConfirm' placeholder='XÓA HẾT' autocomplete='off'></div>",
    "Xóa toàn bộ", async () => {
      const v = ($("mWipeConfirm").value || "").trim();
      if (v !== "XÓA HẾT") { toast("Bạn chưa gõ đúng cụm xác nhận.", "warn"); return; }
      const { error } = await supa.from("records")
        .delete().neq("id", "00000000-0000-0000-0000-000000000000");
      closeModal();
      if (error) { toast("Lỗi xóa: " + error.message, "err"); return; }
      state.page = 0;
      try { await loadRecords(); } catch (e) {}
      toast("Đã xóa toàn bộ dữ liệu quét.", "ok");
    });
}

/* ---------------- tài khoản của tôi ---------------- */
async function changeMyPassword() {
  const p1 = $("newPass").value, p2 = $("newPass2").value;
  if (p1.length < 6) { toast("Mật khẩu mới phải từ 6 ký tự trở lên (theo yêu cầu của Supabase).", "warn"); return; }
  if (p1 !== p2) { toast("Nhập lại mật khẩu mới chưa khớp.", "warn"); return; }
  const { error } = await supa.auth.updateUser({ password: p1 });
  if (error) { toast("Lỗi đổi mật khẩu: " + error.message, "err"); return; }
  $("newPass").value = $("newPass2").value = "";
  toast("Đã đổi mật khẩu.", "ok");
}

/* ---------------- export ---------------- */
function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
/* ---- v5.0: xuất Excel CÓ định dạng (ExcelJS) ----
 * SheetJS bản cộng đồng (0.18.5) KHÔNG ghi được style (đã kiểm chứng) nên
 * header vàng #F59E0B theo mẫu yêu cầu phải dùng ExcelJS (tải khi cần, có cache).
 * Tải lỗi -> rớt về SheetJS (đủ dữ liệu, mất màu). */
const XL_YELLOW = "FFF59E0B";
function ensureExcelJS() {
  if (window.ExcelJS) return Promise.resolve(true);
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
    s.onload = () => resolve(!!window.ExcelJS);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}
function xlBorder() {
  const t = { style: "thin", color: { argb: "FF94A3B8" } };
  return { top: t, left: t, bottom: t, right: t };
}
function xlHeaderRow(ws, rowNum, ncols) {
  const row = ws.getRow(rowNum);
  for (let c = 1; c <= ncols; c++) {
    const cell = row.getCell(c);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XL_YELLOW } };
    cell.font = { name: "Arial", size: 11, bold: true, color: { argb: "FF0F172A" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = xlBorder();
  }
  row.height = 22;
}
function xlBodyCell(cell, center) {
  cell.font = { name: "Arial", size: 11 };
  cell.alignment = { vertical: "middle", horizontal: center ? "center" : "left" };
  cell.border = xlBorder();
}
function xlDownload(buf, name) {
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
/* Xuất Excel .xlsx đúng mẫu tem thùng: 1 sheet/ngày, header vàng, cột
 * STT | Chỉ thị | PO | Size/số đôi | Số thùng | Số pallet | Giờ quét | Người quét */
async function exportExcel() {
  const list = filteredRecords();
  if (!list.length) { toast("Không có bản ghi nào để xuất.", "warn"); return; }
  const stamp = todayStr().replace(/-/g, "") + "_" +
    new Date().toLocaleTimeString("vi-VN", { timeZone: TZ, hour12: false }).replace(/:/g, "");
  if (await ensureExcelJS()) {
    const groups = {};
    list.forEach((r) => {
      const d = new Date(r.scannedAt).toLocaleDateString("en-CA", { timeZone: TZ });
      (groups[d] = groups[d] || []).push(r);
    });
    const headers = ["STT", "Chỉ thị", "PO", "Size/số đôi", "Số thùng", "Số pallet", "Giờ quét", "Người quét"];
    const wb = new ExcelJS.Workbook();
    wb.creator = "QuetDoc QRcode";
    Object.keys(groups).sort().forEach((day) => {
      const ws = wb.addWorksheet(day);
      ws.columns = [{ width: 8 }, { width: 16 }, { width: 18 }, { width: 14 },
                    { width: 22 }, { width: 14 }, { width: 12 }, { width: 14 }];
      ws.addRow(headers);
      xlHeaderRow(ws, 1, headers.length);
      groups[day].slice().sort((a, b) => new Date(a.scannedAt) - new Date(b.scannedAt))
        .forEach((r, i) => {
          const row = ws.addRow([i + 1, r.chiThi || "", r.po || "", r.size || "",
            r.content || "", r.session || "", fmtTimeOnly(r.scannedAt), dName(r.username)]); // v6.5
          row.eachCell((cell, cn) => xlBodyCell(cell, cn === 1 || cn === 7));
        });
    });
    xlDownload(await wb.xlsx.writeBuffer(), "Ket_Qua_Quet_Ma_" + stamp + ".xlsx");
    toast("Đã xuất file Excel (" + list.length + " bản ghi, " + Object.keys(groups).length + " sheet).", "ok");
    return;
  }
  // Fallback: SheetJS (đủ dữ liệu, không có màu) khi không tải được ExcelJS
  if (typeof XLSX === "undefined") {
    toast("Chưa tải được thư viện Excel. Kiểm tra mạng rồi thử lại (hoặc dùng Xuất CSV).", "err");
    return;
  }
  toast("Không tải được thư viện định dạng Excel — xuất bản không màu.", "warn");
  const groups = {};
  list.forEach((r) => {
    const d = new Date(r.scannedAt).toLocaleDateString("en-CA", { timeZone: TZ });
    (groups[d] = groups[d] || []).push(r);
  });
  const wb = XLSX.utils.book_new();
  const headers = ["STT", "Chỉ thị", "PO", "Size/số đôi", "Số thùng", "Số pallet", "Giờ quét", "Người quét"];
  const thinB = { style: "thin", color: { rgb: "FF94A3B8" } };
  const borderAll = { left: thinB, right: thinB, top: thinB, bottom: thinB };
  const hdrStyle = {
    font: { name: "Arial", sz: 11, bold: true, color: { rgb: "FF0F172A" } },
    fill: { patternType: "solid", fgColor: { rgb: "FFF59E0B" } },
    alignment: { horizontal: "center", vertical: "center" },
    border: borderAll,
  };
  const cellStyle = (center) => ({
    font: { name: "Arial", sz: 11 },
    alignment: { horizontal: center ? "center" : "left", vertical: "center" },
    border: borderAll,
  });
  Object.keys(groups).sort().forEach((day) => {
    const rows = groups[day].slice().sort((a, b) => new Date(a.scannedAt) - new Date(b.scannedAt));
    const ws = XLSX.utils.aoa_to_sheet([headers].concat(rows.map((r, i) => [
      i + 1, r.chiThi || "", r.po || "", r.size || "", r.content || "",
      r.session || "", fmtTimeOnly(r.scannedAt), r.username || "",
    ])));
    const range = XLSX.utils.decode_range(ws["!ref"]);
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      if (ws[addr]) ws[addr].s = hdrStyle;
    }
    for (let rr = 1; rr <= range.e.r; rr++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r: rr, c });
        if (ws[addr]) {
          ws[addr].s = cellStyle(c === 0 || c === 6);
          ws[addr].t = c === 0 ? "n" : "s"; // STT là số; còn lại ép text (giữ số 0 đầu PO)
        }
      }
    }
    ws["!cols"] = [{ wch: 8 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 12 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws, day);
  });
  XLSX.writeFile(wb, "Ket_Qua_Quet_Ma_" + stamp + ".xlsx");
  toast("Đã xuất file Excel (" + list.length + " bản ghi, " + Object.keys(groups).length + " sheet).", "ok");
}
function exportCSV() {
  const list = filteredRecords();
  const head = ["STT", "Chi thi", "PO", "Size", "So thung", "So pallet", "Gio quet (GMT+7)", "Nguoi quet"];
  const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const lines = [head.map(q).join(",")];
  list.forEach((r, i) => lines.push(
    [i + 1, r.chiThi, r.po, r.size, r.content, r.session, fmtTime(r.scannedAt), r.username].map(q).join(",")));
  download("Ket_Qua_Quet_Ma_" + todayStr().replace(/-/g, "") + ".csv", "﻿" + lines.join("\r\n"), "text/csv;charset=utf-8");
  toast("Đã xuất file CSV (" + list.length + " bản ghi).", "ok");
}
function exportJSON() {
  const list = filteredRecords();
  download("quetdoc_qrcode_" + todayStr() + ".json",
    JSON.stringify({ exportedAt: new Date().toISOString(), exportedBy: state.me.username, records: list }, null, 2),
    "application/json");
  toast("Đã xuất file JSON (" + list.length + " bản ghi).", "ok");
}

/* ---------------- scanner ---------------- */
function setCamStatus(txt, cls) {
  const c = $("camStatus");
  c.innerHTML = txt; c.className = "chip " + (cls || "");
}
function setHttpsChip() {
  const secure = location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname);
  const c = $("httpsStatus");
  c.innerHTML = secure ? "🔒 <b>HTTPS</b> — dùng được camera" : "⚠️ <b>Không phải HTTPS</b> — camera có thể bị chặn";
  c.className = "chip " + (secure ? "ok" : "warn");
}

/* v6.6: chỉ đổi nhãn "— đang dùng" trên dropdown camera, KHÔNG động vào phần cứng.
 * (Trước đây gọi listCameras() ở đây -> Html5Qrcode.getCameras() mở getUserMedia
 * "dùng 1 lần" rồi stop track; trên iOS việc này giết luôn stream đang quét
 * -> video đen vĩnh viễn. Dropdown đang disabled khi quét nên cũng không cần
 * tải lại danh sách.) */
function markActiveCameraOption() {
  try {
    const sel = $("cameraSelect");
    if (!sel) return;
    if (state.cameraId) {
      const has = Array.prototype.some.call(sel.options, (o) => o.value === state.cameraId);
      if (has) sel.value = state.cameraId;
    }
    const opt = sel.selectedOptions && sel.selectedOptions[0];
    if (!opt) return;
    const base = opt.textContent.replace(/ — đang dùng$/, "").replace(/^[📷🤳] /, "");
    if (state.realFacing === "environment") opt.textContent = "📷 " + base + " — đang dùng";
    else if (state.realFacing === "user") opt.textContent = "🤳 " + base + " — đang dùng";
  } catch (e) {}
}
async function listCameras() {
  // v6.6: TUYỆT ĐỐI không liệt kê lại khi đang quét — Html5Qrcode.getCameras()
  // mở một getUserMedia "dùng 1 lần" rồi stop track; trên iOS (Safari/Chrome)
  // việc này giết luôn stream camera đang quét -> video đen vĩnh viễn.
  // Android chịu được nên trước đây không lộ bệnh.
  if (state.scanning) return;
  // Thư viện CDN nạp async nên có thể chưa sẵn sàng lúc init: đợi tối đa ~10s
  const prev = state.cameras || [];
  state.cameras = [];
  for (let i = 0; i < 20; i++) {
    try {
      if (typeof Html5Qrcode !== "undefined") { state.cameras = await Html5Qrcode.getCameras(); break; }
    } catch (e) { state.cameras = []; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Nếu lần quét này không ra camera mà trước đó đã có -> giữ danh sách cũ
  // (tránh dropdown báo sai "Không tìm thấy camera" khi camera vẫn mở được)
  if (!state.cameras.length && prev.length) state.cameras = prev;
  const sel = $("cameraSelect");
  sel.innerHTML = "";
  if (!state.cameras.length) {
    sel.innerHTML = "<option value=''>Không tìm thấy camera</option>";
    return;
  }
  state.cameras.forEach((c, i) => {
    const o = document.createElement("option");
    o.value = c.id; o.textContent = c.label || ("Camera " + (i + 1));
    sel.appendChild(o);
  });
  // Giữ lựa chọn hiện tại nếu vẫn còn (vd user chọn tay, hoặc vừa mở camera xong);
  // nếu chưa chọn tay thì ưu tiên camera sau theo tên.
  const has = (id) => id && state.cameras.some((c) => c.id === id);
  const back = state.cameras.find((c) => /back|rear|environment/i.test(c.label || ""));
  if (has(state.cameraId)) sel.value = state.cameraId;
  else sel.value = (back || state.cameras[0]).id;
  state.cameraId = sel.value;
  // Hiển thị facingMode THỰC TẾ (đọc từ camera track) thay vì tin nhãn trình duyệt (đôi khi sai)
  const selOpt = sel.selectedOptions && sel.selectedOptions[0];
  if (selOpt && state.realFacing === "environment") selOpt.textContent = "📷 Camera sau — đang dùng";
  else if (selOpt && state.realFacing === "user") selOpt.textContent = "🤳 Camera trước — đang dùng";
}

/* ---- v6.3: chữa lỗi camera khung đen trên iOS (iPhone/iPad) ----
 * Nguyên nhân thường gặp: (1) thiếu playsinline -> iPhone không render video
 * inline (chỉ thấy màn hình đen); (2) deviceId exact trên iOS hay cho video
 * đen; (3) mở trang trong webview của Zalo/Facebook -> bị chặn camera, video
 * đen dù getUserMedia "thành công".
 * Cách chữa: iOS luôn dùng facingMode ideal (bỏ deviceId exact), ép
 * playsinline + play() sau khi mở, và watchdog 6s: video vẫn đen -> dừng và
 * báo rõ cách sửa (mở bằng Safari, cấp quyền camera). */
function isIOS() {
  try {
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1; // iPadOS 13+
  } catch (e) { return false; }
}
// Tách hàm thuần để test được (harness v6.3)
function pickCamera(ios, camManual, camId, backCam) {
  if (ios) return { facingMode: { ideal: "environment" } }; // iOS: deviceId exact hay cho video đen
  if (camManual && camId) return { deviceId: { exact: camId } };
  if (backCam) return { deviceId: { exact: backCam.id } };
  return { facingMode: "environment" };
}
function buildVideoConstraints(ios, camPick) {
  const base = { width: { min: 640, ideal: 1280 }, height: { min: 480, ideal: 720 } };
  if (!ios) base.advanced = [{ focusMode: "continuous" }]; // iOS: bỏ để giảm rủi ro
  return Object.assign(base, camPick);
}
// Ép video chạy inline trên iPhone (không có playsinline thì chỉ thấy màn hình đen)
function forceInlineVideo() {
  try {
    const video = document.querySelector("#reader video");
    if (!video) return false;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.muted = true;
    video.setAttribute("muted", "");
    const pr = video.play();
    if (pr && pr.catch) pr.catch(() => {});
    return true;
  } catch (e) { return false; }
}
// Video thật sự có hình không? (v: video-like {videoWidth, paused, readyState})
function videoHasPicture(v) {
  return !!(v && v.videoWidth > 0 && !v.paused && v.readyState >= 2);
}
// Chuỗi chẩn đoán ngắn gọn — hiện cố định trong khung quét để user chụp màn hình gửi về
function videoDiag() {
  try {
    const v = document.querySelector("#reader video");
    if (!v) return "khong-co-the-video";
    let t = "khong-co-track";
    try {
      const tr = v.srcObject ? v.srcObject.getVideoTracks()[0] : null;
      if (tr) {
        let extra = "";
        try { const s = tr.getSettings ? tr.getSettings() : {}; extra = " facing=" + (s.facingMode || "?"); } catch (e) {}
        t = "track:" + tr.readyState + (tr.muted ? ":MUTED" : ":live") + extra;
      }
    } catch (e) {}
    return "video:rs=" + v.readyState + ",w=" + v.videoWidth + (v.paused ? ",paused" : ",playing") + " | " + t;
  } catch (e) { return "loi-doc:" + (e && e.message); }
}
// Gắn playsinline/muted NGAY khi html5-qrcode tạo thẻ <video> (MutationObserver).
// Gắn sau khi thư viện đã gọi play() thì iPhone đã kịp quyết định fullscreen -> đen.
let videoObserver = null;
function fixVideoEl(v) {
  if (!v || v.tagName !== "VIDEO") return;
  v.setAttribute("playsinline", "");
  v.setAttribute("webkit-playsinline", "");
  v.setAttribute("muted", "");
  try { v.muted = true; } catch (e) {}
}
function watchVideoElement() {
  stopWatchVideoElement();
  try {
    const root = document.getElementById("reader");
    if (!root || typeof MutationObserver === "undefined") return;
    root.querySelectorAll("video").forEach(fixVideoEl);
    videoObserver = new MutationObserver((muts) => {
      muts.forEach((m) => (m.addedNodes || []).forEach((n) => {
        if (!n || !n.tagName) return;
        if (n.tagName === "VIDEO") fixVideoEl(n);
        else if (n.querySelectorAll) n.querySelectorAll("video").forEach(fixVideoEl);
      }));
    });
    videoObserver.observe(root, { childList: true, subtree: true });
  } catch (e) {}
}
function stopWatchVideoElement() {
  try { if (videoObserver) videoObserver.disconnect(); } catch (e) {}
  videoObserver = null;
}
async function startScan() {
  if (state.scanning) return;
  if (!sessionStatus().ok) { // v5.3: bắt buộc nhập đủ phiên quét
    toast("Hãy nhập đủ thông tin phiên quét (loại, số pallet, 4 số cuối chỉ thị/PO) trước.", "warn");
    return;
  }
  if (typeof Html5Qrcode === "undefined") { toast("Chưa tải được thư viện quét mã. Kiểm tra mạng rồi tải lại trang.", "err"); return; }
  const camId = $("cameraSelect").value;
  // Kể cả khi liệt kê camera thất bại (dropdown trống), vẫn thử mở bằng
  // facingMode "environment": nhiều máy liệt kê lỗi nhưng getUserMedia vẫn mở được.
  // Nếu máy thật sự không có camera, lỗi sẽ báo rõ ở catch bên dưới.

  // Chọn camera: iOS luôn dùng facingMode ideal (v6.3: deviceId exact hay cho video đen);
  // các máy khác: (1) user chọn tay -> deviceId exact; (2) camera sau theo tên -> deviceId exact;
  // (3) chưa đọc được tên -> facingMode environment.
  const ios = isIOS();
  const backCam = state.cameras.find((c) => /(facing back|\bback\b|\brear\b|environment)/i.test(c.label || ""));
  const camPick = pickCamera(ios, state.camManual, camId, backCam);

  $("reader").innerHTML = "";
  html5Qr = new Html5Qrcode("reader");
  watchVideoElement(); // v6.4: gắn playsinline ngay khi thư viện tạo thẻ video
  setCamStatus("⏳ Đang mở camera…", "");
  try {
    await html5Qr.start(
      // LƯU Ý (audit 25/09/2026): html5-qrcode 2.3.8 BỎ QUA tham số camera thứ nhất khi
      // config.videoConstraints tồn tại -> bắt buộc gộp deviceId/facingMode VÀO videoConstraints.
      camPick,
      { fps: 15, qrbox: (w, h) => ({ width: Math.min(w, h) * 0.75, height: Math.min(w, h) * 0.75 }),
        aspectRatio: 1.0,
        // Ưu tiên bộ giải mã native của trình duyệt (nhanh hơn nhiều trên Chrome/Android),
        // tự động dùng zxing (JS) khi thiết bị không hỗ trợ.
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        // Lấy nét liên tục + độ phân giải tốt giúp đọc mã nhanh và chính xác hơn trên điện thoại
        // (v6.3: iOS bỏ advanced focusMode để giảm rủi ro video đen)
        videoConstraints: buildVideoConstraints(ios, camPick),
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE, Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39, Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.DATA_MATRIX] },
      (text, result) => addRecord(text, result && result.result && result.result.format
        ? String(result.result.format.formatName || result.result.format).replace(/_/g, " ") : "QR"),
      () => {}
    );
    state.scanning = true;
    forceInlineVideo(); // v6.3: iPhone thiếu playsinline sẽ chỉ thấy màn hình đen
    // v6.4: watchdog — 6s sau nếu video vẫn đen thì thử cứu 1 lần (pause -> gắn lại
    // playsinline -> play -> chờ 2.5s); vẫn đen -> dừng và hiện bảng chẩn đoán cố
    // định trong khung quét để user chụp màn hình gửi về (toast chỉ hiện 3s).
    clearTimeout(state.videoWatch);
    state.videoWatch = setTimeout(async () => {
      if (!state.scanning) return;
      const pic = () => { try { return document.querySelector("#reader video"); } catch (e) { return null; } };
      if (!videoHasPicture(pic())) {
        try { pic().pause(); } catch (e) {}
        forceInlineVideo();
        await new Promise((r) => setTimeout(r, 2500));
        if (state.scanning && !videoHasPicture(pic())) {
          const diag = videoDiag();
          stopScan();
          setCamStatus("🔴 Camera không lên hình", "warn");
          $("reader").innerHTML =
            '<div class="camdiag"><b>🔴 Không lấy được hình camera</b>' +
            '<code>' + esc(diag) + '</code>' +
            '<p>Trên iPhone, camera qua trình duyệt ổn định nhất với <b>Safari</b>. ' +
            'Hãy mở Safari và vào <b>' + esc(location.host) + '</b> rồi quét lại.</p>' +
            '<p>Nếu Safari vẫn đen: Cài đặt iPhone → Safari → Camera → <b>Cho phép</b>, ' +
            'tải lại trang, bấm <b>Bắt đầu quét</b> và chọn <b>Cho phép</b> khi được hỏi.</p>' +
            '<button class="small" id="btnDiagRetry">↻ Thử lại</button></div>';
          $("btnDiagRetry").addEventListener("click", startScan);
        }
      }
    }, 6000);
    ensureOCR().catch(() => {}); // v4.8: tải trước thư viện OCR khi mở camera để quét đầu không phải chờ
    $("btnStart").disabled = true; $("btnStop").disabled = false;
    $("cameraSelect").disabled = true;
    setCamStatus("🟢 <b>Đang quét</b> — hướng camera vào mã", "ok");
    updateTorchBtn(); updateZoomCtl();
    // Sau khi cấp quyền, đọc facingMode thực tế từ track (nhãn enumerateDevices
    // đôi khi sai trên một số máy Android) để đổi nhãn dropdown + kiểm chứng
    // camera trước/sau. v6.6: KHÔNG gọi listCameras() ở đây nữa.
    try {
      const video = document.querySelector("#reader video");
      const tr = video && video.srcObject ? video.srcObject.getVideoTracks()[0] : null;
      const st = tr && tr.getSettings ? tr.getSettings() : {};
      if (st.deviceId) state.cameraId = st.deviceId;
      state.realFacing = st.facingMode || "";
    } catch (e) {}
    // Kiểm chứng sau khi mở: nếu vẫn mở nhầm camera trước thì báo để user chọn tay
    if (!state.camManual && state.realFacing === "user") {
      toast("Máy đã mở nhầm camera trước. Hãy mở danh sách camera, chọn camera sau (facing back) rồi bấm quét lại.", "warn");
    }
    markActiveCameraOption(); // v6.6: chỉ đổi nhãn dropdown, không gọi listCameras() (giết camera trên iOS)
  } catch (e) {
    stopWatchVideoElement();
    setCamStatus("🔴 Không mở được camera", "warn");
    toast("Không mở được camera: " + (e && e.message ? e.message : e) + ". Hãy cấp quyền camera hoặc dùng HTTPS.", "err");
  }
}
async function stopScan() {
  if (!state.scanning || !html5Qr) return;
  clearTimeout(state.videoWatch); // v6.3: hủy watchdog kiểm tra video
  stopWatchVideoElement(); // v6.4: gỡ observer gắn playsinline
  try { await html5Qr.stop(); } catch (e) {}
  try { html5Qr.clear(); } catch (e) {}
  state.scanning = false; state.torchOn = false; state.realFacing = "";
  const bs = $("btnStart"), bt = $("btnStop"), cs = $("cameraSelect");
  if (bt) bt.disabled = true;
  if (cs) cs.disabled = false;
  updateScanGate(); // v5.3: bật/tắt nút quét theo phiên (thay vì mở cứng)
  const tb = $("btnTorch");
  if (tb) tb.classList.add("hidden");
  const zr = $("zoomRow");
  if (zr) zr.classList.add("hidden");
  const rd = $("reader");
  if (rd) rd.innerHTML = '<div class="reader-idle">📷<br>Nhấn <b>Bắt đầu quét</b> để mở camera</div>';
  setCamStatus("⚪ Camera đang tắt", "");
  listCameras(); // tải lại nhãn thường (xóa chữ "— đang dùng" còn kẹt lại)
}
function updateTorchBtn() {
  const btn = $("btnTorch");
  try {
    const video = document.querySelector("#reader video");
    const tr = video && video.srcObject ? video.srcObject.getVideoTracks()[0] : null;
    const caps = tr && tr.getCapabilities ? tr.getCapabilities() : {};
    btn.classList.toggle("hidden", !caps.torch);
  } catch (e) { btn.classList.add("hidden"); }
}
/* Thu phóng camera: chỉ hiện thanh trượt khi thiết bị hỗ trợ (mã nhỏ, mã ở xa đọc tốt hơn) */
function updateZoomCtl() {
  const row = $("zoomRow"), range = $("zoomRange");
  try {
    const video = document.querySelector("#reader video");
    const tr = video && video.srcObject ? video.srcObject.getVideoTracks()[0] : null;
    const caps = tr && tr.getCapabilities ? tr.getCapabilities() : {};
    if (caps.zoom) {
      range.min = caps.zoom.min; range.max = caps.zoom.max; range.step = caps.zoom.step || 0.1;
      const cur = (tr.getSettings && tr.getSettings().zoom) || caps.zoom.min;
      range.value = cur;
      $("zoomVal").textContent = "×" + Number(cur).toFixed(1);
      row.classList.remove("hidden");
      return;
    }
  } catch (e) {}
  row.classList.add("hidden");
}
async function toggleTorch() {  try {
    const video = document.querySelector("#reader video");
    const tr = video && video.srcObject ? video.srcObject.getVideoTracks()[0] : null;
    if (!tr) return;
    state.torchOn = !state.torchOn;
    await tr.applyConstraints({ advanced: [{ torch: state.torchOn }] });
    $("btnTorch").classList.toggle("on", state.torchOn);
    $("btnTorch").innerHTML = state.torchOn ? "🔦 Tắt đèn" : "🔦 Bật đèn";
  } catch (e) { toast("Thiết bị không hỗ trợ bật đèn.", "warn"); }
}
function scanFromFile(file) {
  if (!file) return;
  if (!sessionStatus().ok) { toast("Hãy nhập đủ thông tin phiên quét trước khi quét từ ảnh.", "warn"); return; } // v5.3
  if (typeof Html5Qrcode === "undefined") { toast("Chưa tải được thư viện quét mã.", "err"); return; }
  const tmp = new Html5Qrcode("reader");
  toast("Đang đọc mã từ ảnh…", "");
  tmp.scanFile(file, true)
    .then((text) => addRecord(text, "Ảnh"))
    .catch(() => toast("Không đọc được mã trong ảnh này.", "err"));
}

/* ---------------- events ---------------- */
function bindEvents() {
  $("btnLogin").addEventListener("click", doLogin);
  [$("loginUser"), $("loginPass")].forEach((el) =>
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); }));
  $("btnLogout").addEventListener("click", doLogout);

  $("btnStart").addEventListener("click", startScan);
  $("btnStop").addEventListener("click", stopScan);
  $("btnTorch").addEventListener("click", toggleTorch);
  $("zoomRange").addEventListener("input", async (e) => {
    const v = parseFloat(e.target.value);
    $("zoomVal").textContent = "×" + v.toFixed(1);
    try {
      const video = document.querySelector("#reader video");
      const tr = video && video.srcObject ? video.srcObject.getVideoTracks()[0] : null;
      if (tr) await tr.applyConstraints({ advanced: [{ zoom: v }] });
    } catch (err) { /* thiết bị không hỗ trợ thì bỏ qua */ }
  });
  $("cameraSelect").addEventListener("change", (e) => { state.camManual = true; state.cameraId = e.target.value; });
  $("btnRefreshCam").addEventListener("click", listCameras);

  $("btnFromFile").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", (e) => { scanFromFile(e.target.files[0]); e.target.value = ""; });

  $("btnManualAdd").addEventListener("click", () => {
    if (!sessionStatus().ok) { toast("Hãy nhập đủ thông tin phiên quét trước khi thêm mã.", "warn"); return; }
    const v = $("manualInput").value.trim();
    if (!v) { toast("Nhập nội dung mã trước khi thêm.", "warn"); return; }
    addRecord(v, "Nhập tay"); $("manualInput").value = "";
  });
  $("manualInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnManualAdd").click(); });

  // v5.3: phiên quét bắt buộc
  ["sessType", "sessPallet", "sessChi", "sessPo"].forEach((id) => {
    $(id).addEventListener("input", refreshSession);
    $(id).addEventListener("change", refreshSession);
  });
  $("noteInput").addEventListener("input", (e) => { state.settings.note = e.target.value; saveStore(); });
  $("chkSound").addEventListener("change", (e) => { state.settings.sound = e.target.checked; saveStore(); });
  $("chkOcr").addEventListener("change", (e) => { state.settings.ocr = e.target.checked; saveStore(); });
  $("pairsMinus").addEventListener("click", () => bumpPairs(-1));
  $("pairsPlus").addEventListener("click", () => bumpPairs(1));

  $("searchInput").addEventListener("input", (e) => { state.filterText = e.target.value; state.page = 0; renderTable(); });
  $("dateInput").addEventListener("change", (e) => { state.filterDate = e.target.value; state.page = 0; renderTable(); });
  $("btnClearFilter").addEventListener("click", () => {
    state.filterText = ""; state.filterDate = ""; state.page = 0;
    $("searchInput").value = ""; $("dateInput").value = ""; renderTable();
  });

  $("btnPrev").addEventListener("click", () => { if (state.page > 0) { state.page--; renderTable(); } });
  $("btnNext").addEventListener("click", () => { state.page++; renderTable(); });

  $("btnExportXlsx").addEventListener("click", exportExcel);
  $("btnExportCsv").addEventListener("click", exportCSV);
  $("btnExportJson").addEventListener("click", exportJSON);
  $("btnExportReport").addEventListener("click", openReportModal); // v5.0: báo cáo sản lượng
  // v6.7: tổng hợp theo nhân viên
  $("btnSumPrev").addEventListener("click", () => shiftSumDate(-1));
  $("btnSumNext").addEventListener("click", () => shiftSumDate(1));
  $("btnSumReload").addEventListener("click", () => renderUserSummary());
  $("sumDate").addEventListener("change", () => renderUserSummary());
  $("btnDashRefresh").addEventListener("click", refreshDashboard); // v5.4
  $("btnClear").addEventListener("click", clearAll);

  $("btnMasterAdd").addEventListener("click", () => masterForm("", ""));
  $("btnMasterImport").addEventListener("click", () => $("masterFile").click());
  $("masterFile").addEventListener("change", (e) => { importMasterCSV(e.target.files[0]); e.target.value = ""; });
  $("masterSearch").addEventListener("input", renderMaster);

  $("btnPackingImport").addEventListener("click", () => $("packingFile").click()); // v5.0
  $("packingFile").addEventListener("change", (e) => { importPackingXlsx(e.target.files[0]); e.target.value = ""; });
  $("btnPackingAdd").addEventListener("click", () => packingForm("", "", ""));
  $("packingSearch").addEventListener("input", renderPacking);

  $("btnWipeAll").addEventListener("click", adminWipeAll);

  $("btnChgPass").addEventListener("click", changeMyPassword);

  $("modalCancel").addEventListener("click", closeModal);
  $("modalOk").addEventListener("click", () => { if (modalOkFn) modalOkFn(); });
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });

  window.addEventListener("beforeunload", () => { if (state.scanning) stopScan(); });
}

/* ---------------- init ---------------- */
async function init() {
  // login hiện sẵn mặc định trong HTML (chống trang đen)
  try {
    loadStore();
    // v5.3: khôi phục phiên quét đã lưu
    const sess0 = getSession();
    $("sessType").value = sess0.type || "";
    $("sessPallet").value = sess0.pallet || "";
    $("sessChi").value = sess0.chi || "";
    $("sessPo").value = sess0.po || "";
    $("noteInput").value = state.settings.note || "";
    $("chkSound").checked = state.settings.sound !== false;
    $("chkOcr").checked = state.settings.ocr !== false;
    renderSizePad();
    setHttpsChip();
    setCamStatus("⚪ Camera đang tắt", "");
    bindEvents();
    listCameras();
    if (!("mediaDevices" in navigator)) {
      toast("Trình duyệt không hỗ trợ camera. Bạn vẫn có thể nhập tay hoặc quét từ ảnh.", "warn");
    }
    // kết nối máy chủ + tự đăng nhập lại nếu còn phiên
    const sb = await ensureSupa();
    sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") doLogout(); });
    const { data: { session } } = await sb.auth.getSession();
    if (session && session.user) {
      await afterAuth(sb, session.user);
    }
    if (!storageOK) {
      toast("⚠️ Trình duyệt đang chặn lưu trữ cục bộ — phiên đăng nhập có thể không được giữ. Hãy cho phép site data cho trang này.", "err");
    }
  } catch (e) {
    console.error("Lỗi khởi tạo:", e);
    const le = $("loginErr");
    if (le && !le.textContent) le.textContent = "Không kết nối được máy chủ: " + (e && e.message ? e.message : e);
  }
}

// Lưới an toàn cuối cùng: nếu vì lý do gì cả 2 màn hình đều ẩn (trang đen),
// tự động hiện lại màn hình đăng nhập thay vì để trắng tinh.
window.addEventListener("error", () => {
  try {
    const l = document.getElementById("viewLogin"), a = document.getElementById("viewApp");
    if (l && a && l.classList.contains("hidden") && a.classList.contains("hidden")) l.classList.remove("hidden");
  } catch (e) {}
});
document.addEventListener("DOMContentLoaded", init);

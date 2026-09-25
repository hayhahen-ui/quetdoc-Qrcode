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
  settings: { session: "", note: "", sound: true, sizeUK: "", pairs: 6 },
  me: null,             // user đang đăng nhập {id, username, role}
  scanning: false,
  cameras: [],
  cameraId: null,
  camManual: false,     // true khi user tự chọn camera trong dropdown
  realFacing: "",       // facingMode THỰC TẾ đọc từ camera track ("environment"/"user")
  torchOn: false,
  lastContent: "",
  lastAt: 0,
  page: 0,
  filterText: "",
  filterDate: "",
  directives: {},       // danh mục Chỉ thị: { "AE2608210": {po} } (PO cố định; size mỗi thùng mỗi khác -> chọn ở pad quét)
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
  $("dirPanel").classList.toggle("hidden", !admin);
  $("btnClear").innerHTML = admin ? "🗑 Xóa tất cả" : "🗑 Xóa bản ghi của tôi";
  $("dataHint").textContent = admin
    ? "Bạn đang xem toàn bộ bản ghi của mọi tài khoản — đồng bộ trực tiếp. Bấm vào ô PO / Size để sửa."
    : "Bạn chỉ xem được các mã do chính mình quét. Bấm vào ô PO / Size để sửa.";
  state.page = 0;
  renderHead();
  try {
    await loadRecords();
    await loadDirectives();
    if (admin) await loadAccounts();
  } catch (e) {
    toast("Không tải được dữ liệu: " + (e.message || e), "err");
  }
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

  // Tem thùng giày: tự tách chỉ thị từ số thùng, tra PO cố định từ danh mục.
  // Size mỗi thùng mỗi khác -> lấy từ pad chọn size (dính cho các mã tiếp theo),
  // KHÔNG dùng size mặc định theo chỉ thị nữa.
  const chiThi = parseChiThi(content);
  const dir = chiThi ? state.directives[chiThi] : null;

  // Ghi nhận TỨC THÌ (optimistic): hiện lên bảng + kêu beep ngay,
  // đồng bộ lên server ở nền để không chặn lần quét tiếp theo.
  const tempId = "tmp_" + uid();
  const rec = {
    id: tempId, content, format: format || "QR",
    scannedAt: new Date().toISOString(),
    session: state.settings.session.trim(), note: state.settings.note.trim(),
    userId: state.me.id, username: state.me.username,
    chiThi, po: dir ? dir.po : "", size: currentSizeStr(),
    pending: true,
  };
  state.records.unshift(rec);
  state.page = 0;
  renderAll();
  showOkBox(rec);
  beep(true);

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
    renderAll();
  } catch (e) {
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
function showOkBox(rec) {
  const box = $("lastscan");
  box.classList.remove("show"); void box.offsetWidth;
  box.classList.remove("dup");
  box.innerHTML = "✅ <b>Đã ghi nhận:</b><br>" +
    "<code>" + esc(rec.content) + "</code><br><span class='muted'>" + esc(rec.format) + " · " + fmtTime(rec.scannedAt) + "</span>" +
    (rec.chiThi ? "<br><span class='muted'>Chỉ thị <b>" + esc(rec.chiThi) + "</b>" +
      (rec.po ? " · PO " + esc(rec.po) : "") + (rec.size ? " · Size " + esc(rec.size) : "") + "</span>" : "");
  box.classList.add("show");
  toast("Đã ghi nhận mã mới.", "ok");
}

function showDupBox(dup, content) {
  const box = $("lastscan");
  box.classList.remove("show"); void box.offsetWidth;
  state.dupSkipped = (state.dupSkipped || 0) + 1;
  saveStore(); renderStats();
  box.classList.add("dup");
  box.innerHTML = "⚠️ <b>Đã được quét</b> — mã này đã ghi nhận trước đó nên bỏ qua.<br>" +
    "<code>" + esc(content) + "</code><br><span class='muted'>" +
    (dup ? "Ghi nhận lần đầu: " + fmtTime(dup.scannedAt) + (dup.username ? " · bởi <b>" + esc(dup.username) + "</b>" : "")
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

function stats() {
  const list = visibleRecords();
  const t = todayStr();
  const today = list.filter((r) =>
    new Date(r.scannedAt).toLocaleDateString("en-CA", { timeZone: TZ }) === t).length;
  const uniq = new Set(list.map((r) => norm(r.content))).size;
  return { total: list.length, today, uniq, dup: state.dupSkipped || 0 };
}

function renderAll() {
  if (!state.me) { doLogout(); return; }
  renderStats(); renderTable();
  const n = visibleRecords().length;
  $("btnExportXlsx").disabled = $("btnExportCsv").disabled = $("btnExportJson").disabled = $("btnClear").disabled = !n;
}

function renderStats() {
  const s = stats();
  $("kpiTotal").textContent = s.total.toLocaleString("vi-VN");
  $("kpiToday").textContent = s.today.toLocaleString("vi-VN");
  $("kpiUniq").textContent = s.uniq.toLocaleString("vi-VN");
  $("kpiDup").textContent = s.dup.toLocaleString("vi-VN");
}

function renderHead() {
  const admin = isAdmin();
  $("theadRow").innerHTML = "<tr><th>#</th><th>Chỉ thị</th><th>PO</th><th>Size</th><th>Số thùng</th>" +
    "<th>Giờ quét</th><th>Số pallet</th>" + (admin ? "<th>Người quét</th>" : "") + "<th></th></tr>";
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
        "<td class='editable' data-edit='size' data-id='" + r.id + "' title='Bấm để sửa Size'>" + esc(r.size || "—") + "</td>" +
        "<td class='content'><code style='font-size:12px'>" + esc(r.content) + "</code>" +
          (r.note ? "<br><span class='muted'>" + esc(r.note) + "</span>" : "") + "</td>" +
        "<td class='muted' style='white-space:nowrap'>" + fmtTime(r.scannedAt) + "</td>" +
        "<td>" + esc(r.session || "") + "</td>" +
        (admin ? "<td><b>" + esc(r.username || "—") + "</b></td>" : "") +
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
      else { rec[field] = v; toast("Đã cập nhật " + label + ".", "ok"); }
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

/* ---------------- danh sách tài khoản (admin xem) ----------------
 * Thêm/xóa/đặt lại mật khẩu thực hiện trong Supabase Dashboard → Authentication
 * để đảm bảo an toàn (cần service_role key, không thể làm từ frontend). */
async function loadAccounts() {
  if (!isAdmin() || !supa) return;
  const body = $("usersBody");
  try {
    const { data, error } = await supa.from("profiles").select("id,username,role,created_at").order("username");
    if (error) throw error;
    const counts = {};
    state.records.forEach((r) => { if (r.userId) counts[r.userId] = (counts[r.userId] || 0) + 1; });
    body.innerHTML = (data || []).map((u) =>
      "<tr><td><b>" + esc(u.username) + "</b>" +
        (state.me && u.id === state.me.id ? " <span class='badge new'>bạn</span>" : "") + "</td>" +
      "<td>" + (u.role === "admin" ? "<span class='role admin'>Quản trị</span>" : "<span class='role user'>Nhân viên</span>") + "</td>" +
      "<td class='muted'>" + fmtTime(u.created_at) + "</td>" +
      "<td class='muted'>" + (counts[u.id] || 0) + "</td></tr>"
    ).join("");
  } catch (e) {
    body.innerHTML = "<tr><td colspan='4' class='muted'>Không tải được danh sách tài khoản.</td></tr>";
  }
}

/* ---------------- danh mục chỉ thị (tem thùng giày, admin quản lý) ---------------- */
let warnedNoDirectives = false;
async function loadDirectives() {
  state.directives = {};
  if (!supa) return;
  try {
    const { data, error } = await supa.from("directives").select("chi_thi,po").order("chi_thi");
    if (error) throw error;
    (data || []).forEach((d) => { state.directives[d.chi_thi] = { po: d.po || "" }; });
  } catch (e) {
    console.warn("Không tải được danh mục chỉ thị:", e.message);
    // Bảng chưa tồn tại = chưa chạy migration v4.0 -> nhắc admin 1 lần/phiên
    if (isAdmin() && !warnedNoDirectives && /directives|schema cache|does not exist/i.test(e.message || "")) {
      warnedNoDirectives = true;
      toast("Chưa có bảng Danh mục Chỉ thị. Hãy chạy đoạn migration v4.0 trong Supabase SQL Editor.", "warn");
    }
  }
  if (isAdmin()) renderDirectives();
}
function renderDirectives() {
  const body = $("dirBody");
  if (!body) return;
  const keys = Object.keys(state.directives).sort();
  if (!keys.length) {
    body.innerHTML = "<tr><td colspan='3' class='muted'>Chưa có chỉ thị nào. Bấm “＋ Thêm chỉ thị”.</td></tr>";
    return;
  }
  body.innerHTML = keys.map((k) => {
    const d = state.directives[k];
    return "<tr><td><b>" + esc(k) + "</b></td><td>" + esc(d.po || "—") + "</td>" +
      "<td style='white-space:nowrap'><button class='small' data-diredit='" + esc(k) + "'>Sửa</button> " +
      "<button class='small danger' data-dirdel='" + esc(k) + "'>Xóa</button></td></tr>";
  }).join("");
  body.querySelectorAll("[data-diredit]").forEach((b) =>
    b.addEventListener("click", () => dirForm(b.getAttribute("data-diredit"))));
  body.querySelectorAll("[data-dirdel]").forEach((b) =>
    b.addEventListener("click", () => dirDelete(b.getAttribute("data-dirdel"))));
}
function dirForm(chiThi) {
  const d = (chiThi && state.directives[chiThi]) || { po: "" };
  openModal(chiThi ? "Sửa chỉ thị " + chiThi : "Thêm chỉ thị",
    "<div class='field'><label>Chỉ thị (2 chữ + 7 số)</label>" +
    "<input id='mChiThi' value='" + esc(chiThi || "") + "'" + (chiThi ? " disabled" : "") +
    " placeholder='VD: AE2608210' style='text-transform:uppercase'></div>" +
    "<div class='field'><label>PO (cố định theo chỉ thị)</label><input id='mPo' value='" + esc(d.po) + "' placeholder='VD: 0903174893-1'></div>" +
    "<p class='muted' style='font-size:12px'>Size mỗi thùng mỗi khác nên công nhân chọn ở khung quét, không nhập ở đây.</p>",
    "Lưu", async () => {
      const k = (chiThi || $("mChiThi").value).trim().toUpperCase();
      const po = $("mPo").value.trim();
      if (!/^[A-Z]{2}\d{7}$/.test(k)) { toast("Chỉ thị phải đúng dạng 2 chữ + 7 số (VD: AE2608210).", "warn"); return; }
      const { error } = await supa.from("directives").upsert(
        { chi_thi: k, po, updated_at: new Date().toISOString(), updated_by: state.me.username },
        { onConflict: "chi_thi" });
      closeModal();
      if (error) { toast("Lỗi lưu danh mục: " + error.message, "err"); return; }
      await loadDirectives();
      // Kaizen: tự điền PO cho các bản ghi cũ cùng chỉ thị mà đang trống PO,
      // để bảng và file xuất có PO ngay sau khi admin bổ sung danh mục.
      if (schemaV4 && po) {
        try {
          await supa.from("records").update({ po }).eq("chi_thi", k).eq("po", "");
          await supa.from("records").update({ po }).eq("chi_thi", k).is("po", null);
          await loadRecords();
        } catch (e) { /* thiếu quyền/cột -> bỏ qua, không chặn */ }
      }
      toast("Đã lưu chỉ thị " + k + ".", "ok");
    });
}
function dirDelete(chiThi) {
  openModal("Xóa chỉ thị",
    "<p>Xóa <b>" + esc(chiThi) + "</b> khỏi danh mục? Các bản ghi đã quét giữ nguyên.</p>",
    "Xóa", async () => {
      const { error } = await supa.from("directives").delete().eq("chi_thi", chiThi);
      closeModal();
      if (error) { toast("Lỗi xóa: " + error.message, "err"); return; }
      await loadDirectives();
      toast("Đã xóa chỉ thị " + chiThi + ".", "ok");
    });
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
/* Xuất Excel .xlsx đúng mẫu tem thùng: 1 sheet/ngày, header vàng, cột
 * STT | Chỉ thị | PO | Size/số đôi | Số thùng | Số pallet | Giờ quét | Người quét */
async function exportExcel() {
  const list = filteredRecords();
  if (!list.length) { toast("Không có bản ghi nào để xuất.", "warn"); return; }
  if (typeof XLSX === "undefined") {
    toast("Chưa tải được thư viện Excel. Kiểm tra mạng rồi thử lại (hoặc dùng Xuất CSV).", "err");
    return;
  }
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
  const stamp = todayStr().replace(/-/g, "") + "_" +
    new Date().toLocaleTimeString("vi-VN", { timeZone: TZ, hour12: false }).replace(/:/g, "");
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

async function listCameras() {
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

async function startScan() {
  if (state.scanning) return;
  if (typeof Html5Qrcode === "undefined") { toast("Chưa tải được thư viện quét mã. Kiểm tra mạng rồi tải lại trang.", "err"); return; }
  const camId = $("cameraSelect").value;
  // Kể cả khi liệt kê camera thất bại (dropdown trống), vẫn thử mở bằng
  // facingMode "environment": nhiều máy liệt kê lỗi nhưng getUserMedia vẫn mở được.
  // Nếu máy thật sự không có camera, lỗi sẽ báo rõ ở catch bên dưới.

  // Chọn camera: (1) user chọn tay -> deviceId exact; (2) camera sau theo tên -> deviceId exact;
  // (3) chưa đọc được tên -> facingMode environment.
  const backCam = state.cameras.find((c) => /(facing back|\bback\b|\brear\b|environment)/i.test(c.label || ""));
  const camPick = (state.camManual && camId) ? { deviceId: { exact: camId } }
    : backCam ? { deviceId: { exact: backCam.id } }
    : { facingMode: "environment" };

  $("reader").innerHTML = "";
  html5Qr = new Html5Qrcode("reader");
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
        videoConstraints: Object.assign(
          { width: { min: 640, ideal: 1280 }, height: { min: 480, ideal: 720 },
            advanced: [{ focusMode: "continuous" }] },
          camPick),
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE, Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39, Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.DATA_MATRIX] },
      (text, result) => addRecord(text, result && result.result && result.result.format
        ? String(result.result.format.formatName || result.result.format).replace(/_/g, " ") : "QR"),
      () => {}
    );
    state.scanning = true;
    $("btnStart").disabled = true; $("btnStop").disabled = false;
    $("cameraSelect").disabled = true;
    setCamStatus("🟢 <b>Đang quét</b> — hướng camera vào mã", "ok");
    updateTorchBtn(); updateZoomCtl();
    // Sau khi cấp quyền, trình duyệt mới hiện tên camera thật -> tải lại để dropdown
    // hiện đúng tên và trỏ đúng camera đang dùng. Đọc facingMode thực tế từ track
    // (nhãn enumerateDevices đôi khi sai trên một số máy Android).
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
    listCameras();
  } catch (e) {
    setCamStatus("🔴 Không mở được camera", "warn");
    toast("Không mở được camera: " + (e && e.message ? e.message : e) + ". Hãy cấp quyền camera hoặc dùng HTTPS.", "err");
  }
}
async function stopScan() {
  if (!state.scanning || !html5Qr) return;
  try { await html5Qr.stop(); } catch (e) {}
  try { html5Qr.clear(); } catch (e) {}
  state.scanning = false; state.torchOn = false; state.realFacing = "";
  const bs = $("btnStart"), bt = $("btnStop"), cs = $("cameraSelect");
  if (bs) { bs.disabled = false; bt.disabled = true; cs.disabled = false; }
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
    const v = $("manualInput").value.trim();
    if (!v) { toast("Nhập nội dung mã trước khi thêm.", "warn"); return; }
    addRecord(v, "Nhập tay"); $("manualInput").value = "";
  });
  $("manualInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnManualAdd").click(); });

  $("sessionInput").addEventListener("input", (e) => { state.settings.session = e.target.value; saveStore(); });
  $("noteInput").addEventListener("input", (e) => { state.settings.note = e.target.value; saveStore(); });
  $("chkSound").addEventListener("change", (e) => { state.settings.sound = e.target.checked; saveStore(); });
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
  $("btnClear").addEventListener("click", clearAll);

  $("btnDirAdd").addEventListener("click", () => dirForm(""));

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
    $("sessionInput").value = state.settings.session || "";
    $("noteInput").value = state.settings.note || "";
    $("chkSound").checked = state.settings.sound !== false;
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

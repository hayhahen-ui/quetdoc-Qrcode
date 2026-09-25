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
  settings: { session: "", note: "", sound: true },
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
  $("btnClear").innerHTML = admin ? "🗑 Xóa tất cả" : "🗑 Xóa bản ghi của tôi";
  $("dataHint").textContent = admin
    ? "Bạn đang xem toàn bộ bản ghi của mọi tài khoản — đồng bộ trực tiếp, không cần tải lại trang."
    : "Bạn chỉ xem được các mã do chính mình quét. Dữ liệu đồng bộ lên máy chủ chung.";
  state.page = 0;
  renderHead();
  try {
    await loadRecords();
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

/* ---------------- records (Supabase - dữ liệu chung đa thiết bị) ---------------- */
const rowToRec = (r) => ({
  id: r.id, content: r.content, format: r.format || "QR",
  scannedAt: r.scanned_at, session: r.session || "", note: r.note || "",
  userId: r.user_id, username: r.username || "",
});

async function loadRecords() {
  if (!supa || !state.me) return;
  const { data, error } = await supa.from("records")
    .select("id,content,format,session,note,user_id,username,scanned_at")
    .order("scanned_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  state.records = (data || []).map(rowToRec);
  state.page = 0;
  renderAll();
}

async function addRecord(content, format) {
  if (!state.me || !supa) { toast("Bạn cần đăng nhập để quét.", "err"); return; }
  content = String(content || "").trim();
  if (!content) { toast("Mã quét rỗng, bỏ qua.", "warn"); return; }

  const now = Date.now();
  if (content === state.lastContent && now - state.lastAt < DUP_COOLDOWN_MS) return; // chống camera quét dính 2 lần
  state.lastContent = content; state.lastAt = now;

  const box = $("lastscan");
  box.classList.remove("show"); void box.offsetWidth;

  const showDup = (dup) => {
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
  };

  // kiểm tra nhanh trên bản sao local trước
  const dupLocal = state.records.find((r) => norm(r.content) === norm(content));
  if (dupLocal) { showDup(dupLocal); return; }

  box.classList.remove("dup");
  box.innerHTML = "⏳ <b>Đang ghi nhận…</b><br><code>" + esc(content) + "</code>";
  box.classList.add("show");

  const { data, error } = await supa.from("records").insert({
    content,
    format: format || "QR",
    session: state.settings.session.trim(),
    note: state.settings.note.trim(),
    user_id: state.me.id,
    username: state.me.username,
  }).select("id,content,format,session,note,user_id,username,scanned_at").single();

  if (error) {
    // 23505 = unique index records_content_uniq: máy khác đã quét mã này trước
    if (error.code === "23505" || error.status === 409) {
      try { await loadRecords(); } catch (e) {}
      showDup(state.records.find((r) => norm(r.content) === norm(content)) || null);
      return;
    }
    box.classList.remove("show");
    toast("Lỗi ghi nhận: " + (error.message || "không rõ"), "err");
    return;
  }
  const rec = rowToRec(data);
  state.records.unshift(rec);
  state.page = 0;
  renderAll();
  box.classList.remove("dup");
  box.innerHTML = "✅ <b>Đã ghi nhận:</b><br>" +
    "<code>" + esc(content) + "</code><br><span class='muted'>" + esc(rec.format) + " · " + fmtTime(rec.scannedAt) + "</span>";
  box.classList.add("show");
  beep(true);
  toast("Đã ghi nhận mã mới (đồng bộ).", "ok");
}

function deleteRecord(id) {
  const rec = state.records.find((r) => r.id === id);
  if (!rec) return;
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
  $("btnExportCsv").disabled = $("btnExportJson").disabled = $("btnClear").disabled = !n;
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
  $("theadRow").innerHTML = "<tr><th>#</th><th>Nội dung mã</th><th>Định dạng</th><th>Thời gian quét</th>" +
    "<th>Phiên / Ghi chú</th>" + (admin ? "<th>Người quét</th>" : "") + "<th></th></tr>";
}

function renderTable() {
  const admin = isAdmin();
  const list = filteredRecords();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  const slice = list.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);
  const cols = admin ? 7 : 6;

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
        "<td class='content'><code style='font-size:12px'>" + esc(r.content) + "</code></td>" +
        "<td class='muted'>" + esc(r.format || "") + "</td>" +
        "<td class='muted' style='white-space:nowrap'>" + fmtTime(r.scannedAt) + "</td>" +
        "<td>" + esc(r.session || "") + (r.note ? "<br><span class='muted'>" + esc(r.note) + "</span>" : "") + "</td>" +
        (admin ? "<td><b>" + esc(r.username || "—") + "</b></td>" : "") +
        "<td><button class='small danger' data-del='" + r.id + "'>Xóa</button></td>" +
        "</tr>";
    }).join("");
  }
  body.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => deleteRecord(b.getAttribute("data-del"))));

  $("recCount").textContent = list.length;
  $("pageInfo").textContent = "Trang " + (state.page + 1) + "/" + pages + " · " + list.length + " bản ghi";
  $("btnPrev").disabled = state.page <= 0;
  $("btnNext").disabled = state.page >= pages - 1;
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
function exportCSV() {
  const list = filteredRecords();
  const head = ["STT", "Noi dung ma", "Dinh dang", "Thoi gian quet (GMT+7)", "Phien", "Ghi chu", "Nguoi quet"];
  const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const lines = [head.map(q).join(",")];
  list.forEach((r, i) => lines.push(
    [i + 1, r.content, r.format, fmtTime(r.scannedAt), r.session, r.note, r.username].map(q).join(",")));
  download("quetdoc_qrcode_" + todayStr() + ".csv", "﻿" + lines.join("\r\n"), "text/csv;charset=utf-8");
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
  state.cameras = [];
  for (let i = 0; i < 20; i++) {
    try {
      if (typeof Html5Qrcode !== "undefined") { state.cameras = await Html5Qrcode.getCameras(); break; }
    } catch (e) { state.cameras = []; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
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
  if (!camId && !state.camManual) { toast("Không tìm thấy camera trên thiết bị này.", "err"); return; }

  $("reader").innerHTML = "";
  html5Qr = new Html5Qrcode("reader");
  setCamStatus("⏳ Đang mở camera…", "");
  // Chưa chọn tay -> ép dùng camera sau (trình duyệt tự chọn), tránh nhầm camera trước
  // khi tên camera chưa đọc được (chưa cấp quyền).
  const camConstraint = (state.camManual && camId) ? camId : { facingMode: "environment" };
  try {
    await html5Qr.start(
      camConstraint,
      { fps: 15, qrbox: (w, h) => ({ width: Math.min(w, h) * 0.75, height: Math.min(w, h) * 0.75 }),
        aspectRatio: 1.0,
        // Ưu tiên bộ giải mã native của trình duyệt (nhanh hơn nhiều trên Chrome/Android),
        // tự động dùng zxing (JS) khi thiết bị không hỗ trợ.
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        // Lấy nét liên tục + độ phân giải tốt giúp đọc mã nhanh và chính xác hơn trên điện thoại
        videoConstraints: { width: { min: 640, ideal: 1280 }, height: { min: 480, ideal: 720 },
                            advanced: [{ focusMode: "continuous" }] },
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

  $("searchInput").addEventListener("input", (e) => { state.filterText = e.target.value; state.page = 0; renderTable(); });
  $("dateInput").addEventListener("change", (e) => { state.filterDate = e.target.value; state.page = 0; renderTable(); });
  $("btnClearFilter").addEventListener("click", () => {
    state.filterText = ""; state.filterDate = ""; state.page = 0;
    $("searchInput").value = ""; $("dateInput").value = ""; renderTable();
  });

  $("btnPrev").addEventListener("click", () => { if (state.page > 0) { state.page--; renderTable(); } });
  $("btnNext").addEventListener("click", () => { state.page++; renderTable(); });

  $("btnExportCsv").addEventListener("click", exportCSV);
  $("btnExportJson").addEventListener("click", exportJSON);
  $("btnClear").addEventListener("click", clearAll);

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

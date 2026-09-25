/* QuetDoc QRcode — Quét mã & ghi nhận dữ liệu (có đăng nhập phân quyền)
 * Static app: mọi dữ liệu lưu ở localStorage của trình duyệt, không gửi đi đâu.
 * - Mỗi mã chỉ ghi nhận 1 lần duy nhất; quét trùng -> cảnh báo "Đã được quét", bỏ qua.
 * - Phân quyền: admin (quản lý tài khoản) / user (chỉ quét + xem bản ghi của mình).
 */
"use strict";

const STORE_KEY = "quetdoc_qrcode_v1";
const USERS_KEY = "quetdoc_users_v1";
const SESSION_KEY = "quetdoc_session_v1";
const DUP_COOLDOWN_MS = 2500;
const PAGE_SIZE = 50;
const TZ = "Asia/Ho_Chi_Minh";

/* ---------------- state ---------------- */
const state = {
  records: [],          // [{id, content, format, scannedAt, session, note, userId, username}]
  dupSkipped: 0,        // số lượt quét trùng đã bỏ qua
  settings: { session: "", note: "", sound: true },
  me: null,             // user đang đăng nhập {id, username, role}
  scanning: false,
  cameras: [],
  cameraId: null,
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

/* ---------------- storage: bản ghi ---------------- */
function loadStore() {
  try {
    const raw = safeLS.get(STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.records)) state.records = data.records;
    if (typeof data.dupSkipped === "number") state.dupSkipped = data.dupSkipped;
    if (data.settings && typeof data.settings === "object") {
      state.settings = Object.assign(state.settings, data.settings);
    }
  } catch (e) { console.warn("Không đọc được dữ liệu cũ:", e); }
}
function saveStore() {
  try {
    safeLS.set(STORE_KEY, JSON.stringify({
      records: state.records, dupSkipped: state.dupSkipped, settings: state.settings, v: 2,
    }));
  } catch (e) { toast("Bộ nhớ trình duyệt đầy, không lưu được bản ghi mới.", "err"); }
}

/* ---------------- auth: băm mật khẩu ---------------- */
async function sha256Hex(str) {
  try {
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch (e) { /* rơi xuống fallback */ }
  // Fallback khi không có crypto.subtle (môi trường không an toàn)
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return "x" + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}
function makeSalt() {
  try {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) { return "s" + Math.random().toString(36).slice(2) + Date.now().toString(36); }
}
const pwHash = (pw, salt) => sha256Hex(salt + "::" + pw);

/* ---------------- auth: users & session ---------------- */
function getUsers() {
  try { const u = JSON.parse(safeLS.get(USERS_KEY)); return Array.isArray(u) ? u : []; }
  catch (e) { return []; }
}
function saveUsers(u) { safeLS.set(USERS_KEY, JSON.stringify(u)); }
function findUserByName(name) {
  const n = String(name || "").trim().toLowerCase();
  return getUsers().find((u) => u.username.toLowerCase() === n) || null;
}
async function seedUsers() {
  if (safeLS.get(USERS_KEY) != null) return;
  const users = [];
  const add = async (username, password, role) => {
    const salt = makeSalt();
    users.push({ id: uid(), username, salt, passHash: await pwHash(password, salt), role, createdAt: new Date().toISOString() });
  };
  await add("admin", "admin", "admin");
  for (let i = 1; i <= 5; i++) await add("user" + i, "123456", "user");
  saveUsers(users);
}
function getSession() {
  try { return JSON.parse(safeLS.get(SESSION_KEY)); } catch (e) { return null; }
}
function setSession(s) {
  if (s) safeLS.set(SESSION_KEY, JSON.stringify(s));
  else safeLS.del(SESSION_KEY);
}
function currentUser() {
  const s = getSession();
  if (!s || !s.userId) return null;
  return getUsers().find((u) => u.id === s.userId) || null;
}
const isAdmin = () => !!(state.me && state.me.role === "admin");

async function doLogin() {
  const name = $("loginUser").value.trim();
  const pass = $("loginPass").value;
  const err = $("loginErr");
  err.textContent = "";
  if (!name || !pass) { err.textContent = "Nhập tên đăng nhập và mật khẩu."; return; }
  const user = findUserByName(name);
  if (!user) { err.textContent = "Sai tên đăng nhập hoặc mật khẩu."; return; }
  const h = await pwHash(pass, user.salt);
  if (h !== user.passHash) { err.textContent = "Sai tên đăng nhập hoặc mật khẩu."; return; }
  setSession({ userId: user.id, ts: Date.now() });
  if (!getSession()) {
    err.textContent = "Trình duyệt đang chặn lưu trữ (localStorage) nên không giữ được đăng nhập. Hãy cho phép site data cho trang này rồi tải lại.";
    return;
  }
  $("loginPass").value = "";
  toast("Xin chào, " + user.username + "!", "ok");
  enterApp();
}
function doLogout() {
  stopScan();
  setSession(null);
  state.me = null;
  $("viewApp").classList.add("hidden");
  $("viewLogin").classList.remove("hidden");
  $("loginUser").value = "";
  $("loginErr").textContent = "";
}
function enterApp() {
  state.me = currentUser();
  if (!state.me) { doLogout(); return; }
  $("viewLogin").classList.add("hidden");
  $("viewApp").classList.remove("hidden");
  $("chipName").textContent = state.me.username;
  const rc = $("chipRole");
  rc.textContent = state.me.role === "admin" ? "Quản trị" : "Nhân viên";
  rc.className = "role " + state.me.role;
  $("chgName").value = state.me.username;
  const admin = isAdmin();
  $("adminPanel").classList.toggle("hidden", !admin);
  $("btnClear").innerHTML = admin ? "🗑 Xóa tất cả" : "🗑 Xóa bản ghi của tôi";
  $("dataHint").textContent = admin
    ? "Bạn đang xem toàn bộ bản ghi của mọi tài khoản. Xuất CSV để mở bằng Excel."
    : "Bạn chỉ xem được các mã do chính mình quét. Dữ liệu lưu trong trình duyệt, tắt trang vẫn còn.";
  state.page = 0;
  renderHead(); renderUsers(); renderAll();
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

/* ---------------- records ---------------- */
function addRecord(content, format) {
  if (!state.me) { toast("Bạn cần đăng nhập để quét.", "err"); return; }
  content = String(content || "").trim();
  if (!content) { toast("Mã quét rỗng, bỏ qua.", "warn"); return; }

  const now = Date.now();
  if (content === state.lastContent && now - state.lastAt < DUP_COOLDOWN_MS) return; // chống camera quét dính 2 lần
  state.lastContent = content; state.lastAt = now;

  const box = $("lastscan");
  box.classList.remove("show"); void box.offsetWidth;

  const dup = state.records.find((r) => norm(r.content) === norm(content));
  if (dup) {
    // Mã trùng: KHÔNG ghi nhận, chỉ cảnh báo
    state.dupSkipped = (state.dupSkipped || 0) + 1;
    saveStore(); renderStats();
    box.classList.add("dup");
    box.innerHTML = "⚠️ <b>Đã được quét</b> — mã này đã ghi nhận trước đó nên bỏ qua.<br>" +
      "<code>" + esc(content) + "</code><br><span class='muted'>Ghi nhận lần đầu: " + fmtTime(dup.scannedAt) + "</span>";
    box.classList.add("show");
    beepDup();
    toast("Đã được quét — bỏ qua mã trùng.", "warn");
    return;
  }

  const rec = {
    id: uid(),
    content,
    format: format || "QR",
    scannedAt: new Date().toISOString(),
    session: state.settings.session.trim(),
    note: state.settings.note.trim(),
    userId: state.me.id,
    username: state.me.username,
  };
  state.records.unshift(rec);
  state.page = 0;
  saveStore(); renderAll();

  box.classList.remove("dup");
  box.innerHTML = "✅ <b>Đã ghi nhận:</b><br>" +
    "<code>" + esc(content) + "</code><br><span class='muted'>" + esc(rec.format) + " · " + fmtTime(rec.scannedAt) + "</span>";
  box.classList.add("show");
  beep(true);
  toast("Đã ghi nhận mã mới.", "ok");
}

function deleteRecord(id) {
  const rec = state.records.find((r) => r.id === id);
  if (!rec) return;
  if (!isAdmin() && rec.userId !== state.me.id) { toast("Bạn chỉ được xóa bản ghi của mình.", "err"); return; }
  state.records = state.records.filter((r) => r.id !== id);
  saveStore(); renderAll();
  toast("Đã xóa bản ghi.", "ok");
}
function clearAll() {
  const mine = visibleRecords();
  if (!mine.length) return;
  const label = isAdmin() ? "toàn bộ " + state.records.length + " bản ghi của mọi tài khoản"
                          : mine.length + " bản ghi của bạn";
  openModal("Xóa dữ liệu", "<p>Xóa " + esc(label) + "? Hành động này không thể hoàn tác.</p>", "Xóa", () => {
    state.records = isAdmin() ? [] : state.records.filter((r) => r.userId !== state.me.id);
    state.page = 0;
    saveStore(); renderAll(); closeModal();
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
  // nếu tài khoản bị xóa khi đang đăng nhập -> đăng xuất
  state.me = currentUser();
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

/* ---------------- quản lý tài khoản (admin) ---------------- */
function renderUsers() {
  if (!isAdmin()) return;
  const users = getUsers();
  const counts = {};
  state.records.forEach((r) => { if (r.userId) counts[r.userId] = (counts[r.userId] || 0) + 1; });
  $("usersBody").innerHTML = users.map((u) =>
    "<tr><td><b>" + esc(u.username) + "</b>" +
      (state.me && u.id === state.me.id ? " <span class='badge new'>bạn</span>" : "") + "</td>" +
    "<td>" + (u.role === "admin" ? "<span class='role admin'>Quản trị</span>" : "<span class='role user'>Nhân viên</span>") + "</td>" +
    "<td class='muted'>" + fmtTime(u.createdAt) + "</td>" +
    "<td class='muted'>" + (counts[u.id] || 0) + "</td>" +
    "<td style='white-space:nowrap'><button class='small' data-pw='" + u.id + "'>Đổi MK</button> " +
    "<button class='small danger' data-deluser='" + u.id + "'>Xóa</button></td></tr>"
  ).join("");
  $("usersBody").querySelectorAll("[data-pw]").forEach((b) =>
    b.addEventListener("click", () => adminResetPw(b.getAttribute("data-pw"))));
  $("usersBody").querySelectorAll("[data-deluser]").forEach((b) =>
    b.addEventListener("click", () => adminDeleteUser(b.getAttribute("data-deluser"))));
}

async function adminAddUser() {
  const name = $("newUserName").value.trim();
  let pass = $("newUserPass").value;
  const role = $("newUserRole").value === "admin" ? "admin" : "user";
  if (name.length < 3) { toast("Tên đăng nhập phải từ 3 ký tự trở lên.", "warn"); return; }
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) { toast("Tên đăng nhập chỉ gồm chữ, số, dấu . _ -", "warn"); return; }
  if (findUserByName(name)) { toast("Tên đăng nhập đã tồn tại.", "err"); return; }
  if (!pass) pass = "123456";
  if (pass.length < 4) { toast("Mật khẩu phải từ 4 ký tự trở lên.", "warn"); return; }
  const salt = makeSalt();
  const users = getUsers();
  users.push({ id: uid(), username: name, salt, passHash: await pwHash(pass, salt), role, createdAt: new Date().toISOString() });
  saveUsers(users);
  $("newUserName").value = ""; $("newUserPass").value = "";
  renderUsers();
  toast("Đã thêm tài khoản " + name + ".", "ok");
}

function adminResetPw(userId) {
  const users = getUsers();
  const u = users.find((x) => x.id === userId);
  if (!u) return;
  openModal("Đặt lại mật khẩu",
    "<p>Đặt mật khẩu mới cho tài khoản <b>" + esc(u.username) + "</b>:</p>" +
    "<div class='field'><label for='mNewPass'>Mật khẩu mới</label>" +
    "<input type='password' id='mNewPass' placeholder='Tối thiểu 4 ký tự'></div>",
    "Lưu mật khẩu", async () => {
      const p = $("mNewPass").value;
      if (p.length < 4) { toast("Mật khẩu phải từ 4 ký tự trở lên.", "warn"); return; }
      const salt = makeSalt();
      u.salt = salt; u.passHash = await pwHash(p, salt);
      saveUsers(users); closeModal(); renderUsers();
      toast("Đã đổi mật khẩu cho " + u.username + ".", "ok");
    });
}

function adminDeleteUser(userId) {
  const users = getUsers();
  const u = users.find((x) => x.id === userId);
  if (!u) return;
  if (u.id === state.me.id) { toast("Không thể xóa chính tài khoản đang đăng nhập.", "err"); return; }
  if (u.role === "admin" && users.filter((x) => x.role === "admin").length <= 1) {
    toast("Không thể xóa quản trị viên cuối cùng.", "err"); return;
  }
  const n = state.records.filter((r) => r.userId === u.id).length;
  openModal("Xóa tài khoản",
    "<p>Xóa tài khoản <b>" + esc(u.username) + "</b>?" +
    (n ? " (" + n + " bản ghi của tài khoản này sẽ được giữ lại cho admin xem.)" : "") + "</p>",
    "Xóa tài khoản", () => {
      saveUsers(users.filter((x) => x.id !== userId));
      closeModal(); renderUsers();
      toast("Đã xóa tài khoản " + u.username + ".", "ok");
    });
}

/* ---------------- tài khoản của tôi ---------------- */
async function changeMyName() {
  const name = $("chgName").value.trim();
  if (name.length < 3) { toast("Tên đăng nhập phải từ 3 ký tự trở lên.", "warn"); return; }
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) { toast("Tên đăng nhập chỉ gồm chữ, số, dấu . _ -", "warn"); return; }
  const other = findUserByName(name);
  if (other && other.id !== state.me.id) { toast("Tên đăng nhập đã tồn tại.", "err"); return; }
  const users = getUsers();
  const u = users.find((x) => x.id === state.me.id);
  if (!u) return;
  u.username = name;
  saveUsers(users);
  state.me = currentUser();
  $("chipName").textContent = state.me.username;
  // cập nhật tên hiển thị trên các bản ghi của mình
  state.records.forEach((r) => { if (r.userId === u.id) r.username = name; });
  saveStore(); renderTable();
  toast("Đã đổi tên đăng nhập thành " + name + ".", "ok");
}

async function changeMyPassword() {
  const oldP = $("oldPass").value, p1 = $("newPass").value, p2 = $("newPass2").value;
  const users = getUsers();
  const u = users.find((x) => x.id === state.me.id);
  if (!u) return;
  if ((await pwHash(oldP, u.salt)) !== u.passHash) { toast("Mật khẩu hiện tại không đúng.", "err"); return; }
  if (p1.length < 4) { toast("Mật khẩu mới phải từ 4 ký tự trở lên.", "warn"); return; }
  if (p1 !== p2) { toast("Nhập lại mật khẩu mới chưa khớp.", "warn"); return; }
  const salt = makeSalt();
  u.salt = salt; u.passHash = await pwHash(p1, salt);
  saveUsers(users);
  $("oldPass").value = $("newPass").value = $("newPass2").value = "";
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
  const back = state.cameras.find((c) => /back|rear|environment/i.test(c.label || ""));
  sel.value = (back || state.cameras[0]).id;
  state.cameraId = sel.value;
}

async function startScan() {
  if (state.scanning) return;
  if (typeof Html5Qrcode === "undefined") { toast("Chưa tải được thư viện quét mã. Kiểm tra mạng rồi tải lại trang.", "err"); return; }
  const camId = $("cameraSelect").value;
  if (!camId) { toast("Không tìm thấy camera trên thiết bị này.", "err"); return; }

  $("reader").innerHTML = "";
  html5Qr = new Html5Qrcode("reader");
  setCamStatus("⏳ Đang mở camera…", "");
  try {
    await html5Qr.start(
      camId,
      { fps: 12, qrbox: (w, h) => ({ width: Math.min(w, h) * 0.75, height: Math.min(w, h) * 0.75 }),
        aspectRatio: 1.0,
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
    updateTorchBtn();
  } catch (e) {
    setCamStatus("🔴 Không mở được camera", "warn");
    toast("Không mở được camera: " + (e && e.message ? e.message : e) + ". Hãy cấp quyền camera hoặc dùng HTTPS.", "err");
  }
}
async function stopScan() {
  if (!state.scanning || !html5Qr) return;
  try { await html5Qr.stop(); } catch (e) {}
  try { html5Qr.clear(); } catch (e) {}
  state.scanning = false; state.torchOn = false;
  const bs = $("btnStart"), bt = $("btnStop"), cs = $("cameraSelect");
  if (bs) { bs.disabled = false; bt.disabled = true; cs.disabled = false; }
  const tb = $("btnTorch");
  if (tb) tb.classList.add("hidden");
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
async function toggleTorch() {
  try {
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
  $("cameraSelect").addEventListener("change", (e) => { state.cameraId = e.target.value; });
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

  $("btnAddUser").addEventListener("click", adminAddUser);
  $("btnChgName").addEventListener("click", changeMyName);
  $("btnChgPass").addEventListener("click", changeMyPassword);

  $("modalCancel").addEventListener("click", closeModal);
  $("modalOk").addEventListener("click", () => { if (modalOkFn) modalOkFn(); });
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });

  window.addEventListener("beforeunload", () => { if (state.scanning) stopScan(); });
}

/* ---------------- init ---------------- */
async function init() {
  // CHỐNG TRANG ĐEN: hiện màn hình đăng nhập NGAY LẬP TỨC, trước mọi tác vụ
  // async/storage có thể lỗi. Dù phía sau có sự cố gì, người dùng vẫn thấy giao diện.
  try {
    if (!currentUser()) $("viewLogin").classList.remove("hidden");
  } catch (e) {
    try { $("viewLogin").classList.remove("hidden"); } catch (e2) {}
  }

  try {
    await seedUsers();
    loadStore();
    $("sessionInput").value = state.settings.session || "";
    $("noteInput").value = state.settings.note || "";
    $("chkSound").checked = state.settings.sound !== false;
    setHttpsChip();
    setCamStatus("⚪ Camera đang tắt", "");
    bindEvents();
    if (currentUser()) enterApp();
    // (không có session: màn hình đăng nhập đã hiện sẵn ở trên)
    listCameras();
    if (!("mediaDevices" in navigator)) {
      toast("Trình duyệt không hỗ trợ camera. Bạn vẫn có thể nhập tay hoặc quét từ ảnh.", "warn");
    }
    if (!storageOK) {
      const msg = "Trình duyệt đang chặn lưu trữ cục bộ — dữ liệu quét sẽ KHÔNG được lưu. Hãy cho phép site data/cookie cho trang này rồi tải lại.";
      toast("⚠️ " + msg, "err");
      const le = $("loginErr");
      if (le) le.textContent = msg;
    }
  } catch (e) {
    console.error("Lỗi khởi tạo:", e);
    try { $("viewLogin").classList.remove("hidden"); } catch (e2) {}
    const le = $("loginErr");
    if (le) le.textContent = "Không khởi tạo được ứng dụng: " + (e && e.message ? e.message : e);
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

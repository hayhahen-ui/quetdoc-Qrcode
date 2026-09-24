/* QuetDoc QRcode — Quét mã & ghi nhận dữ liệu
 * Static app: mọi dữ liệu lưu ở localStorage của trình duyệt, không gửi đi đâu.
 */
"use strict";

const STORE_KEY = "quetdoc_qrcode_v1";
const DUP_COOLDOWN_MS = 2500;
const PAGE_SIZE = 50;
const TZ = "Asia/Ho_Chi_Minh";

/* ---------------- state ---------------- */
const state = {
  records: [],          // [{id, content, format, scannedAt, session, note, dup}]
  settings: { session: "", note: "", warnDuplicate: true, sound: true },
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

/* ---------------- storage ---------------- */
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.records)) state.records = data.records;
    if (data.settings && typeof data.settings === "object") {
      state.settings = Object.assign(state.settings, data.settings);
    }
  } catch (e) { console.warn("Không đọc được dữ liệu cũ:", e); }
}
function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ records: state.records, settings: state.settings, v: 1 }));
  } catch (e) { toast("Bộ nhớ trình duyệt đầy, không lưu được bản ghi mới.", "err"); }
}

/* ---------------- helpers ---------------- */
const $ = (id) => document.getElementById(id);

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString("vi-VN", { timeZone: TZ, hour12: false });
  } catch (e) { return iso; }
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

/* ---------------- records ---------------- */
function addRecord(content, format) {
  content = String(content || "").trim();
  if (!content) { toast("Mã quét rỗng, bỏ qua.", "warn"); return; }

  const now = Date.now();
  if (content === state.lastContent && now - state.lastAt < DUP_COOLDOWN_MS) return; // chống quét dính 2 lần
  state.lastContent = content; state.lastAt = now;

  const isDup = state.records.some((r) => r.content === content);
  const rec = {
    id: uid(),
    content,
    format: format || "QR",
    scannedAt: new Date().toISOString(),
    session: state.settings.session.trim(),
    note: state.settings.note.trim(),
    dup: isDup,
  };
  state.records.unshift(rec);
  state.page = 0;
  saveStore(); renderAll();

  const box = $("lastscan");
  box.classList.toggle("dup", isDup);
  box.classList.remove("show"); void box.offsetWidth;
  box.innerHTML = (isDup ? "⚠️ <b>Mã trùng</b> — đã quét trước đó.<br>" : "✅ <b>Đã ghi nhận:</b><br>") +
    "<code>" + esc(content) + "</code><br><span class='muted'>" + esc(rec.format) + " · " + fmtTime(rec.scannedAt) + "</span>";
  box.classList.add("show");

  if (isDup && state.settings.warnDuplicate) { beep(false); toast("Mã này đã được quét trước đó.", "warn"); }
  else { beep(true); toast(isDup ? "Đã ghi nhận (mã trùng)." : "Đã ghi nhận mã mới.", isDup ? "warn" : "ok"); }
}

function deleteRecord(id) {
  state.records = state.records.filter((r) => r.id !== id);
  saveStore(); renderAll();
  toast("Đã xóa bản ghi.", "ok");
}
function clearAll() {
  if (!state.records.length) return;
  if (!confirm("Xóa toàn bộ " + state.records.length + " bản ghi? Hành động này không thể hoàn tác.")) return;
  state.records = []; state.page = 0;
  saveStore(); renderAll();
  toast("Đã xóa toàn bộ dữ liệu.", "ok");
}

/* ---------------- filter / render ---------------- */
function filteredRecords() {
  const q = state.filterText.trim().toLowerCase();
  return state.records.filter((r) => {
    if (q && !(r.content.toLowerCase().includes(q) ||
               (r.note || "").toLowerCase().includes(q) ||
               (r.session || "").toLowerCase().includes(q))) return false;
    if (state.filterDate && !String(r.scannedAt).startsWith(state.filterDate)) {
      // so sánh theo giờ VN
      const d = new Date(r.scannedAt).toLocaleDateString("en-CA", { timeZone: TZ });
      if (d !== state.filterDate) return false;
    }
    return true;
  });
}

function stats() {
  const total = state.records.length;
  const t = todayStr();
  const today = state.records.filter((r) =>
    new Date(r.scannedAt).toLocaleDateString("en-CA", { timeZone: TZ }) === t).length;
  const uniq = new Set(state.records.map((r) => r.content)).size;
  return { total, today, uniq, dup: total - uniq };
}

function renderAll() {
  renderStats(); renderTable();
  $("btnExportCsv").disabled = $("btnExportJson").disabled = $("btnClear").disabled = !state.records.length;
}

function renderStats() {
  const s = stats();
  $("kpiTotal").textContent = s.total.toLocaleString("vi-VN");
  $("kpiToday").textContent = s.today.toLocaleString("vi-VN");
  $("kpiUniq").textContent = s.uniq.toLocaleString("vi-VN");
  $("kpiDup").textContent = s.dup.toLocaleString("vi-VN");
}

function renderTable() {
  const list = filteredRecords();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  const slice = list.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);

  const body = $("tbody");
  if (!slice.length) {
    body.innerHTML = '<tr><td colspan="6"><div class="empty">' +
      (state.records.length ? "Không tìm thấy bản ghi phù hợp bộ lọc." : "Chưa có bản ghi nào. Hãy quét mã đầu tiên 📷") +
      "</div></td></tr>";
  } else {
    body.innerHTML = slice.map((r, i) => {
      const n = state.page * PAGE_SIZE + i + 1;
      return "<tr>" +
        "<td class='muted'>" + n + "</td>" +
        "<td class='content'><code style='font-size:12px'>" + esc(r.content) + "</code><br>" +
          "<span class='badge " + (r.dup ? "dup'>trùng" : "new'>mới") + "</span></td>" +
        "<td class='muted'>" + esc(r.format || "") + "</td>" +
        "<td class='muted' style='white-space:nowrap'>" + fmtTime(r.scannedAt) + "</td>" +
        "<td>" + esc(r.session || "") + (r.note ? "<br><span class='muted'>" + esc(r.note) + "</span>" : "") + "</td>" +
        "<td><button class='small danger' data-del='" + r.id + "'>Xóa</button></td>" +
        "</tr>";
    }).join("");
  }
  body.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => deleteRecord(b.getAttribute("data-del"))));

  $("pageInfo").textContent = "Trang " + (state.page + 1) + "/" + pages + " · " + list.length + " bản ghi";
  $("btnPrev").disabled = state.page <= 0;
  $("btnNext").disabled = state.page >= pages - 1;
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
  const head = ["STT", "Noi dung ma", "Dinh dang", "Thoi gian quet (GMT+7)", "Phien", "Ghi chu", "Trung lap"];
  const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const lines = [head.map(q).join(",")];
  state.records.forEach((r, i) => lines.push(
    [i + 1, r.content, r.format, fmtTime(r.scannedAt), r.session, r.note, r.dup ? "Co" : ""].map(q).join(",")));
  download("quetdoc_qrcode_" + todayStr() + ".csv", "﻿" + lines.join("\r\n"), "text/csv;charset=utf-8");
  toast("Đã xuất file CSV.", "ok");
}
function exportJSON() {
  download("quetdoc_qrcode_" + todayStr() + ".json",
    JSON.stringify({ exportedAt: new Date().toISOString(), records: state.records }, null, 2),
    "application/json");
  toast("Đã xuất file JSON.", "ok");
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
  try {
    state.cameras = await Html5Qrcode.getCameras();
  } catch (e) { state.cameras = []; }
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
  $("btnStart").disabled = false; $("btnStop").disabled = true;
  $("cameraSelect").disabled = false; $("btnTorch").classList.add("hidden");
  $("reader").innerHTML = '<div class="reader-idle">📷<br>Nhấn <b>Bắt đầu quét</b> để mở camera</div>';
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
  $("chkWarnDup").addEventListener("change", (e) => { state.settings.warnDuplicate = e.target.checked; saveStore(); });
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

  window.addEventListener("beforeunload", () => { if (state.scanning) stopScan(); });
}

/* ---------------- init ---------------- */
function init() {
  loadStore();
  $("sessionInput").value = state.settings.session || "";
  $("noteInput").value = state.settings.note || "";
  $("chkWarnDup").checked = state.settings.warnDuplicate !== false;
  $("chkSound").checked = state.settings.sound !== false;
  $("recCount").textContent = state.records.length;
  setHttpsChip();
  setCamStatus("⚪ Camera đang tắt", "");
  bindEvents();
  renderAll();
  listCameras();
  if (!("mediaDevices" in navigator)) {
    toast("Trình duyệt không hỗ trợ camera. Bạn vẫn có thể nhập tay hoặc quét từ ảnh.", "warn");
  }
}
document.addEventListener("DOMContentLoaded", init);

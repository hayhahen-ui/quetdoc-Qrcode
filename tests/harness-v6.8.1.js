// Harness v6.8.1 — fix "num is not defined" ở Tổng hợp theo nhân viên.
// Trích hàm thật từ app.js, stub các dependency ngoài, chạy đúng kịch bản ảnh user gửi.
const fs = require("fs");
const src = fs.readFileSync(process.env.HOME + "/workspace/quetdoc-Qrcode/assets/js/app.js", "utf8");
function grab(name) {
  const m = src.match(new RegExp("(?:function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\})"));
  if (!m) throw new Error("khong tim thay ham " + name);
  return m[0];
}
// stub dependency ngoài (giống production)
const norm = (s) => String(s == null ? "" : s).trim().toUpperCase();
const dName = (u) => ({ user1: "Ms.Dung", user2: "Ms.Phượng" }[String(u || "").toLowerCase()] || u);
const parseChiThi = (c) => String(c || "").slice(0, 9).toUpperCase();
const boxPairs = () => 6; // packing: 6 đôi/thùng
const esc = (s) => String(s);
eval(grab("fmtNum"));
eval(grab("parseSessType"));
eval(grab("summarizeDay"));
eval(grab("sumCell"));

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) pass++;
  else { fail++; console.log("FAIL " + name); }
}

// --- đúng dữ liệu ảnh: Ms.Phượng quét 8 thùng Kiểm 1 (AE2608209), Ms.Dung quét 5 thùng Kiểm 2 (AE2608507) ---
const rows = [];
for (let i = 0; i < 8; i++)
  rows.push({ content: "AE2608209600" + (48 + i), chi_thi: "AE2608209", session: "Kiểm 1", username: "user2", size: "7.0-6" });
for (let i = 0; i < 5; i++)
  rows.push({ content: "AE2608507600" + (10 + i), chi_thi: "AE2608507", session: "Kiểm 2", username: "user1", size: "5.0-6" });
// 1 mã trùng (quét lại) -> chỉ đếm 1 lần
rows.push({ content: "AE260820960048", chi_thi: "AE2608209", session: "Kiểm 1", username: "user2", size: "7.0-6" });

let users;
try {
  users = summarizeDay(rows);
  t("summarizeDay khong nem ReferenceError", true);
} catch (e) {
  t("summarizeDay khong nem ReferenceError (" + e.message + ")", false);
}
t("2 user", users.length === 2);
const phuong = users.find((g) => g.user === "user2");
const dung = users.find((g) => g.user === "user1");
t("Ms.Phuong 8 thung (dedupe)", phuong && phuong.boxes === 8);
t("Ms.Phuong 48 doi", phuong && phuong.pairs === 48);
t("Ms.Phuong Kiem 8 thung", phuong && phuong.types["kiểm"].boxes === 8);
t("Ms.Dung 5 thung", dung && dung.boxes === 5);
t("Ms.Dung 30 doi", dung && dung.pairs === 30);
t("Ms.Phuong 1 pallet", phuong && phuong.pallets.size === 1);

// --- sumCell: trước đây chính chỗ này ném "num is not defined" ---
let html = "";
try {
  html = users.map((g) =>
    "<td>" + sumCell(g.types["kiểm"]) + "</td><td><b>" + fmtNum(g.pallets.size) + "</b></td>").join("");
  t("render dong user khong nem loi", true);
} catch (e) {
  t("render dong user khong nem loi (" + e.message + ")", false);
}
t("sumCell Ms.Phuong: 8 · 48", html.includes("<b>8</b> · 48"));
t("sumCell Ms.Dung: 5 · 30", html.includes("<b>5</b> · 30"));
t("sumCell 0 -> gach ngang", sumCell({ boxes: 0, pairs: 0 }).includes("—"));

// --- fmtNum ---
t("fmtNum(1234) -> '1.234'", fmtNum(1234) === "1.234");
t("fmtNum(0) -> '0'", fmtNum(0) === "0");

// --- parseSessType van giu ---
t("parseSessType('Kiểm 1')", parseSessType("Kiểm 1") === "kiểm");
t("parseSessType('KIEM 2')", parseSessType("KIEM 2") === "kiểm");
t("parseSessType('Nhập 3')", parseSessType("Nhập 3") === "nhập");

// --- audit tinh: khong con num( toan cuc trong khoi summary ---
const block = src.slice(src.indexOf("function sumCell"), src.indexOf("/* v5.4: DASHBOARD"));
t("khong con num( trong khoi summary", !/[^a-zA-Z_.]num\(/.test(block));
t("dung fmtNum trong sumCell", block.includes("fmtNum(t.boxes)"));
t("dung fmtNum trong renderUserSummary", block.includes("fmtNum(g.boxes)") && block.includes("fmtNum(tot.pairs)"));

console.log("\n" + pass + "/" + (pass + fail) + " pass");
process.exit(fail ? 1 : 0);

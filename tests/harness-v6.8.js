// Harness v6.8 — báo cáo đúng mẫu xưởng (dòng Tổng theo chỉ thị, 3 cột xanh, tên sheet)
// Trích trực tiếp hàm thuần từ assets/js/app.js rồi eval -> test đúng code production.
const fs = require("fs");
const src = fs.readFileSync(process.env.HOME + "/workspace/quetdoc-Qrcode/assets/js/app.js", "utf8");
function grab(name) {
  const m = src.match(new RegExp("(?:function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\})"));
  if (!m) throw new Error("khong tim thay ham " + name);
  return m[0];
}
eval(grab("reportSheetName"));
eval(grab("groupReportRows"));
eval(grab("boxListStr"));

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; /*console.log("PASS " + name);*/ }
  else { fail++; console.log("FAIL " + name); }
}

// --- mô phỏng đúng số liệu ảnh mẫu của user ---
function mkRow(ct, size, p, doi, tu, den, boxes) {
  return { rg: { chi_thi: ct, po: "0903174964-1", art: "LC1786", size: size,
    tong_doi: (den - tu + 1) * doi, doi_thung: doi, so_thung: den - tu + 1, thung_tu: tu, thung_den: den },
    p: p, q: p * doi, boxes: boxes };
}
const rows = [
  mkRow("AE2608209", 7, 4, 6, 43, 52, [48, 49, 50, 51]),
  mkRow("AE2608209", 8, 6, 6, 53, 58, [52, 53, 54, 55, 56, 57]),
  mkRow("AE2608507", 4, 4, 6, 1, 25, [3, 4, 5, 6]),
  mkRow("AE2608507", 5, 11, 6, 26, 94, [29, 31, 60, 61, 62, 63, 65, 66, 67, 68, 70]),
  mkRow("AE2608507", 6, 6, 6, 95, 159, [94, 113, 114, 115, 116, 118]),
  mkRow("AE2608507", 7, 3, 6, 160, 181, [159, 160, 161]),
  mkRow("AE2608507", 8, 2, 6, 182, 191, [181, 190]),
  mkRow("AE2608507", 9, 2, 6, 192, 200, [191, 192]),
];
const gs = groupReportRows(rows);
t("gom dung 2 nhom chi thi", gs.length === 2);
t("thu tu nhom giu nguyen (AE2608209 truoc)", gs[0].chi_thi === "AE2608209" && gs[1].chi_thi === "AE2608507");
t("nhom 1 co 2 dong", gs[0].items.length === 2);
t("nhom 2 co 6 dong", gs[1].items.length === 6);
t("Tong nhom 1: 10 thung", gs[0].sP === 10);
t("Tong nhom 1: 60 doi", gs[0].sQ === 60);
t("Tong nhom 2: 28 thung", gs[1].sP === 28);
t("Tong nhom 2: 168 doi", gs[1].sQ === 168);
t("Tong cong: 38 thung", gs.reduce((a, g) => a + g.sP, 0) === 38);
t("Tong cong: 228 doi", gs.reduce((a, g) => a + g.sQ, 0) === 228);
t("nhom rong -> []", groupReportRows([]).length === 0 && groupReportRows(null).length === 0);

// --- boxListStr ---
t("boxListStr dung mau", boxListStr([48, 49, 50, 51]) === "048,049,050,051 = 4 thùng");
t("boxListStr pad 3 so", boxListStr([3, 4]) === "003,004 = 2 thùng");
t("boxListStr rong -> ''", boxListStr([]) === "");

// --- reportSheetName ---
t("sheet Kiem", reportSheetName("kiểm") === "Báo cáo kiểm kho");
t("sheet Nhap", reportSheetName("nhập") === "Báo cáo nhập kho");
t("sheet Xuat", reportSheetName("xuất") === "Báo cáo xuất kho");
t("sheet mac dinh", reportSheetName("") === "Báo cáo nhập kho");

// --- kiểm tra tĩnh: code export dùng đúng cột xanh K/L/M (11,12,13) ---
t("to xanh 3 cot K/L/M", /cn >= NC - 3 && cn <= NC - 1/.test(src));
t("khong con to xanh cu 2 cot", !/cn === NC - 2 \|\| cn === NC - 1\) cell\.fill/.test(src));
t("co dong Tong merge A-J", /mergeCells\(tr\.number, 1, tr\.number, 10\)/.test(src));
t("dong Tong co sP/sQ", /cK\.value = gr\.sP; cL\.value = gr\.sQ;/.test(src));
t("sheet dung ham reportSheetName", /addWorksheet\(reportSheetName\(typeQ\)\)/.test(src));
t("cot M rong 44", /\{ width: 44 \}, \{ width: 16 \}\]/.test(src));

console.log("\n" + pass + "/" + (pass + fail) + " pass");
process.exit(fail ? 1 : 0);

// Harness v6.9 — trang Hướng dẫn sử dụng (mindmap) + nút trên thanh tiêu đề.
const fs = require("fs");
const H = process.env.HOME + "/workspace/quetdoc-Qrcode/";
const g = fs.readFileSync(H + "guide.html", "utf8");
const idx = fs.readFileSync(H + "index.html", "utf8");
const css = fs.readFileSync(H + "assets/css/styles.css", "utf8");
let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) pass++;
  else { fail++; console.log("FAIL " + name); }
}

// --- guide.html ---
const secs = ["sec-login", "sec-session", "sec-scan", "sec-size", "sec-data", "sec-admin"];
secs.forEach((s) => t("section " + s + " ton tai", g.includes('id="' + s + '"')));
const branches = [...g.matchAll(/class="branch" data-target="([^"]+)"/g)].map((m) => m[1]);
t("mindmap co 6 nhanh", branches.length === 6);
t("nhanh tro dung 6 section", secs.every((s) => branches.includes(s)));
t("legend 6 chip mau", (g.match(/<span class="dot"/g) || []).length === 6);
t("nut quay lai app", g.includes('href="./"'));
t("quy trinh 5 buoc", (g.match(/<li><b>[1-5]<\/b>/g) || []).length === 5);
t("key: meo/luu y/admin/bam nhanh", g.includes("💡 Mẹo") && g.includes("⚠️ Lưu ý") && g.includes("🛡 Chỉ admin") && g.includes("Bấm vào nhánh"));
t("nd admin: XOA HET", g.includes("XÓA HẾT"));
t("nd admin: packing", g.includes("Packing list"));
t("nd admin: master", g.includes("ĐƠN ĐẶT HÀNG TVS"));
t("nd admin: ten NV", g.includes("Tên nhân viên"));
t("nd quet: phien bat buoc", g.includes("4 số cuối Chỉ thị"));
t("nd quet: OCR", g.includes("🤖 OCR"));
t("nd quet: size 1 cham", g.includes("Chạm 1 lần"));
t("nd bao cao: tong hop NV", g.includes("Tổng hợp theo nhân viên"));
t("js branch click", g.includes('querySelectorAll(".branch")'));
t("svg viewBox", g.includes('viewBox="0 0 1240 800"'));

// --- index.html: nút Hướng dẫn ---
t("nut btnGuide ton tai", idx.includes('id="btnGuide"'));
t("tro toi guide.html", idx.includes('href="guide.html"'));
t("mo tab moi", idx.includes('target="_blank"'));
t("nam sau userchip", idx.indexOf('id="btnGuide"') > idx.indexOf("userchip"));
t("footer v6.9", idx.includes("<b>v6.9</b>"));
t("cache-bust js v6.9", idx.includes("app.js?v=6.9"));
t("cache-bust css v6.9", idx.includes("styles.css?v=6.9"));

// --- styles.css ---
t("css a.small", css.includes("a.small{") || css.includes("a.small {"));
t("a.small bo gach chan", css.includes("text-decoration:none"));

console.log("\n" + pass + "/" + (pass + fail) + " pass");
process.exit(fail ? 1 : 0);

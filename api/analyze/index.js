// 1) تطبيع النص: إزالة علامات RTL وتوحيد المسافات والأسطر
function normalizeText(s = "") {
  return String(s)
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "") // RTL/LTR marks
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 2) تحويل الأرقام العربية-الهندية إلى أرقام إنجليزية
function toLatinDigits(str = "") {
  const map = {
    "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
    "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9"
  };
  return String(str).replace(/[٠-٩۰-۹]/g, d => map[d] ?? d);
}

// 3) التقاط رقم بعد عنوان عربي (مرن مع الفواصل/الأقواس/السالب)
function extractNumberAfterLabel(text, labelRegex) {
  const t = toLatinDigits(normalizeText(text));

  // رقم مثل: (108,959) أو -108,959 أو 108,959 أو 108959.00
  const num = String.raw`(\(\s*[-]?\d[\d,\s]*?(?:\.\d+)?\s*\)|-?\d[\d,\s]*?(?:\.\d+)?)`;

  const re = new RegExp(String.raw`${labelRegex.source}\s*[:：]?\s*${num}`, "i");
  const m = t.match(re);
  if (!m) return null;

  let v = m[1].replace(/\s/g, "");

  // (123,456) => -123456
  const isParen = /^\(.*\)$/.test(v);
  v = v.replace(/[(),]/g, "");
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return isParen ? -Math.abs(n) : n;
}

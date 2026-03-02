// api/_lib/parse-arabic-number.js
// يحول نص رقم عربي مثل "٢٫٢١٨,٦٦٢٫٧٣٥" إلى رقم صحيح 2218662735
// ويدعم السالب بالأقواس (١٢٣) => -123

function toLatinDigits(s) {
  const map = {
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
    "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
    "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
    "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  };
  return String(s).replace(/[٠-٩۰-۹]/g, (ch) => map[ch] ?? ch);
}

function looksLikeThousandGrouping(parts) {
  // مثال: 2 | 218 | 662 | 735  => true
  if (!parts || parts.length < 2) return false;
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].length !== 3) return false;
    if (!/^\d{3}$/.test(parts[i])) return false;
  }
  // أول جزء يسمح 1-3 أرقام
  return /^\d{1,3}$/.test(parts[0]);
}

function parseArabicNumber(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === "number" && Number.isFinite(input)) return input;

  let s = String(input).trim();
  if (!s) return null;

  // سالب بين قوسين: (١٢٣) أو ( ١٢٣ )
  let neg = false;
  if (s.includes("(") && s.includes(")")) {
    neg = true;
    s = s.replace(/[()]/g, "");
  }

  s = toLatinDigits(s);

  // إزالة مسافات
  s = s.replace(/\s+/g, "");

  // فواصل ممكنة في العربية/الإنجليزية
  //  - "٬" آلاف عربي
  //  - "," فاصلة إنجليزية (قد تكون آلاف)
  //  - "٫" فاصلة عشرية عربية (لكن OCR قد يستخدمها بدل آلاف)
  //  - "." فاصلة عشرية إنجليزية
  const hasSep = /[٬,٫.]/.test(s);

  // احتفظ فقط بالرقم + فواصل + إشارة سالب
  s = s.replace(/[^\d٬,٫.\-]/g, "");

  // إذا فيه أكثر من فاصل داخل الرقم وعلى نمط مجموعات ثلاثية => اعتبره آلاف
  if (hasSep) {
    // نقسم على أي فاصل ونشوف شكل المجموعات
    const parts = s.split(/[٬,٫.]/).filter(Boolean);

    if (looksLikeThousandGrouping(parts)) {
      // آلاف => نجمعها بدون فواصل
      const joined = parts.join("");
      const n = Number(joined);
      if (!Number.isFinite(n)) return null;
      return neg ? -n : n;
    }

    // غير نمط آلاف: نعامل "٫" كعشري، ونحذف فواصل الآلاف
    // 1) نحول "٫" إلى "."
    s = s.replace(/٫/g, ".");
    // 2) نحذف "٬" و ","
    s = s.replace(/[٬,]/g, "");

    // إذا صار عندنا أكثر من نقطة، نخلي آخر نقطة عشرية ونحذف الباقي (احتياط)
    const dotCount = (s.match(/\./g) || []).length;
    if (dotCount > 1) {
      const last = s.lastIndexOf(".");
      s = s.replace(/\./g, "");
      s = s.slice(0, last) + "." + s.slice(last);
    }
  }

  // أخيرًا: تحويل
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

module.exports = { parseArabicNumber };

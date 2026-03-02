// api/_lib/parse-arabic-number.js

// يحول نص رقم عربي مثل: "١,٦٢٣,١٦٠٫٩٧١" => 1623160.971
// ويدعم السالب بالأقواس: "(١٢٣)" => -123
// ويرجع null إذا ما كان رقم

function toLatinDigits(s) {
  // الأرقام العربية والهندية الشائعة
  const map = {
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
    "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
    "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
    "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  };

  return String(s).replace(/[٠-٩۰-۹]/g, (ch) => map[ch] ?? ch);
}

function parseArabicNumber(input) {
  if (input === null || input === undefined) return null;

  // لو أصلاً رقم جاهز
  if (typeof input === "number" && Number.isFinite(input)) return input;

  let s = String(input).trim();
  if (!s) return null;

  // إزالة مسافات لا مرئية
  s = s.replace(/\u00A0/g, " ").trim();

  // سالب بالأقواس ( ... )
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  // تحويل الأرقام العربية إلى لاتينية
  s = toLatinDigits(s);

  // توحيد فواصل الأرقام:
  // "٫" (decimal) => "."
  // "٬" (thousands) => ","
  s = s.replace(/٫/g, ".").replace(/٬/g, ",");

  // إزالة أي رموز غير رقمية مسموحة (نخلي أرقام + . + , + -)
  // وأيضاً نحذف كلمات مثل "ريال" وغيرها إن وجدت
  s = s.replace(/[^\d.,\-]/g, "");

  // إذا صار فاضي بعد التنظيف
  if (!s) return null;

  // لو فيه أكثر من "-" نخليه غير صالح
  const minusCount = (s.match(/\-/g) || []).length;
  if (minusCount > 1) return null;

  // إذا "-" مو في البداية -> غير صالح
  if (s.includes("-") && !s.startsWith("-")) return null;

  // إزالة فواصل الآلاف: 1,234,567.89 => 1234567.89
  // لكن قبلها: لو النص يحتوي "." نعتبرها الفاصلة العشرية
  // (هذا مناسب لمعطيات Document Intelligence عندك)
  s = s.replace(/,/g, "");

  // إذا صار مثل "." أو "-" فقط
  if (s === "." || s === "-" || s === "-.") return null;

  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  return negative ? -Math.abs(n) : n;
}

module.exports = { parseArabicNumber };

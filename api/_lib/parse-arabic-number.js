// api/_lib/parse-arabic-number.js
// يحول نص رقم عربي مثل: "٢٫٢١٨,٦٦٢٫٧٣٥" => 2218662735
// ويدعم السالب بالأقواس: "(١٢٣)" => -123
// ويعيد null إذا ما كان رقم

function toLatinDigits(s) {
  const map = {
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
    "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
    "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
    "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  };
  return String(s).replace(/[٠-٩۰-۹]/g, (ch) => map[ch] ?? ch);
}

function countChar(str, ch) {
  return (str.match(new RegExp(`\\${ch}`, "g")) || []).length;
}

function parseArabicNumber(input) {
  if (input === null || input === undefined) return null;

  // لو رقم جاهز
  if (typeof input === "number" && Number.isFinite(input)) return input;

  let s = String(input).trim();
  if (!s) return null;

  // إزالة رموز شائعة
  s = s
    .replace(/\s+/g, "")                // مسافات
    .replace(/[ر﷼$٪%]/g, "")            // عملات/نسب
    .replace(/ـ/g, "")                  // تطويل
    .replace(/,/g, ",")                 // توحيد (احتياط)
    .replace(/٬/g, ",")                 // Arabic thousands -> comma
    .replace(/٫/g, ".");                // Arabic decimal -> dot (مؤقتًا)

  // سالب بالأقواس
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  // دعم السالب العادي
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (s.startsWith("+")) s = s.slice(1);

  s = toLatinDigits(s);

  // أبقي فقط أرقام وفواصل
  s = s.replace(/[^\d.,]/g, "");
  if (!s) return null;

  // ======== القاعدة الذهبية للقوائم المالية ========
  // إذا وجدنا "أكثر من فاصل" غالبًا هذه فواصل آلاف وليست كسور
  const dotCount = countChar(s, ".");
  const commaCount = countChar(s, ",");

  const totalSeps = dotCount + commaCount;

  // مثال: 2.218,662.735  أو  1,784,755,283  => كله آلاف
  if (totalSeps >= 2) {
    const asInt = s.replace(/[.,]/g, "");
    if (!/^\d+$/.test(asInt)) return null;
    const n = Number(asInt);
    if (!Number.isFinite(n)) return null;
    return negative ? -n : n;
  }

  // إذا يوجد فاصل واحد فقط: نقرر هل هو كسور أم آلاف
  if (totalSeps === 1) {
    const sep = dotCount === 1 ? "." : ",";
    const parts = s.split(sep);

    // إذا الجزء بعد الفاصل 1-2 رقم => اعتبرها كسور
    // غير ذلك => اعتبر الفاصل آلاف واحذفه
    if (parts.length === 2) {
      const frac = parts[1] || "";
      if (frac.length >= 1 && frac.length <= 2) {
        const n = Number(parts[0] + "." + frac);
        if (!Number.isFinite(n)) return null;
        return negative ? -n : n;
      } else {
        const asInt = parts[0] + parts[1];
        if (!/^\d+$/.test(asInt)) return null;
        const n = Number(asInt);
        if (!Number.isFinite(n)) return null;
        return negative ? -n : n;
      }
    }
  }

  // بدون فواصل
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

module.exports = { parseArabicNumber };

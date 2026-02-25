/* assets/js/main.js
   UI renderer for /api/analyze results (Arabic-friendly)
*/

console.log("main.js loaded ✅");

const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const btnShow = document.getElementById("btnShow");
const btnClear = document.getElementById("btnClear");
const statusEl = document.getElementById("status");
const resultsSection = document.getElementById("results");
const cardsEl = document.getElementById("cards");

let selectedFiles = [];

function setStatus(msg, type = "info") {
  // type: info | ok | warn | err
  statusEl.textContent = msg || "";
  statusEl.classList.remove("ok", "warn", "err");
  if (type === "ok") statusEl.classList.add("ok");
  if (type === "warn") statusEl.classList.add("warn");
  if (type === "err") statusEl.classList.add("err");
}

function clearUI() {
  selectedFiles = [];
  fileInput.value = "";
  if (fileListEl) fileListEl.innerHTML = "";
  if (cardsEl) cardsEl.innerHTML = "";
  resultsSection?.classList.add("hidden");
  btnShow.disabled = true;
  setStatus("");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(n) {
  try {
    const x = typeof n === "string" ? Number(n) : n;
    if (!Number.isFinite(x)) return null;
    return new Intl.NumberFormat("en-US").format(x);
  } catch {
    return null;
  }
}

// لو القيمة “غريبة جدًا” (مثل 5e17) نحاول نلتقط رقم منطقي من النص
function parseBestNumberFromSnippet(snippet) {
  if (!snippet) return null;

  // أمثلة: 1,249,440,428  | (149,968,457) | 541,162,565
  const cleaned = String(snippet).replace(/\u200f|\u200e/g, ""); // remove RTL/LTR marks

  // التقط أكبر رقم “مجمّع” بالـ commas
  const matches = cleaned.match(/\(?-?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?/g);
  if (!matches || !matches.length) return null;

  // نختار الرقم الأطول (غالباً هو الأهم)
  matches.sort((a, b) => b.length - a.length);
  const raw = matches[0];

  const isParenNeg = raw.startsWith("(") && raw.endsWith(")");
  const numStr = raw.replace(/[(),]/g, "");
  const num = Number(numStr);
  if (!Number.isFinite(num)) return null;
  return isParenNeg ? -num : num;
}

function pickValue(fieldObj) {
  // fieldObj: { value, snippet }
  if (!fieldObj) return { ok: false, value: null, from: "none" };

  const v = fieldObj.value;

  // لو value رقم معقول (مثلاً أقل من 1e13) نستخدمه
  if (Number.isFinite(v) && Math.abs(v) > 0 && Math.abs(v) < 1e13) {
    return { ok: true, value: v, from: "value" };
  }

  // غير كذا نقرأ من snippet
  const sn = parseBestNumberFromSnippet(fieldObj.snippet);
  if (Number.isFinite(sn) && Math.abs(sn) < 1e13) {
    return { ok: true, value: sn, from: "snippet" };
  }

  return { ok: false, value: null, from: "none" };
}

function buildMetricRow(label, fieldObj, currency = "SAR") {
  const picked = pickValue(fieldObj);
  const fmt = picked.ok ? formatNumber(picked.value) : null;

  const badge =
    picked.from === "value"
      ? `<span class="badge ok">مستخرج</span>`
      : picked.from === "snippet"
      ? `<span class="badge warn">من النص</span>`
      : `<span class="badge err">غير متوفر</span>`;

  const valHtml = fmt
    ? `<div class="metric-val">${fmt} <span class="muted">${escapeHtml(currency)}</span></div>`
    : `<div class="metric-val muted">غير متوفر</div>`;

  const snip = fieldObj?.snippet ? String(fieldObj.snippet).trim() : "";
  const snipHtml = snip
    ? `<details class="snip"><summary>عرض المقطع</summary><pre>${escapeHtml(snip)}</pre></details>`
    : `<div class="muted small">لا يوجد مقطع نصي</div>`;

  return `
    <div class="metric">
      <div class="metric-head">
        <div class="metric-label">${escapeHtml(label)}</div>
        ${badge}
      </div>
      ${valHtml}
      ${snipHtml}
    </div>
  `;
}

function renderResults(data) {
  // اعرض القسم
  resultsSection?.classList.remove("hidden");
  cardsEl.innerHTML = "";

  const meta = data?.meta || {};
  const currency = meta.currency || "SAR";

  const score = data?.extractionScore || {};
  const found = Number.isFinite(score.foundCount) ? score.foundCount : "-";
  const total = Number.isFinite(score.totalChecked) ? score.totalChecked : "-";

  const headerCard = `
    <div class="card">
      <div class="card-title">ملخص الملف</div>
      <div class="grid">
        <div><span class="muted">اسم الملف:</span> ${escapeHtml(data?.fileName || "-")}</div>
        <div><span class="muted">عدد الصفحات:</span> ${escapeHtml(data?.pages ?? "-")}</div>
        <div><span class="muted">الشركة:</span> ${escapeHtml(meta.company || "-")}</div>
        <div><span class="muted">الفترة:</span> ${escapeHtml(meta.periodHint || "-")}</div>
        <div><span class="muted">نسبة الاستخراج:</span> ${escapeHtml(found)} / ${escapeHtml(total)}</div>
      </div>
    </div>
  `;

  const inc = data?.extracted?.incomeStatement || {};
  const bs = data?.extracted?.balanceSheet || {};
  const cf = data?.extracted?.cashFlow || {};
  const sh = data?.extracted?.shares || {};

  const incomeCard = `
    <div class="card">
      <div class="card-title">قائمة الربح أو الخسارة</div>
      <div class="metrics">
        ${buildMetricRow("الإيرادات", inc.revenue, currency)}
        ${buildMetricRow("مجمل الربح", inc.grossProfit, currency)}
        ${buildMetricRow("الربح التشغيلي", inc.operatingProfit, currency)}
        ${buildMetricRow("صافي الربح", inc.netIncome, currency)}
      </div>
    </div>
  `;

  const balanceCard = `
    <div class="card">
      <div class="card-title">قائمة المركز المالي</div>
      <div class="metrics">
        ${buildMetricRow("إجمالي الأصول", bs.totalAssets, currency)}
        ${buildMetricRow("إجمالي المطلوبات", bs.totalLiabilities, currency)}
        ${buildMetricRow("إجمالي حقوق الملكية", bs.totalEquity, currency)}
      </div>
    </div>
  `;

  const cashCard = `
    <div class="card">
      <div class="card-title">التدفقات النقدية</div>
      <div class="metrics">
        ${buildMetricRow("التدفق النقدي من التشغيل (CFO)", cf.cfo, currency)}
        ${buildMetricRow("التدفق النقدي من الاستثمار (CFI)", cf.cfi, currency)}
        ${buildMetricRow("التدفق النقدي من التمويل (CFF)", cf.cff, currency)}
        ${buildMetricRow("الإنفاق الرأسمالي (CAPEX)", cf.capex, currency)}
      </div>
      <div class="muted small">ملاحظة: إذا كانت هذه البنود “غير متوفر”، فهذا يعني أن الـ API لم يلتقط أرقامها من الـ PDF بعد.</div>
    </div>
  `;

  const sharesCard = `
    <div class="card">
      <div class="card-title">الأسهم وربحية السهم</div>
      <div class="metrics">
        ${buildMetricRow("متوسط الأسهم (Weighted Shares)", sh.weightedShares, "Share")}
        ${buildMetricRow("ربحية السهم الأساسية (EPS Basic)", sh.epsBasic, currency)}
        ${buildMetricRow("ربحية السهم المخففة (EPS Diluted)", sh.epsDiluted, currency)}
      </div>
    </div>
  `;

  cardsEl.insertAdjacentHTML("beforeend", headerCard + incomeCard + balanceCard + cashCard + sharesCard);

  // CSS بسيط داخل JS (بدون ما تلمس ملفات CSS)
  injectMiniStyles();
}

let injected = false;
function injectMiniStyles() {
  if (injected) return;
  injected = true;

  const css = `
    #status.ok { color: #4ade80; }
    #status.warn { color: #fbbf24; }
    #status.err { color: #fb7185; }

    .card {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 14px;
      margin: 12px 0;
      backdrop-filter: blur(6px);
    }
    .card-title {
      font-weight: 800;
      margin-bottom: 10px;
      font-size: 18px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 12px;
      font-size: 14px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .metric {
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 14px;
      padding: 10px;
      background: rgba(0,0,0,0.15);
    }
    .metric-head {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap: 10px;
      margin-bottom: 6px;
    }
    .metric-label { font-weight: 700; font-size: 14px; }
    .metric-val { font-size: 16px; font-weight: 800; }
    .muted { opacity: 0.75; }
    .small { font-size: 12px; }
    .badge {
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.14);
      white-space: nowrap;
    }
    .badge.ok { color: #4ade80; }
    .badge.warn { color: #fbbf24; }
    .badge.err { color: #fb7185; }

    details.snip { margin-top: 8px; }
    details.snip summary { cursor: pointer; opacity: .9; }
    details.snip pre {
      margin: 8px 0 0;
      padding: 10px;
      border-radius: 12px;
      background: rgba(0,0,0,0.25);
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.6;
    }

    @media (max-width: 900px) {
      .grid { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: 1fr; }
    }
  `;

  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

async function analyzeSingleFile(file) {
  const fd = new FormData();

  // حاولنا دعم أكثر من اسم للحقل لتفادي اختلافات السيرفر:
  // لو السيرفر يتوقع "file" أو "files"
  fd.append("file", file);
  fd.append("files", file);

  const res = await fetch("/api/analyze", {
    method: "POST",
    body: fd,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`API error ${res.status}: ${txt || "unknown"}`);
  }

  return res.json();
}

function renderSelectedFiles() {
  if (!fileListEl) return;

  if (!selectedFiles.length) {
    fileListEl.innerHTML = `<div class="muted small">لم يتم اختيار أي ملف.</div>`;
    return;
  }

  const items = selectedFiles
    .map(
      (f) => `
        <div class="file-item">
          <span>${escapeHtml(f.name)}</span>
          <span class="muted small">${formatNumber(f.size) || f.size} bytes</span>
        </div>`
    )
    .join("");

  fileListEl.innerHTML = items;
}

fileInput?.addEventListener("change", () => {
  selectedFiles = Array.from(fileInput.files || []);
  renderSelectedFiles();

  if (selectedFiles.length) {
    btnShow.disabled = false;
    setStatus(`تم اختيار ${selectedFiles.length} ملف ✅`, "ok");
  } else {
    btnShow.disabled = true;
    setStatus("لم يتم اختيار ملف.", "warn");
  }
});

btnClear?.addEventListener("click", () => {
  clearUI();
});

btnShow?.addEventListener("click", async () => {
  if (!selectedFiles.length) {
    setStatus("اختر ملف أولاً.", "warn");
    return;
  }

  btnShow.disabled = true;
  setStatus("جاري رفع الملف وتحليل البيانات...", "info");

  try {
    // حاليا نعالج أول ملف فقط (حسب تصميمك). لو تبغى متعدد نوسعها بعدين.
    const data = await analyzeSingleFile(selectedFiles[0]);

    console.log("API Response:", data);

    if (!data?.ok) {
      setStatus("الـ API رجّع نتيجة غير متوقعة.", "err");
      return;
    }

    renderResults(data);
    setStatus("تم استخراج البيانات وعرض النتائج ✅", "ok");
  } catch (e) {
    console.error(e);
    setStatus(`حدث خطأ: ${e?.message || e}`, "err");
  } finally {
    btnShow.disabled = false;
  }
});

// اول تحميل
clearUI();

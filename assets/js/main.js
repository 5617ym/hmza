console.log("MAIN_JS_VERSION = 3B_COMPARE_NORMALIZE_AND_2FILES_WITH_LASTNORMALIZED_2026-03-04");
console.log("main.js loaded ✅");

const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const btnShow = document.getElementById("btnShow");
const btnClear = document.getElementById("btnClear");
const statusEl = document.getElementById("status");
const resultsSection = document.getElementById("results");
const cardsEl = document.getElementById("cards");

const periodEl = document.getElementById("period");
const compareEl = document.getElementById("compare");

let selectedFiles = [];

function setStatus(msg, type = "info") {
  if (!statusEl) return;
  statusEl.textContent = msg || "";
  statusEl.className = "status";
  if (type === "ok") statusEl.classList.add("ok");
  if (type === "warn") statusEl.classList.add("warn");
  if (type === "err") statusEl.classList.add("err");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clearUI() {
  selectedFiles = [];
  if (fileInput) fileInput.value = "";
  if (fileListEl) fileListEl.innerHTML = "";
  if (cardsEl) cardsEl.innerHTML = "";
  resultsSection?.classList.add("hidden");
  if (btnShow) btnShow.disabled = true;
  setStatus("");

  // ✅ reset debug cache too
  window.lastAnalyzeA = null;
  window.lastAnalyzeB = null;
  window.lastNormalized = null;
  window.lastNormalizedPrev = null;
  window.lastUiSelection = null;
}

function renderSelectedFiles() {
  if (!fileListEl) return;

  if (!selectedFiles.length) {
    fileListEl.innerHTML = `<div>لم يتم اختيار أي ملف.</div>`;
    return;
  }

  fileListEl.innerHTML = selectedFiles
    .map((f) => {
      const size = Number(f.size || 0).toLocaleString();
      return `<div>${escapeHtml(f.name)} - ${size} bytes</div>`;
    })
    .join("");
}

async function safeJson(res) {
  const txt = await res.text().catch(() => "");
  if (!txt) return { ok: false, error: "Empty response body", status: res.status };
  try {
    return JSON.parse(txt);
  } catch (e) {
    return {
      ok: false,
      error: "Invalid JSON from server",
      status: res.status,
      raw: txt.slice(0, 1500),
    };
  }
}

/* ==============================================
   ✅ Normalize UI selections (period/compare)
   - period: annual | quarterly | ttm
   - compare: none | compare
   ============================================== */

function getUiSelection() {
  const periodRaw = (periodEl?.value || "").trim();

  let period = null;
  if (periodRaw) {
    const p = periodRaw.toLowerCase();
    if (p.includes("ربع") || p === "quarterly") period = "quarterly";
    else if (p.includes("سن") || p === "annual" || p === "yearly") period = "annual";
    else if (p.includes("12") || p.includes("ttm") || p.includes("آخر") || p.includes("اخر")) period = "ttm";
    else period = periodRaw;
  }

  const compareRaw = (compareEl?.value || "").trim();

  let compare = "none";
  if (compareRaw) {
    const c = compareRaw.toLowerCase();
    if (
      c.includes("بدون") ||
      c === "none" ||
      c === "no" ||
      c === "no_compare" ||
      c === "no-compare"
    ) {
      compare = "none";
    } else {
      compare = "compare";
    }
  }

  return { period, compare };
}

/* ==============================================
   🚀 Upload -> PUT -> Ingest -> (Auto Follow Next)
   ============================================== */

async function analyzeSingleFile(file, ui) {
  const r1 = await fetch("/api/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || "application/pdf",
      period: ui?.period || null,
      compare: ui?.compare || "none",
    }),
  });

  const j1 = await safeJson(r1);
  console.log("UPLOAD-URL:", j1);

  if (!r1.ok || !j1?.ok) {
    throw new Error(`upload-url failed: ${JSON.stringify(j1)}`);
  }
  if (!j1.uploadUrl || !j1.blobUrl) {
    throw new Error(`upload-url missing uploadUrl/blobUrl: ${JSON.stringify(j1)}`);
  }

  const put = await fetch(j1.uploadUrl, {
    method: "PUT",
    headers: {
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });

  if (!put.ok) {
    const t = await put.text().catch(() => "");
    throw new Error(`PUT failed: ${put.status} ${t}`);
  }

  const ingestBody = {
    fileName: file.name,
    blobUrl: j1.blobUrl,
    contentType: file.type || "application/pdf",
    period: ui?.period || null,
    compare: ui?.compare || "none",
  };

  const r2 = await fetch("/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ingestBody),
  });

  const j2 = await safeJson(r2);
  console.log("INGEST:", j2);

  if (!r2.ok || !j2?.ok) {
    throw new Error(`ingest failed: ${JSON.stringify(j2)}`);
  }

  if (j2?.next) {
    const nextUrl = j2.next;
    const payload = j2.payload || ingestBody;

    const r3 = await fetch(nextUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const j3 = await safeJson(r3);
    console.log("NEXT:", nextUrl, j3);

    if (!r3.ok || !j3?.ok) {
      throw new Error(`next(${nextUrl}) failed: ${JSON.stringify(j3)}`);
    }
    return j3;
  }

  return j2;
}

/* ==============================================
   🧠 Extract Financial (supports 1 file or 2 files)
   ============================================== */

async function extractFinancial(payload) {
  const r = await fetch("/api/extract-financial", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const j = await safeJson(r);
  console.log("EXTRACT-FINANCIAL:", j);

  if (!r.ok || !j?.ok) {
    throw new Error(`extract-financial failed: ${JSON.stringify(j)}`);
  }

  return j;
}

/* ==============================================
   ✅ Debug helpers for Console (IMPORTANT)
   بعد ما تضغط "عرض النتائج" تقدر تشغل:
   window.runBalanceDiag()
   window.runExtractAgain()
   ============================================== */

window.runBalanceDiag = async function () {
  const normA = window.lastNormalized;
  if (!normA) {
    console.warn("لا يوجد lastNormalized. اضغط (عرض النتائج) أولاً.");
    return;
  }

  const r = await fetch("/api/extract-financial?diag=1&target=balance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      normalized: normA,
      normalizedPrev: window.lastNormalizedPrev || null,
      period: window.lastUiSelection?.period || null,
      compare: window.lastUiSelection?.compare || "none",
    }),
  });

  const j = await safeJson(r);
  console.log("BALANCE-DIAG:", j);
  return j;
};

window.runExtractAgain = async function () {
  const normA = window.lastNormalized;
  if (!normA) {
    console.warn("لا يوجد lastNormalized. اضغط (عرض النتائج) أولاً.");
    return;
  }

  const payload = {
    normalized: normA,
    period: window.lastUiSelection?.period || null,
    compare: window.lastUiSelection?.compare || "none",
  };
  if (window.lastNormalizedPrev) payload.normalizedPrev = window.lastNormalizedPrev;

  const j = await extractFinancial(payload);
  console.log("EXTRACT-AGAIN:", j);
  return j;
};

/* ==============================================
   🎯 Events
   ============================================== */

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

btnClear?.addEventListener("click", clearUI);

btnShow?.addEventListener("click", async () => {
  if (!selectedFiles.length) {
    setStatus("اختر ملف أولاً.", "warn");
    return;
  }

  const ui = getUiSelection();
  window.lastUiSelection = ui; // ✅ cache

  if (ui.compare === "none" && selectedFiles.length > 1) {
    setStatus("تم اختيار أكثر من ملف مع (بدون مقارنة). سيتم تحليل أول ملف فقط.", "warn");
  }

  btnShow.disabled = true;
  setStatus("جاري رفع الملف ثم التحليل...", "info");

  try {
    resultsSection?.classList.remove("hidden");

    const dataA = await analyzeSingleFile(selectedFiles[0], ui);

    // ✅ cache for console diagnostics
    window.lastAnalyzeA = dataA;
    window.lastNormalized = dataA?.normalized || null;

    const pagesA = Number(dataA?.normalized?.meta?.pages || 0);
    const tablesA = Number(dataA?.normalized?.meta?.tables || 0);
    const textLengthA = Number(dataA?.normalized?.meta?.textLength || 0);
    const tablesPreviewCountA = Array.isArray(dataA?.normalized?.tablesPreview)
      ? dataA.normalized.tablesPreview.length
      : 0;

    let dataB = null;
    let pagesB = 0;
    let tablesB = 0;
    let textLengthB = 0;
    let tablesPreviewCountB = 0;

    if (ui.compare === "compare" && selectedFiles.length >= 2) {
      setStatus("تم تحليل الملف الأول ✅ — جاري تحليل الملف الثاني للمقارنة...", "info");
      dataB = await analyzeSingleFile(selectedFiles[1], ui);

      // ✅ cache for console diagnostics
      window.lastAnalyzeB = dataB;
      window.lastNormalizedPrev = dataB?.normalized || null;

      pagesB = Number(dataB?.normalized?.meta?.pages || 0);
      tablesB = Number(dataB?.normalized?.meta?.tables || 0);
      textLengthB = Number(dataB?.normalized?.meta?.textLength || 0);
      tablesPreviewCountB = Array.isArray(dataB?.normalized?.tablesPreview)
        ? dataB.normalized.tablesPreview.length
        : 0;
    } else {
      window.lastAnalyzeB = null;
      window.lastNormalizedPrev = null;
    }

    // ✅ حط تنبيه واضح إذا tablesPreview صفر (هذا سبب ranked:[])
    if (!tablesPreviewCountA) {
      console.warn("⚠️ normalized.tablesPreview = 0. هذا يعني extract-financial لن يجد الجداول.");
    }

    setStatus("تم التحليل ✅ — جاري استخراج البيانات المالية...", "info");

    const payload = {
      normalized: dataA?.normalized,
      period: ui.period,
      compare: ui.compare,
    };

    if (dataB?.normalized) {
      payload.normalizedPrev = dataB.normalized;
    }

    const fin = await extractFinancial(payload);
    const selectionInfo = fin?.financial?.selectionPolicy || null;

    cardsEl.innerHTML = `
      <div class="card">ملف 1 — الصفحات: <b>${pagesA}</b></div>
      <div class="card">ملف 1 — الجداول: <b>${tablesA}</b></div>
      <div class="card">ملف 1 — طول النص: <b>${textLengthA}</b></div>
      <div class="card">ملف 1 — tablesPreview: <b>${tablesPreviewCountA}</b></div>

      ${
        dataB
          ? `
      <div class="card">ملف 2 — الصفحات: <b>${pagesB}</b></div>
      <div class="card">ملف 2 — الجداول: <b>${tablesB}</b></div>
      <div class="card">ملف 2 — طول النص: <b>${textLengthB}</b></div>
      <div class="card">ملف 2 — tablesPreview: <b>${tablesPreviewCountB}</b></div>
      `
          : ""
      }

      <div class="card">
        <div class="muted small">اختيارك:</div>
        <pre class="small" style="white-space:pre-wrap;max-height:180px;overflow:auto;margin:8px 0 0;">${escapeHtml(
          JSON.stringify({ period: ui.period, compare: ui.compare, twoFiles: Boolean(dataB) }, null, 2)
        )}</pre>
      </div>

      <div class="card">
        <div class="muted small">Policy (من السيرفر):</div>
        <pre class="small" style="white-space:pre-wrap;max-height:180px;overflow:auto;margin:8px 0 0;">${escapeHtml(
          JSON.stringify(selectionInfo ?? {}, null, 2)
        )}</pre>
      </div>

      <div class="card">
        <div class="muted small">🧪 Debug سريع:</div>
        <pre class="small" style="white-space:pre-wrap;max-height:220px;overflow:auto;margin:8px 0 0;">${escapeHtml(
          JSON.stringify(
            {
              hasLastNormalized: Boolean(window.lastNormalized),
              hasLastNormalizedPrev: Boolean(window.lastNormalizedPrev),
              tip: "افتح Console ثم شغّل: window.runBalanceDiag()",
            },
            null,
            2
          )
        )}</pre>
      </div>

      <div class="card">
        <div class="muted small">Extract Financial (مختصر):</div>
        <pre class="small" style="white-space:pre-wrap;max-height:320px;overflow:auto;margin:8px 0 0;">${escapeHtml(
          JSON.stringify(fin?.financial?.incomeStatementLite ?? fin, null, 2).slice(0, 6000)
        )}</pre>
      </div>
    `;

    setStatus("تم استخراج البيانات المالية بنجاح ✅", "ok");
  } catch (e) {
    console.error(e);
    setStatus(`حدث خطأ: ${e.message}`, "err");
  } finally {
    btnShow.disabled = false;
  }
});

clearUI();

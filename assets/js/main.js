console.log("MAIN_JS_VERSION = 3B_EXTRACT_FINANCIAL_COMPARE_FIX_2026-03-03");
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
  return String(s ?? "")
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
   🚀 Upload -> PUT -> Ingest -> (Auto Follow Next)
   ============================================== */

async function analyzeSingleFile(file) {
  const period = periodEl?.value || null;
  const compare = compareEl?.value || null;

  // (A) upload-url
  const r1 = await fetch("/api/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || "application/pdf",
      period,
      compare,
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

  // (B) PUT to Azure Blob
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

  // (C) ingest
  const ingestBody = {
    fileName: file.name,
    blobUrl: j1.blobUrl,
    contentType: file.type || "application/pdf",
    period,
    compare,
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

  // (D) auto-follow next (analyze)
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
   🧠 Extract Financial (POST /api/extract-financial)
   - IMPORTANT: send compare/period so backend can decide noCompare
   ============================================== */

async function extractFinancialFromAnalyze(analyzeData) {
  const normalized = analyzeData?.normalized;
  if (!normalized || typeof normalized !== "object") {
    throw new Error("extract-financial يحتاج normalized من analyze، لكنه غير موجود.");
  }

  const period = periodEl?.value || null;
  const compare = compareEl?.value || null;

  const r = await fetch("/api/extract-financial", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      normalized,
      period,
      compare,
      // ملاحظة: diag/target اختيارية، لو ما تحتاجها احذفها من هنا
      diag: 0,
      target: "income",
    }),
  });

  const j = await safeJson(r);
  console.log("EXTRACT-FINANCIAL:", j);

  if (!r.ok || !j?.ok) {
    throw new Error(`extract-financial failed: ${JSON.stringify(j)}`);
  }

  return j;
}

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

btnClear?.addEventListener("click", () => clearUI());

btnShow?.addEventListener("click", async () => {
  if (!selectedFiles.length) {
    setStatus("اختر ملف أولاً.", "warn");
    return;
  }

  btnShow.disabled = true;
  setStatus("جاري رفع الملف ثم التحليل عبر ingest...", "info");

  try {
    // 1) Analyze عبر ingest router
    const data = await analyzeSingleFile(selectedFiles[0]);
    resultsSection?.classList.remove("hidden");

    const pages = Number(data?.normalized?.meta?.pages || 0);
    const tables = Number(data?.normalized?.meta?.tables || 0);
    const textLength = Number(data?.normalized?.meta?.textLength || 0);

    // 2) Extract Financial
    setStatus("تم التحليل ✅ — جاري استخراج قائمة الدخل...", "info");
    const fin = await extractFinancialFromAnalyze(data);

    const picked = fin?.financial?.pickedColumns || fin?.pickedColumns || null;
    const policy = fin?.financial?.selectionPolicy || fin?.selectionPolicy || null;
    const income = fin?.financial?.incomeStatementLite || fin?.incomeStatementLite || null;

    const revenueCur = income?.revenue?.current ?? null;
    const revenuePrev = income?.revenue?.previous ?? null;

    cardsEl.innerHTML = `
      <div class="card">عدد الصفحات: <b>${pages}</b></div>
      <div class="card">عدد الجداول: <b>${tables}</b></div>
      <div class="card">طول النص: <b>${textLength}</b></div>

      <div class="card">
        <div class="muted small">Policy / Picked Columns:</div>
        <pre class="small" style="white-space:pre-wrap;max-height:220px;overflow:auto;margin:8px 0 0;">${escapeHtml(
          JSON.stringify({ policy, picked }, null, 2)
        )}</pre>
      </div>

      <div class="card">
        <div class="muted small">Income (Revenue):</div>
        <pre class="small" style="white-space:pre-wrap;max-height:220px;overflow:auto;margin:8px 0 0;">${escapeHtml(
          JSON.stringify({ current: revenueCur, previous: revenuePrev }, null, 2)
        )}</pre>
      </div>

      <div class="card">
        <div class="muted small">Extract Financial (Raw) مختصر:</div>
        <pre class="small" style="white-space:pre-wrap;max-height:260px;overflow:auto;margin:8px 0 0;">${escapeHtml(
          JSON.stringify(fin, null, 2).slice(0, 3000)
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

console.log("MAIN_JS_VERSION = 2B_INGEST_ROUTER_PLUS_EXTRACT_2026-03-02_FIXED");
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
  const r1 = await fetch("/api/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || "application/pdf",
      period: periodEl?.value || null,
      compare: compareEl?.value || null,
    }),
  });

  const j1 = await safeJson(r1);
  if (!r1.ok || !j1?.ok) {
    throw new Error(`upload-url failed: ${JSON.stringify(j1)}`);
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
    period: periodEl?.value || null,
    compare: compareEl?.value || null,
  };

  const r2 = await fetch("/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ingestBody),
  });

  const j2 = await safeJson(r2);
  if (!r2.ok || !j2?.ok) {
    throw new Error(`ingest failed: ${JSON.stringify(j2)}`);
  }

  if (j2?.next) {
    const r3 = await fetch(j2.next, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(j2.payload || ingestBody),
    });

    const j3 = await safeJson(r3);
    if (!r3.ok || !j3?.ok) {
      throw new Error(`next failed: ${JSON.stringify(j3)}`);
    }
    return j3;
  }

  return j2;
}

/* ==============================================
   🧠 Extract Financial
   ============================================== */

async function extractFinancialFromAnalyze(analyzeData) {
  const normalized = analyzeData?.normalized;

  if (!normalized || typeof normalized !== "object") {
    throw new Error("extract-financial يحتاج normalized من analyze.");
  }

  const r = await fetch("/api/extract-financial", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ normalized, diag: 1, target: "balance" }),
  });

  const j = await safeJson(r);

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

btnClear?.addEventListener("click", clearUI);

btnShow?.addEventListener("click", async () => {
  if (!selectedFiles.length) {
    setStatus("اختر ملف أولاً.", "warn");
    return;
  }

  btnShow.disabled = true;
  setStatus("جاري رفع الملف ثم التحليل...", "info");

  try {
    const data = await analyzeSingleFile(selectedFiles[0]);
    resultsSection?.classList.remove("hidden");

    const pages = Number(data?.normalized?.meta?.pages || 0);
    const tables = Number(data?.normalized?.meta?.tables || 0);
    const textLength = Number(data?.normalized?.meta?.textLength || 0);

    setStatus("تم التحليل — جاري استخراج البيانات المالية...", "info");
    const fin = await extractFinancialFromAnalyze(data);

    cardsEl.innerHTML = `
      <div class="card">عدد الصفحات: <b>${pages}</b></div>
      <div class="card">عدد الجداول: <b>${tables}</b></div>
      <div class="card">طول النص: <b>${textLength}</b></div>
      <div class="card">
        <pre style="white-space:pre-wrap;max-height:300px;overflow:auto;">
${escapeHtml(JSON.stringify(fin, null, 2))}
        </pre>
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

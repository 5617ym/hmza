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
    .map((f) => `<div>${f.name} - ${f.size.toLocaleString()} bytes</div>`)
    .join("");
}

async function safeJson(res) {
  const txt = await res.text().catch(() => "");
  if (!txt) return { ok: false, error: "Empty response body" };
  try {
    return JSON.parse(txt);
  } catch (e) {
    return { ok: false, error: "Invalid JSON from server", raw: txt.slice(0, 1500) };
  }
}

/* ==============================================
   🚀  Upload → PUT → Analyze (مباشرة)
   ============================================== */

async function analyzeSingleFile(file) {
  // (A) طلب uploadUrl + blobUrl
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
  console.log("UPLOAD-URL:", j1);

  if (!r1.ok || !j1?.ok) {
    throw new Error(`upload-url failed: ${JSON.stringify(j1)}`);
  }

  if (!j1.uploadUrl || !j1.blobUrl) {
    throw new Error(`upload-url missing uploadUrl/blobUrl: ${JSON.stringify(j1)}`);
  }

  // (B) رفع الملف إلى Azure Blob
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

  // (C) تحليل الملف عبر blobUrl
  const r2 = await fetch("/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      blobUrl: j1.blobUrl,
      // (اختياري) نرسل نوع الملف لو احتجته في السيرفر
      contentType: file.type || "",
      period: periodEl?.value || null,
      compare: compareEl?.value || null,
    }),
  });

  const j2 = await safeJson(r2);
  console.log("ANALYZE:", j2);

  if (!r2.ok || !j2?.ok) {
    throw new Error(`analyze failed: ${JSON.stringify(j2)}`);
  }

  return j2;
}

/* ==============================================
   🎯  Events
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

btnClear?.addEventListener("click", () => {
  clearUI();
});

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

    const pages = data.pages ?? data.pageCount ?? 0;
    const tables = data.tables ?? data.tableCount ?? 0;
    const textLength = data.textLength ?? (data.text ? data.text.length : 0);

    cardsEl.innerHTML = `
      <div class="card">عدد الصفحات: <b>${pages}</b></div>
      <div class="card">عدد الجداول: <b>${tables}</b></div>
      <div class="card">طول النص: <b>${textLength}</b></div>
      <div class="card"><div class="muted small">Raw JSON (مختصر):</div>
        <pre class="small" style="white-space:pre-wrap;max-height:220px;overflow:auto;margin:8px 0 0;">${escapeHtml(JSON.stringify(data, null, 2).slice(0, 2500))}</pre>
      </div>
    `;

    setStatus("تم استخراج البيانات بنجاح ✅", "ok");
  } catch (e) {
    console.error(e);
    setStatus(`حدث خطأ: ${e.message}`, "err");
  } finally {
    btnShow.disabled = false;
  }
});

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

clearUI();

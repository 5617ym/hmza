const fileInput = document.getElementById("fileInput");
const btnShow = document.getElementById("btnShow");
const btnClear = document.getElementById("btnClear");
const btnSample = document.getElementById("btnSample");
const fileList = document.getElementById("fileList");

let selectedFiles = [];

function renderFiles() {
  if (!fileList) return;

  if (selectedFiles.length === 0) {
    fileList.innerHTML = `<p class="muted small">لم يتم اختيار أي ملف.</p>`;
    return;
  }

  fileList.innerHTML = selectedFiles.map(f => {
    const sizeKB = (f.size / 1024).toFixed(1);
    return `
      <div class="file-item">
        <strong>${f.name}</strong>
        <div class="muted small">النوع: ${f.type || "غير معروف"} — الحجم: ${sizeKB} KB</div>
      </div>
    `;
  }).join("");
}

fileInput?.addEventListener("change", () => {
  selectedFiles = Array.from(fileInput.files || []);
  renderFiles();
});

btnShow?.addEventListener("click", () => {
  if (selectedFiles.length === 0) {
    alert("⚠️ اختر ملف أولاً");
    return;
  }
  alert("✅ تم رفع الملفات (حالياً عرض أسماء الملفات فقط). الخطوة القادمة: تحليل CSV/Excel.");
});

btnClear?.addEventListener("click", () => {
  if (fileInput) fileInput.value = "";
  selectedFiles = [];
  renderFiles();
});

btnSample?.addEventListener("click", () => {
  const csv = [
    "Year,NetProfit,OperatingCashFlow",
    "2022,100,120",
    "2023,110,105",
    "2024,130,150"
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "wasla_sample.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
});

renderFiles();

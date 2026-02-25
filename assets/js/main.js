(function () {
  const fileInput = document.getElementById("fileInput");
  const fileList = document.getElementById("fileList");
  const btnClear = document.getElementById("btnClear");
  const btnShow = document.getElementById("btnShow");
  const status = document.getElementById("status");

  const results = document.getElementById("results");
  const cards = document.getElementById("cards");

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  }

  function detectType(file) {
    const name = (file.name || "").toLowerCase();
    const type = (file.type || "").toLowerCase();

    if (type.includes("pdf") || name.endsWith(".pdf")) return "PDF";
    if (type.includes("spreadsheet") || name.endsWith(".xlsx") || name.endsWith(".xls")) return "Excel";
    if (type.includes("csv") || name.endsWith(".csv")) return "CSV";
    if (type.includes("word") || name.endsWith(".doc") || name.endsWith(".docx")) return "Word";
    if (type.startsWith("image/") || /\.(png|jpg|jpeg|webp|gif)$/i.test(name)) return "صورة";
    return "ملف";
  }

  function renderFileList(files) {
    fileList.innerHTML = "";
    if (!files || files.length === 0) {
      status.textContent = "لم يتم اختيار أي ملفات.";
      btnShow.disabled = true;
      results.classList.add("hidden");
      return;
    }

    status.textContent = `تم اختيار ${files.length} ملف/ملفات. الآن اضغط "عرض النتائج" للانتقال للخطوة التالية.`;
    btnShow.disabled = false;

    [...files].forEach((f) => {
      const item = document.createElement("div");
      item.className = "file-item";

      const left = document.createElement("div");
      left.className = "file-left";

      const name = document.createElement("div");
      name.className = "file-name";
      name.textContent = f.name;

      const meta = document.createElement("div");
      meta.className = "file-meta";
      meta.textContent = `${detectType(f)} • ${formatBytes(f.size)}${f.type ? " • " + f.type : ""}`;

      left.appendChild(name);
      left.appendChild(meta);

      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "جاهز";

      item.appendChild(left);
      item.appendChild(tag);

      fileList.appendChild(item);
    });
  }

  function showResults(files) {
    results.classList.remove("hidden");
    cards.innerHTML = "";

    // حاليا: فقط بطاقات “تم استلام الملفات”
    const card1 = document.createElement("div");
    card1.className = "card";
    card1.innerHTML = `
      <div style="font-weight:800; margin-bottom:6px;">تم استلام الملفات</div>
      <div class="muted">عدد الملفات: ${files.length}</div>
      <div class="muted">الخطوة القادمة: استخراج البيانات حسب نوع الملف (PDF / Excel / CSV / صور)</div>
    `;
    cards.appendChild(card1);

    const kinds = {};
    [...files].forEach((f) => {
      const k = detectType(f);
      kinds[k] = (kinds[k] || 0) + 1;
    });

    const card2 = document.createElement("div");
    card2.className = "card";
    card2.innerHTML = `
      <div style="font-weight:800; margin-bottom:6px;">توزيع الأنواع</div>
      <div class="muted">${Object.entries(kinds).map(([k,v]) => `${k}: ${v}`).join("<br>")}</div>
    `;
    cards.appendChild(card2);

    const card3 = document.createElement("div");
    card3.className = "card";
    card3.innerHTML = `
      <div style="font-weight:800; margin-bottom:6px;">مهم</div>
      <div class="muted">اختر أي ملف عندك الآن (حتى لو صورة لقائمة مالية أو PDF). بعد الرفع قلّي نوع الملف وسأضيف قارئه داخل الموقع خطوة بخطوة.</div>
    `;
    cards.appendChild(card3);
  }

  // Events
  fileInput.addEventListener("change", () => {
    renderFileList(fileInput.files);
  });

  btnClear.addEventListener("click", () => {
    fileInput.value = "";
    renderFileList([]);
  });

  btnShow.addEventListener("click", () => {
    const files = fileInput.files;
    if (!files || files.length === 0) {
      status.textContent = "ارفع ملف واحد على الأقل.";
      return;
    }
    showResults(files);
  });

  // Initial
  renderFileList([]);
})();

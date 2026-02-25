const fileInput = document.getElementById("fileInput");
const fileHint = document.getElementById("fileHint");
const btnShow = document.getElementById("btnShow");
const btnClear = document.getElementById("btnClear");
const results = document.getElementById("results");

function updateFileHint() {
  const files = fileInput.files;
  if (!files || files.length === 0) {
    fileHint.textContent = "لم يتم اختيار أي ملف";
    return;
  }
  if (files.length === 1) {
    fileHint.textContent = `تم اختيار: ${files[0].name}`;
  } else {
    fileHint.textContent = `تم اختيار ${files.length} ملفات`;
  }
}

fileInput.addEventListener("change", updateFileHint);

btnShow.addEventListener("click", () => {
  // إذا ما فيه ملفات، برضه نعرض النتائج (حسب رغبتك لاحقًا ممكن نجبر الرفع)
  results.classList.remove("hidden");
  // ننزل المستخدم تلقائياً للنتائج
  results.scrollIntoView({ behavior: "smooth", block: "start" });
});

btnClear.addEventListener("click", () => {
  fileInput.value = "";
  updateFileHint();
  results.classList.add("hidden");
});

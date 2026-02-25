console.log("main.js loaded ✅");

const fileInput = document.getElementById("fileInput");
const btnShow = document.getElementById("btnShow");

btnShow.addEventListener("click", async () => {
  const file = fileInput.files[0];

  if (!file) {
    alert("اختر ملف أولاً");
    return;
  }

  const reader = new FileReader();

  reader.onload = async function () {
    const base64 = reader.result;

    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fileName: file.name,
        fileBase64: base64,
      }),
    });

    const result = await response.json();

    console.log(result);

    alert(JSON.stringify(result, null, 2));
  };

  reader.readAsDataURL(file);
});

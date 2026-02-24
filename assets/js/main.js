const fileInput = document.getElementById("fileInput");
const fileList = document.getElementById("fileList");
const btnStart = document.getElementById("btnStart");
const dashboard = document.getElementById("dashboard");

let uploadedFiles = [];

fileInput.addEventListener("change", (e)=>{
  uploadedFiles = Array.from(e.target.files);
  renderFiles();
});

function renderFiles(){
  fileList.innerHTML = "";

  if(!uploadedFiles.length){
    btnStart.disabled = true;
    return;
  }

  uploadedFiles.forEach(f=>{
    const div = document.createElement("div");
    div.style.marginTop = "8px";
    div.textContent = f.name;
    fileList.appendChild(div);
  });

  btnStart.disabled = false;
}

btnStart.addEventListener("click", ()=>{
  dashboard.classList.remove("is-hidden");
});

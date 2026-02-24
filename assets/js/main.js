function analyze() {

    let profit = parseFloat(document.getElementById("netProfit").value);
    let cash = parseFloat(document.getElementById("cashFlow").value);

    if (!profit || !cash) {
        document.getElementById("result").innerHTML = "⚠️ أدخل القيم أولاً";
        return;
    }

    let ratio = ((cash / profit) * 100).toFixed(1);

    let resultBox = document.getElementById("result");

    if (ratio >= 100) {
        resultBox.innerHTML = `<span class="good">جودة ربح ممتازة ⭐⭐⭐⭐<br>نسبة التحويل: ${ratio}%</span>`;
    }
    else if (ratio >= 80) {
        resultBox.innerHTML = `<span class="medium">جودة جيدة ⭐⭐⭐<br>نسبة التحويل: ${ratio}%</span>`;
    }
    else {
        resultBox.innerHTML = `<span class="bad">تحذير: جودة ضعيفة ⭐⭐<br>نسبة التحويل: ${ratio}%</span>`;
    }
}


// ربط الزر بالوظيفة
document.getElementById("analyzeBtn").addEventListener("click", analyze);

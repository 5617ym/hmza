PROJECT_STATE.md

PROJECT:
Financial Statement Extraction Engine

LAST_UPDATE:
2026-03-17

CURRENT_ENGINE_VERSION:
extract-financial-v7.6

CURRENT_PHASE:
PHASE 5 – Financial Statement Intelligence Layer

CURRENT_TASK:
معالجة جودة استخراج البنود (Line Items)
وحل مشكلة فقدان الـ Labels في القوائم المالية
مع الحفاظ على استقرار Input Resolution و Ranking

بعد اختبار جديد على:

almarai-layout.json

تم الوصول إلى نتائج مهمة جدًا:

Input Resolution يعمل بثبات 100%

meta.pages و meta.tables تُقرأ بشكل صحيح

selectedPages صحيحة:

incomePage = 10

balancePage = 9

cashFlowPage = 4

Ranking يعمل بشكل دقيق

النظام يختار القوائم الصحيحة بصريًا

Balance extraction يعمل بشكل جيد

Income extraction يعمل جزئيًا (الأرقام صحيحة)

Cash Flow page تم اختيارها لكن extraction فشل

لكن ظهرت مشكلة أساسية:

🔴 المشكلة الجوهرية الجديدة
1️⃣ Label Corruption (تشوه اللابل)

النظام يستخرج:

"بآلاف"

"إيضاحات"

"للسنة"

بدل:

إيرادات

تكلفة الإيرادات

مجمل الربح

...

السبب:

الـ payload لا يحتوي labels نظيفة داخل الجداول
والنظام يعتمد بشكل زائد على:

page_text_nearby

مما يؤدي إلى التقاط:

header text

column titles

unit labels

بدل financial line items

2️⃣ Cash Flow Extraction Failure

رغم:

cashFlowPage = 4 (صحيح)

إلا أن:

financialRows.cashflow = []

السبب:

فشل collectNumericRows في التقاط الصفوف

أو رفضها داخل isAcceptableFinancialLabel

أو ضعف الربط بين rows و labels

🟢 ما تم إثباته

هذه نقطة مهمة جدًا:

✔ المشكلة ليست في Azure
✔ ليست في parsing
✔ ليست في ranking

👉 المشكلة الآن في:

Post-Processing Intelligence Layer

التركيز الحالي أصبح على:

إصلاح استخراج labels من داخل الجداول نفسها

تقليل الاعتماد على page_text

تحسين:

repairMissingLabelsFromPageText

تحسين:

isAcceptableFinancialLabel

ليميز بين:

✔ Financial labels
❌ Headers / Notes / Units

تحسين:

Row → Label mapping

إصلاح Cash Flow row extraction
بدون كسر الحمايات السابقة

🔧 التحسينات المطلوبة (Current Engineering Focus)

1️⃣ تحسين Label Source Priority

بدلاً من:

page_text → table

يصبح:

table → nearby text (fallback فقط)

2️⃣ Label Cleaning Layer

إضافة فلترة لإزالة:

"بآلاف"

"إيضاحات"

"للسنة"

"ريال سعودي"

قبل قبول label

3️⃣ Strengthening isAcceptableFinancialLabel

إضافة:

blacklist للكلمات غير المالية

minimum semantic length

رفض labels الرقمية أو القصيرة جدًا

4️⃣ Cash Flow Extraction Hardening

تحسين:

collectNumericRows

detectRowStructure

الربط بين الأرقام والصفوف الفعلية

5️⃣ Diagnostic Upgrade

توسيع:

missingLabelDiagnostics

ليوضح:

هل اللابل من header

هل من unit row

هل من note column

CURRENT_STATUS

النظام الآن:

✔ يقرأ البيانات بدقة
✔ يحدد الصفحات بدقة
✔ يفهم القطاع
✔ يبني pageContexts
✔ ينجح في Balance extraction

لكن:

✖ Income labels غير موثوقة
✖ Cash Flow extraction غير مكتمل
✖ الاعتماد على page_text عالي جدًا

NEXT STEP

الخطوة القادمة:

تحسين طبقة استخراج البنود (Line Items Intelligence)

الهدف:

استخراج labels حقيقية من الجداول

ربط كل رقم بالبند الصحيح

تقليل الضوضاء من headers

ثم:

إعادة اختبار على:

المراعي

جاهز

مصرف

REIT

DEFINITION OF DONE (Updated)

تعتبر المرحلة مكتملة عندما يصبح النظام قادرًا على:

استخراج labels صحيحة (إيرادات، تكلفة، ...)

تجاهل headers و units بالكامل

ربط الأرقام بالبند الصحيح

استخراج Income و Balance بشكل كامل

استخراج Cash Flow عند توفر بيانات فعلية

الاستمرار في رفض النتائج الخاطئة

الحفاظ على استقرار Input Resolution و Ranking

KNOWN RULE

لا يتم تغيير المعمارية العامة

أي تحسين يكون:

Layer فوق النظام الحالي

التركيز الحالي:

Intelligence > Parsing

Accuracy > Coverage

Honesty > Fake Results

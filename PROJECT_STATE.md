# PROJECT_STATE.md

PROJECT:
Financial Statement Extraction Engine

LAST_UPDATE:
2026-03-12

CURRENT_ENGINE_VERSION:
extract-financial-v6.5

CURRENT_PHASE:
4B – Extraction Engine Hardening

---

## PHASE HISTORY

PHASE 4A
Multi-Sector Validation Completed

تم اختبار النظام بنجاح على قطاعات متعددة للتأكد من قدرة
محرك استخراج القوائم المالية على التعامل مع اختلاف
هياكل التقارير المالية.

القطاعات التي تم اختبارها:

1. شركة تشغيلية عربية
2. شركة تشغيلية إنجليزية
3. بنك عربي
4. بنك إنجليزي
5. شركة تأمين
6. صندوق REIT
7. شركة صناعية

الشركات المستخدمة في الاختبار:

* جاهز (تشغيلية عربية)
* المراعي (تشغيلية إنجليزية)
* مصرف الإنماء (بنك عربي)
* مصرف الراجحي (بنك إنجليزي)
* التعاونية للتأمين
* صندوق جدوى ريت
* شركة المتقدمة للبتروكيماويات

النتيجة:

النظام نجح في اكتشاف صفحات:

Balance Sheet
Income Statement
Cash Flow Statement

ودعم:

العربية
الإنجليزية
تقارير IFRS
تقارير السوق السعودي

STATUS:
Stable

---

## CURRENT PHASE

PHASE 4B
Extraction Engine Hardening

هدف هذه المرحلة:

إعادة بناء وتحسين محرك extract-financial
ليكون أكثر استقرارًا مع اختلاف هياكل الجداول
في التقارير المالية الواقعية.

تم تنفيذ تحسينات متدرجة على المحرك في الإصدارات:

v5.4
v5.9
v6.0
v6.1
v6.2
v6.3
v6.4
v6.5

---

## SYSTEM PIPELINE

المسار الكامل للنظام:

upload-url
→ ingest
→ analyze (Azure Document Intelligence - prebuilt-layout)
→ extract-financial

جميع المراحل تعمل بشكل مستقر.

---

## ENGINE CAPABILITIES

المحرك الحالي يقوم بالمهام التالية:

1. Statement Profile Detection

تحديد نوع الشركة باستخدام تحليل الكلمات المفتاحية.

الأنواع المدعومة:

bank
insurance
reit
operating_company

2. Statement Page Detection

اكتشاف صفحات القوائم المالية باستخدام نظام Ranking
يعتمد على:

statement titles
structure keywords
numeric density
header detection
page order
page guardrails

3. Table Structure Detection

تحليل الجداول لاكتشاف:

currentCol
previousCol
noteCol
labelCol
headerRowIndex
table direction
distinct label-column detection

4. Row Extraction

استخراج الصفوف من الجداول مع تطبيق
طبقة تحقق (Row Validation) لمنع استخراج:

header rows
separator rows
narrative rows
date rows
ownership rows

5. Guarded Recovery

تمت إضافة guarded template recovery
بحيث لا يتم السماح للصفوف الرقمية غير الموسومة
بإغراق المخرجات كما كان يحدث سابقًا.

6. Multi-page Protection

تم تشديد التحقق قبل ضم الصفحة التالية
لنفس الجدول باستخدام توافق البنية والاتجاه
والأعمدة والسنوات.

7. Data Output

يتم إنشاء نوعين من المخرجات:

Lite Structure

incomeStatementLite
balanceSheetLite
cashFlowLite

Structured Fields

incomeStatementStructured
balanceSheetStructured
cashFlowStructured

---

## LATEST TEST (BANK PROFILE)

تم اختبار الإصدار v6.2 باستخدام:

Saudi National Bank (SNB)

نتيجة المحرك:

statementProfile = bank

selectedPages:

balancePage = 95
incomePage = 96
cashFlowPage = 66

إحصائيات الاستخراج:

income:
accepted = 25
rejected = 4
recoveredNumericRows = 0
realLabelAcceptedRows = 25
outputItems = 24

balance:
accepted = 25
rejected = 4
recoveredNumericRows = 0
realLabelAcceptedRows = 25
outputItems = 24

cashflow:
accepted = 30
rejected = 5
recoveredNumericRows = 0
realLabelAcceptedRows = 30
outputItems = 11

---

## LATEST TEST (OPERATING COMPANY)

تم إجراء اختبار إضافي على شركة تشغيلية عربية
باستخدام تقرير مالي حقيقي.

statementProfile:

operating_company

selectedPages detected by engine:

incomePage = 10
balancePage = 7
cashFlowPage = 54

الصفحات الصحيحة في التقرير كانت:

balance sheet → page 7
income statement → page 8
cash flow statement → page 10

نتيجة الاختبار:

balancePage تم اكتشافها بشكل صحيح.

لكن:

incomePage تم اختيار صفحة التدفقات بدلًا من
قائمة الدخل.

cashFlowPage تم اختيار صفحة إيضاحية متأخرة
بدلًا من قائمة التدفقات النقدية الأساسية.

---

## LATEST RESULT

تم حل المشكلة السابقة الخاصة بـ Row Extraction Failure.

لم تعد المشكلة الحالية في:

* اكتشاف profile
* أو اكتشاف الأعمدة
* أو fallback/recovery
* أو ownership tables

التحسن الواضح:

1. لم يعد هناك flood من الصفوف المسترجعة بالقالب
2. realLabelAcceptedRows أصبح مرتفعًا
3. extraction layer أصبحت تعمل فعليًا
4. distinct label-column detection خفف من فوز
   الجداول RTL العامة ذات 3 أعمدة

---

## CURRENT PROBLEM

Semantic Page Selection Failure

المشكلة الحالية لم تعد في استخراج الصفوف،
بل أصبحت في اختيار الصفحة الصحيحة دلاليًا.

المحرك ينجح الآن في استخراج الصفوف من الصفحة المختارة،
لكن في بعض الحالات يختار صفحات إيضاحية رقمية قوية
وليست القوائم المالية الأساسية نفسها.

---

## ROOT CAUSE

السبب الجذري الآن هو:

Ranking Semantic Guardrails Gap

بمعنى أن نظام الترتيب الحالي ما زال يعطي درجات
مرتفعة لصفحات إيضاحية متقدمة لأنها تحتوي على:

* أرقام كثيرة
* أعمدة واضحة
* label column حقيقي
* كلمات مالية قوية

لكنها ليست القوائم الأساسية المطلوبة.

بالتالي أصبح الخلل الحالي في:

Page Ranking Semantics

وليس في Row Extraction.

---

## WHAT HAS BEEN FIXED IN 4B

تم إنجاز ما يلي داخل هذه المرحلة:

1. RTL label detection improved
2. row-level label fallback added
3. guarded template recovery added
4. stronger multi-page extension guard added
5. ownership-page detection added
6. ownership-row rejection added
7. distinct label-column guardrail added
8. semantic ranking signals added
9. truncated RTL cashflow detection added
10. dense-table protection logic added

هذا يعني أن البنية الحالية أصبحت أقوى بكثير
من مرحلة v5.3، ولم يعد الخلل في الطبقات الدنيا
للاستخراج.

---

## REMAINING WORK TO FINISH 4B

المتبقي الآن هو تحسين ranking فقط.

المطلوب في الإصدار القادم:

extract-financial-v6.6

التحسينات المخطط لها:

1. Core Statement Boost

إعطاء boost قوي جدًا فقط للصفحات التي تحتوي
على بنية statement حقيقية.

2. Note-Table Penalty

إضافة penalty واضح للصفحات الإيضاحية التي تحتوي
على جداول مخاطر، فجوات، صكوك، سندات، قروض مصدرة،
عوائد ثابتة/متغيرة، أو جداول تفصيل أدوات مالية.

3. Mandatory Core Anchors

عدم السماح بفوز صفحة balance / income / cashflow
إلا إذا احتوت anchors أساسية كافية لكل نوع statement.

4. Better Year Logic

تحسين التعامل مع الحالات التي يظهر فيها:

latest = previous

أو عندما تكون السنوات المستخرجة غير ممثلة
لرأسي الأعمدة الفعلية للقائمة.

5. Stronger Late-Note Rejection

تشديد رفض الصفحات المتأخرة التي تبدو كإيضاحات
حتى لو كانت غنية بالأرقام وذات label column صحيح.

---

## CURRENT STATUS

Architecture: Stable
Pipeline: Stable
Statement Profile Detection: Stable
Header / Column Detection: Strong
Row Extraction: Strong
Guarded Recovery: Stable
Ownership Guardrails: Stable

Ranking Engine:
Needs Semantic Hardening

---

## PROJECT STATUS

STABLE ARCHITECTURE
EXTRACTION ENGINE HARDENING IN PROGRESS

CURRENT ASSESSMENT:

تم تجاوز مشكلة الاستخراج الأساسية،
والمشكلة المتبقية الآن محصورة في
Semantic Page Ranking.

PHASE COMPLETION ESTIMATE:

حوالي **80% إلى 85%** من المرحلة 4B تم إنجازه.

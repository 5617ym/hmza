# PROJECT_STATE.md

PROJECT:
Financial Statement Extraction Engine

LAST_UPDATE:
2026-03-10

CURRENT_ENGINE_VERSION:
extract-financial-v5.3

CURRENT_PHASE:
4B – Extraction Engine Hardening


------------------------------------------------------------
PHASE HISTORY
------------------------------------------------------------

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

- جاهز (تشغيلية عربية)
- المراعي (تشغيلية إنجليزية)
- مصرف الإنماء (بنك عربي)
- مصرف الراجحي (بنك إنجليزي)
- التعاونية للتأمين
- صندوق جدوى ريت
- شركة المتقدمة للبتروكيماويات

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


------------------------------------------------------------
CURRENT PHASE
------------------------------------------------------------

PHASE 4B
Extraction Engine Hardening

هدف هذه المرحلة:

إعادة بناء وتحسين محرك extract-financial
ليكون أكثر استقرارًا مع اختلاف هياكل الجداول
في التقارير المالية الواقعية.

تم تنفيذ عدة تحسينات على المحرك في الإصدارات:

v5.2  
v5.3


------------------------------------------------------------
SYSTEM PIPELINE
------------------------------------------------------------

المسار الكامل للنظام:

upload-url  
→ ingest  
→ analyze (Azure Document Intelligence - prebuilt-layout)  
→ extract-financial

جميع المراحل تعمل بشكل مستقر.


------------------------------------------------------------
ENGINE CAPABILITIES
------------------------------------------------------------

المحرك الحالي يقوم بالمهام التالية:

1) Statement Profile Detection

تحديد نوع الشركة باستخدام تحليل الكلمات المفتاحية.

الأنواع المدعومة:

bank  
insurance  
reit  
operating_company


2) Statement Page Detection

اكتشاف صفحات القوائم المالية باستخدام نظام Ranking
يعتمد على:

statement titles  
structure keywords  
numeric density  
header detection  
page order


3) Table Structure Detection

تحليل الجداول لاكتشاف:

currentCol  
previousCol  
noteCol  
labelCol  
headerRowIndex  


4) Row Extraction

استخراج الصفوف من الجداول مع تطبيق
طبقة تحقق (Row Validation) لمنع استخراج:

header rows  
separator rows  
narrative rows  
date rows  


5) Data Output

يتم إنشاء نوعين من المخرجات:

Lite Structure

incomeStatementLite  
balanceSheetLite  
cashFlowLite  


Structured Fields

incomeStatementStructured  
balanceSheetStructured  
cashFlowStructured  


------------------------------------------------------------
LATEST TEST
------------------------------------------------------------

تم اختبار الإصدار v5.3 باستخدام:

Saudi National Bank (SNB)

نتيجة اختيار الصفحات:

balancePage = 8  
incomePage = 9  
cashFlowPage = 12  

اكتشاف الصفحات يعمل بشكل صحيح.


------------------------------------------------------------
CURRENT PROBLEM
------------------------------------------------------------

Row Extraction Failure

نتيجة الاستخراج:

acceptedRowsCount = 0  
rejectedRowsCount = 61  

أغلب الصفوف تم رفضها بسبب:

reason = "no_label"


مثال صف مرفوض:

42,119,698 | 44,923,237 | 4


------------------------------------------------------------
ROOT CAUSE
------------------------------------------------------------

السبب الرئيسي هو ترتيب الأعمدة في الجداول العربية.

في التقارير العربية غالبًا يكون ترتيب الأعمدة:

2024 | 2025 | Note | Label

أو

Value | Value | Note | Label


بينما المحرك يفترض غالبًا:

Label | Note | Value | Value


لذلك يفشل المحرك في اكتشاف عمود الوصف (label)
ويتم رفض الصف بسبب عدم وجود label.


------------------------------------------------------------
SECONDARY ISSUE
------------------------------------------------------------

Multi-page Table Extension

في بعض الحالات يقوم المحرك بدمج الصفحة التالية
كجزء من نفس الجدول بدون تحقق كافٍ.

مثال:

tablesUsed = 2  
sourcePages = [8,9]

وقد تكون الصفحة الثانية قائمة مختلفة.


------------------------------------------------------------
NEXT STEP
------------------------------------------------------------

الإصدار القادم:

extract-financial-v5.4

التحسينات المخطط لها:

1) RTL Label Detection

تفضيل العمود النصي الأخير كـ label
في الجداول العربية.


2) Row-Level Label Fallback

عند فشل اكتشاف label من header
يتم البحث داخل الصف من اليمين إلى اليسار
عن أول خلية نصية صالحة.


3) Stronger Multi-Page Guard

منع تمديد الجدول إلى صفحة أخرى
إلا إذا كانت بنية الجدول متطابقة.


4) Improved Row Validation

تحسين قواعد منع الصفوف غير المالية.


------------------------------------------------------------
CURRENT STATUS
------------------------------------------------------------

Page Detection: Stable  
Statement Profile Detection: Stable  
Ranking Engine: Stable  
Structured Mapping: Stable  

Row Extraction:
Needs RTL Fix


------------------------------------------------------------
PROJECT STATUS
------------------------------------------------------------

STABLE ARCHITECTURE  
EXTRACTION ENGINE HARDENING IN PROGRESS

PROJECT_STATE.md

PROJECT:
Financial Statement Extraction Engine

LAST_UPDATE:
2026-03-14

CURRENT_ENGINE_VERSION:
extract-financial-v6.8

CURRENT_PHASE:
PHASE 5 – Financial Statement Intelligence Layer

CURRENT_TASK:
تثبيت استقرار Ranking و Multi-Page Statement Continuation Detection
بعد إدخال تحسينات إضافية لمنع الصفحات غير المالية من الفوز في Ranking.

التركيز الحالي كان على:

منع صفحات Audit Narrative من الفوز

تقليل فوز الصفحات التي تحتوي أرقام فقط

تحسين دقة اكتشاف القوائم المالية الثلاث.

القوائم المستهدفة:

Income Statement
Balance Sheet
Cash Flow Statement

PHASE HISTORY

PHASE 4A
Multi-Sector Validation

تم اختبار النظام على قطاعات متعددة للتأكد من قدرة
محرك استخراج القوائم المالية على التعامل مع اختلاف
هياكل التقارير المالية.

القطاعات التي تم اختبارها:

شركة تشغيلية عربية

شركة تشغيلية إنجليزية

بنك عربي

بنك إنجليزي

شركة تأمين

صندوق REIT

شركة صناعية

الشركات المستخدمة في الاختبار:

جاهز

المراعي

مصرف الإنماء

مصرف الراجحي

التعاونية

جدوى ريت

المتقدمة

النتيجة:

النظام أثبت القدرة على العمل عبر قطاعات متعددة
مع اختلاف كبير في شكل القوائم المالية.

PHASE 4B
Extraction Engine Hardening

تم تقوية منطق اختيار الصفحات المالية باستخدام:

Ranking System
+
Penalties
+
Structure Signals

الهدف كان تقليل التقاط:

صفحات الإيضاحات
بدلاً من القوائم المالية الفعلية.

أهم التحسينات:

تحسين اكتشاف صفحة قائمة الدخل

تحسين اكتشاف صفحة المركز المالي

تحسين اكتشاف صفحة التدفقات النقدية

إضافة penalties للصفحات المتأخرة

تقليل فوز صفحات الملاحظات

دعم أفضل لاختلاف القطاع

PHASE 5

Financial Statement Intelligence Layer

بدأت هذه المرحلة لإضافة فهم مالي أعمق للنظام
بدلاً من الاعتماد فقط على كلمات عامة.

الطبقات التي تم بناؤها داخل هذه المرحلة:

1️⃣ Sector Detection Layer

يقوم النظام باكتشاف نوع الشركة مثل:

Bank
Insurance
REIT
Operating Company

ثم يغير منطق التحليل بناءً على القطاع.

2️⃣ Sector-Aware Statement Ranking

طريقة Ranking للقوائم المالية أصبحت تعتمد على القطاع
وليس فقط الكلمات العامة.

3️⃣ Multi-Page Statement Continuation Detection

تم بناء منطق يسمح للنظام باكتشاف:

امتداد القوائم المالية عبر أكثر من صفحة.

بدلاً من إرجاع:

صفحة واحدة فقط

أصبح النظام قادرًا على إرجاع:

Page Range

مثل:

income:
[8,9]

balance:
[95,96]

cashflow:
[14]

4️⃣ StatementSelectionResolved Layer

تم إدخال طبقة جديدة داخل المخرجات النهائية للنظام:

statementSelectionResolved

هذه الطبقة تعيد لكل قائمة:

basePage
+
pages
+
pageContexts

مما يسمح للمراحل القادمة من النظام
بالعمل على جميع صفحات القائمة
وليس فقط صفحة البداية.

5️⃣ Ranking Stabilization Improvements

تم تنفيذ تحسينات إضافية على Ranking
لتقليل فوز الصفحات العامة أو الصفحات
التي تحتوي كلمات جزئية فقط.

أهم ما تم تحسينه:

تقوية noTitle penalty

تقوية noTitleNoStructure penalty

تحسين حل التعارض بين Income و Balance

تقوية negativeHits penalty

تقليل تأثير years + numbers فقط

إضافة حماية خاصة لصفحات Cash Flow

إضافة fallback محدود لصفحات Cash Flow الطويلة

6️⃣ Audit Narrative Protection

تم إضافة حماية خاصة لمنع الصفحات الخاصة بالمراجعة مثل:

Key Audit Matters
أمور المراجعة الرئيسية
تقرير المراجع

من الفوز في Ranking.

تم إضافة penalty:

auditNarrativePenalty

الذي يمنع هذه الصفحات من الفوز حتى لو
احتوت على كلمات مثل "قائمة الدخل".

7️⃣ Continuation Threshold Stabilization

تم رفع حد قبول الصفحة التالية داخل:

detectStatementContinuation()

من:

nextEval.score >= 55

إلى:

nextEval.score >= 65

الهدف:

تقليل ضم الصفحات الضعيفة
التي قد تبدو مشابهة جزئيًا
لكنها ليست استمرارًا فعليًا للقائمة.

LATEST VALIDATION RESULT

آخر اختبار للنظام أظهر النتائج التالية:

selectedPages:

incomePage = 4
balancePage = 7
cashFlowPage = 9

statementPageRanges:

income:
[4]

balance:
[7]

cashflow:
[9]

النتيجة المهمة:

النظام نجح في:

اكتشاف Income Statement

اكتشاف Balance Sheet

اكتشاف Cash Flow Statement

منع صفحات Audit Narrative من الفوز

منع الصفحات العامة من الفوز على القوائم

الحفاظ على استقرار Continuation Detection

CURRENT_STATUS

المحرك الآن قادر على:

✔ اكتشاف القطاع
✔ تغيير منطق التحليل حسب القطاع
✔ ترتيب الصفحات باستخدام Ranking متقدم
✔ تقليل التقاط صفحات الإيضاحات
✔ تقليل فوز الصفحات العامة
✔ منع صفحات Audit Narrative
✔ اكتشاف امتداد القوائم المالية
✔ إرجاع نطاق الصفحات بدلاً من صفحة واحدة
✔ توفير pageContexts لكل صفحة في القائمة
✔ إرجاع statementSelectionResolved داخل المخرجات النهائية
✔ تثبيت اختيار القوائم الثلاث في آخر عينة اختبار

المعمارية الحالية مستقرة.

NEXT STEP

الخطوة القادمة:

إجراء مجموعة اختبارات إضافية
على ملفات جديدة من قطاعات مختلفة
للتأكد من استقرار:

Ranking
+
Continuation Detection

قبل الانتقال إلى المرحلة التالية:

Financial Line Item Extraction

وهي المرحلة التي يبدأ فيها النظام
بفهم بنود القوائم المالية نفسها.

DEFINITION OF DONE

تعتبر هذه المرحلة مكتملة عندما يصبح النظام قادرًا على:

اكتشاف القطاع

اختيار نوع القوائم حسب القطاع

تحديد صفحة بداية القائمة

اكتشاف امتداد القائمة عبر الصفحات

إرجاع Page Range للقائمة

تقليل فوز الصفحات العامة في Ranking

منع صفحات Audit Narrative من الفوز

منع ضم صفحة قائمة أخرى كاستمرار خاطئ

الحفاظ على استقرار المعمارية الحالية

KNOWN RULE

لا يتم تغيير المعمارية العامة.

لا يتم كسر البناء الحالي.

أي تحسين يجب أن يكون:

Layer فوق النظام الحالي

وليس إعادة بناء من الصفر.

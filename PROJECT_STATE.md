# PROJECT_STATE.md

CURRENT_PHASE: 4A (Multi-Sector Validation)

CURRENT_TASK:
اختبار النظام على قطاعات متعددة للتأكد من استقرار
محرك استخراج القوائم المالية مع اختلاف أشكال التقارير المالية.

هدف هذه المرحلة ليس تعديل الكود،
بل اختبار النظام على ملفات حقيقية من قطاعات مختلفة
واكتشاف الحالات التي تحتاج منطق استخراج خاص.

المسار الحالي للنظام:

upload-url
→ ingest
→ analyze (Azure Document Intelligence - prebuilt-layout)
→ extract-financial

SYSTEM_ARCHITECTURE:

طبقات التحليل الحالية داخل extract-financial:

financial:

* incomeStatementLite
* balanceSheetLite
* cashFlowLite
* balanceSheetStructured
* incomeStatementStructured
* cashFlowStructured
* checks
* ratios
* insights
* signals
* summary
* executiveSummary
* evaluation
* investmentView

LAST_TEST:

تم اختبار النظام على ملف حقيقي لقطاع البنوك
(مصرف الإنماء – القوائم المالية السنوية).

RESULT:

تم استخراج القوائم الثلاث بنجاح:

selectedPages:

incomePage = 9
balancePage = 8
cashFlowPage = 12

وهذا يطابق القوائم الحقيقية داخل التقرير.

كما نجح النظام في:

incomeStatementLite
balanceSheetLite
cashFlowLite

استخراج القيم الرقمية بشكل صحيح.

مثال:

incomeStatementLite:

الدخل من التمويل والاستثمارات
2025 → 60,961,683
2024 → 57,835,422

cashFlowLite:

دخل السنة قبل الزكاة وضريبة الدخل
2025 → 27,896,733
2024 → 23,614,771

TECHNICAL_CONFIRMATION:

تم التأكد أن محرك extract-financial أصبح قادراً على:

1. اكتشاف الصفحات المالية تلقائياً
2. استبعاد الصفحات غير المالية مثل:

   * الفهرس
   * صفحات المعايير
   * الجداول التحليلية
   * قائمة التغيرات في حقوق الملكية
3. تحديد أعمدة السنوات تلقائياً
4. تحويل الأرقام العربية إلى أرقام رقمية صحيحة

ENGINE_VERSION:

extract-financial-v3.3

IMPORTANT_DISCOVERY:

القوائم المالية للبنوك تختلف عن الشركات التشغيلية التقليدية.

أمثلة من ملف البنك:

قائمة الدخل تحتوي على:

* الدخل من الاستثمارات والتمويل
* دخل رسوم خدمات مصرفية
* إجمالي دخل العمليات
* صافي دخل السنة

بدلاً من:

* الإيرادات
* تكلفة الإيرادات
* مجمل الربح
* الربح التشغيلي

وكذلك قائمة المركز المالي للبنوك تختلف في التصنيف.

لذلك لا يمكن استخدام نموذج واحد لجميع القطاعات.

TESTING_PLAN:

سيتم اختبار شركتين من كل قطاع في السوق السعودي.

القطاعات المستهدفة:

* Banks
* Insurance
* Petrochemicals
* Telecom
* Retail
* Industrial
* Real Estate Development
* REIT
* Transportation
* Energy

EXPECTED_TEST_SIZE:

تقريباً:

20 شركة

الهدف من الاختبارات:

1. اكتشاف اختلافات القوائم المالية بين القطاعات
2. تحديد الحالات التي يفشل فيها الاستخراج
3. تحديد الحاجة إلى Financial Statement Profiles

NO_CODE_CHANGE_RULE:

خلال هذه المرحلة لا يتم تعديل الكود.

يتم فقط:

Test
→ Observe
→ Record

NEXT_PHASE:

4B (Financial Statement Profiles)

وسيتم فيها إضافة:

* OperatingCompanyProfile
* BankProfile
* InsuranceProfile
* REITProfile

بحيث يستطيع النظام:

تحديد نوع القوائم المالية تلقائياً
واستخدام منطق الاستخراج المناسب.

STATUS:
TESTING

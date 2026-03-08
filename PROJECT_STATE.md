# PROJECT_STATE.md

CURRENT_PHASE: 4A (Multi-Sector Validation)

CURRENT_TASK:
بدء مرحلة اختبار النظام على قطاعات متعددة للتأكد من استقرار
محرك استخراج القوائم المالية مع اختلاف أشكال التقارير المالية.

الهدف من هذه المرحلة ليس تعديل الكود،
بل اختبار النظام على ملفات حقيقية من قطاعات مختلفة
واكتشاف الحالات التي تحتاج منطق استخراج خاص.

المسار الحالي للنظام:

upload-url
→ ingest
→ analyze (Azure Document Intelligence - prebuilt-layout)
→ extract-financial

طبقات التحليل الحالية داخل extract-financial:

financial:
- incomeStatementLite
- balanceSheetLite
- cashFlowLite
- checks
- ratios
- insights
- signals
- summary
- executiveSummary
- evaluation
- investmentView

LAST_TEST:

تم اختبار النظام على ملف حقيقي لقطاع البنوك
(مصرف الإنماء – القوائم المالية السنوية).

RESULT:

- cashFlowLite نجح في استخراج:
  - endingCash
  - beginningCash
  - netChangeInCash

- cashFlowEquation = true

لكن:

incomeStatementLite = null  
balanceSheetLite = null  
ratios = null  
investmentView = null

REASON:

تم اكتشاف أن القوائم المالية للبنوك تختلف
عن الشركات التشغيلية التقليدية.

أمثلة من ملف البنك:

قائمة الدخل تحتوي على:
- الدخل من الاستثمارات والتمويل
- دخل رسوم خدمات مصرفية
- إجمالي دخل العمليات
- صافي دخل السنة

بدلاً من:

- الإيرادات
- تكلفة الإيرادات
- مجمل الربح
- الربح التشغيلي

وكذلك قائمة المركز المالي للبنوك تختلف في التصنيف.

IMPORTANT_DISCOVERY:

النظام الحالي يعمل بشكل جيد مع
Operating Companies
لكن يحتاج منطق خاص لقطاعات أخرى مثل:

- Banks
- Insurance
- REIT
- Investment Companies

لذلك سيتم استخدام مرحلة الاختبار
لتحديد الأنماط المختلفة للقوائم المالية.

TESTING_PLAN:

سيتم اختبار شركتين من كل قطاع في السوق السعودي.

القطاعات المستهدفة للاختبار:

- Banks
- Insurance
- Petrochemicals
- Telecom
- Retail
- Industrial
- Real Estate Development
- REIT
- Transportation
- Energy

EXPECTED_TEST_SIZE:

تقريباً:
20 شركة

الهدف من الاختبارات:

1) اكتشاف اختلافات القوائم المالية بين القطاعات
2) تحديد الحالات التي يفشل فيها الاستخراج
3) تحديد الحاجة إلى Financial Statement Profiles

NO_CODE_CHANGE_RULE:

خلال هذه المرحلة لا يتم تعديل الكود.

يتم فقط:

Test
→ Observe
→ Record

وسيتم جمع النتائج أولاً
ثم تحسين منطق الاستخراج لاحقاً.

NEXT_PHASE:

4B (Financial Statement Profiles)

وسيتم فيها إضافة:

- OperatingCompanyProfile
- BankProfile
- InsuranceProfile
- REITProfile

بحيث يستطيع النظام
تحديد نوع القوائم المالية تلقائياً
واستخدام منطق الاستخراج المناسب.

STATUS:
TESTING

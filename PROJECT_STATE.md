# PROJECT_STATE.md

CURRENT_PHASE: 3B (Extract Financial - Income Statement Stable)

CURRENT_TASK:
تثبيت مسار استخراج قائمة الدخل ثم استكمال استخراج قائمة المركز المالي.

المسار الحالي للنظام:

upload-url  
→ ingest  
→ analyze (Azure Document Intelligence - prebuilt-layout)  
→ extract-financial

تم اختبار المسار كاملاً مع ملف PDF حقيقي.

LAST_TEST:
رفع ملف:
"جاهز سنوي حالي #####.pdf"

النتائج في Network:

upload-url → 200  
blob upload → 201  
ingest → 200  
analyze → 500

رسالة الخطأ:

Failed to start Document Intelligence analyze  
status: 404  
Resource not found  
hasOperationLocation: false

LAST_RESULT:

- upload يعمل بشكل صحيح
- ingest يعمل بشكل صحيح
- الاتصال بـ Azure Document Intelligence يفشل عند بداية analyze
- الخطأ يظهر قبل بدء polling

ACTIVE_PROBLEM:

Endpoint الخاص بـ Azure Document Intelligence غير متوافق مع المسار المستخدم في الكود.

الطلب الحالي يستخدم:

/documentintelligence/documentModels/prebuilt-layout:analyze

لكن خدمة Azure ترجع:

404 Resource not found

مما يعني أحد الاحتمالات التالية:

1) DI_ENDPOINT غير صحيح
2) الخدمة تستخدم المسار القديم formrecognizer
3) إصدار API غير متوافق
4) endpoint يحتوي path إضافي

NEXT_STEP (غداً):

1) التأكد من DI_ENDPOINT داخل Azure
   يجب أن يكون بالشكل:

   https://<resource-name>.cognitiveservices.azure.com

2) اختبار endpoint يدوياً

3) تثبيت مسار analyze بشكل نهائي

4) بعد نجاح analyze نكمل:

analyze
→ normalized.tablesPreview
→ extract-financial
→ استخراج:
   - Income Statement
   - Balance Sheet

STATUS:
BLOCKED (Analyze endpoint issue)

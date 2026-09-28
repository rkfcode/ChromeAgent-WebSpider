/* ============================================================
   WebSpider side panel — v8
   Source of truth for the conversation is the `items` array;
   the DOM is rendered from it, so restore is exact and no state
   is scraped back out of the markup.
   ============================================================ */
(() => {
"use strict";

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const messages = $("#messages");
const input    = $("#input");
const WELCOME  = messages.innerHTML;   // template reused by every new session

let lang = "en";
let mode = "agent";
let running = false;
let sessionId = null;
let items = [];
let history = [];
let startedAt = 0;
let elapsedTimer = null;
let lastStreamed = "";
let live = null;            // {node, bubble, text}
let persistTimer = null;
let modalResolve = null;

const S = {};               // mirror of chrome.storage settings

/* ---------------------------------------------------------- 1. i18n */
const T = {
en:{
  tag:"AI Browser Agent", ready:"Ready", busy:"Working", paused:"Paused",
  newChat:"New chat", history:"Chat history", language:"Language", toggleTheme:"Toggle theme",
  settings:"Settings", close:"Close", dismiss:"Dismiss", toLatest:"Jump to latest",
  placeholder:"Example: audit this site, find SEO issues and prepare a report…",
  hint:"Enter to send · Shift+Enter for new line", run:"Run", stop:"Pause",
  page:"Current page", pageTip:"Attach a snapshot of the current page",
  diagnose:"Diagnose", diagnoseTip:"Run a page diagnostic",
  eyebrow:"BROWSER AUTOMATION ENGINE", welcome:"Give your browser a job.",
  desc:"WebSpider can inspect pages, navigate, interact with forms, research, diagnose issues and recover from temporary AI/API failures.",
  capFast:"Fast actions", capSafe:"Safe confirmations", capFailover:"Model failover",
  qAnalyze:"Analyze page", qAnalyzeSub:"Structure + UX",
  qSeo:"SEO audit", qSeoSub:"Technical checks",
  qDiagnose:"Diagnose", qDiagnoseSub:"Find browser issues",
  qResearch:"Research", qResearchSub:"Evidence-based",
  modeAgent:"Agent", modePlan:"Plan", modeResearch:"Research",
  modeAgentTip:"Act directly in the browser", modePlanTip:"Plan first, act after approval", modeResearchTip:"Read-only evidence gathering",
  resumeTitle:"A paused task is ready", resumeSub:"Continue from the last verified step.", resume:"Resume",
  confirmTitle:"Confirm sensitive action", approve:"Approve & continue", deny:"Cancel",
  humanTitle:"Human verification required", humanSub:"Complete the verification in the browser, then resume the agent.",
  planReady:"Plan ready", planReadySub:"Review the steps, then let the agent execute them.", execute:"Execute plan",
  historySub:"Resume previous work", deleteAll:"Delete all", noHistory:"No chats yet.",
  settingsSub:"Connection, behaviour and appearance",
  tabConnection:"Connection", tabAgent:"Agent", tabAppearance:"Appearance", tabAbout:"About",
  conn:"Model connection", connIdle:"Add an endpoint and API key, then test the connection.",
  good:"Connected", bad:"Connection failed", checking:"Checking API and models…",
  models:"models", verified:"verified", testConn:"Test connection",
  endpoint:"Primary API base URL or endpoint", endpointHelp:"OpenAI-compatible base URL. WebSpider resolves /chat/completions and /models from it.",
  fallback:"Fallback endpoints", optional:"(optional)", model:"Default model", check:"Check",
  customModel:"Or pin a model id manually", key:"API key", showKey:"Show or hide",
  remember:"Store the API key in Chrome storage", save:"Save & test", clear:"Delete history",
  temp:"Temperature", maxSteps:"Max agent steps", timeout:"Request timeout", retries:"Retries per model",
  retry0:"Fail over immediately", retry1:"1 fast retry",
  streaming:"Stream answers as they are generated",
  confirm:"Ask before purchases, deletion, sending, submission or sensitive changes",
  vision:"Send screenshots when the selected model supports vision",
  showThoughts:"Show the agent's interim reasoning notes",
  sendOnEnter:"Enter sends the message (Shift+Enter makes a new line)",
  notify:"Notify me when a task finishes in the background",
  rulesTitle:"Agent rules", rules:"Custom instructions",
  rulesPh:"Example: always answer in English. Ask before irreversible actions.",
  resilientTitle:"Resilient execution",
  resilientSub:"Transient API and network errors trigger a retry plus model failover while the task state is preserved.",
  theme:"Theme", themeDark:"Dark", themeLight:"Light", themeSystem:"System",
  accent:"Accent colour", fontSize:"Text size", fontSm:"Small", fontMd:"Default", fontLg:"Large",
  data:"Data", resetUi:"Reset appearance", clearState:"Clear agent state",
  creator:"WebSpider creator", support:"Support", version:"Version", engine:"Engine",
  note:"A browser extension cannot create internet access when the device is offline. WebSpider can retry requests and fail over between the endpoints you configure.",
  fontNote:"UI typography prioritises Vazirmatn / Vazir when available.",
  copied:"Copied to clipboard", copyFailed:"Could not copy", copy:"Copy",
  saved:"Settings saved", settingsSaved:"Settings saved and verified",
  needTask:"Type a task first.", needKey:"Add an API key in Settings first.",
  needModel:"Verify at least one model in Settings first.",
  needEndpointKey:"Endpoint and API key are required.",
  taskStarted:"Task started", taskPaused:"Task paused — ready to resume",
  resuming:"Resuming from the saved step", executing:"Executing the approved plan",
  execPlanMsg:"Execute the plan above.",
  confirmDeleteOne:"Delete this chat?", confirmDeleteOneBody:"The conversation will be removed from your history.",
  confirmDeleteAll:"Delete all chat history?", confirmDeleteAllBody:"Every saved conversation will be permanently removed.",
  delete:"Delete", cancel:"Cancel",
  cleared:"Agent state cleared", reset:"Appearance reset",
  swOffline:"The service worker did not respond. Reopen the panel and try again.",
  noPageData:"No page data available.",
  tabTools:"Tools", speed:"Execution speed", speedFast:"Fast", speedBalanced:"Balanced", speedThorough:"Thorough",
  speedHelp:"Fast minimises round trips. Thorough re-reads the page after every action.",
  autoVerify:"Verify the page after each action",
  autoVerifyHelp:"Catches a click that silently did nothing instead of reporting success.",
  cacheSnapshot:"Reuse a recent page snapshot",
  humanAssist:"Pause for CAPTCHA or human verification, then resume automatically",
  dialogPolicy:"Native browser dialogs",
  dialogRecord:"Show them (default)", dialogAccept:"Auto-accept", dialogDismiss:"Auto-dismiss",
  dialogHelp:"Only change this when an alert or confirm box is blocking an automated run.",
  safeTitle:"Security controls stay in charge",
  safeSub:"WebSpider detects CAPTCHA and human-verification challenges, pauses and shows you the screen, then resumes the run automatically the moment you finish. It never solves or bypasses a challenge for you.",
  toolsTitle:"Built-in tools", toolsSub:"Everything the agent can do on the page, grouped by what it is allowed to do.",
  toolsUnit:"tools",
  toolGroupRead:"Read & inspect", toolGroupAct:"Act on the page", toolGroupWait:"Wait & verify", toolGroupSafe:"Safety & control",
  humanAuto:"WebSpider resumes automatically once you finish.", humanVendor:"Detected",
  humanSolved:"Verification cleared — resuming the task", humanTimeout:"The verification challenge was not completed in time.",
  exportChat:"Export", exportAll:"Export all conversations",
  exported:"Conversation exported", exportAllDone:"All conversations exported",
  exportEmpty:"There is nothing to export yet.", exportFailed:"Export failed"
},
fa:{
  tag:"عامل هوشمند مرورگر", ready:"آماده", busy:"در حال انجام", paused:"متوقف",
  newChat:"گفتگوی جدید", history:"تاریخچه گفتگوها", language:"زبان", toggleTheme:"تغییر تم",
  settings:"تنظیمات", close:"بستن", dismiss:"بستن", toLatest:"رفتن به آخرین",
  placeholder:"مثلاً: این سایت را بررسی کن، مشکلات SEO را پیدا کن و گزارش بده…",
  hint:"Enter ارسال · Shift+Enter خط جدید", run:"اجرا", stop:"مکث",
  page:"صفحه فعلی", pageTip:"تصویری از وضعیت صفحه فعلی پیوست کن",
  diagnose:"عیب‌یابی", diagnoseTip:"اجرای عیب‌یابی صفحه",
  eyebrow:"موتور خودکارسازی مرورگر", welcome:"مرورگر را به یک دستیار واقعی بسپار.",
  desc:"WebSpider می‌تواند صفحات را تحلیل کند، جابه‌جا شود، فرم‌ها را پر کند، تحقیق کند، مشکلات را تشخیص دهد و از خطاهای موقت API یا مدل عبور کند.",
  capFast:"کنش‌های سریع", capSafe:"تأیید ایمن", capFailover:"جایگزینی مدل",
  qAnalyze:"تحلیل صفحه", qAnalyzeSub:"ساختار و تجربه کاربری",
  qSeo:"بررسی SEO", qSeoSub:"کنترل‌های فنی",
  qDiagnose:"عیب‌یابی", qDiagnoseSub:"یافتن مشکلات مرورگر",
  qResearch:"تحقیق", qResearchSub:"مبتنی بر شواهد",
  modeAgent:"عامل", modePlan:"نقشه", modeResearch:"تحقیق",
  modeAgentTip:"کنش مستقیم در مرورگر", modePlanTip:"اول نقشه، سپس اجرا با تأیید", modeResearchTip:"فقط خواندن و جمع‌آوری شواهد",
  resumeTitle:"یک کار متوقف‌شده آماده ادامه است", resumeSub:"از آخرین مرحله تأییدشده ادامه بده.", resume:"ادامه",
  confirmTitle:"تأیید عملیات حساس", approve:"تأیید و ادامه", deny:"لغو",
  humanTitle:"نیاز به تأیید انسانی", humanSub:"تأیید را در مرورگر انجام بده و سپس عامل را ادامه بده.",
  planReady:"نقشه آماده است", planReadySub:"مراحل را بررسی کن و سپس اجازه اجرا بده.", execute:"اجرای نقشه",
  historySub:"ادامه کارهای قبلی", deleteAll:"حذف همه", noHistory:"هنوز گفتگویی ثبت نشده است.",
  settingsSub:"اتصال، رفتار و ظاهر",
  tabConnection:"اتصال", tabAgent:"عامل", tabAppearance:"ظاهر", tabAbout:"درباره",
  conn:"اتصال مدل", connIdle:"آدرس و API Key را وارد کن، سپس اتصال را تست کن.",
  good:"متصل", bad:"اتصال ناموفق", checking:"در حال بررسی API و مدل‌ها…",
  models:"مدل", verified:"تأییدشده", testConn:"تست اتصال",
  endpoint:"آدرس اصلی API یا Endpoint", endpointHelp:"آدرس سازگار با OpenAI. مسیرهای /chat/completions و /models از آن ساخته می‌شود.",
  fallback:"Endpointهای جایگزین", optional:"(اختیاری)", model:"مدل پیش‌فرض", check:"بررسی",
  customModel:"یا نام مدل را دستی وارد کن", key:"API Key", showKey:"نمایش یا پنهان",
  remember:"ذخیره API Key در حافظه کروم", save:"ذخیره و تست", clear:"حذف تاریخچه",
  temp:"دما (Temperature)", maxSteps:"حداکثر گام‌های عامل", timeout:"مهلت درخواست", retries:"تلاش مجدد هر مدل",
  retry0:"جایگزینی فوری", retry1:"یک تلاش سریع",
  streaming:"نمایش پاسخ به‌صورت زنده و تدریجی",
  confirm:"برای خرید، حذف، ارسال، ثبت یا تغییر حساس تأیید بگیر",
  vision:"در صورت پشتیبانی مدل از تصویر، اسکرین‌شات ارسال کن",
  showThoughts:"یادداشت‌های میانی عامل نمایش داده شود",
  sendOnEnter:"کلید Enter پیام را ارسال کند (Shift+Enter خط جدید)",
  notify:"پایان کار در پس‌زمینه را اطلاع بده",
  rulesTitle:"قواعد عامل", rules:"دستورهای سفارشی",
  rulesPh:"مثلاً: همیشه فارسی پاسخ بده. پیش از کارهای بازگشت‌ناپذیر بپرس.",
  resilientTitle:"اجرای مقاوم",
  resilientSub:"خطاهای موقت شبکه یا API باعث تلاش مجدد و جایگزینی مدل می‌شود و وضعیت کار حفظ می‌شود.",
  theme:"تم", themeDark:"تیره", themeLight:"روشن", themeSystem:"سیستم",
  accent:"رنگ لهجه", fontSize:"اندازه متن", fontSm:"کوچک", fontMd:"پیش‌فرض", fontLg:"بزرگ",
  data:"داده‌ها", resetUi:"بازنشانی ظاهر", clearState:"پاک‌کردن وضعیت عامل",
  creator:"سازنده WebSpider", support:"حمایت", version:"نسخه", engine:"موتور",
  note:"یک افزونه مرورگر نمی‌تواند وقتی دستگاه آفلاین است اینترنت بسازد. WebSpider می‌تواند درخواست‌ها را تکرار کند و بین Endpointهای تنظیم‌شده جایگزین شود.",
  fontNote:"تایپوگرافی رابط در اولویت از Vazirmatn / Vazir استفاده می‌کند.",
  copied:"در حافظه کپی شد", copyFailed:"کپی نشد", copy:"کپی",
  saved:"تنظیمات ذخیره شد", settingsSaved:"تنظیمات ذخیره و تأیید شد",
  needTask:"اول یک کار بنویس.", needKey:"اول در تنظیمات API Key را وارد کن.",
  needModel:"اول در تنظیمات حداقل یک مدل را تأیید کن.",
  needEndpointKey:"آدرس Endpoint و API Key لازم است.",
  taskStarted:"کار آغاز شد", taskPaused:"کار متوقف شد — آماده ادامه",
  resuming:"ادامه از مرحله ذخیره‌شده", executing:"در حال اجرای نقشه تأییدشده",
  execPlanMsg:"نقشه بالا را اجرا کن.",
  confirmDeleteOne:"این گفتگو حذف شود؟", confirmDeleteOneBody:"این گفتگو از تاریخچه حذف می‌شود.",
  confirmDeleteAll:"کل تاریخچه پاک شود؟", confirmDeleteAllBody:"همه گفتگوهای ذخیره‌شده برای همیشه حذف می‌شوند.",
  delete:"حذف", cancel:"لغو",
  cleared:"وضعیت عامل پاک شد", reset:"ظاهر بازنشانی شد",
  swOffline:"سرویس‌ورکر پاسخ نداد. پنل را ببند و باز کن و دوباره تلاش کن.",
  noPageData:"داده‌ای از صفحه در دسترس نیست.",
  tabTools:"ابزارها", speed:"سرعت اجرا", speedFast:"سریع", speedBalanced:"متعادل", speedThorough:"دقیق",
  speedHelp:"«سریع» رفت‌وبرگشت‌ها را کم می‌کند. «دقیق» پس از هر کنش صفحه را دوباره می‌خواند.",
  autoVerify:"پس از هر کنش، صفحه بررسی شود",
  autoVerifyHelp:"کلیکی که بی‌صدا بی‌اثر مانده را آشکار می‌کند.",
  cacheSnapshot:"استفاده دوباره از تصویر تازه صفحه",
  humanAssist:"برای کپچا یا تأیید انسانی توقف کن، سپس خودکار ادامه بده",
  dialogPolicy:"دیالوگ‌های بومی مرورگر",
  dialogRecord:"نمایش داده شوند (پیش‌فرض)", dialogAccept:"پذیرش خودکار", dialogDismiss:"رد خودکار",
  dialogHelp:"این را فقط وقتی تغییر بده که یک alert یا confirm اجرای خودکار را متوقف کرده است.",
  safeTitle:"کنترل‌های امنیتی در اختیار می‌مانند",
  safeSub:"WebSpider کپچا و تأیید انسانی را تشخیص می‌دهد، متوقف می‌شود و صفحه را نشانت می‌دهد، سپس به‌محض تمام‌کردن، اجرا را خودکار ادامه می‌دهد. هرگز کپچا را به‌جای تو حل یا دور نمی‌زند.",
  toolsTitle:"ابزارهای داخلی", toolsSub:"هر کاری که عامل روی صفحه می‌تواند انجام دهد، دسته‌بندی‌شده بر اساس نوع مجوز.",
  toolsUnit:"ابزار",
  toolGroupRead:"خواندن و بررسی", toolGroupAct:"کنش روی صفحه", toolGroupWait:"انتظار و تأیید", toolGroupSafe:"ایمنی و کنترل",
  humanAuto:"به‌محض پایان‌دادن، WebSpider خودکار ادامه می‌دهد.", humanVendor:"شناسایی‌شده",
  humanSolved:"تأیید انجام شد — کار ادامه می‌یابد", humanTimeout:"تأیید انسانی در زمان مقرر کامل نشد.",
  exportChat:"خروجی", exportAll:"خروجی همه گفتگوها",
  exported:"گفتگو صادر شد", exportAllDone:"همه گفتگوها صادر شد",
  exportEmpty:"هنوز چیزی برای صدور وجود ندارد.", exportFailed:"صدور انجام نشد"
}};
const tr = k => (T[lang] && T[lang][k]) || T.en[k] || k;

/* ------------------------------------------------- 2. small helpers */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

function icon(id, cls = "event-icon") {
  const p = EVENT_ICONS[id] || EVENT_ICONS.agent;
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
}
const EVENT_ICONS = {
  agent:'<path d="M7 8h10v9H7zM9 5h6M12 3v2M4 11h3M17 11h3M9 17v3M15 17v3"/><circle cx="10" cy="12" r="1"/><circle cx="14" cy="12" r="1"/>',
  plan:'<path d="M6 4h12v16H6zM9 8h6M9 12h6M9 16h4"/>',
  bolt:'<path d="m13 2-8 12h6l-1 8 8-12h-6z"/>',
  refresh:'<path d="M20 11a8 8 0 0 0-14.7-4L3 10M3 5v5h5M4 13a8 8 0 0 0 14.7 4L21 14M21 19v-5h-5"/>',
  bug:'<path d="M9 7h6a3 3 0 0 1 3 3v5a6 6 0 0 1-12 0v-5a3 3 0 0 1 3-3Z"/><path d="M12 3v4M5 11H2M22 11h-3M6 6 4 4M18 6l2-2M6 16l-3 2M18 16l3 2"/>',
  shield:'<path d="M12 3 19 6v5c0 4.5-2.8 8-7 10-4.2-2-7-5.5-7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  pause:'<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
  play:'<path d="m9 6 10 6-10 6z"/>',
  check:'<path d="m5 13 4.5 4.5L19 7"/>',
  wand:'<path d="m4 20 10-10M15 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 12l.6 1.2 1.4.8-1.4.8-.6 1.2-.6-1.2-1.4-.8 1.4-.8z"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'
};

/* --------------------------------------- 2b. tool catalogue */
/* Kept beside the UI rather than in the i18n dictionary: 45 tools in two
   languages would swamp the dictionary, and this list is data, not chrome.
   The static gate asserts it stays in step with background.js TOOLS. */
const TOOLS_INFO = [
  { g:"toolGroupRead", items:[
    ["page_snapshot", "Full page snapshot with stable element ids", "تصویر کامل صفحه با شناسه‌های پایدار عناصر"],
    ["page_state", "Lightweight page state and a change token", "وضعیت سبک صفحه و نشانه تغییر"],
    ["page_diagnostics", "Page errors, broken images, slow resources", "خطاهای صفحه، تصاویر شکسته، منابع کند"],
    ["query_elements", "Structured list for any CSS selector", "فهرست ساخت‌یافته برای هر انتخابگر CSS"],
    ["get_table", "Table rows, headers and keyed objects", "سطرها، سرستون‌ها و آبجکت‌های جدول"],
    ["get_form", "Form fields, labels, values, validation", "میدان‌های فرم، برچسب‌ها، مقادیر، اعتبارسنجی"],
    ["find_in_page", "Locate text with its surrounding context", "یافتن متن همراه با زمینه اطراف"],
    ["get_selection", "The text the user has selected", "متنی که کاربر انتخاب کرده است"],
    ["console_logs", "Console messages produced by the page", "پیام‌های کنسول تولیدشده توسط صفحه"],
    ["dialog_log", "Native alert and confirm dialogs raised", "دیالوگ‌های بومی alert و confirm"],
    ["network_log", "Resource timings and transfer sizes", "زمان‌بندی منابع و حجم انتقال"],
    ["styles_of", "Computed styles and contrast ratio", "استایل محاسبه‌شده و نسبت کنتراست"],
    ["audit", "SEO, accessibility, performance, links, content", "سئو، دسترس‌پذیری، کارایی، پیوندها، محتوا"],
    ["extract", "Readable text, HTML or links from an area", "متن، HTML یا پیوندهای یک ناحیه"],
    ["mark_page", "Set a before/after marker", "نشانه‌گذاری پیش و پس از کنش"],
    ["diff_page", "Prove exactly what changed", "اثبات دقیق آنچه تغییر کرده"]
  ]},
  { g:"toolGroupAct", items:[
    ["navigate", "Go to a URL in the current tab", "رفتن به یک نشانی در زبانه فعلی"],
    ["open_tab", "Open a URL in a new working tab", "بازکردن نشانی در زبانه کاری جدید"],
    ["back", "One history step back", "یک گام به عقب در تاریخچه"],
    ["forward", "One history step forward", "یک گام به جلو در تاریخچه"],
    ["click", "Click by element id, selector or text", "کلیک با شناسه، انتخابگر یا متن"],
    ["click_at", "Click at viewport coordinates", "کلیک در مختصات ناحیه دید"],
    ["type", "Fill an input, textarea or rich editor", "پرکردن ورودی، متن یا ویرایشگر غنی"],
    ["clear_field", "Empty a field", "خالی‌کردن یک میدان"],
    ["select", "Choose an option in a dropdown", "انتخاب یک گزینه از فهرست بازشو"],
    ["check", "Tick or untick a checkbox or radio", "تیک‌زدن یا برداشتن چک‌باکس و رادیو"],
    ["hover", "Reveal menus, tooltips and hover states", "نمایان‌کردن منوها، راهنماها و حالت‌های شناور"],
    ["focus", "Move keyboard focus without clicking", "انتقال تمرکز صفحه‌کلید بدون کلیک"],
    ["press_key", "Press Enter, Tab, Escape or the arrows", "فشردن Enter، Tab، Escape یا کلیدهای جهت"],
    ["submit_form", "Submit a form with real validation", "ارسال فرم با اعتبارسنجی واقعی"],
    ["scroll", "Scroll by a number of pixels", "پیمایش به اندازه پیکسل مشخص"],
    ["scroll_to", "Scroll to an element or an offset", "پیمایش تا یک عنصر یا موقعیت مشخص"],
    ["highlight", "Highlight an element for the user", "برجسته‌کردن یک عنصر برای کاربر"],
    ["draw", "Annotate the page with a line or box", "یادداشت‌گذاری روی صفحه با خط یا کادر"],
    ["screenshot", "Capture the visible viewport", "گرفتن تصویر از ناحیه دید"]
  ]},
  { g:"toolGroupWait", items:[
    ["wait", "Wait a fixed number of milliseconds", "انتظار به اندازه میلی‌ثانیه مشخص"],
    ["wait_for_element", "Wait until an element appears", "انتظار تا ظاهرشدن یک عنصر"],
    ["wait_for_text", "Wait until text appears", "انتظار تا ظاهرشدن یک متن"],
    ["wait_for_dom_stable", "Wait until the DOM stops changing", "انتظار تا توقف تغییرات DOM"],
    ["wait_for_network_idle", "Wait until requests settle", "انتظار تا آرام‌شدن درخواست‌ها"]
  ]},
  { g:"toolGroupSafe", items:[
    ["detect_human_check", "Detect CAPTCHA — never solve it", "تشخیص کپچا — هرگز آن را حل نمی‌کند"],
    ["human_verification", "Pause for the user, resume automatically", "توقف برای کاربر و ادامه خودکار"],
    ["ask_confirmation", "Ask before a sensitive action", "پرسیدن پیش از کنش حساس"],
    ["set_dialog_policy", "Record, accept or dismiss native dialogs", "ثبت، پذیرش یا رد دیالوگ‌های بومی"],
    ["sync_browser_target", "Follow a popup, OAuth window or new tab", "دنبال‌کردن پنجره، OAuth یا زبانه جدید"]
  ]}
];

function renderTools() {
  const box = $("#toolsList");
  if (!box) return;
  const pick = lang === "fa" ? 2 : 1;
  box.innerHTML = "";
  let total = 0;
  for (const group of TOOLS_INFO) {
    const wrap = document.createElement("div");
    wrap.className = "tool-group";
    const head = document.createElement("div");
    head.className = "tool-group-title";
    head.textContent = tr(group.g);
    wrap.appendChild(head);
    for (const it of group.items) {
      total++;
      const row = document.createElement("div");
      row.className = "tool-row";
      const code = document.createElement("code");
      code.textContent = it[0];
      const desc = document.createElement("span");
      desc.textContent = it[pick] || it[1];
      row.appendChild(code);
      row.appendChild(desc);
      wrap.appendChild(row);
    }
    box.appendChild(wrap);
  }
  const count = $("#toolsCount");
  if (count) count.textContent = `${total} ${tr("toolsUnit")}`;
}

/* ------------------------------------------- 3. markdown renderer */
function codeBlock(code, langLabel) {
  return `<div class="codeblock"><div class="codeblock-head"><span>${esc(langLabel || "code")}</span>`
       + `<button class="copycode" data-copy="code" type="button">${icon("check","")}${esc(tr("copy"))}</button></div>`
       + `<pre><code>${esc(code)}</code></pre></div>`;
}

function md(src) {
  const inline = t => esc(t)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');

  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const langLabel = line.trim().slice(3).trim();
      const buf = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;                                   // skip the closing fence
      out.push(codeBlock(buf.join("\n"), langLabel));
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { out.push(`<h4 class="md-h">${inline(m[2])}</h4>`); i++; continue; }
    if ((m = /^>\s?(.*)$/.exec(line))) {
      const buf = [];
      while (i < lines.length && (m = /^>\s?(.*)$/.exec(lines[i]))) { buf.push(m[1]); i++; }
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+])\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && (m = /^\s*[-*+]\s+(.*)$/.exec(lines[i]))) { buf.push(`<li>${inline(m[1])}</li>`); i++; }
      out.push(`<ul>${buf.join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && (m = /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]))) { buf.push(`<li>${inline(m[1])}</li>`); i++; }
      out.push(`<ol>${buf.join("")}</ol>`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { out.push("<hr>"); i++; continue; }
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*```/.test(lines[i])
           && !/^#{1,6}\s+/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])
           && !/^\s*\d+[.)]\s+/.test(lines[i]) && !/^>\s?/.test(lines[i])) { buf.push(lines[i]); i++; }
    out.push(`<p>${inline(buf.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }
  return out.join("") || `<p>${esc(src)}</p>`;
}

/* ------------------------------------------------- 4. toast + modal */
function toast(text, kind = "", ms = 2800) {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = `${icon(kind === "err" ? "bug" : kind === "ok" ? "check" : "info", "")}<span></span>`
               + `<button type="button" aria-label="${esc(tr("close"))}">${icon("close","")}</button>`;
  el.querySelector("span").textContent = String(text);
  const kill = () => { el.classList.add("out"); setTimeout(() => el.remove(), 220); };
  el.querySelector("button").onclick = kill;
  box.appendChild(el);
  if (ms) setTimeout(kill, ms);
}

function closeModal(value) {
  $("#modal").classList.add("hidden");
  const r = modalResolve; modalResolve = null;
  if (r) r(value);
}
function askConfirm({ title, body, ok, cancel, danger = false }) {
  return new Promise(resolve => {
    modalResolve = resolve;
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = body;
    $("#modalOk").textContent = ok || tr("approve");
    $("#modalCancel").textContent = cancel || tr("cancel");
    $("#modalOk").classList.toggle("danger", danger);
    $("#modal").classList.remove("hidden");
    $("#modalOk").focus();
  });
}

/* ------------------------------------------- 5. appearance / theme */
function applyAppearance() {
  const root = document.documentElement;
  const theme = S.theme || "dark";
  const resolved = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : theme;
  root.dataset.theme  = resolved;
  root.dataset.accent = S.accent || "amber";
  root.dataset.fs     = S.fontSize || "md";
  const use = $("#themeBtn use");
  if (use) use.setAttribute("href", resolved === "dark" ? "#i-sun" : "#i-moon");
  seg("#themeSeg", theme);
  seg("#fsSeg", S.fontSize || "md");
  seg("#langSeg", lang);
  seg("#accentSeg", S.accent || "amber");
  seg("#speedSeg", S.speed || "balanced");
}
function seg(sel, val) {
  $$(sel + " button").forEach(b => b.classList.toggle("active", b.dataset.val === val));
}

/* ------------------------------------------------------ 6. i18n UI */
function applyLang() {
  const root = document.documentElement;
  root.lang = lang;
  root.dir = lang === "fa" ? "rtl" : "ltr";
  $$("[data-i18n]").forEach(el => { el.textContent = tr(el.dataset.i18n); });
  $$("[data-i18n-ph]").forEach(el => { el.placeholder = tr(el.dataset.i18nPh); });
  $$("[data-i18n-title]").forEach(el => {
    const v = tr(el.dataset.i18nTitle);
    el.title = v; el.setAttribute("aria-label", v);
  });
  $("#lang").textContent = lang === "en" ? "FA" : "EN";
  $("#status").textContent = running ? tr("busy") : tr("ready");
  $("#composerState").textContent = running ? tr("busy") : tr("ready");
  $("#composerMode").textContent = tr(mode === "agent" ? "modeAgent" : mode === "plan" ? "modePlan" : "modeResearch");
  renderTools();
  applyAppearance();
}

/* --------------------------------------------- 7. session / items */
function titleOf() {
  const u = items.find(x => x.k === "u");
  const t = u ? u.t : "";
  return (t || tr("newChat")).replace(/\s+/g, " ").slice(0, 60);
}
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persist(); }, 350);
}
function persist() {
  if (!sessionId) return;
  const cur = history.find(x => x.id === sessionId);
  if (!items.length) {
    if (cur) chrome.storage.local.set({ chatSessions: history, activeSession: sessionId });
    return;
  }
  const rec = cur || { id: sessionId, created: Date.now() };
  rec.updated = Date.now();
  rec.title = titleOf();
  rec.items = items.slice(-600);
  if (!cur) history.unshift(rec);
  history.sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0));
  history = history.slice(0, 60);
  chrome.storage.local.set({ chatSessions: history, activeSession: sessionId });
}

function startSession() {
  sessionId = "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  items = [];
  live = null;
  messages.innerHTML = WELCOME;
  chrome.storage.local.set({ activeSession: sessionId });
  renderHistory();
  hideResume();
  setProgress(0, 0);
  scrollDown(true);
}

function pushItem(it) {
  items.push(it);
  const node = renderItem(it);
  if (node) messages.appendChild(node);
  trimDom();
  scrollDown();
  schedulePersist();
  return node;
}
function trimDom() {
  const nodes = $$(".msg, .event, .confirm, .human-card, .plan-card", messages);
  if (nodes.length <= 800) return;
  nodes.slice(0, nodes.length - 800).forEach(n => n.remove());
}

function renderItem(it) {
  if (!it) return null;
  if (it.k === "u" || it.k === "a") return msgNode(it);
  if (it.k === "e") return eventNode(it);
  if (it.k === "t") return showThoughts() ? thoughtNode(it.t) : null;
  if (it.k === "c") return confirmNode(it);
  if (it.k === "h") return humanNode(it);
  if (it.k === "p") return planNode(it);
  return null;
}

function msgNode(it) {
  const w = document.createElement("div");
  w.className = "msg " + (it.k === "u" ? "user" : "assistant");
  const body = document.createElement("div");
  body.className = "msg-body";
  const b = document.createElement("div");
  b.className = "bubble" + (it.err ? " error" : "");
  if (it.k === "u") b.textContent = it.t; else b.innerHTML = md(it.t);
  body.appendChild(b);

  const acts = document.createElement("div");
  acts.className = "msg-actions";
  const cp = document.createElement("button");
  cp.className = "mini"; cp.type = "button"; cp.dataset.copy = "bubble";
  cp.innerHTML = `${icon("check","")}<span>${esc(tr("copy"))}</span>`;
  acts.appendChild(cp);
  body.appendChild(acts);
  w.appendChild(body);
  return w;
}
function eventNode(it) {
  const e = document.createElement("div");
  e.className = "event " + (it.l || "");
  const id = it.lb === "MODEL" ? "agent" : it.lb === "ACTION" ? "bolt"
           : (it.lb === "RETRY" || it.lb === "FAILOVER") ? "refresh"
           : it.lb === "ERROR" ? "bug" : it.lb === "PAUSE" ? "pause"
           : it.lb === "RESUME" ? "play" : it.lb === "DONE" ? "check"
           : it.lb === "VERIFY" ? "shield" : "plan";
  e.innerHTML = `${icon(id)}<div class="event-copy"><div><span class="tag">${esc(it.lb || "AGENT")}</span> <span class="txt">${esc(it.t || "")}</span></div>${it.m ? `<small>${esc(it.m)}</small>` : ""}</div>`;
  return e;
}
function thoughtNode(text) {
  const e = document.createElement("div");
  e.className = "event thought";
  e.innerHTML = `${icon("wand")}<div class="event-copy"><div class="txt">${esc(text)}</div></div>`;
  return e;
}
function confirmNode(it) {
  const e = document.createElement("div");
  e.className = "confirm";
  const resolved = it.ok === true || it.ok === false;
  e.innerHTML = `<div class="confirm-icon">${icon("shield","")}</div><div class="confirm-copy">`
    + `<strong>${esc(tr("confirmTitle"))}</strong><p>${esc(it.t || "")}${it.r ? "<br>" + esc(it.r) : ""}</p>`
    + (resolved ? `<p><b>${esc(it.ok ? tr("approve") : tr("deny"))}</b></p>`
                : `<div class="row"><button class="approve" type="button">${esc(tr("approve"))}</button>`
                + `<button class="deny" type="button">${esc(tr("deny"))}</button></div>`)
    + `</div>`;
  if (!resolved) {
    e.querySelector(".approve").onclick = () => { it.ok = true; reply(it); e.replaceWith(confirmNode(it)); schedulePersist(); };
    e.querySelector(".deny").onclick    = () => { it.ok = false; reply(it); e.replaceWith(confirmNode(it)); schedulePersist(); };
  }
  return e;
}
function reply(it) {
  if (!it.id) return;
  chrome.runtime.sendMessage({ type: "confirmation", id: it.id, approved: it.ok === true }).catch(() => {});
}
function humanNode(it) {
  const e = document.createElement("div");
  e.className = "human-card";
  const vendor = it.v ? `<span class="human-vendor">${esc(tr("humanVendor"))}: <b>${esc(it.v)}</b></span>` : "";
  e.innerHTML = `${icon("shield","")}<div class="human-copy"><b>${esc(tr("humanTitle"))}</b>`
    + `<small>${esc(it.t || tr("humanSub"))}</small>`
    + `<small class="human-auto">${esc(tr("humanAuto"))}</small>${vendor}</div>`
    + `<button class="go" type="button" title="${esc(tr("resume"))}" aria-label="${esc(tr("resume"))}">${icon("play","")}</button>`;
  if (it.img) {
    const img = document.createElement("img");
    img.className = "human-preview"; img.alt = "Visible verification screen";
    img.src = it.img;
    e.querySelector(".human-copy").appendChild(img);
  }
  e.querySelector("button").onclick = () => resumeTask();
  return e;
}
function planNode(it) {
  const e = document.createElement("div");
  e.className = "plan-card";
  e.innerHTML = `${icon("plan","")}<div class="confirm-copy"><b>${esc(tr("planReady"))}</b>`
    + `<small>${esc(tr("planReadySub"))}</small>`
    + `<div class="row"><button class="approve" type="button">${esc(tr("execute"))}</button></div></div>`;
  e.querySelector(".approve").onclick = () => executePlan(it.t);
  return e;
}

/* ------------------------------------------------ 8. scroll + run */
const nearBottom = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90;
function scrollDown(force) { if (force || nearBottom()) messages.scrollTop = messages.scrollHeight; }

function setRun(v) {
  running = v;
  $("#run").classList.toggle("hidden", v);
  $("#stop").classList.toggle("hidden", !v);
  $("#dot").classList.toggle("busy", v);
  $("#dot").classList.toggle("paused", false);
  $("#miniDot").classList.toggle("busy", v);
  $("#livePulse").classList.toggle("active", v);
  $("#status").textContent = v ? tr("busy") : tr("ready");
  $("#composerState").textContent = v ? tr("busy") : tr("ready");
  $("#elapsed").classList.toggle("hidden", !v);
  $$(".quick").forEach(b => { b.disabled = v; });
  if (v) { startedAt = Date.now(); startElapsed(); }
  else { stopElapsed(); }
}
function startElapsed() {
  stopElapsed();
  $("#elapsed").textContent = fmt(0);
  elapsedTimer = setInterval(() => { $("#elapsed").textContent = fmt(Math.floor((Date.now() - startedAt) / 1000)); }, 250);
}
function stopElapsed() { if (elapsedTimer) clearInterval(elapsedTimer); elapsedTimer = null; }
function fmt(s) { return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }

function setProgress(step, max) {
  const chip = $("#progressChip");
  if (!max) { chip.classList.add("hidden"); return; }
  chip.classList.remove("hidden");
  chip.textContent = `${step || 0}/${max}`;
}
function setModelChip(name) {
  const chip = $("#statusModel");
  if (!name) { chip.classList.add("hidden"); chip.textContent = ""; return; }
  chip.classList.remove("hidden");
  chip.textContent = name;
  chip.title = name;
}

async function send(msg) {
  try { return await chrome.runtime.sendMessage(msg); }
  catch (e) { toast(tr("swOffline"), "err"); throw e; }
}

async function runTask(task, runMode) {
  if (running) return;
  const p = (task ?? input.value).trim();
  const m = runMode || mode;
  if (!p) { toast(tr("needTask"), "err"); input.focus(); return; }
  if (!S.apiKey) { toast(tr("needKey"), "err"); openDrawer("#drawer", "connection"); return; }
  if (!S.model && !(S.verifiedModels || []).length) { toast(tr("needModel"), "err"); openDrawer("#drawer", "connection"); return; }

  pushItem({ k: "u", t: p });
  if (task == null) { input.value = ""; autoGrow(); }
  setRun(true);
  lastStreamed = "";
  setProgress(0, 0);
  try {
    const r = await send({ type: "runAgent", task: p, mode: m });
    finishRun(r, m);
  } catch (e) {
    finishRun({ ok: false, error: e?.message || String(e) }, m);
  }
}

function finishRun(r, runMode) {
  if (r && r.ok && r.message) {
    const txt = String(r.message);
    const dup = lastStreamed && txt.trim() === lastStreamed.trim();
    if (!dup) {
      if (runMode === "plan" && r.status === "done") pushItem({ k: "p", t: txt });
      else pushItem({ k: "a", t: txt });
    }
  } else if (r && r.error) {
    pushItem({ k: "a", t: String(r.error), err: true });
  }
  lastStreamed = "";
  setRun(false);
  setProgress(0, 0);
  refreshAgentState();
}

async function resumeTask() {
  if (running) return;
  setRun(true);
  lastStreamed = "";
  pushItem({ k: "e", t: tr("resuming"), lb: "RESUME", l: "warn" });
  try { finishRun(await send({ type: "resumeAgent" })); }
  catch (e) { finishRun({ ok: false, error: e?.message || String(e) }); }
}

async function executePlan(planText) {
  if (running) return;
  setMode("agent");
  pushItem({ k: "u", t: tr("execPlanMsg") });
  pushItem({ k: "e", t: tr("executing"), lb: "PLAN", l: "warn" });
  setRun(true);
  lastStreamed = "";
  try {
    const r = await send({ type: "runAgent", task: "Execute this plan step by step, verifying each step and reporting evidence:\n\n" + planText, mode: "agent" });
    finishRun(r, "agent");
  } catch (e) { finishRun({ ok: false, error: e?.message || String(e) }, "agent"); }
}

async function refreshAgentState() {
  let r;
  try { r = await send({ type: "getAgentState" }); } catch { return; }
  const st = r && r.state;
  if (!st || !st.task || st.status === "idle" || st.status === "done") { hideResume(); setProgress(0, 0); return; }
  showResume(st);
  if (st.status === "running" && !running) {
    $("#status").textContent = tr("busy");
    $("#dot").classList.add("busy");
  }
  if (st.max) setProgress(st.turn || 0, st.max);
}
function showResume(st) {
  $("#resumeCard").classList.remove("hidden");
  $("#resumeTitle").textContent = st && st.status === "paused" ? tr("resumeTitle") : tr("busy");
  $("#resumeSub").textContent = (st && (st.currentAction || st.task)) || tr("resumeSub");
  $("#resumeBtn").title = tr("resume");
}
function hideResume() { $("#resumeCard").classList.add("hidden"); }

/* ----------------------------------------------- 9. streaming live */
function showThoughts() { return S.showThoughts !== false; }

/* The `streaming` setting governs the service worker. If deltas arrive at all,
   they are rendered — never buffered into lastStreamed, which would make
   finishRun think the answer had already been shown and drop it. */
function onStreamStart() {
  if (live) onStreamEnd({ final:false });
  const w = document.createElement("div");
  w.className = "msg assistant";
  const body = document.createElement("div");
  body.className = "msg-body";
  const b = document.createElement("div");
  b.className = "bubble cursor";
  body.appendChild(b);
  w.appendChild(body);
  messages.appendChild(w);
  live = { node:w, bubble:b, text:"" };
  scrollDown();
}
function onDelta(text) {
  if (!text) return;
  if (!live) onStreamStart();
  if (!live) return;
  live.text += text;
  live.bubble.innerHTML = md(live.text);
  if (nearBottom()) scrollDown(true);
}
function onStreamEnd(msg) {
  if (!live) return;
  const text = live.text.trim();
  const node = live.node;
  live = null;
  node.remove();
  if (msg && msg.final) {
    if (text) { lastStreamed = text; pushItem({ k:"a", t:text }); }
  } else if (text && showThoughts()) {
    pushItem({ k:"t", t:text });
  }
}

/* -------------------------------------------- 10. background msgs */
function onAgentEvent(m) {
  if (m.label === "MODEL" && m.model) setModelChip(m.model);
  if (m.label === "MODEL") return;              // model traffic is shown in the status bar only
  pushItem({ k: "e", t: m.text || "", lb: m.label || "AGENT", l: m.level || "", m: m.model || "" });
}
function onConfirm(m) {
  pushItem({ k: "c", t: m.action, r: m.reason, ok: null, id: m.id });
}
function onHumanCheck(m) {
  setRun(false);
  setProgress(0, 0);
  showResume({ status: "paused", currentAction: tr("humanSub") });
  pushItem({ k: "h", t: m.message || tr("humanSub"), img: m.image || "", v: m.vendor || "" });
}
function onFinished(m) {
  setRun(false);
  setProgress(0, 0);
  if (m && m.status === "paused") refreshAgentState();
  else hideResume();
}

chrome.runtime.onMessage.addListener(msg => {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case "agentEvent":      onAgentEvent(msg); break;
    case "agentDelta":      onDelta(msg.text || ""); break;
    case "agentStreamStart":onStreamStart(); break;
    case "agentStreamEnd":  onStreamEnd(msg); break;
    case "agentProgress":   setProgress(msg.step, msg.max); break;
    case "agentConfirm":    onConfirm(msg); break;
    case "humanCheck":      onHumanCheck(msg); break;
    case "humanCheckSolved":  setRun(true); hideResume(); pushItem({ k:"e", t: tr("humanSolved"), lb:"RESUME", l:"" }); break;
    case "humanCheckTimeout": setRun(false); pushItem({ k:"e", t: tr("humanTimeout"), lb:"PAUSE", l:"warn" }); break;
    case "agentFinished":   onFinished(msg); break;
    case "agentPaused":     showResume({ status: "paused", currentAction: msg.reason }); break;
  }
});

/* ------------------------------------------------- 11. history UI */
function renderHistory() {
  const box = $("#historyList");
  box.innerHTML = "";
  if (!history.length) {
    const d = document.createElement("div");
    d.className = "note";
    d.textContent = tr("noHistory");
    box.appendChild(d);
    return;
  }
  for (const c of history) {
    const row = document.createElement("div");
    row.className = "history-item";
    const open = document.createElement("button");
    open.className = "history-open" + (c.id === sessionId ? " active" : "");
    open.type = "button";
    const b = document.createElement("b");
    b.textContent = c.title || tr("newChat");
    const sm = document.createElement("small");
    const when = new Date(c.updated || c.created || Date.now());
    sm.textContent = when.toLocaleString(lang === "fa" ? "fa-IR" : "en-US", { dateStyle: "short", timeStyle: "short" });
    open.append(b, sm);
    open.onclick = () => openSession(c.id);
    const del = document.createElement("button");
    del.className = "x"; del.type = "button";
    del.title = tr("delete"); del.setAttribute("aria-label", tr("delete"));
    del.innerHTML = `<svg><use href="#i-trash"/></svg>`;
    del.onclick = () => deleteSession(c.id);
    row.append(open, del);
    box.appendChild(row);
  }
}

function openSession(id) {
  const c = history.find(x => x.id === id);
  if (!c) return;
  sessionId = id;
  items = Array.isArray(c.items) ? c.items.slice() : [];
  live = null;
  messages.innerHTML = "";
  if (!items.length) messages.innerHTML = WELCOME;
  else for (const it of items) { const n = renderItem(it); if (n) messages.appendChild(n); }
  chrome.storage.local.set({ activeSession: sessionId });
  closeDrawer("#historyDrawer");
  renderHistory();
  setProgress(0, 0);
  scrollDown(true);
  refreshAgentState();
}

async function deleteSession(id) {
  const ok = await askConfirm({
    title: tr("confirmDeleteOne"), body: esc(tr("confirmDeleteOneBody")),
    ok: tr("delete"), cancel: tr("cancel"), danger: true
  });
  if (!ok) return;
  history = history.filter(x => x.id !== id);
  await chrome.storage.local.set({ chatSessions: history });
  if (id === sessionId) startSession();
  renderHistory();
  toast(tr("delete"), "ok");
}

async function deleteAll() {
  const ok = await askConfirm({
    title: tr("confirmDeleteAll"), body: esc(tr("confirmDeleteAllBody")),
    ok: tr("deleteAll"), cancel: tr("cancel"), danger: true
  });
  if (!ok) return;
  history = [];
  await chrome.storage.local.remove("chatSessions");
  startSession();
  renderHistory();
  toast(tr("deleteAll"), "ok");
}

/* -------------------------------------------------- 12. settings */
async function loadSettings() {
  const keys = ["endpoint","fallbackEndpoints","model","verifiedModels","temperature","apiKey","remember",
    "confirmRisk","vision","system","maxSteps","retryCount","requestTimeout","streaming","showThoughts",
    "sendOnEnter","notify","lang","theme","accent","fontSize","connectionOk","lastHealthyModel","lastLatency","uiVersion",
    "speed","autoVerify","cacheSnapshot","humanAssist","dialogPolicy"];
  let d = {};
  try { d = await chrome.storage.local.get(keys); } catch {}
  const first = !d.uiVersion || d.uiVersion < 8;

  Object.assign(S, {
    endpoint: d.endpoint || "https://api.openai.com/v1",
    fallbackEndpoints: d.fallbackEndpoints || "",
    model: d.model || "",
    verifiedModels: Array.isArray(d.verifiedModels) ? d.verifiedModels : [],
    temperature: d.temperature ?? 0.15,
    apiKey: d.apiKey || "",
    remember: d.remember !== false,
    confirmRisk: d.confirmRisk !== false,
    vision: d.vision !== false,
    system: d.system || "",
    maxSteps: d.maxSteps || 40,
    retryCount: d.retryCount ?? 0,
    requestTimeout: d.requestTimeout || 18000,
    streaming: d.streaming !== false,
    showThoughts: d.showThoughts !== false,
    sendOnEnter: d.sendOnEnter !== false,
    notify: d.notify === true,
    lang: d.lang || "en",
    theme: d.theme || "dark",
    accent: d.accent || "amber",
    fontSize: d.fontSize || "md",
    speed: d.speed || "balanced",
    autoVerify: d.autoVerify !== false,
    cacheSnapshot: d.cacheSnapshot !== false,
    humanAssist: d.humanAssist !== false,
    dialogPolicy: d.dialogPolicy || "record",
    connectionOk: d.connectionOk,
    lastHealthyModel: d.lastHealthyModel || "",
    lastLatency: d.lastLatency || 0
  });
  lang = S.lang;
  if (first) chrome.storage.local.set({
    uiVersion: 8, lang, theme: S.theme, accent: S.accent, fontSize: S.fontSize, streaming: true,
    showThoughts: true, sendOnEnter: true, speed: S.speed, autoVerify: true, cacheSnapshot: true,
    humanAssist: true, dialogPolicy: "record"
  });

  fillForm();
  applyLang();
  try { $("#aboutVersion").textContent = chrome.runtime.getManifest().version; } catch {}
  if (S.verifiedModels.length) fillModels(S.verifiedModels, S.model);
  if (S.connectionOk === true && S.lastHealthyModel) setConn("good", `${tr("good")} · ${S.lastHealthyModel}`);
  else setConn("", tr("connIdle"));
  if (S.lastLatency) $("#connLatency").textContent = `${S.lastLatency} ms`;
  if (S.apiKey && !S.verifiedModels.length) discover(false);
}

function fillForm() {
  $("#endpoint").value = S.endpoint;
  $("#fallbackEndpoints").value = S.fallbackEndpoints;
  $("#temperature").value = S.temperature;
  $("#apiKey").value = S.apiKey;
  $("#remember").checked = S.remember;
  $("#confirmRisk").checked = S.confirmRisk;
  $("#vision").checked = S.vision;
  $("#streaming").checked = S.streaming;
  $("#showThoughts").checked = S.showThoughts;
  $("#sendOnEnter").checked = S.sendOnEnter;
  $("#notify").checked = S.notify;
  $("#system").value = S.system;
  $("#maxSteps").value = S.maxSteps;
  $("#retryCount").value = S.retryCount;
  $("#requestTimeout").value = S.requestTimeout;
  $("#autoVerify").checked = S.autoVerify;
  $("#cacheSnapshot").checked = S.cacheSnapshot;
  $("#humanAssist").checked = S.humanAssist;
  $("#dialogPolicy").value = S.dialogPolicy;
  $("#modelCustom").value = "";
}

function fillModels(list, selected) {
  const sel = $("#model");
  sel.innerHTML = "";
  const ids = [...new Set((list || []).filter(Boolean))];
  if (!ids.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = lang === "fa" ? "مدل تأییدشده‌ای یافت نشد" : "No verified models";
    sel.appendChild(o);
  } else {
    for (const id of ids) {
      const o = document.createElement("option");
      o.value = id; o.textContent = id;
      if (id === selected) o.selected = true;
      sel.appendChild(o);
    }
  }
  const active = selected || ids[0] || "";
  S.model = active;
  $("#connModel").textContent = active || "—";
  setModelChip(active);
}
function setConn(type, text) {
  $("#connection").className = "connection " + (type || "");
  $("#connSub").textContent = text;
  $("#dot").classList.toggle("error", type === "bad");
  $("#miniDot").classList.toggle("error", type === "bad");
}

async function discover(show = true) {
  const endpoint = $("#endpoint").value.trim();
  const key = $("#apiKey").value.trim();
  const fb = $("#fallbackEndpoints").value.trim();
  if (!endpoint || !key) { setConn("bad", tr("needEndpointKey")); if (show) toast(tr("needEndpointKey"), "err"); return false; }
  setConn("checking", tr("checking"));
  $("#connLatency").textContent = "…";
  try {
    const r = await send({ type: "discoverModels", endpoint, apiKey: key, fallbackEndpoints: fb });
    if (!r || !r.ok) throw Error((r && r.error) || "Discovery failed");
    S.verifiedModels = r.models || [];
    S.model = r.selected || "";
    S.connectionOk = true;
    fillModels(r.models, r.selected);
    $("#connLatency").textContent = r.latency ? `${r.latency} ms` : "—";
    setConn("good", `${tr("good")} · ${(r.models || []).length} ${tr("models")}`);
    if (show) toast(`${(r.models || []).length} ${tr("models")} ${tr("verified")}`, "ok");
    return true;
  } catch (e) {
    const m = e?.message || String(e);
    setConn("bad", m);
    $("#connLatency").textContent = "—";
    if (show) toast(m, "err");
    return false;
  }
}

async function save() {
  const custom = $("#modelCustom").value.trim();
  const chosen = custom || $("#model").value || S.model || "";
  const verified = [...new Set([...(S.verifiedModels || []), chosen].filter(Boolean))];
  const data = {
    endpoint: $("#endpoint").value.trim(),
    fallbackEndpoints: $("#fallbackEndpoints").value.trim(),
    model: chosen,
    temperature: clamp(Number($("#temperature").value), 0, 2, 0.15),
    remember: $("#remember").checked,
    confirmRisk: $("#confirmRisk").checked,
    vision: $("#vision").checked,
    streaming: $("#streaming").checked,
    showThoughts: $("#showThoughts").checked,
    sendOnEnter: $("#sendOnEnter").checked,
    notify: $("#notify").checked,
    system: $("#system").value,
    maxSteps: Math.round(clamp(Number($("#maxSteps").value), 5, 100, 40)),
    retryCount: Number($("#retryCount").value) || 0,
    requestTimeout: Number($("#requestTimeout").value) || 18000,
    speed: S.speed || "balanced",
    autoVerify: $("#autoVerify").checked,
    cacheSnapshot: $("#cacheSnapshot").checked,
    humanAssist: $("#humanAssist").checked,
    dialogPolicy: $("#dialogPolicy").value || "record",
    lang, theme: S.theme, accent: S.accent, fontSize: S.fontSize,
    verifiedModels: verified,
    uiVersion: 8
  };
  data.apiKey = data.remember ? $("#apiKey").value.trim() : "";
  if (!data.remember) { try { await chrome.storage.local.remove("apiKey"); } catch {} }
  Object.assign(S, data);
  try { await chrome.storage.local.set(data); } catch {}
  toast(tr("saved"), "ok");
  if (S.apiKey) await discover(true);
  else setConn("", tr("connIdle"));
  applyLang();
}
function clamp(v, lo, hi, dflt) { return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt; }

/* --------------------------------------------------- 13. drawers */
function openDrawer(sel, tab) {
  if (tab) selectTab(tab);
  $(sel).classList.add("open");
  const f = $(sel).querySelector("input, button, select, textarea");
  if (f) setTimeout(() => f.focus(), 40);
}
function closeDrawer(sel) { $(sel).classList.remove("open"); }
function anyDrawerOpen() { return $$(".drawer.open").length > 0; }
function closeTopDrawer() { const d = $$(".drawer.open").pop(); if (d) d.classList.remove("open"); return !!d; }

function selectTab(name) {
  $$(".tab").forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  });
  $$(".tabpanel").forEach(p => p.classList.toggle("hidden", p.dataset.panel !== name));
}

/* ---------------------------------------------------- 14. composer */
function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(160, Math.max(46, input.scrollHeight)) + "px";
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}
async function flashCopied(btn, ok) {
  const span = btn.querySelector("span");
  const old = span ? span.textContent : "";
  btn.classList.toggle("done", ok);
  if (span) span.textContent = ok ? tr("copied") : tr("copyFailed");
  setTimeout(() => { btn.classList.remove("done"); if (span) span.textContent = old; }, 1300);
}

function setMode(m) {
  mode = m;
  $$(".mode").forEach(b => {
    const on = b.dataset.mode === m;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  $("#composerMode").textContent = tr(m === "agent" ? "modeAgent" : m === "plan" ? "modePlan" : "modeResearch");
  try { chrome.storage.local.set({ lastMode: m }); } catch {}
}

/* -------------------------------------------------- 14b. export */
function sessionToText(c) {
  const out = [];
  for (const it of (c.items || [])) {
    if (it.k === "u")      out.push(`## User\n${it.t || ""}`);
    else if (it.k === "a") out.push(`## WebSpider\n${it.t || ""}`);
    else if (it.k === "t") out.push(`> ${it.t || ""}`);
    else if (it.k === "e") out.push(`- [${it.lb || "AGENT"}] ${it.t || ""}`);
    else if (it.k === "c") out.push(`- [CONFIRM] ${it.t || ""}${it.r ? " — " + it.r : ""}`);
    else if (it.k === "h") out.push(`- [HUMAN VERIFICATION] ${it.t || ""}`);
    else if (it.k === "p") out.push(`- [PLAN]\n${it.t || ""}`);
  }
  return out.join("\n\n");
}

function download(filename, text) {
  try {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); try { URL.revokeObjectURL(url); } catch {} }, 0);
    return true;
  } catch { return false; }
}

/* The live session is the source of truth, so fold it back into `history`
   before serialising — otherwise the newest turns would be missing. */
function currentIntoHistory() {
  const cur = history.find(x => x.id === sessionId);
  if (cur) { cur.items = items; cur.title = titleOf(); cur.updated = Date.now(); }
  return cur || null;
}

function exportSessions(list, filename, doneKey) {
  if (!list || !list.length) { toast(tr("exportEmpty"), "err"); return false; }
  let version = "";
  try { version = chrome.runtime.getManifest().version; } catch {}
  const payload = {
    app: "WebSpider",
    version,
    exportedAt: new Date().toISOString(),
    sessions: list.map(c => ({
      id: c.id,
      title: c.title || "",
      created: c.created || null,
      updated: c.updated || null,
      messages: c.items || [],
      transcript: sessionToText(c)
    }))
  };
  const ok = download(filename, JSON.stringify(payload, null, 2));
  toast(ok ? tr(doneKey) : tr("exportFailed"), ok ? "ok" : "err");
  return ok;
}

const stamp = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------- 15. wire events */
$("#run").onclick = () => runTask();
$("#stop").onclick = async () => {
  try { await send({ type: "stopAgent" }); } catch {}
  setRun(false);
  pushItem({ k: "e", t: tr("taskPaused"), lb: "PAUSE", l: "warn" });
  showResume({ status: "paused", currentAction: tr("resumeSub") });
};
$("#resumeBtn").onclick = resumeTask;
$("#resumeDismiss").onclick = hideResume;
$("#scrollFab").onclick = () => scrollDown(true);

input.addEventListener("input", autoGrow);
input.addEventListener("keydown", e => {
  if (e.isComposing || e.keyCode === 229) return;
  const sendOnEnter = S.sendOnEnter !== false;
  if (e.key === "Enter" && !e.shiftKey && (sendOnEnter || e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    runTask();
  }
});

messages.addEventListener("click", async e => {
  const quick = e.target.closest(".quick[data-prompt]");
  if (quick) { input.value = quick.dataset.prompt; autoGrow(); runTask(); return; }

  const cp = e.target.closest("[data-copy]");
  if (cp) {
    const kind = cp.dataset.copy;
    const scope = kind === "code" ? cp.closest(".codeblock") : cp.closest(".msg");
    const src = kind === "code" ? scope?.querySelector("code") : scope?.querySelector(".bubble");
    const text = kind === "code" ? (src?.textContent || "") : (src?.innerText || "");
    if (!text.trim()) return;
    flashCopied(cp, await copyText(text));
    if (!cp.classList.contains("done")) toast(tr("copyFailed"), "err");
    return;
  }
  const link = e.target.closest("a[href]");
  if (link) { e.preventDefault(); try { chrome.tabs.create({ url: link.href }); } catch {} }
});

messages.addEventListener("scroll", () => $("#scrollFab").classList.toggle("hidden", nearBottom()), { passive: true });

$$(".mode").forEach(b => { b.onclick = () => setMode(b.dataset.mode); });

$("#newChat").onclick = () => { startSession(); toast(tr("newChat"), "ok", 1500); };
$("#newChat2").onclick = () => { closeDrawer("#historyDrawer"); startSession(); };
$("#historyBtn").onclick = () => { renderHistory(); openDrawer("#historyDrawer"); };
$("#historyClose").onclick = () => closeDrawer("#historyDrawer");
$("#deleteHistory").onclick = deleteAll;
$("#exportChat").onclick = () => {
  const cur = currentIntoHistory();
  exportSessions(cur ? [cur] : [], `webspider-${stamp()}.json`, "exported");
};
$("#exportAll").onclick = () => {
  currentIntoHistory();
  exportSessions(history, `webspider-all-${stamp()}.json`, "exportAllDone");
};
$("#settings").onclick = () => openDrawer("#drawer");
$("#close").onclick = () => closeDrawer("#drawer");
$("#save").onclick = save;
$("#clear").onclick = deleteAll;
$("#refreshModels").onclick = () => discover(true);
$("#testConn").onclick = () => discover(true);
$("#toggleKey").onclick = () => {
  const k = $("#apiKey");
  k.type = k.type === "password" ? "text" : "password";
};

$$(".tab").forEach(t => { t.onclick = () => selectTab(t.dataset.tab); });

$("#themeBtn").onclick = () => {
  const cur = document.documentElement.dataset.theme;
  S.theme = cur === "dark" ? "light" : "dark";
  applyAppearance();
  chrome.storage.local.set({ theme: S.theme });
};
$("#lang").onclick = () => setLang(lang === "en" ? "fa" : "en");

function setLang(next) {
  lang = next; S.lang = next;
  chrome.storage.local.set({ lang: next });
  applyLang();
  fillModels(S.verifiedModels, S.model);
  renderHistory();
}
$("#langSeg").addEventListener("click", e => { const b = e.target.closest("button[data-val]"); if (b) setLang(b.dataset.val); });
$("#themeSeg").addEventListener("click", e => {
  const b = e.target.closest("button[data-val]"); if (!b) return;
  S.theme = b.dataset.val; applyAppearance(); chrome.storage.local.set({ theme: S.theme });
});
$("#fsSeg").addEventListener("click", e => {
  const b = e.target.closest("button[data-val]"); if (!b) return;
  S.fontSize = b.dataset.val; applyAppearance(); chrome.storage.local.set({ fontSize: S.fontSize });
});
$("#speedSeg").addEventListener("click", e => {
  const b = e.target.closest("button[data-val]"); if (!b) return;
  S.speed = b.dataset.val; applyAppearance(); chrome.storage.local.set({ speed: S.speed });
});
$("#accentSeg").addEventListener("click", e => {
  const b = e.target.closest("button[data-val]"); if (!b) return;
  S.accent = b.dataset.val; applyAppearance(); chrome.storage.local.set({ accent: S.accent });
});
$("#resetUi").onclick = () => {
  S.theme = "dark"; S.accent = "amber"; S.fontSize = "md";
  applyAppearance();
  chrome.storage.local.set({ theme: S.theme, accent: S.accent, fontSize: S.fontSize });
  toast(tr("reset"), "ok");
};
$("#clearState").onclick = async () => {
  try { await send({ type: "clearAgentState" }); } catch {}
  hideResume(); setProgress(0, 0);
  toast(tr("cleared"), "ok");
};
$("#attachPage").onclick = async () => {
  try {
    const r = await send({ type: "pageSummary" });
    if (r && r.ok) pushItem({ k: "a", t: "```json\n" + (r.message || "") + "\n```" });
    else pushItem({ k: "a", t: (r && r.error) || tr("noPageData"), err: true });
  } catch (e) { pushItem({ k: "a", t: e?.message || String(e), err: true }); }
};
$("#diagnoseBtn").onclick = () => {
  input.value = "Diagnose this page for visible errors, broken images, slow resources, suspicious links, form problems and common UX issues. Verify findings before reporting.";
  autoGrow();
  runTask();
};

/* modal */
$$("[data-modal-close]").forEach(el => { el.onclick = () => closeModal(false); });
$("#modalOk").onclick = () => closeModal(true);
$("#modalCancel").onclick = () => closeModal(false);

/* keyboard */
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    if (!$("#modal").classList.contains("hidden")) { e.preventDefault(); closeModal(false); return; }
    if (closeTopDrawer()) { e.preventDefault(); return; }
    if (document.activeElement === input) input.blur();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.focus(); return; }
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const map = { "1": "agent", "2": "plan", "3": "research" };
    if (map[e.key]) { e.preventDefault(); setMode(map[e.key]); }
  }
});

window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if ((S.theme || "dark") === "system") applyAppearance();
});

/* ------------------------------------------------------ 16. boot */
(async function boot() {
  try {
    const d = await chrome.storage.local.get(["chatSessions", "activeSession", "lastMode"]);
    history = Array.isArray(d.chatSessions) ? d.chatSessions : [];
    const active = d.activeSession;
    if (active && history.some(x => x.id === active)) {
      sessionId = active;
      const c = history.find(x => x.id === active);
      items = Array.isArray(c.items) ? c.items.slice() : [];
      if (items.length) for (const it of items) { const n = renderItem(it); if (n) messages.appendChild(n); }
    } else {
      sessionId = "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }
    if (!items.length) messages.innerHTML = WELCOME;
    if (d.lastMode && ["agent","plan","research"].includes(d.lastMode)) setMode(d.lastMode);
  } catch {
    sessionId = "s_" + Date.now().toString(36);
    messages.innerHTML = WELCOME;
  }
  setRun(false);
  autoGrow();
  await loadSettings();
  setMode(mode);
  renderHistory();
  scrollDown(true);
  $("#scrollFab").classList.add("hidden");
  refreshAgentState();
})();
})();

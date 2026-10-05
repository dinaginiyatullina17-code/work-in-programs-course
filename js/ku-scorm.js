/* ════════════════════════════════════════════════════════════════════════
   SCORM 1.2 — рантайм курса. Копируется в курс как js/ku-scorm.js БЕЗ ПРАВОК.

   ЕДИНСТВЕННЫЙ способ завершить курс — клик по [data-ku-complete].
   Кнопка ведёт себя одинаково во всех курсах и не зависит ни от каких
   настроек: ни от course.json, ни от атрибутов разметки, ни от режимов.

   ПОСЛЕДОВАТЕЛЬНОСТЬ ПРИ КЛИКЕ
       cmi.suspend_data, cmi.core.session_time = HHHH:MM:SS.SS
       cmi.core.lesson_status = "passed"
       LMSCommit("")                   ← LMSFinish НЕ зовём (см. complete())
       экран «Курс пройден»
       раз в секунду, 8 раз: lesson_status = "passed", LMSCommit("")
                                       ← повторная запись закрывает попытку в WebTutor

   Итоговый статус — passed, а не completed: эталонный пакет Articulate
   (BK_2_allergeny) настроен «Report status to LMS as: Passed/Incomplete».

   ДО ЗАВЕРШЕНИЯ
       при первом сохранении, если статуса ещё нет, ставится "incomplete" —
       вторая половина той же пары Passed/Incomplete. Уже полученный
       passed/completed никогда не понижается.

   РАЗМЕТКА
       <html data-ku-course="идентификатор-курса">
       <button data-ku-complete>Завершить курс</button>
       <script src="js/ku-scorm.js"></script>   — до скриптов курса

   API ДЛЯ КОДА КУРСА
       KU.complete()                       — то же, что клик по кнопке
       KU.vars.get/set/all                 — поля свободного ответа
       KU.progress.markDone/isDone         — решённые упражнения
       KU.progress.setUnlocked/unlocked    — открытые главы
       KU.save()                           — форс-сохранение
       KU.state, KU.inLMS
       события: ku:ready, ku:done, ku:completed
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  /* ══ 1. SCORM 1.2 API ═══════════════════════════════════════════════ */
  var api = null;
  var lmsReady = false;
  var startedAt = Date.now();

  function findAPI(win) {
    try {
      var n = 0;
      while (win && n++ < 10) {
        if (win.API) return win.API;
        if (win === win.parent) break;
        win = win.parent;
      }
    } catch (e) { /* другой домен — считаем, что LMS нет */ }
    return null;
  }
  function lmsInit() {
    api = findAPI(window);
    if (!api && window.opener) api = findAPI(window.opener);
    if (!api) return;
    try { api.LMSInitialize(""); lmsReady = true; }
    catch (e) { api = null; lmsReady = false; }
  }
  function lmsGet(k) {
    if (!lmsReady) return "";
    try { return String(api.LMSGetValue(k) || ""); } catch (e) { return ""; }
  }
  function lmsSet(k, v) {
    if (!lmsReady) return;
    try { api.LMSSetValue(k, String(v)); } catch (e) {}
  }
  function lmsCommit() {
    if (!lmsReady) return;
    try { api.LMSCommit(""); } catch (e) {}
  }
  function lmsFinish() {
    if (!lmsReady) return;
    try { api.LMSFinish(""); } catch (e) {}
    lmsReady = false;
  }

  /* Длительность сеанса в формате SCORM 1.2 — HHHH:MM:SS.SS */
  function sessionTime() {
    var t = Math.max(0, Date.now() - startedAt) / 1000;
    function pad(n, w) {
      var s = String(Math.floor(n));
      while (s.length < w) s = "0" + s;
      return s;
    }
    return pad(t / 3600, 4) + ":" + pad((t % 3600) / 60, 2) + ":" +
           pad(t % 60, 2) + "." + pad((t % 1) * 100, 2);
  }

  /* ══ 2. СОСТОЯНИЕ И ХРАНИЛИЩЕ ═══════════════════════════════════════ */
  var COURSE_ID = document.documentElement.getAttribute("data-ku-course") ||
                  location.pathname;
  var LS_KEY = "ku::" + COURSE_ID;

  var state = { unlocked: 1, done: {}, vars: {}, completed: false };

  function lsGet() { try { return localStorage.getItem(LS_KEY) || ""; } catch (e) { return ""; } }
  function lsSet(v) { try { localStorage.setItem(LS_KEY, v); } catch (e) {} }

  /* suspend_data в SCORM 1.2 — не длиннее 4096 символов. Если не влезаем,
     режем свободные ответы, в крайнем случае выкидываем их совсем:
     структура прогресса важнее текстов. */
  function serialize(full) {
    var snap = { unlocked: state.unlocked, done: state.done,
                 vars: state.vars, completed: state.completed };
    var json = JSON.stringify(snap);
    if (full || json.length <= 4000) return json;
    var trimmed = {}, k;
    for (k in snap.vars) {
      var v = String(snap.vars[k]);
      trimmed[k] = v.length > 120 ? v.slice(0, 119) + "…" : v;
    }
    json = JSON.stringify({ unlocked: snap.unlocked, done: snap.done,
                            vars: trimmed, completed: snap.completed });
    if (json.length <= 4000) return json;
    return JSON.stringify({ unlocked: snap.unlocked, done: snap.done,
                            vars: {}, completed: snap.completed });
  }

  var saveTimer = null;
  function save() {
    lsSet(serialize(true));
    if (!lmsReady) return;
    lmsSet("cmi.suspend_data", serialize(false));
    // Вторая половина пары Passed/Incomplete. Ставим только тому курсу,
    // который ещё не пройден: иначе повторный вход понизил бы статус.
    var status = lmsGet("cmi.core.lesson_status");
    if (!state.completed &&
        (status === "" || status === "not attempted" || status === "unknown")) {
      lmsSet("cmi.core.lesson_status", "incomplete");
    }
    lmsCommit();
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }

  function load() {
    var json = lmsReady ? lmsGet("cmi.suspend_data") : "";
    // Локальная копия — только без LMS или когда LMS продолжает попытку.
    // Новая попытка (entry ≠ resume) начинается с нуля: иначе повторно
    // назначенный курс открылся бы пройденным и не получил бы incomplete.
    if (!json && (!lmsReady || lmsGet("cmi.core.entry") === "resume")) json = lsGet();
    if (json) {
      try {
        var s = JSON.parse(json);
        if (typeof s.unlocked === "number") state.unlocked = Math.max(1, s.unlocked);
        if (s.done && typeof s.done === "object") state.done = s.done;
        if (s.vars && typeof s.vars === "object") state.vars = s.vars;
        if (s.completed) state.completed = true;
      } catch (e) { /* мусор в хранилище игнорируем */ }
    }
    // Курс могли пройти на другом устройстве — верим статусу в LMS.
    var st = lmsGet("cmi.core.lesson_status");
    if (st === "passed" || st === "completed") state.completed = true;
  }

  /* ══ 3. ЗАВЕРШЕНИЕ — ТОЛЬКО ПО КНОПКЕ ═══════════════════════════════ */
  var finished = false;
  var confirmTimer = null;
  var CONFIRM_EVERY = 1000;              // мс между подтверждениями passed
  var CONFIRM_TIMES = 8;                 // сколько раз подтвердить

  function confirmPassed() {
    lmsSet("cmi.core.lesson_status", "passed");
    lmsCommit();
  }

  function complete() {
    if (finished) return;
    finished = true;
    state.completed = true;
    lsSet(serialize(true));

    // Отклик кнопки — до вызовов LMS.
    var btns = document.querySelectorAll("[data-ku-complete]");
    for (var i = 0; i < btns.length; i++) btns[i].classList.add("is-completed");
    document.dispatchEvent(new CustomEvent("ku:completed"));
    showGoodbye();

    if (!lmsReady) return;

    lmsSet("cmi.suspend_data", serialize(false));
    lmsSet("cmi.core.session_time", sessionTime());
    lmsSet("cmi.core.lesson_status", "passed");
    lmsCommit();

    /* LMSFinish НЕ вызываем: WebTutor принял бы его за выход ученика.

       Попытку WebTutor закрывает сам (ответ SESSION=F, свой флажок «Курс
       завершен») на записи passed, которая приходит, когда первая запись уже
       обработана: первая переводит курс лишь в «Завершен». Обрабатывается она
       ~2,5 с, а LMSCommit возвращается сразу — момент её окончания курсу не
       виден. Поэтому passed подтверждается раз в секунду, CONFIRM_TIMES раз:
       первое подтверждение после окончания первой записи закрывает попытку,
       лишние после закрытия безвредны (ответ ERROR=0). Проверено на WebTutor
       03.10.2026. */
    var n = 0;
    confirmTimer = setInterval(function () {
      confirmPassed();
      if (++n >= CONFIRM_TIMES) { clearInterval(confirmTimer); confirmTimer = null; }
    }, CONFIRM_EVERY);
  }

  function showGoodbye() {
    if (document.getElementById("ku-done")) return;

    var css = document.createElement("style");
    css.textContent =
      "#ku-done{position:fixed;inset:0;z-index:2147483647;display:flex;" +
      "align-items:center;justify-content:center;padding:1.5rem;" +
      "background:color-mix(in srgb, var(--ku-text,#1b1f2a) 55%, transparent);" +
      "backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}" +
      "#ku-done .ku-done__card{width:min(100%,28rem);text-align:center;" +
      "padding:2.2rem 1.8rem;border-radius:var(--ku-radius-xl,20px);" +
      "background:var(--ku-elevated,var(--ku-card,#fff));color:var(--ku-text,#1b1f2a);" +
      "box-shadow:var(--ku-shadow-l,0 18px 50px rgba(0,0,0,.22));" +
      "font:400 1rem/1.55 var(--ku-font-body,system-ui,-apple-system,sans-serif)}" +
      "#ku-done .ku-done__mark{width:3.25rem;height:3.25rem;margin:0 auto 1rem;" +
      "border-radius:50%;display:grid;place-items:center;" +
      "background:var(--ku-success,#2e9e5b);color:#fff;font-size:1.6rem;line-height:1}" +
      "#ku-done h2{margin:0 0 .45em;font:700 1.45rem/1.25 " +
      "var(--ku-font-display,var(--ku-font-body,inherit));color:inherit}" +
      "#ku-done p{margin:0;color:var(--ku-text-muted,var(--ku-text-soft,#6b7280))}";
    document.head.appendChild(css);

    var el = document.createElement("div");
    el.id = "ku-done";
    el.setAttribute("role", "alertdialog");
    el.setAttribute("aria-live", "assertive");
    el.innerHTML =
      '<div class="ku-done__card">' +
      '<div class="ku-done__mark" aria-hidden="true">✓</div>' +
      "<h2>Курс пройден</h2>" +
      "<p>Результат отправлен в систему обучения.<br>Это окно можно закрыть.</p>" +
      "</div>";
    document.body.appendChild(el);
    document.body.style.overflow = "hidden";
  }


  /* Ушёл, не завершив: фиксируем время и помечаем попытку приостановленной —
     так же делает Suspend() в драйвере эталона. pagehide надёжнее
     beforeunload: в мобильных браузерах и внутри iframe он приходит чаще. */
  var left = false;
  function leave() {
    if (left || !lmsReady) return;
    if (finished) {
      // Закрыл окно, не дождавшись подтверждений, — подтверждаем напоследок.
      if (confirmTimer) { left = true; clearInterval(confirmTimer); confirmPassed(); }
      return;
    }
    left = true;
    lmsSet("cmi.suspend_data", serialize(false));
    lmsSet("cmi.core.session_time", sessionTime());
    lmsSet("cmi.core.exit", "suspend");
    lmsCommit();
    lmsFinish();
  }

  function bindComplete() {
    var btns = document.querySelectorAll("[data-ku-complete]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", complete);
    }
  }

  /* ══ 4. ПОЛЯ СВОБОДНОГО ОТВЕТА ══════════════════════════════════════ */
  function fieldValue(el) {
    if (el.type === "checkbox") return el.checked ? (el.value || "да") : "";
    if (el.type === "radio") return el.checked ? el.value : undefined;
    return el.value;
  }
  function bindVars() {
    var els = document.querySelectorAll("[data-ku-var]");
    for (var i = 0; i < els.length; i++) bindOne(els[i]);
    function bindOne(el) {
      var name = el.getAttribute("data-ku-var");
      var saved = state.vars[name];
      if (saved !== undefined) {
        if (el.type === "checkbox") el.checked = saved !== "";
        else if (el.type === "radio") { if (el.value === saved) el.checked = true; }
        else el.value = saved;
      }
      function onChange() {
        var v = fieldValue(el);
        if (v !== undefined) { state.vars[name] = v; saveSoon(); }
      }
      el.addEventListener("input", onChange);
      el.addEventListener("change", onChange);
    }
  }

  /* ══ 5. ПРОГРЕСС ════════════════════════════════════════════════════ */
  function decorateDone(id) {
    var els = document.querySelectorAll('[data-ku-id="' + id.replace(/"/g, '\\"') + '"]');
    for (var i = 0; i < els.length; i++) els[i].classList.add("is-done");
  }
  var progress = {
    markDone: function (id) {
      if (!id || state.done[id]) return;
      state.done[id] = true;
      decorateDone(id);
      document.dispatchEvent(new CustomEvent("ku:done", { detail: id }));
      save();
    },
    isDone: function (id) { return !!state.done[id]; },
    setUnlocked: function (n) { if (n > state.unlocked) { state.unlocked = n; save(); } },
    unlocked: function () { return state.unlocked; },
  };

  /* ══ 6. ЗАПУСК ══════════════════════════════════════════════════════ */
  // На 'load', не DOMContentLoaded: LMS подключает API к окну позже разметки.
  window.addEventListener("load", function () {
    lmsInit();
    load();
    bindVars();
    bindComplete();
    for (var id in state.done) decorateDone(id);
    document.dispatchEvent(new CustomEvent("ku:ready", { detail: state }));
  });
  window.addEventListener("pagehide", leave);
  window.addEventListener("beforeunload", leave);

  window.KU = {
    complete: complete,
    save: save,
    vars: {
      get: function (n) { return state.vars[n]; },
      set: function (n, v) { state.vars[n] = v; saveSoon(); },
      all: function () { var o = {}, k; for (k in state.vars) o[k] = state.vars[k]; return o; },
    },
    progress: progress,
    get state() { return state; },
    get inLMS() { return lmsReady; },
  };
})();

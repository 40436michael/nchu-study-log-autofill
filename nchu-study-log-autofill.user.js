// ==UserScript==
// @name         中興大學出勤系統 - 學習日誌自動填寫
// @namespace    https://psf.nchu.edu.tw/
// @version      5.3
// @description  在「學習日誌」表單頁面，指定日期範圍與需要天數（可跨多個月、每月各挑幾天），自動跳過六日挑選工作天並逐筆送出；起訖日期可手打西元/民國（可只寫到月份，如 115年5月）或用日曆選擇；送出中途網頁被整頁重新整理也會自動接續；全部送完後自動切到「學習日誌列印」並帶入校內編號，跨月時每個月分開帶入日期範圍、按一次列印就換下一個月
// @author       you
// @match        https://psf.nchu.edu.tw/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ========================================================
  // 這裡只是「表單一開始的預設值」，之後在頁面上的面板裡
  // 都可以直接改，不用再回來改程式碼。
  // ========================================================
  const DEFAULTS = {
    startDate: '2026-08-01',   // 起始日期（西元, yyyy-mm-dd）
    endDate: '2026-08-20',     // 結束日期（西元, yyyy-mm-dd）
    neededDays: 4,             // 需要幾個工作天
    needMode: 'month',         // 'month' = 每個月各需要 neededDays 天；'total' = 整段範圍合計 neededDays 天
    excludeDates: '',          // 額外要排除的日期（西元 yyyy-mm-dd，逗號分隔），例如國定假日、補假
    work: '協助資料整理、資料標記',
    schno: '115RB004',
    delayAfterSubmitMs: 1800,
    delayBeforeSubmitMs: 300,
    resumeGapMs: 500,          // 同一頁內，送完一筆到接著送下一筆之間的緩衝時間
  };
  // ========================================================

  const JOB_KEY = 'nchu_af_active_job_v1';
  const PRINT_JOB_KEY = 'nchu_af_print_request_v1';

  // 「學習日誌」本身的表單
  function hasForm() {
    return !!(
      document.getElementById('date') &&
      document.getElementById('work') &&
      document.getElementById('schno') &&
      document.getElementById('btnSent')
    );
  }

  // 「學習日誌列印」查詢表單（校內編號 + 起訖日期 + 列印按鈕）
  function hasPrintForm() {
    return !!(
      document.getElementById('dtQryBeg') &&
      document.getElementById('dtQryEnd') &&
      document.getElementById('schno') &&
      document.getElementById('btnSent')
    );
  }

  // 等到「學習日誌」表單或「學習日誌列印」表單其中一種出現為止，
  // 回傳 'log' / 'print' / null（逾時都沒找到）
  function waitForAnyForm(timeoutMs) {
    return new Promise((resolve) => {
      function check() {
        if (hasForm()) return 'log';
        if (hasPrintForm()) return 'print';
        return null;
      }
      const first = check();
      if (first) return resolve(first);
      const start = Date.now();
      const timer = setInterval(() => {
        const kind = check();
        if (kind) {
          clearInterval(timer);
          resolve(kind);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 200);
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  // 西元 Date -> 民國 yyymmdd（表單欄位要求的格式）
  function toRocString(date) {
    const rocYear = date.getFullYear() - 1911;
    return String(rocYear) + pad2(date.getMonth() + 1) + pad2(date.getDate());
  }

  // 西元 Date -> yyyy-mm-dd（純顯示、比對用）
  function toIsoString(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  // 寬鬆的日期解析，西元、民國都吃：
  //   2026-05-01、2026/5/1、20260501、115-05-01、115/5/1、1150501、115年5月1日
  // 只寫到「月」也可以（例如 115年5月、2026-05、115/5）：
  //   mode = 'start' → 該月 1 號；mode = 'end' → 該月最後一天；mode = 'exact' → 不接受只寫到月
  // 年份 4 位數視為西元，2~3 位數視為民國。
  function parseFlexibleDate(str, mode) {
    const s = String(str || '').trim().replace(/\s+/g, '');
    if (!s) return null;
    let mt;
    let y, m, d;
    if ((mt = /^(\d{2,4})年(\d{1,2})月(?:(\d{1,2})日?)?$/.exec(s))) {
      [y, m, d] = [mt[1], mt[2], mt[3]];
    } else if ((mt = /^(\d{2,4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$/.exec(s))) {
      [y, m, d] = [mt[1], mt[2], mt[3]];
    } else if ((mt = /^(\d{3,4})(\d{2})(\d{2})$/.exec(s))) {
      [y, m, d] = [mt[1], mt[2], mt[3]];
    } else {
      return null;
    }
    y = Number(y);
    m = Number(m);
    if (y < 1000) y += 1911;
    if (m < 1 || m > 12) return null;
    if (d === undefined) {
      if (mode === 'exact') return null;
      d = mode === 'end' ? new Date(y, m, 0).getDate() : 1;
    } else {
      d = Number(d);
    }
    const date = new Date(y, m - 1, d);
    // 擋掉 2026-02-31 這種會被 Date 自動進位成 3 月的日期
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    return date;
  }

  function parseExcludeSet(text) {
    const set = new Set();
    String(text)
      .split(/[,，、;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((s) => {
        const d = parseFlexibleDate(s, 'exact');
        if (d) set.add(toIsoString(d));
      });
    return set;
  }

  function monthKey(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1);
  }

  // 每個月各自挑 perMonth 個工作天（範圍頭尾若只涵蓋半個月，就只在涵蓋到的那幾天裡挑）。
  // 回傳 [{ key: 'yyyy-mm', picks: [Date...] }, ...]
  function pickWorkdaysPerMonth(start, end, perMonth, excludeSet) {
    const groups = [];
    let cur = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur <= end) {
      const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      const from = cur < start ? start : cur;
      const to = monthEnd > end ? end : monthEnd;
      groups.push({ key: monthKey(cur), picks: pickWorkdays(from, to, perMonth, excludeSet) });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    return groups;
  }

  // 在 [start, end] 範圍內，跳過六日與 excludeSet 中的日期，
  // 依序挑出最多 neededDays 個工作天
  function pickWorkdays(start, end, neededDays, excludeSet) {
    const result = [];
    const cur = new Date(start.getTime());
    while (cur <= end && result.length < neededDays) {
      const day = cur.getDay(); // 0=日 6=六
      const iso = toIsoString(cur);
      if (day !== 0 && day !== 6 && !excludeSet.has(iso)) {
        result.push(new Date(cur.getTime()));
      }
      cur.setDate(cur.getDate() + 1);
    }
    return result;
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 保留原始 alert/confirm，讓真正需要使用者回應的確認視窗（例如一開始的「確定要送出嗎？」）
  // 永遠是「真的」在問使用者；只在每一筆實際送出的當下才短暫蓋掉，送完立刻還原。
  const originalAlert = window.alert.bind(window);
  const originalConfirm = window.confirm.bind(window);

  function patchDialogs() {
    try {
      window.alert = function (msg) {
        console.log('[學習日誌自動填寫] 系統訊息(alert 已自動略過):', msg);
      };
      window.confirm = function (msg) {
        console.log('[學習日誌自動填寫] 系統詢問(confirm 已自動確認):', msg);
        return true;
      };
    } catch (e) {
      // 忽略
    }
  }

  function restoreDialogs() {
    try {
      window.alert = originalAlert;
      window.confirm = originalConfirm;
    } catch (e) {
      // 忽略
    }
  }

  async function submitOneDate(dateStr, work, schno) {
    const dateInput = document.getElementById('date');
    const workInput = document.getElementById('work');
    const schnoSelect = document.getElementById('schno');
    const btn = document.getElementById('btnSent');

    if (!dateInput || !workInput || !schnoSelect || !btn) {
      throw new Error('表單欄位不齊全，可能頁面結構有變動');
    }

    setNativeValue(dateInput, dateStr);
    setNativeValue(workInput, work);
    schnoSelect.value = schno;
    schnoSelect.dispatchEvent(new Event('change', { bubbles: true }));

    await sleep(DEFAULTS.delayBeforeSubmitMs);
    btn.click();
    await sleep(DEFAULTS.delayAfterSubmitMs);
  }

  function getDoneSet(schno) {
    try {
      return new Set(JSON.parse(localStorage.getItem('nchu_study_log_autofill_done_' + schno) || '[]'));
    } catch (e) {
      return new Set();
    }
  }
  function saveDoneSet(schno, set) {
    localStorage.setItem('nchu_study_log_autofill_done_' + schno, JSON.stringify([...set]));
  }

  // ---- 跨頁面重新整理也能接續的「批次佇列」 ----
  // 存進 localStorage，所以就算送出過程中網站把 iframe 整頁重新整理、
  // 我們目前的程式被腰斬，下一次腳本重新注入時還是讀得到還沒跑完的清單，
  // 可以自動接著跑，不用使用者再按一次按鈕。
  function readJob() {
    try {
      const raw = localStorage.getItem(JOB_KEY);
      if (!raw) return null;
      const job = JSON.parse(raw);
      if (!job || !Array.isArray(job.queue)) return null;
      return job;
    } catch (e) {
      return null;
    }
  }
  function saveJob(job) {
    localStorage.setItem(JOB_KEY, JSON.stringify(job));
  }
  function clearJob() {
    localStorage.removeItem(JOB_KEY);
  }

  function log(panel, msg) {
    const line = document.createElement('div');
    line.textContent = msg;
    panel.logEl.appendChild(line);
    panel.logEl.scrollTop = panel.logEl.scrollHeight;
    console.log('[學習日誌自動填寫]', msg);
  }

  // ---- 送完一批日期後，自動幫忙切到「學習日誌列印」並帶好查詢條件 ----
  // 列印請求放太久（例如上次沒印完就關掉）就當作過期，免得之後手動點進列印頁還被帶入舊資料
  const PRINT_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  // 把送出過的民國日期（yyymmdd）依月份分組，每個月一筆列印範圍：該月 1 號 ~ 月底
  function buildPrintMonths(rocDates) {
    const keys = [...new Set(rocDates.map((s) => String(s).slice(0, -2)))].sort();
    return keys.map((key) => {
      const rocYear = Number(key.slice(0, -2));
      const month = Number(key.slice(-2));
      const lastDay = new Date(rocYear + 1911, month, 0).getDate();
      return {
        label: `${rocYear}年${month}月`,
        start: key + '01',
        end: key + pad2(lastDay),
        printed: false,
      };
    });
  }

  function savePrintJob(job) {
    localStorage.setItem(PRINT_JOB_KEY, JSON.stringify(job));
  }
  function readPrintJob() {
    try {
      const raw = localStorage.getItem(PRINT_JOB_KEY);
      if (!raw) return null;
      const job = JSON.parse(raw);
      if (!job) return null;
      // 舊版（5.1 以前）存的是單一 start/end，轉成只有一個月的格式
      if (!Array.isArray(job.months)) {
        if (!job.start || !job.end) return null;
        job.months = [{ label: `${job.start} ~ ${job.end}`, start: job.start, end: job.end, printed: false }];
        job.index = 0;
      }
      if (job.months.length === 0) return null;
      if (job.createdAt && Date.now() - job.createdAt > PRINT_JOB_MAX_AGE_MS) {
        localStorage.removeItem(PRINT_JOB_KEY);
        return null;
      }
      if (!(job.index >= 0 && job.index < job.months.length)) job.index = 0;
      return job;
    } catch (e) {
      return null;
    }
  }
  function clearPrintJob() {
    localStorage.removeItem(PRINT_JOB_KEY);
  }

  // 我們現在跑在「學習日誌」那個 iframe 裡，左側選單其實是在最外層(frameset)頁面，
  // 但因為同源，可以直接透過 window.top 去點擊選單連結，讓 iframe 換頁到「學習日誌列印」。
  function goToPrintMenu() {
    try {
      const links = window.top.document.querySelectorAll('#menu a');
      for (const a of links) {
        if (a.textContent.trim() === '學習日誌列印') {
          a.click();
          return true;
        }
      }
    } catch (e) {
      console.log('[學習日誌自動填寫] 嘗試切換到學習日誌列印失敗：', e);
    }
    return false;
  }

  function updateJobStatus(panel, job) {
    if (!job) {
      panel.jobStatus.textContent = '目前沒有進行中的批次。';
      panel.cancelBtn.disabled = true;
      return;
    }
    panel.jobStatus.textContent =
      `進行中：校內編號 ${job.schno}，工作內容「${job.work}」，剩 ${job.queue.length} / ${job.total} 筆待處理。`;
    panel.cancelBtn.disabled = false;
  }

  // 處理佇列裡的下一筆。若這個文件在送出過程中被整頁重新整理換掉，
  // 這個函式後面的程式碼就不會繼續跑（因為整個JS環境被換掉了）——
  // 沒關係，新頁面重新注入的腳本在一開始（init）會自動偵測到佇列還有東西，接著呼叫這個函式繼續處理。
  async function runQueueStep(panel) {
    const job = readJob();
    if (!job) {
      updateJobStatus(panel, null);
      return;
    }
    if (job.queue.length === 0) {
      log(panel, `批次已全部處理完畢（共 ${job.total} 筆），請到學習日誌列表或列印頁確認每筆是否都成功新增。`);
      clearJob();
      updateJobStatus(panel, null);
      panel.startBtn.disabled = false;

      // 全部送完後，自動幫忙切換到「學習日誌列印」並帶好校內編號、起訖日期，
      // 少一道自己回想日期範圍、重新選校內編號的手續；最後那一下「列印」還是要你自己按。
      const months = buildPrintMonths(job.allDates || []);
      if (months.length > 0) {
        savePrintJob({ schno: job.schno, months, index: 0, createdAt: Date.now() });
        log(
          panel,
          `準備自動切換到「學習日誌列印」，校內編號 ${job.schno}，共 ${months.length} 個月要分開列印：${months
            .map((m) => m.label)
            .join('、')}...`
        );
        const ok = goToPrintMenu();
        if (!ok) {
          log(panel, '⚠️ 沒能自動找到「學習日誌列印」選單連結，麻煩自己點一下左側選單，欄位會自動幫你帶好。');
        }
      }
      return;
    }

    const rocStr = job.queue[0];
    job.queue = job.queue.slice(1);
    saveJob(job); // 先存檔再送出，就算等一下整頁重新整理也不會重複送出同一筆
    updateJobStatus(panel, job);

    log(panel, `${rocStr}：填寫並送出中...（剩 ${job.queue.length} 筆待處理）`);
    patchDialogs();
    try {
      await submitOneDate(rocStr, job.work, job.schno);
      const doneSet = getDoneSet(job.schno);
      doneSet.add(rocStr);
      saveDoneSet(job.schno, doneSet);
      log(panel, `${rocStr}：已送出 ✅`);
    } catch (err) {
      log(panel, `${rocStr}：送出失敗 ❌ (${err.message})，請確認後手動處理`);
    } finally {
      restoreDialogs();
    }

    // 這個文件還活著（沒被整頁重新整理換掉）就繼續處理下一筆；
    // 如果被換掉了，下面這幾行根本不會被執行到。
    if (hasForm()) {
      await sleep(DEFAULTS.resumeGapMs);
      runQueueStep(panel);
    }
  }

  // 直接讀取原本表單「校內編號」下拉選單裡現成的選項，
  // 這樣我們面板上的下拉選單一定跟系統上的一致，不用自己維護一份清單。
  function getSchnoOptionsFromPage() {
    const select = document.getElementById('schno');
    if (!select) return [];
    return Array.from(select.options).map((opt) => ({
      value: opt.value,
      text: opt.textContent.trim(),
    }));
  }

  function buildPanel(schnoOptions) {
    const box = document.createElement('div');
    box.style.cssText = [
      'position:relative', 'width:100%', 'box-sizing:border-box',
      'margin:0 0 10px 0', 'background:#fffbe6',
      'border:2px solid #c1aa65', 'border-radius:8px', 'padding:10px',
      'z-index:2147483647', 'font-size:13px', 'font-family:sans-serif',
      'box-shadow:0 2px 10px rgba(0,0,0,.15)'
    ].join(';');

    box.innerHTML = `
      <div style="font-weight:bold;margin-bottom:8px;">🔧 學習日誌自動填寫（腳本面板）</div>

      <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center;margin-bottom:8px;">
        <label>起始日期</label>
        <div style="display:flex;gap:4px;align-items:center;position:relative;">
          <input type="text" id="af-start" placeholder="例如 2026-05-01 或 115年5月" value="${DEFAULTS.startDate}" style="flex:1;">
          <button type="button" id="af-start-cal" title="用日曆選擇">📅</button>
          <input type="date" id="af-start-native" value="${DEFAULTS.startDate}" style="position:absolute;width:0;height:0;opacity:0;pointer-events:none;">
        </div>

        <label>結束日期</label>
        <div style="display:flex;gap:4px;align-items:center;position:relative;">
          <input type="text" id="af-end" placeholder="例如 2026-09-30 或 115年9月" value="${DEFAULTS.endDate}" style="flex:1;">
          <button type="button" id="af-end-cal" title="用日曆選擇">📅</button>
          <input type="date" id="af-end-native" value="${DEFAULTS.endDate}" style="position:absolute;width:0;height:0;opacity:0;pointer-events:none;">
        </div>

        <span></span>
        <div id="af-range-hint" style="font-size:11px;color:#777;"></div>

        <label>需要天數</label>
        <div style="display:flex;gap:4px;align-items:center;">
          <select id="af-need-mode">
            <option value="month" ${DEFAULTS.needMode === 'month' ? 'selected' : ''}>每個月</option>
            <option value="total" ${DEFAULTS.needMode === 'total' ? 'selected' : ''}>整段合計</option>
          </select>
          <input type="number" id="af-needed" min="1" value="${DEFAULTS.neededDays}" style="width:60px;">
          <span>天</span>
        </div>

        <label>排除日期</label>
        <input type="text" id="af-exclude" placeholder="例如 2026-08-05, 2026-08-06" value="${DEFAULTS.excludeDates}" style="width:100%;">

        <label>工作內容</label>
        <input type="text" id="af-work" value="${DEFAULTS.work}" style="width:100%;">

        <label>校內編號</label>
        <select id="af-schno" style="width:100%;">
          ${schnoOptions
            .map(
              (opt) =>
                `<option value="${opt.value}" ${opt.value === DEFAULTS.schno ? 'selected' : ''}>${opt.text}</option>`
            )
            .join('')}
        </select>
      </div>
      <div style="font-size:11px;color:#777;margin-bottom:8px;">
        日期可用西元或民國（2026-05-01、115/5/1、1150501、115年5月1日），只寫到月份也行（起始取 1 號、結束取月底），
        例如 115年5月 ~ 115年9月 就是 2026-05-01 ~ 2026-09-30。選「每個月」時會在每個月各挑指定天數。<br>
        會自動跳過範圍內的六日；其他國定假日/補假請自行填在「排除日期」欄位（可用逗號分隔多個日期）。
      </div>

      <button id="af-generate">產生日期清單</button>
      <div id="af-preview" style="margin-top:8px;"></div>

      <button id="af-start-btn" style="margin-top:8px;margin-right:6px;" disabled>開始自動填寫</button>
      <button id="af-reset">清除本機已完成紀錄</button>

      <div style="margin-top:8px;padding:6px;background:#fff;border:1px solid #ddd;border-radius:4px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span id="af-job-status" style="font-size:12px;color:#555;">目前沒有進行中的批次。</span>
        <button id="af-cancel" disabled>取消目前批次</button>
      </div>

      <div id="af-log" style="margin-top:8px;border-top:1px solid #ccc;padding-top:6px;max-height:220px;overflow:auto;"></div>
    `;
    document.body.insertBefore(box, document.body.firstChild);

    return {
      root: box,
      startInput: box.querySelector('#af-start'),
      endInput: box.querySelector('#af-end'),
      startNative: box.querySelector('#af-start-native'),
      endNative: box.querySelector('#af-end-native'),
      startCalBtn: box.querySelector('#af-start-cal'),
      endCalBtn: box.querySelector('#af-end-cal'),
      rangeHint: box.querySelector('#af-range-hint'),
      needModeInput: box.querySelector('#af-need-mode'),
      neededInput: box.querySelector('#af-needed'),
      excludeInput: box.querySelector('#af-exclude'),
      workInput: box.querySelector('#af-work'),
      schnoInput: box.querySelector('#af-schno'),
      generateBtn: box.querySelector('#af-generate'),
      preview: box.querySelector('#af-preview'),
      startBtn: box.querySelector('#af-start-btn'),
      resetBtn: box.querySelector('#af-reset'),
      jobStatus: box.querySelector('#af-job-status'),
      cancelBtn: box.querySelector('#af-cancel'),
      logEl: box.querySelector('#af-log'),
    };
  }

  function init() {
    const schnoOptions = getSchnoOptionsFromPage();
    const panel = buildPanel(schnoOptions);
    let currentPicks = []; // [{date: Date, checked: bool}]

    // 起始/結束日期：文字輸入框可以直接手打（格式 yyyy-mm-dd），
    // 旁邊的 📅 按鈕則是打開隱藏的原生日期輸入框，用日曆選好後同步回文字框。
    function wireDateDual(textInput, nativeInput, calBtn, mode) {
      if (!textInput || !nativeInput || !calBtn) return;
      calBtn.addEventListener('click', () => {
        // 先把目前文字框裡看得懂的日期同步給原生輸入框，這樣打開日曆時預設會停在同一天
        const parsed = parseFlexibleDate(textInput.value, mode);
        if (parsed) {
          nativeInput.value = toIsoString(parsed);
        }
        try {
          nativeInput.showPicker();
        } catch (e) {
          // 部分瀏覽器/情境不支援 showPicker()，退而求其次直接 focus 讓使用者自己點開
          nativeInput.focus();
        }
      });
      nativeInput.addEventListener('change', () => {
        if (nativeInput.value) {
          textInput.value = nativeInput.value;
          updateRangeHint();
        }
      });
      textInput.addEventListener('input', updateRangeHint);
    }

    // 在起訖日期下方即時顯示「實際會用的範圍」，手打民國或只寫月份時可以一眼確認有沒有被正確理解
    function updateRangeHint() {
      const startRaw = panel.startInput.value.trim();
      const endRaw = panel.endInput.value.trim();
      const start = parseFlexibleDate(startRaw, 'start');
      const end = parseFlexibleDate(endRaw, 'end');
      const parts = [];
      if (startRaw && !start) parts.push('⚠️ 看不懂起始日期');
      if (endRaw && !end) parts.push('⚠️ 看不懂結束日期');
      if (start && end) {
        if (start > end) {
          parts.push('⚠️ 起始日期晚於結束日期');
        } else {
          const months =
            (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1;
          parts.push(`實際範圍：${toIsoString(start)} ~ ${toIsoString(end)}（涵蓋 ${months} 個月）`);
        }
      }
      panel.rangeHint.textContent = parts.join('　');
    }

    wireDateDual(panel.startInput, panel.startNative, panel.startCalBtn, 'start');
    wireDateDual(panel.endInput, panel.endNative, panel.endCalBtn, 'end');
    updateRangeHint();

    function renderPreview() {
      if (currentPicks.length === 0) {
        panel.preview.innerHTML = '<i style="color:#999;">尚未產生清單</i>';
        return;
      }
      // 依月份分組顯示，每組前面加一行月份標題
      const countByMonth = {};
      currentPicks.forEach((p) => {
        const k = monthKey(p.date);
        countByMonth[k] = (countByMonth[k] || 0) + 1;
      });
      let lastKey = null;
      panel.preview.innerHTML = currentPicks
        .map((p, i) => {
          const k = monthKey(p.date);
          let header = '';
          if (k !== lastKey) {
            lastKey = k;
            header = `<div style="font-weight:bold;margin-top:6px;">${k}（${countByMonth[k]} 天）</div>`;
          }
          return `${header}
          <label style="display:block;">
            <input type="checkbox" class="af-pick" data-i="${i}" ${p.checked ? 'checked' : ''}>
            ${toIsoString(p.date)}（民國 ${toRocString(p.date)}）
          </label>`;
        })
        .join('');
      panel.preview.querySelectorAll('.af-pick').forEach((cb) => {
        cb.addEventListener('change', (e) => {
          currentPicks[Number(e.target.dataset.i)].checked = e.target.checked;
        });
      });
    }

    panel.generateBtn.addEventListener('click', () => {
      const start = parseFlexibleDate(panel.startInput.value, 'start');
      const end = parseFlexibleDate(panel.endInput.value, 'end');
      const needed = Math.max(1, parseInt(panel.neededInput.value, 10) || 1);
      const perMonth = panel.needModeInput.value === 'month';
      const excludeSet = parseExcludeSet(panel.excludeInput.value);

      if (!start || !end || start > end) {
        originalAlert(
          '請確認起始日期與結束日期都有填、格式看得懂（例如 2026-05-01、115/5/1、115年5月），且起始日期不晚於結束日期。'
        );
        return;
      }

      let picks;
      if (perMonth) {
        const groups = pickWorkdaysPerMonth(start, end, needed, excludeSet);
        picks = [];
        const short = [];
        groups.forEach((g) => {
          picks.push(...g.picks);
          if (g.picks.length < needed) short.push(`${g.key} 只有 ${g.picks.length} 天`);
        });
        if (short.length > 0) {
          log(
            panel,
            `⚠️ 以下月份扣除六日與排除日期後湊不滿 ${needed} 個工作天：${short.join('、')}（範圍頭尾只涵蓋半個月時常見，請確認是否正確）。`
          );
        }
        log(panel, `已產生 ${groups.length} 個月、共 ${picks.length} 個日期，可在下方取消勾選調整。`);
      } else {
        picks = pickWorkdays(start, end, needed, excludeSet);
        if (picks.length < needed) {
          log(
            panel,
            `⚠️ 範圍內扣除六日與排除日期後，只找到 ${picks.length} 個工作天（需要 ${needed} 個），請放寬日期範圍或減少需要天數。`
          );
        } else {
          log(panel, `已產生 ${picks.length} 個日期，可在下方取消勾選調整。`);
        }
      }
      currentPicks = picks.map((d) => ({ date: d, checked: true }));

      renderPreview();
      panel.startBtn.disabled = currentPicks.length === 0;
    });

    panel.resetBtn.addEventListener('click', () => {
      const schno = panel.schnoInput.value.trim();
      localStorage.removeItem('nchu_study_log_autofill_done_' + schno);
      log(panel, `已清除校內編號 ${schno} 的本機「已完成」紀錄。`);
    });

    panel.cancelBtn.addEventListener('click', () => {
      clearJob();
      updateJobStatus(panel, null);
      panel.startBtn.disabled = currentPicks.length === 0;
      log(panel, '已取消目前批次，剩下沒送出的日期不會再自動處理。');
    });

    panel.startBtn.addEventListener('click', () => {
      const work = panel.workInput.value.trim();
      const schno = panel.schnoInput.value.trim();
      const selected = currentPicks.filter((p) => p.checked).map((p) => p.date);

      if (!work || !schno) {
        originalAlert('工作內容、校內編號不能空白。');
        return;
      }
      if (selected.length === 0) {
        originalAlert('目前沒有勾選任何日期。');
        return;
      }

      const monthCount = new Set(selected.map(monthKey)).size;
      const ok = originalConfirm(
        `確定要自動送出 ${selected.length} 筆學習日誌嗎？（涵蓋 ${monthCount} 個月）\n校內編號：${schno}\n工作內容：${work}\n\n送出過程中若網站把頁面重新整理，腳本會自動接續處理剩下的日期，不用手動再按一次。`
      );
      if (!ok) return;

      const rocList = selected.map(toRocString);
      const job = { work, schno, queue: rocList, allDates: rocList.slice(), total: rocList.length };
      saveJob(job);
      updateJobStatus(panel, job);
      panel.startBtn.disabled = true;
      runQueueStep(panel);
    });

    // 偵測是否有上一輪留下、尚未跑完的批次（例如剛才送出時網站把頁面重新整理了），
    // 有的話自動接續處理，不需要使用者再按一次「開始自動填寫」。
    const existingJob = readJob();
    if (existingJob) {
      log(
        panel,
        `偵測到尚未完成的批次（校內編號 ${existingJob.schno}，工作內容「${existingJob.work}」，剩 ${existingJob.queue.length} 筆），自動接續處理...`
      );
      updateJobStatus(panel, existingJob);
      panel.startBtn.disabled = true;
      runQueueStep(panel);
    } else {
      updateJobStatus(panel, null);
    }

    renderPreview();
  }

  // 「學習日誌列印」查詢頁：如果剛好有上一步留下來的列印請求，自動幫忙帶入校內編號、起訖日期，
  // 最後「列印」那一下（會開新分頁跳出瀏覽器原生列印視窗）還是要你自己按，這是瀏覽器的安全限制，腳本做不到。
  //
  // 跨好幾個月時「每個月分開列印」：一次只帶入一個月，你按下「列印」後，
  // 腳本會自動把欄位換成下一個還沒印的月份；也可以在面板上直接點任一個月份重新帶入。
  // 進度存在 localStorage，就算按列印後頁面被重新整理也會接續停在下一個月。
  function initPrint() {
    let printJob = readPrintJob();
    if (!printJob) return; // 使用者自己手動點進來看看而已，不動這個頁面

    const schnoSelect = document.getElementById('schno');
    const begInput = document.getElementById('dtQryBeg');
    const endInput = document.getElementById('dtQryEnd');
    const btn = document.getElementById('btnSent');

    const note = document.createElement('div');
    note.style.cssText =
      'background:#fffbe6;border:2px solid #c1aa65;border-radius:8px;padding:10px;margin-bottom:10px;font-size:13px;font-family:sans-serif;';
    if (document.body) {
      document.body.insertBefore(note, document.body.firstChild);
    }

    function fillMonth(i) {
      const m = printJob.months[i];
      if (!m) return;
      printJob.index = i;
      savePrintJob(printJob);
      if (schnoSelect) {
        schnoSelect.value = printJob.schno;
        schnoSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (begInput) setNativeValue(begInput, m.start);
      if (endInput) setNativeValue(endInput, m.end);
      console.log(
        `[學習日誌自動填寫] 已帶入學習日誌列印查詢條件：校內編號=${printJob.schno}，${m.label}（${m.start} ~ ${m.end}）`
      );
      render();
    }

    function render() {
      const total = printJob.months.length;
      const doneCount = printJob.months.filter((m) => m.printed).length;
      const cur = printJob.months[printJob.index];
      note.innerHTML = `
        <div style="font-weight:bold;margin-bottom:6px;">🔧 學習日誌列印（每個月分開印，已按過列印 ${doneCount} / ${total} 個月）</div>
        <div style="margin-bottom:6px;">
          目前已帶入：<b>${cur.label}</b>（${cur.start} ~ ${cur.end}），校內編號 ${printJob.schno}。<br>
          請自己按一下「列印」（會開新分頁跳出列印視窗，選「另存為 PDF」存檔，這步瀏覽器不給腳本代勞）；
          按完後這裡會自動換成下一個月。
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">
          ${printJob.months
            .map(
              (m, i) =>
                `<button type="button" class="af-print-month" data-i="${i}" style="${
                  i === printJob.index ? 'font-weight:bold;outline:2px solid #e53838;' : ''
                }">${m.printed ? '✅ ' : ''}${m.label}</button>`
            )
            .join('')}
        </div>
        <button type="button" id="af-print-finish">結束列印（清除這份列印清單）</button>
      `;
      note.querySelectorAll('.af-print-month').forEach((b) => {
        b.addEventListener('click', () => fillMonth(Number(b.dataset.i)));
      });
      note.querySelector('#af-print-finish').addEventListener('click', finish);
    }

    function finish() {
      clearPrintJob();
      if (btn) btn.style.outline = '';
      note.textContent = '🔧 學習日誌列印清單已結束。';
    }

    // 稍微標記一下列印按鈕，提醒使用者這裡需要自己手動點一下
    // （不自動幫你按，避免瀏覽器把自動彈出的新分頁當成廣告快顯擋掉）
    if (btn) {
      btn.style.outline = '3px solid #e53838';
      btn.style.outlineOffset = '2px';

      // 使用者按下「列印」：同步把這個月標記成已印、進度推到下一個月並存檔
      // （同步存，萬一按完頁面被重新整理，下次載入也會直接停在下一個月）
      btn.addEventListener('click', () => {
        const job = readPrintJob();
        if (!job) return; // 已經按過「結束列印」
        printJob = job;
        printJob.months[printJob.index].printed = true;
        const next = printJob.months.findIndex((m) => !m.printed);
        if (next === -1) {
          clearPrintJob();
          setTimeout(() => {
            if (btn) btn.style.outline = '';
            note.textContent = `🔧 ${printJob.months.length} 個月都已按過列印，列印清單已清除。若有哪個月沒存到，請自行選擇日期再印一次。`;
          }, 1000);
          return;
        }
        printJob.index = next;
        savePrintJob(printJob);
        // 稍等一下再換欄位，讓系統先用目前的欄位值把這個月的列印頁開出來
        setTimeout(() => fillMonth(next), 1000);
      });
    }

    fillMonth(printJob.index);
  }

  async function boot() {
    console.log(
      '[學習日誌自動填寫] 腳本已注入，URL=' + location.href +
      '，hasForm=' + hasForm() + '，hasPrintForm=' + hasPrintForm()
    );
    const found = await waitForAnyForm(5000);
    if (!found) {
      console.log('[學習日誌自動填寫] 這個頁面 5 秒內找不到表單欄位，不動作。URL=' + location.href);
      return;
    }
    if (!document.body) return;

    if (found === 'log') {
      console.log('[學習日誌自動填寫] 找到學習日誌表單，準備顯示面板。URL=' + location.href);
      init();
    } else {
      console.log('[學習日誌自動填寫] 找到學習日誌列印表單。URL=' + location.href);
      initPrint();
    }
  }

  boot();
})();
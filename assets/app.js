/**
 * app.js — 申论·综应·遴选 智能阅卷工作台 · 逻辑层
 * 纯脚本（classic script），无 import / export。
 * 依赖 data.js 中定义的全局常量：EXAM_TYPES / QUESTION_TYPES / WORD_RULES /
 * GENRE_RULES / ESSAY_WEIGHTS / OUTPUT_SECTIONS / ROLE_PROMPT
 *
 * 职责：state 管理 / 字数统计 / 校验 / 指令组装 / 渲染 / localStorage / 事件绑定。
 */
'use strict';

(function () {
  'use strict';

  /* ======================== 常量 ======================== */
  var STORAGE_KEY = 'shenlun_grader_history_v1';
  var MAX_HISTORY = 30;
  var DEBOUNCE_MS = 300;
  var SEP_MAJOR = '============================================================';
  var SEP_MINOR = '------------------------------------------------------------';

  /* ======================== 状态 ======================== */
  var state = {
    examType: 'auto',
    questionType: 'gngk',
    score: '',
    wordReq: '',
    stem: '',
    material: '',
    answer: '',
    parsedWord: null,      // { type, min, max, expected, raw, text } | null
    wordStat: null,        // { total, chinese, status:{ level, text } } | null
    history: [],
    storageAvailable: true,
    lastInstruction: '',
    debounceTimer: null
  };

  /* DOM 引用，init() 时填充 */
  var els = {};

  /* ======================== 通用工具 ======================== */
  function $(id) { return document.getElementById(id); }

  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined && text !== null) { e.textContent = String(text); }
    return e;
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function two(n) { return (n < 10 ? '0' : '') + n; }

  function nowISO() { try { return new Date().toISOString(); } catch (e) { return String(Date.now()); } }

  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return String(iso); }
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) +
      ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }

  function tsFilename() {
    var d = new Date();
    return '阅卷指令_' + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) +
      '_' + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds()) + '.txt';
  }

  /* ======================== 查询辅助 ======================== */
  function findExam(id) {
    for (var i = 0; i < EXAM_TYPES.length; i++) {
      if (EXAM_TYPES[i].id === id) { return EXAM_TYPES[i]; }
    }
    return EXAM_TYPES[0];
  }

  function findQuestion(id) {
    for (var i = 0; i < QUESTION_TYPES.length; i++) {
      if (QUESTION_TYPES[i].id === id) { return QUESTION_TYPES[i]; }
    }
    return QUESTION_TYPES[0];
  }

  function getWordRule(examId) {
    return WORD_RULES[examId] || WORD_RULES['default'];
  }

  /* ======================== 字数统计 ======================== */
  /**
   * 统计非空白字符总数（含中文标点，不含空格/换行/制表符）与中文字符数。
   * 使用 Array.from 以正确处理代理对（如 emoji）。
   */
  function countChars(str) {
    var s = (str === undefined || str === null) ? '' : String(str);
    var noWs = s.replace(/\s+/g, '');   // \s 覆盖空格、制表、换行以及全角空格 \u3000
    var total = (typeof Array.from === 'function') ? Array.from(noWs).length : noWs.length;
    var cnMatch = noWs.match(/[\u4e00-\u9fff]/g);
    var chinese = cnMatch ? cnMatch.length : 0;
    return { total: total, chinese: chinese };
  }

  /* ======================== 字数要求解析 ======================== */
  /**
   * 解析题干字数要求，支持：
   *   不超过N字 / 不超出N字 / 最多N字   → { type:'max', max:N }
   *   不少于N字 / 至少N字              → { type:'min', min:N }
   *   N字左右 / 约N字 / 大约N字        → { type:'around', expected:N }
   *   A-B字 / A~B字 / A—B字 (含全角)   → { type:'range', min:A, max:B }
   *   纯数字 N                        → { type:'exact', min:N, max:N }
   * 无法识别时返回 { type:'unknown', text: 原文 }。
   */
  function parseWordReq(raw) {
    if (raw === undefined || raw === null) { return null; }
    var s = String(raw).trim();
    if (!s) { return null; }

    var norm = s.replace(/[~～—–－﹣ー至到]/g, '-');
    var N = '(\\d+(?:\\.\\d+)?)';
    var m;

    /* 1) 区间：A - B */
    m = norm.match(new RegExp(N + '\\s*-\\s*' + N));
    if (m) {
      var a = parseFloat(m[1]);
      var b = parseFloat(m[2]);
      var lo = Math.min(a, b);
      var hi = Math.max(a, b);
      return { type: 'range', min: lo, max: hi, expected: null, raw: s, text: fmtNum(lo) + '~' + fmtNum(hi) + ' 字' };
    }

    /* 2) 上限 */
    m = s.match(new RegExp('不\\s*超\\s*(?:过|出)?\\s*' + N));
    if (m) {
      var max1 = parseFloat(m[1]);
      return { type: 'max', min: null, max: max1, expected: null, raw: s, text: '不超过 ' + fmtNum(max1) + ' 字' };
    }
    m = s.match(new RegExp('最\\s*多\\s*' + N));
    if (m) {
      var max2 = parseFloat(m[1]);
      return { type: 'max', min: null, max: max2, expected: null, raw: s, text: '不超过 ' + fmtNum(max2) + ' 字' };
    }

    /* 3) 下限 */
    m = s.match(new RegExp('不\\s*少\\s*于\\s*' + N));
    if (m) {
      var min1 = parseFloat(m[1]);
      return { type: 'min', min: min1, max: null, expected: null, raw: s, text: '不少于 ' + fmtNum(min1) + ' 字' };
    }
    m = s.match(new RegExp('至\\s*少\\s*' + N));
    if (m) {
      var min2 = parseFloat(m[1]);
      return { type: 'min', min: min2, max: null, expected: null, raw: s, text: '不少于 ' + fmtNum(min2) + ' 字' };
    }

    /* 4) 左右 / 约 */
    m = s.match(new RegExp(N + '\\s*字\\s*(?:左右|上下|前后)'));
    if (m) {
      var ex1 = parseFloat(m[1]);
      return { type: 'around', min: null, max: null, expected: ex1, raw: s, text: '约 ' + fmtNum(ex1) + ' 字' };
    }
    m = s.match(new RegExp('(?:约|大约|大概)\\s*' + N));
    if (m) {
      var ex2 = parseFloat(m[1]);
      return { type: 'around', min: null, max: null, expected: ex2, raw: s, text: '约 ' + fmtNum(ex2) + ' 字' };
    }

    /* 5) 纯数字 */
    m = s.match(new RegExp('^\\s*' + N + '\\s*字?\\s*$'));
    if (m) {
      var ex3 = parseFloat(m[1]);
      return { type: 'exact', min: ex3, max: ex3, expected: ex3, raw: s, text: fmtNum(ex3) + ' 字' };
    }

    return { type: 'unknown', min: null, max: null, expected: null, raw: s, text: s };
  }

  function fmtNum(n) {
    if (n === null || n === undefined) { return ''; }
    return (Math.round(n) === n) ? String(n) : String(n);
  }

  /* ======================== 字数校验 ======================== */
  /**
   * 依据该考试的字数容错口径，输出三态：ok（达标）/ near（接近边界）/ bad（超限或不足）。
   */
  function evalWordStatus(count, parsed, examId) {
    var rule = getWordRule(examId);
    var tol = (rule && typeof rule.tolerance === 'number') ? rule.tolerance : 0.10;

    if (!parsed || parsed.type === 'unknown') {
      return { level: 'none', text: '未设置字数要求' };
    }

    var min = parsed.min;
    var max = parsed.max;
    var exp = parsed.expected;

    /* around：以期望值为中心按容差展开区间 */
    if (parsed.type === 'around' && exp !== null && exp !== undefined) {
      min = exp * (1 - tol);
      max = exp * (1 + tol);
    }

    if (min !== null && min !== undefined && max !== null && max !== undefined) {
      if (count >= min && count <= max) { return { level: 'ok', text: '达标' }; }
      var lowOk = min * (1 - tol);
      var highOk = max * (1 + tol);
      if (count >= lowOk && count <= highOk) { return { level: 'near', text: '接近边界' }; }
      return { level: 'bad', text: count > max ? '超限' : '不足' };
    }

    if (max !== null && max !== undefined) {
      if (count <= max) { return { level: 'ok', text: '达标' }; }
      if (count <= max * (1 + tol)) { return { level: 'near', text: '接近边界（略超）' }; }
      return { level: 'bad', text: '超限' };
    }

    if (min !== null && min !== undefined) {
      if (count >= min) { return { level: 'ok', text: '达标' }; }
      if (count >= min * (1 - tol)) { return { level: 'near', text: '接近边界（略少）' }; }
      return { level: 'bad', text: '不足' };
    }

    return { level: 'none', text: '未设置字数要求' };
  }

  /* ======================== 指令组装 ======================== */
  function buildInstruction() {
    var exam = findExam(state.examType);
    var q = findQuestion(state.questionType);
    var out = [];

    /* 1) 完整角色提示词 */
    out.push(String(ROLE_PROMPT).trim());
    out.push('');
    out.push(SEP_MAJOR);
    out.push('');

    /* 2) 本次阅卷任务卡 */
    out.push('【本次阅卷任务卡】');
    out.push('');

    out.push('· 考试类型：' + exam.name +
      (state.examType === 'auto' ? '（请依据题干、材料与题型特征自动判定；若无法判定，须主动向考生确认，禁止随意套用默认标准）' : ''));
    out.push('· 当前生效阅卷范式：' + exam.name);
    out.push('· 阅卷导向：' + exam.guide);
    if (exam.special === 'B') {
      out.push('· 特别提示：本次为事业单位综合应用能力 B，不属于传统申论，已切换至综应专属阅卷规则');
    }
    if (exam.special === 'C') {
      out.push('· 特别提示：本次为事业单位综合应用能力 C（理科向），严禁文科申论标准批改；若为科技实务且缺少图表材料，需提示考生补齐材料');
    }

    /* 题型与专项规则 */
    out.push('· 题型：' + q.name + '（' + q.tag + '题型）');
    var genre = GENRE_RULES[q.name];
    if (genre && genre.length) {
      out.push('  ▸ 该题型专项规则：');
      for (var i = 0; i < genre.length; i++) {
        out.push('    - ' + genre[i]);
      }
    }

    /* 满分 */
    var scoreFilled = state.score !== null && String(state.score).trim() !== '';
    out.push('· 满分：' + (scoreFilled ? String(state.score).trim() : '（待考生确认）') +
      (scoreFilled ? '' : '（未填写满分，已按题型默认满分占位，建议补全）'));

    /* 字数要求 */
    out.push('· 字数要求（题干原文）：' + (state.wordReq && state.wordReq.trim() ? state.wordReq.trim() : '未提供'));

    /* 字数统计 */
    var wstat = state.wordStat;
    if (wstat) {
      var rule = getWordRule(state.examType);
      out.push('· 字数解析结果：' + (state.parsedWord ? state.parsedWord.text : '未解析'));
      out.push('· 考生作文字数：' + wstat.total + ' 字（非空白字符计；其中中文字符 ' + wstat.chinese + ' 字）');
      out.push('· 字数校验结论：' + wstat.status.text + '（适用口径：' + rule.label + '）');
      if (wstat.status.level === 'bad') {
        out.push('· 字数扣分口径：' + rule.penalty);
      }
    }

    out.push('');
    out.push(SEP_MINOR);
    out.push('');

    /* 3) 原始输入 */
    out.push('— 题干 —');
    out.push(state.stem.trim());
    out.push('');
    out.push('— 给定材料 —');
    out.push(state.material.trim());
    out.push('');
    out.push('— 考生作答 —');
    out.push(state.answer.trim() ? state.answer.trim() : '（考生未提供作答，请提示考生补齐后再批改）');

    out.push('');
    out.push(SEP_MAJOR);
    out.push('');

    /* 4) 输出结构硬性要求 */
    out.push('【输出结构硬性要求（以下 7 段顺序不可打乱）】');
    for (var j = 0; j < OUTPUT_SECTIONS.length; j++) {
      out.push(OUTPUT_SECTIONS[j]);
    }
    out.push('');
    out.push('【再次强调防幻觉约束】所有采分点必须 100% 来自上方「给定材料」，所有打分与扣分均可溯源；禁止跨范式混用标准，禁止输出无意义空泛评价。');

    return out.join('\n');
  }

  /* ======================== 渲染：范式提示条 ======================== */
  function renderParadigmBar() {
    var exam = findExam(state.examType);
    var bar = els.paradigmBar;
    if (!bar) { return; }
    bar.innerHTML = '';
    bar.className = 'paradigm-bar';

    var main = mk('div', 'paradigm-main');

    if (state.examType === 'auto') {
      bar.classList.add('is-auto');
      main.appendChild(mk('span', 'paradigm-tag', '自动识别模式'));
      main.appendChild(mk('span', 'paradigm-text',
        '将从题干、材料、题型特征自动判定考试类型；若无法判定将主动向考生确认，禁止随意套用默认标准'));
    } else {
      main.appendChild(mk('span', 'paradigm-tag', '当前生效阅卷范式：' + exam.name));
      main.appendChild(mk('span', 'paradigm-text', exam.guide));
    }
    bar.appendChild(main);

    if (exam.special === 'B') {
      bar.appendChild(mk('div', 'paradigm-special',
        '本次为事业单位综合应用能力 B，不属于传统申论，已切换至综应专属阅卷规则'));
    }
    if (exam.special === 'C') {
      bar.appendChild(mk('div', 'paradigm-special',
        '本次为事业单位综合应用能力 C（理科向），严禁文科申论标准批改；若为科技实务且缺少图表材料，需提示考生补齐材料'));
    }
  }

  /* ======================== 渲染：字数要求提示 ======================== */
  function renderWordReqHint() {
    var elx = els.wordReqHint;
    if (!elx) { return; }
    var p = state.parsedWord;
    if (!p) { elx.textContent = ''; elx.className = 'hint'; return; }

    var parts = [];
    if (p.min !== null && p.min !== undefined && p.max !== null && p.max !== undefined) {
      parts.push('下限 ' + fmtNum(p.min) + ' 字');
      parts.push('上限 ' + fmtNum(p.max) + ' 字');
    } else if (p.max !== null && p.max !== undefined) {
      parts.push('上限 ' + fmtNum(p.max) + ' 字');
    } else if (p.min !== null && p.min !== undefined) {
      parts.push('下限 ' + fmtNum(p.min) + ' 字');
    } else if (p.expected !== null && p.expected !== undefined) {
      parts.push('目标 ' + fmtNum(p.expected) + ' 字（左右）');
    }

    if (parts.length) {
      elx.textContent = '字数解析：' + parts.join('，');
      elx.className = 'hint hint-ok';
    } else {
      elx.textContent = '字数解析：' + p.text + '（已按原文保留，未强制换算）';
      elx.className = 'hint';
    }
  }

  /* ======================== 渲染：字数面板 ======================== */
  function renderWordPanel() {
    var panel = els.wordPanel;
    if (!panel) { return; }
    panel.innerHTML = '';

    var stat = state.wordStat || { total: 0, chinese: 0, status: { level: 'none', text: '—' } };
    var parsed = state.parsedWord;
    var rule = getWordRule(state.examType);

    var row = mk('div', 'word-row');

    var cur = mk('span', 'word-item');
    cur.appendChild(mk('span', 'word-k', '当前'));
    cur.appendChild(mk('span', 'word-v', ' ' + stat.total + ' 字'));
    row.appendChild(cur);

    var req = mk('span', 'word-item');
    req.appendChild(mk('span', 'word-k', '要求'));
    req.appendChild(mk('span', 'word-v', ' ' + (parsed ? parsed.text : '未设置')));
    row.appendChild(req);

    var st = mk('span', 'word-status status-' + (stat.status ? stat.status.level : 'none'),
      stat.status ? stat.status.text : '—');
    row.appendChild(st);

    panel.appendChild(row);

    var sub = mk('div', 'word-sub');
    sub.appendChild(mk('span', null, '中文字符 ' + stat.chinese + ' 字'));
    sub.appendChild(mk('span', 'dot', '·'));
    sub.appendChild(mk('span', null, '容错口径：' + rule.label));
    panel.appendChild(sub);
  }

  /* ======================== 渲染：输出 ======================== */
  function renderOutput(text) {
    if (!els.output || !els.outputEmpty) { return; }
    if (!text) {
      els.output.classList.add('hidden');
      els.output.textContent = '';
      els.outputEmpty.classList.remove('hidden');
      return;
    }
    els.output.textContent = text;
    els.output.classList.remove('hidden');
    els.outputEmpty.classList.add('hidden');
  }

  function renderWarnStrip() {
    var strip = els.warnStrip;
    if (!strip) { return; }
    var stat = state.wordStat;
    if (stat && stat.status && stat.status.level === 'bad') {
      var rule = getWordRule(state.examType);
      strip.textContent = '⚠ 字数校验：' + stat.status.text +
        '（当前 ' + stat.total + ' 字，要求 ' + (state.parsedWord ? state.parsedWord.text : '—') +
        '）。已触发该考试字数扣分规则：' + rule.penalty;
      strip.classList.remove('hidden');
    } else {
      strip.textContent = '';
      strip.classList.add('hidden');
    }
  }

  /* ======================== 渲染：标准库 ======================== */
  function buildAccordion(title, builder, openByDefault) {
    var wrap = mk('div', 'accordion' + (openByDefault ? ' open' : ' closed'));
    var head = mk('button', 'accordion-head');
    head.type = 'button';
    head.appendChild(mk('span', null, title));
    head.appendChild(mk('span', 'accordion-caret', '▶'));

    var body = mk('div', 'accordion-body');

    head.addEventListener('click', function () {
      var isOpen = wrap.classList.contains('open');
      if (isOpen) {
        wrap.classList.remove('open');
        wrap.classList.add('closed');
        head.setAttribute('aria-expanded', 'false');
      } else {
        wrap.classList.add('open');
        wrap.classList.remove('closed');
        head.setAttribute('aria-expanded', 'true');
      }
    });
    head.setAttribute('aria-expanded', openByDefault ? 'true' : 'false');

    wrap.appendChild(head);
    wrap.appendChild(body);
    if (typeof builder === 'function') { builder(body); }
    return wrap;
  }

  function renderLibrary() {
    var body = els.libraryBody;
    if (!body) { return; }
    body.innerHTML = '';

    /* a. 考试范式库 */
    body.appendChild(buildAccordion('一、考试范式库', function (host) {
      var grid = mk('div', 'exam-grid');
      for (var i = 0; i < EXAM_TYPES.length; i++) {
        var exam = EXAM_TYPES[i];
        if (exam.id === 'auto') { continue; }
        var item = mk('div', 'exam-item');
        item.appendChild(mk('div', 'exam-item-name', exam.name));
        item.appendChild(mk('div', 'exam-item-guide', exam.guide));
        grid.appendChild(item);
      }
      host.appendChild(grid);
    }, true));

    /* b. 题型专项规则 */
    body.appendChild(buildAccordion('二、题型专项规则', function (host) {
      for (var i = 0; i < QUESTION_TYPES.length; i++) {
        var q = QUESTION_TYPES[i];
        var block = mk('div', 'genre-block');

        var titleRow = mk('div', 'genre-title');
        titleRow.appendChild(mk('span', null, q.name));
        titleRow.appendChild(mk('span', 'tag' + (q.tag === '特色' ? ' tag-special' : ''), q.tag + '题型'));
        block.appendChild(titleRow);

        var rules = GENRE_RULES[q.name] || [];
        if (rules.length) {
          var ul = mk('ul', 'genre-list');
          for (var j = 0; j < rules.length; j++) {
            ul.appendChild(mk('li', null, rules[j]));
          }
          block.appendChild(ul);
        }
        host.appendChild(block);
      }
    }, false));

    /* c. 大作文五维权重 */
    body.appendChild(buildAccordion('三、大作文五维权重', function (host) {
      for (var i = 0; i < ESSAY_WEIGHTS.length; i++) {
        var w = ESSAY_WEIGHTS[i];
        var row = mk('div', 'weight-row');

        var top = mk('div', 'weight-top');
        top.appendChild(mk('span', 'weight-name', w.name));
        top.appendChild(mk('span', 'weight-val', w.w + '%'));
        row.appendChild(top);

        var track = mk('div', 'weight-track');
        var fill = mk('div', 'weight-fill');
        fill.style.width = clamp(w.w, 0, 100) + '%';
        track.appendChild(fill);
        row.appendChild(track);

        host.appendChild(row);
      }
    }, false));
  }

  /* ======================== 渲染：历史记录 ======================== */
  function renderHistory() {
    var host = els.historyBody;
    if (!host) { return; }
    host.innerHTML = '';

    if (els.historyStorageNote) {
      if (state.storageAvailable) {
        els.historyStorageNote.classList.add('hidden');
      } else {
        els.historyStorageNote.classList.remove('hidden');
      }
    }

    if (!state.history.length) {
      host.appendChild(mk('div', 'history-empty', '暂无历史记录。生成一次阅卷指令后会自动记录。'));
      return;
    }

    for (var i = 0; i < state.history.length; i++) {
      (function (rec) {
        var item = mk('div', 'history-item');

        var meta = mk('div', 'history-meta');
        meta.appendChild(mk('span', 'hm-time', formatTime(rec.time)));
        meta.appendChild(mk('span', 'hm-strong', rec.examName || findExam(rec.examType).name));
        meta.appendChild(mk('span', null, rec.questionName || findQuestion(rec.questionType).name));
        meta.appendChild(mk('span', null, '作答 ' + (rec.answerWords || 0) + ' 字'));
        if (rec.wordReq) { meta.appendChild(mk('span', null, '要求：' + rec.wordReq)); }
        item.appendChild(meta);

        var preview = rec.answerPreview ? rec.answerPreview : '（无作答内容）';
        item.appendChild(mk('div', 'history-preview', preview));

        var actions = mk('div', 'history-actions');

        var btnLoad = mk('button', 'btn btn-mini', '载入');
        btnLoad.type = 'button';
        btnLoad.addEventListener('click', function () { loadHistoryRecord(rec.id); });
        actions.appendChild(btnLoad);

        var btnDel = mk('button', 'btn btn-danger btn-mini', '删除');
        btnDel.type = 'button';
        btnDel.addEventListener('click', function () { deleteHistoryRecord(rec.id); });
        actions.appendChild(btnDel);

        item.appendChild(actions);
        host.appendChild(item);
      })(state.history[i]);
    }
  }

  /* ======================== localStorage ======================== */
  function loadHistoryFromStorage() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) { return []; }
      var arr = JSON.parse(raw);
      if (Object.prototype.toString.call(arr) === '[object Array]') { return arr; }
      return [];
    } catch (e) {
      state.storageAvailable = false;
      return [];
    }
  }

  function saveHistoryToStorage(arr) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
      return true;
    } catch (e) {
      state.storageAvailable = false;
      return false;
    }
  }

  function addHistoryRecord() {
    var exam = findExam(state.examType);
    var q = findQuestion(state.questionType);
    var answer = state.answer || '';

    var rec = {
      /* 规格字段 */
      id: 'h' + Date.now() + '_' + Math.floor(Math.random() * 1e6),
      time: nowISO(),
      examType: state.examType,
      questionType: state.questionType,
      score: state.score,
      wordReq: state.wordReq,
      answerWords: state.wordStat ? state.wordStat.total : 0,
      answerPreview: answer.replace(/\s+/g, ' ').slice(0, 60),
      /* 便于「载入」完整回填的扩展字段 */
      examName: exam.name,
      questionName: q.name,
      stem: state.stem,
      material: state.material,
      answer: answer
    };

    state.history.unshift(rec);
    if (state.history.length > MAX_HISTORY) {
      state.history = state.history.slice(0, MAX_HISTORY);
    }
    var ok = saveHistoryToStorage(state.history);
    renderHistory();
    if (!ok && els.historyStorageNote) {
      els.historyStorageNote.classList.remove('hidden');
    }
  }

  function loadHistoryRecord(id) {
    var rec = null;
    for (var i = 0; i < state.history.length; i++) {
      if (state.history[i].id === id) { rec = state.history[i]; break; }
    }
    if (!rec) { return; }

    /* 完整回填已保存字段 */
    state.examType = rec.examType || 'auto';
    state.questionType = rec.questionType || 'gngk';
    state.score = (rec.score === undefined || rec.score === null) ? '' : rec.score;
    state.wordReq = rec.wordReq || '';
    state.stem = rec.stem || '';
    state.material = rec.material || '';
    state.answer = rec.answer || '';

    /* 同步到表单控件 */
    if (els.examType) { els.examType.value = state.examType; }
    if (els.questionType) { els.questionType.value = state.questionType; }
    if (els.score) { els.score.value = state.score; }
    if (els.wordReq) { els.wordReq.value = state.wordReq; }
    if (els.stem) { els.stem.value = state.stem; }
    if (els.material) { els.material.value = state.material; }
    if (els.answer) { els.answer.value = state.answer; }

    /* 清除错误高亮 */
    if (els.stem) { els.stem.classList.remove('field-error'); }
    if (els.material) { els.material.classList.remove('field-error'); }

    updateBadges();
    recomputeStats();
    renderParadigmBar();
    renderWordReqHint();

    closeDrawers();
    toast('已载入历史记录', 'ok');
  }

  function deleteHistoryRecord(id) {
    var next = [];
    for (var i = 0; i < state.history.length; i++) {
      if (state.history[i].id !== id) { next.push(state.history[i]); }
    }
    state.history = next;
    saveHistoryToStorage(state.history);
    renderHistory();
    toast('已删除该条历史记录', 'ok');
  }

  function clearHistory() {
    state.history = [];
    saveHistoryToStorage(state.history);
    renderHistory();
    toast('历史记录已清空', 'ok');
  }

  /* ======================== Toast ======================== */
  function toast(msg, type) {
    var host = els.toastHost;
    if (!host) { return; }
    var elx = mk('div', 'toast' + (type ? ' toast-' + type : ''), msg);
    host.appendChild(elx);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { elx.classList.add('show'); });
    } else {
      elx.classList.add('show');
    }
    setTimeout(function () {
      elx.classList.remove('show');
      setTimeout(function () {
        if (elx.parentNode) { elx.parentNode.removeChild(elx); }
      }, 240);
    }, 2800);
  }

  /* ======================== 复制 / 下载 ======================== */
  function copyText(text, okMsg) {
    if (!text) { toast('暂无可复制内容', 'warn'); return; }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(function () {
        toast(okMsg || '已复制到剪贴板', 'ok');
      }).catch(function () {
        fallbackCopy(text, okMsg);
      });
    } else {
      fallbackCopy(text, okMsg);
    }
  }

  function fallbackCopy(text, okMsg) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      document.body.removeChild(ta);
      if (ok) {
        toast(okMsg || '已复制到剪贴板', 'ok');
      } else {
        toast('复制失败，请在输出区手动选择文本复制', 'error');
        if (els.output) { els.output.focus(); }
      }
    } catch (e) {
      toast('复制失败，请在输出区手动选择文本复制', 'error');
    }
  }

  function downloadText(filename, text) {
    try {
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      toast('已开始下载：' + filename, 'ok');
    } catch (e) {
      toast('当前环境不支持下载，请手动复制', 'error');
    }
  }

  /* ======================== 抽屉控制 ======================== */
  function openDrawer(drawer) {
    if (!drawer) { return; }
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    if (els.scrim) { els.scrim.classList.remove('hidden'); }
  }

  function closeDrawers() {
    if (els.libraryDrawer) {
      els.libraryDrawer.classList.remove('open');
      els.libraryDrawer.setAttribute('aria-hidden', 'true');
    }
    if (els.historyDrawer) {
      els.historyDrawer.classList.remove('open');
      els.historyDrawer.setAttribute('aria-hidden', 'true');
    }
    if (els.scrim) { els.scrim.classList.add('hidden'); }
  }

  /* ======================== 表单变更处理 ======================== */
  function updateBadges() {
    if (els.stemCount) { els.stemCount.textContent = countChars(state.stem).total + ' 字'; }
    if (els.materialCount) { els.materialCount.textContent = countChars(state.material).total + ' 字'; }
    if (els.answerCount) { els.answerCount.textContent = countChars(state.answer).total + ' 字'; }
  }

  function recomputeStats() {
    state.parsedWord = parseWordReq(state.wordReq);
    var c = countChars(state.answer);
    state.wordStat = {
      total: c.total,
      chinese: c.chinese,
      status: evalWordStatus(c.total, state.parsedWord, state.examType)
    };
    renderWordPanel();
  }

  function onMaterialsInput() {
    state.stem = els.stem ? els.stem.value : '';
    state.material = els.material ? els.material.value : '';
    state.answer = els.answer ? els.answer.value : '';

    /* 立即更新角标 */
    updateBadges();

    /* 输入即清除红框高亮 */
    if (els.stem && state.stem.trim()) { els.stem.classList.remove('field-error'); }
    if (els.material && state.material.trim()) { els.material.classList.remove('field-error'); }

    /* 防抖重算统计 */
    if (state.debounceTimer) { clearTimeout(state.debounceTimer); }
    state.debounceTimer = setTimeout(recomputeStats, DEBOUNCE_MS);
  }

  function onWordReqInput() {
    state.wordReq = els.wordReq ? els.wordReq.value : '';
    state.parsedWord = parseWordReq(state.wordReq);
    renderWordReqHint();
    recomputeStats();
  }

  function onExamChange() {
    state.examType = els.examType ? els.examType.value : 'auto';
    renderParadigmBar();
    recomputeStats();
  }

  function onQuestionChange() {
    state.questionType = els.questionType ? els.questionType.value : 'gngk';
  }

  function onScoreInput() {
    state.score = els.score ? els.score.value : '';
  }

  /* ======================== 生成 ======================== */
  function handleGenerate() {
    /* 同步最新输入 */
    state.stem = els.stem ? els.stem.value : state.stem;
    state.material = els.material ? els.material.value : state.material;
    state.answer = els.answer ? els.answer.value : state.answer;
    state.score = els.score ? els.score.value : state.score;
    state.wordReq = els.wordReq ? els.wordReq.value : state.wordReq;
    state.examType = els.examType ? els.examType.value : state.examType;
    state.questionType = els.questionType ? els.questionType.value : state.questionType;
    recomputeStats();
    renderWordReqHint();

    /* 防幻觉拦截：题干与给定材料任一为空 */
    var missing = [];
    if (els.stem) { els.stem.classList.remove('field-error'); }
    if (els.material) { els.material.classList.remove('field-error'); }
    if (!state.stem.trim()) { missing.push(els.stem); }
    if (!state.material.trim()) { missing.push(els.material); }

    if (missing.length) {
      for (var i = 0; i < missing.length; i++) {
        if (missing[i]) { missing[i].classList.add('field-error'); }
      }
      toast('缺少题干或者给定材料，无法完成阅卷，请补齐信息', 'error');
      if (missing[0]) { missing[0].focus(); }
      return;
    }

    /* 满分缺失：允许生成但提示 */
    var scoreFilled = state.score !== null && String(state.score).trim() !== '';
    if (!scoreFilled) {
      toast('未填写满分，已按题型默认满分占位，建议补全', 'warn');
    }

    /* 组装并渲染 */
    var instruction = buildInstruction();
    state.lastInstruction = instruction;
    renderOutput(instruction);
    renderWarnStrip();
    addHistoryRecord();

    toast('阅卷指令已生成', 'ok');
  }

  function handleReset() {
    state.examType = 'auto';
    state.questionType = 'gngk';
    state.score = '';
    state.wordReq = '';
    state.stem = '';
    state.material = '';
    state.answer = '';
    state.parsedWord = null;
    state.wordStat = null;
    state.lastInstruction = '';

    if (els.examType) { els.examType.value = 'auto'; }
    if (els.questionType) { els.questionType.value = 'gngk'; }
    if (els.score) { els.score.value = ''; }
    if (els.wordReq) { els.wordReq.value = ''; }
    if (els.stem) { els.stem.value = ''; els.stem.classList.remove('field-error'); }
    if (els.material) { els.material.value = ''; els.material.classList.remove('field-error'); }
    if (els.answer) { els.answer.value = ''; }

    updateBadges();
    renderParadigmBar();
    renderWordReqHint();
    recomputeStats();
    renderWarnStrip();
    renderOutput('');

    toast('已重置全部输入', 'ok');
  }

  /* ======================== 下拉框填充 ======================== */
  function fillSelect(select, list, getId, getName) {
    if (!select) { return; }
    select.innerHTML = '';
    for (var i = 0; i < list.length; i++) {
      var opt = document.createElement('option');
      opt.value = getId(list[i]);
      opt.textContent = getName(list[i]);
      select.appendChild(opt);
    }
  }

  /* ======================== 事件绑定 ======================== */
  function bindEvents() {
    if (els.stem) { els.stem.addEventListener('input', onMaterialsInput); }
    if (els.material) { els.material.addEventListener('input', onMaterialsInput); }
    if (els.answer) { els.answer.addEventListener('input', onMaterialsInput); }

    if (els.wordReq) { els.wordReq.addEventListener('input', onWordReqInput); }
    if (els.examType) { els.examType.addEventListener('change', onExamChange); }
    if (els.questionType) { els.questionType.addEventListener('change', onQuestionChange); }
    if (els.score) { els.score.addEventListener('input', onScoreInput); }

    if (els.btnGenerate) { els.btnGenerate.addEventListener('click', handleGenerate); }
    if (els.btnReset) { els.btnReset.addEventListener('click', handleReset); }

    if (els.btnCopyAll) {
      els.btnCopyAll.addEventListener('click', function () {
        if (!state.lastInstruction) { toast('请先生成阅卷指令', 'warn'); return; }
        copyText(state.lastInstruction, '完整指令已复制');
      });
    }
    if (els.btnCopyRole) {
      els.btnCopyRole.addEventListener('click', function () {
        copyText(String(ROLE_PROMPT), '角色提示词已复制');
      });
    }
    if (els.btnDownload) {
      els.btnDownload.addEventListener('click', function () {
        if (!state.lastInstruction) { toast('请先生成阅卷指令', 'warn'); return; }
        downloadText(tsFilename(), state.lastInstruction);
      });
    }

    if (els.btnLibrary) {
      els.btnLibrary.addEventListener('click', function () {
        closeDrawers();
        openDrawer(els.libraryDrawer);
      });
    }
    if (els.btnHistory) {
      els.btnHistory.addEventListener('click', function () {
        closeDrawers();
        renderHistory();
        openDrawer(els.historyDrawer);
      });
    }
    if (els.btnCloseLibrary) { els.btnCloseLibrary.addEventListener('click', closeDrawers); }
    if (els.btnCloseHistory) { els.btnCloseHistory.addEventListener('click', closeDrawers); }
    if (els.scrim) { els.scrim.addEventListener('click', closeDrawers); }
    if (els.btnClearHistory) { els.btnClearHistory.addEventListener('click', clearHistory); }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeDrawers(); }
    });
  }

  /* ======================== 初始化 ======================== */
  function init() {
    /* 收集 DOM 引用 */
    els = {
      paradigmBar: $('paradigmBar'),
      examType: $('examType'),
      questionType: $('questionType'),
      score: $('score'),
      wordReq: $('wordReq'),
      wordReqHint: $('wordReqHint'),
      stem: $('stem'),
      material: $('material'),
      answer: $('answer'),
      stemCount: $('stemCount'),
      materialCount: $('materialCount'),
      answerCount: $('answerCount'),
      wordPanel: $('wordPanel'),
      btnGenerate: $('btnGenerate'),
      btnReset: $('btnReset'),
      btnCopyAll: $('btnCopyAll'),
      btnCopyRole: $('btnCopyRole'),
      btnDownload: $('btnDownload'),
      warnStrip: $('warnStrip'),
      output: $('output'),
      outputEmpty: $('outputEmpty'),
      libraryDrawer: $('libraryDrawer'),
      libraryBody: $('libraryBody'),
      btnLibrary: $('btnLibrary'),
      btnCloseLibrary: $('btnCloseLibrary'),
      historyDrawer: $('historyDrawer'),
      historyBody: $('historyBody'),
      historyStorageNote: $('historyStorageNote'),
      btnHistory: $('btnHistory'),
      btnCloseHistory: $('btnCloseHistory'),
      btnClearHistory: $('btnClearHistory'),
      scrim: $('scrim'),
      toastHost: $('toastHost')
    };

    /* 填充下拉框 */
    fillSelect(els.examType, EXAM_TYPES, function (x) { return x.id; }, function (x) { return x.name; });
    fillSelect(els.questionType, QUESTION_TYPES, function (x) { return x.id; }, function (x) { return x.name; });
    if (els.examType) { els.examType.value = 'auto'; }
    if (els.questionType) { els.questionType.value = 'gngk'; }

    /* 载入历史（静默降级） */
    state.history = loadHistoryFromStorage();

    /* 初次渲染 */
    renderParadigmBar();
    renderWordReqHint();
    renderWordPanel();
    renderLibrary();
    renderHistory();
    renderWarnStrip();
    renderOutput('');
    updateBadges();

    /* 绑定事件 */
    bindEvents();
  }

  /* 对外暴露（便于调试，不影响运行） */
  window.__shenlunGrader = {
    state: state,
    parseWordReq: parseWordReq,
    countChars: countChars,
    evalWordStatus: evalWordStatus,
    buildInstruction: buildInstruction
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

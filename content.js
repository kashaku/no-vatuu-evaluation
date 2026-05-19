(() => {
  const STORAGE_KEY = "noVatuuEvaluationState";
  const DEFAULTS = {
    running: false,
    score: "5.0",
    submitDelaySeconds: 15,
    autoSubmit: true,
    positiveText: "课程内容安排合理，教师讲解清晰，学习收获较大。",
    improveText: "建议继续丰富案例与实践环节。",
    phase: "idle",
    submittedCount: 0
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let busy = false;
  let countdownTimer = 0;

  function storageGet() {
    return chrome.storage.local.get(STORAGE_KEY).then((data) => ({
      ...DEFAULTS,
      ...(data[STORAGE_KEY] || {})
    }));
  }

  async function storagePatch(patch) {
    const state = await storageGet();
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        ...state,
        ...patch,
        updatedAt: Date.now()
      }
    });
  }

  function normalizeUrl(url) {
    try {
      return new URL(url, window.location.href).href.replace(/#.*$/, "");
    } catch (error) {
      return String(url || "");
    }
  }

  function textOf(node) {
    return (node && node.textContent ? node.textContent : "").replace(/\s+/g, " ").trim();
  }

  function isVisible(node) {
    if (!node) return false;
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function dispatchInputEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getQuestionnaireLinks() {
    return Array.from(document.querySelectorAll("a[href*='setAction=viewAssess']"))
      .filter((link) => /填写问卷/.test(textOf(link)))
      .map((link) => ({
        href: normalizeUrl(link.href),
        label: textOf(link),
        rowText: textOf(link.closest("tr"))
      }));
  }

  function getCourseNameFromRow(rowText) {
    const parts = rowText.split(" ").filter(Boolean);
    return parts.length >= 3 ? parts.slice(2, 3).join(" ") : rowText;
  }

  function hasAnswerForm() {
    return Boolean(document.querySelector("#answerForm, form[name='answerForm']"));
  }

  function hasEvaluationList() {
    return getQuestionnaireLinks().length > 0;
  }

  function ensureOverlay() {
    let overlay = document.getElementById("no-vatuu-evaluation-status");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "no-vatuu-evaluation-status";
    overlay.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "max-width:360px",
      "padding:10px 12px",
      "border:1px solid #f27a1a",
      "box-shadow:6px 6px 0 rgba(0,0,0,.18)",
      "background:#2b2f35",
      "color:#fff",
      "font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
    ].join(";");
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function setOverlay(message) {
    ensureOverlay().textContent = message;
  }

  async function stopWithStatus(message) {
    setOverlay(message);
    await storagePatch({
      running: false,
      phase: "stopped",
      status: message,
      activeHref: "",
      questionnaireStartedAt: 0
    });
  }

  function revealQuestion(index) {
    const problem = document.getElementById(`post-problem${index}`);
    const answer = document.getElementById(`answerDiv${index}`);
    if (problem) problem.style.display = "block";
    if (answer) answer.style.display = "block";
  }

  function selectRadio(problemId, index, targetScore) {
    const radios = Array.from(document.getElementsByName(`problem${problemId}`))
      .filter((input) => input.type === "radio");
    if (!radios.length) return false;

    const chosen = radios.find((radio) => radio.getAttribute("score") === targetScore) || radios[0];
    revealQuestion(index);
    chosen.checked = true;
    chosen.click();
    dispatchInputEvents(chosen);
    return true;
  }

  function fillTextarea(problemId, index, state) {
    const fields = Array.from(document.getElementsByName(`problem${problemId}`))
      .filter((input) => input.tagName === "TEXTAREA" || input.type === "text");
    if (!fields.length) return false;

    const problemText = textOf(document.getElementById(`post-problem${index}`));
    const fallback = index % 2 === 0 ? state.positiveText : state.improveText;
    const value = /改进|不足|建议|需要/.test(problemText)
      ? state.improveText
      : /满意|收获|优点|有用/.test(problemText)
        ? state.positiveText
        : fallback;

    revealQuestion(index);
    fields.forEach((field) => {
      field.value = value;
      dispatchInputEvents(field);
    });
    return true;
  }

  async function fillQuestionnaire(state) {
    const form = document.querySelector("#answerForm, form[name='answerForm']");
    if (!form) return false;

    const problemIds = Array.from(form.querySelectorAll("input[name='problem_id']"));
    if (!problemIds.length) {
      await stopWithStatus("没有找到题目，已停止");
      return true;
    }

    const currentHref = normalizeUrl(window.location.href);
    const startedAt = state.questionnaireStartedAt && state.activeHref === currentHref
      ? state.questionnaireStartedAt
      : Date.now();

    await storagePatch({
      phase: "filling",
      status: `正在填写 ${problemIds.length} 道题`,
      activeHref: currentHref,
      questionnaireStartedAt: startedAt
    });
    setOverlay(`正在填写问卷：${problemIds.length} 道题`);

    for (let index = 0; index < problemIds.length; index += 1) {
      const latest = await storageGet();
      if (!latest.running) {
        setOverlay("已停止");
        return true;
      }

      const problemId = problemIds[index].value;
      const answered = selectRadio(problemId, index, latest.score) || fillTextarea(problemId, index, latest);
      if (!answered) {
        await stopWithStatus(`第 ${index + 1} 题没有识别到可填写控件`);
        return true;
      }
      await delay(180);
    }

    const latest = await storageGet();
    if (!latest.autoSubmit) {
      await storagePatch({
        phase: "filled",
        status: "已填写，等待手动提交"
      });
      setOverlay("已填写，自动提交已关闭");
      return true;
    }

    await waitBeforeSubmit(startedAt, latest);
    await submitQuestionnaire();
    return true;
  }

  async function waitBeforeSubmit(startedAt, state) {
    const waitMs = Math.max(0, Number(state.submitDelaySeconds || 0) * 1000);
    clearInterval(countdownTimer);

    while (Date.now() - startedAt < waitMs) {
      const latest = await storageGet();
      if (!latest.running) {
        setOverlay("已停止");
        return;
      }

      const remaining = Math.ceil((waitMs - (Date.now() - startedAt)) / 1000);
      const message = `已填写，${remaining} 秒后提交`;
      setOverlay(message);
      await storagePatch({
        phase: "waiting",
        status: message
      });
      await delay(Math.min(1000, waitMs));
    }
  }

  async function submitQuestionnaire() {
    const state = await storageGet();
    if (!state.running) return;

    const submitButton = Array.from(document.querySelectorAll("input[type='button'], button"))
      .find((button) => /提交/.test(button.value || textOf(button)) && isVisible(button));

    if (!submitButton) {
      await stopWithStatus("没有找到提交按钮，已停止");
      return;
    }

    const message = "正在提交当前问卷";
    setOverlay(message);
    await storagePatch({
      phase: "submitted",
      status: message,
      submittedCount: Number(state.submittedCount || 0) + 1,
      activeHref: normalizeUrl(window.location.href)
    });
    submitButton.click();
  }

  async function continueFromList(state) {
    const links = getQuestionnaireLinks();
    if (!links.length) return false;

    if (state.phase === "submitted" && state.activeHref) {
      const sameLinkStillOpen = links.some((link) => link.href === state.activeHref);
      if (sameLinkStillOpen) {
        await stopWithStatus("上一次提交后问卷仍显示未完成，请手动检查");
        return true;
      }
    }

    const next = links[0];
    const courseName = getCourseNameFromRow(next.rowText);
    const message = `准备进入问卷：${courseName || "下一份问卷"}`;
    setOverlay(message);
    await storagePatch({
      phase: "opening",
      status: message,
      activeHref: next.href,
      questionnaireStartedAt: 0
    });
    window.location.assign(next.href);
    return true;
  }

  async function run() {
    if (busy) return;
    busy = true;
    try {
      const state = await storageGet();
      if (!state.running) return;

      if (hasAnswerForm()) {
        await fillQuestionnaire(state);
        return;
      }

      if (hasEvaluationList()) {
        await continueFromList(state);
        return;
      }

      if (window.top === window) {
        setOverlay("已启动，请打开 VATUU 课程评价列表页");
        await storagePatch({
          phase: "idle",
          status: "请打开课程评价列表页"
        });
      }
    } finally {
      busy = false;
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      const next = { ...DEFAULTS, ...changes[STORAGE_KEY].newValue };
      if (next.running) run();
      if (!next.running) {
        clearInterval(countdownTimer);
        const overlay = document.getElementById("no-vatuu-evaluation-status");
        if (overlay) overlay.remove();
      }
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();

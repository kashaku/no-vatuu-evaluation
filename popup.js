const STORAGE_KEY = "noVatuuEvaluationState";

const defaults = {
  running: false,
  score: "5.0",
  submitDelaySeconds: 15,
  autoSubmit: true,
  positiveText: "课程内容安排合理，教师讲解清晰，学习收获较大。",
  improveText: "建议继续丰富案例与实践环节。",
  phase: "idle",
  status: "未启动"
};

const els = {
  status: document.getElementById("status"),
  statusBadge: document.getElementById("statusBadge"),
  score: document.getElementById("score"),
  delay: document.getElementById("delay"),
  autoSubmit: document.getElementById("autoSubmit"),
  positiveText: document.getElementById("positiveText"),
  improveText: document.getElementById("improveText"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop")
};

function readState() {
  if (!globalThis.chrome?.storage?.local) {
    return Promise.resolve({
      ...defaults,
      ...(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || {})
    });
  }

  return chrome.storage.local.get(STORAGE_KEY).then((data) => ({
    ...defaults,
    ...(data[STORAGE_KEY] || {})
  }));
}

function writeState(patch) {
  if (!globalThis.chrome?.storage?.local) {
    return readState().then((state) => {
      const next = {
        ...state,
        ...patch,
        updatedAt: Date.now()
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      render(next);
    });
  }

  return readState().then((state) => chrome.storage.local.set({
    [STORAGE_KEY]: {
      ...state,
      ...patch,
      updatedAt: Date.now()
    }
  }));
}

function statusView(state) {
  if (state.running) {
    return {
      label: "运行中",
      className: "status-badge is-running",
      text: state.status || state.phase || "处理中"
    };
  }

  if (state.phase === "stopped") {
    return {
      label: "已停止",
      className: "status-badge is-stopped",
      text: state.status || "已停止"
    };
  }

  return {
    label: "就绪",
    className: "status-badge is-ready",
    text: state.status && state.status !== "未启动" ? state.status : "等待启动"
  };
}

function render(state) {
  const view = statusView(state);

  els.score.value = state.score || defaults.score;
  els.delay.value = Number.isFinite(Number(state.submitDelaySeconds))
    ? String(state.submitDelaySeconds)
    : String(defaults.submitDelaySeconds);
  els.autoSubmit.checked = state.autoSubmit !== false;
  els.positiveText.value = state.positiveText || defaults.positiveText;
  els.improveText.value = state.improveText || defaults.improveText;
  els.statusBadge.textContent = view.label;
  els.statusBadge.className = view.className;
  els.status.textContent = view.text;
}

function currentOptions() {
  return {
    score: els.score.value,
    submitDelaySeconds: Math.max(0, Number.parseInt(els.delay.value, 10) || 0),
    autoSubmit: els.autoSubmit.checked,
    positiveText: els.positiveText.value.trim() || defaults.positiveText,
    improveText: els.improveText.value.trim() || defaults.improveText
  };
}

els.start.addEventListener("click", () => {
  writeState({
    ...currentOptions(),
    running: true,
    phase: "idle",
    status: "等待评价页面接手",
    activeHref: "",
    startedAt: Date.now(),
    questionnaireStartedAt: 0,
    submittedCount: 0
  });
});

els.stop.addEventListener("click", () => {
  writeState({
    running: false,
    phase: "stopped",
    status: "已停止",
    activeHref: "",
    questionnaireStartedAt: 0
  });
});

if (globalThis.chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      render({ ...defaults, ...changes[STORAGE_KEY].newValue });
    }
  });
}

readState().then(render);

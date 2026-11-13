const INTENTS = ["bug", "confusion", "idea", "praise", "observation"];

let pendingElement = null; // payload from content.js while compose form is open
let selectedIntent = "observation";
let currentSessionId = null;

document.addEventListener("DOMContentLoaded", async () => {
  const config = await sendMessage({ type: "GET_CONFIG" });
  if (config && config.apiBase) document.getElementById("apiBase").value = config.apiBase;
  await refreshSessionStatus();
});

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response));
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// A content script is normally injected at page load. After an unpacked
// extension reload, however, an already-open tab can still carry a stale
// script. Verify that it can receive the message, then inject the current
// script as a fallback instead of showing a misleading armed state.
async function sendToPage(tab, message) {
  try {
    await chrome.tabs.sendMessage(tab.id, message);
    return true;
  } catch (firstError) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tab.id, message);
      return true;
    } catch (injectionError) {
      console.warn("[Continuous Sanity] could not reach the page picker", injectionError || firstError);
      return false;
    }
  }
}

// ---------- Session lifecycle ----------

async function refreshSessionStatus() {
  const session = await sendMessage({ type: "GET_ACTIVE_SESSION" });
  const statusEl = document.getElementById("sessionStatus");
  const joinBtn = document.getElementById("joinSessionBtn");
  const leaveBtn = document.getElementById("leaveSessionBtn");
  const pickerSection = document.getElementById("pickerSection");
  const inviteCodeInput = document.getElementById("inviteCode");
  const testerLabelInput = document.getElementById("testerLabel");

  if (session) {
    currentSessionId = session.sessionId;
    statusEl.classList.add("active");
    const modeLabel = session.mode === "guided" ? session.taskDescription || "guided — no focus set" : "exploratory";
    statusEl.textContent = `${session.inviteCode} · ${session.persona || "unlabeled persona"} · ${modeLabel}`;
    joinBtn.style.display = "none";
    leaveBtn.style.display = "block";
    inviteCodeInput.disabled = true;
    testerLabelInput.disabled = true;
    pickerSection.style.display = "block";
    refreshFeed();
  } else {
    currentSessionId = null;
    statusEl.classList.remove("active");
    statusEl.textContent = "No active session";
    joinBtn.style.display = "block";
    leaveBtn.style.display = "none";
    inviteCodeInput.disabled = false;
    testerLabelInput.disabled = false;
    pickerSection.style.display = "none";
    document.getElementById("feed").innerHTML = `<p class="empty">No observations yet.</p>`;
  }
}

document.getElementById("joinSessionBtn").addEventListener("click", async () => {
  const inviteCode = document.getElementById("inviteCode").value.trim();
  const testerLabel = document.getElementById("testerLabel").value.trim();
  const status = document.getElementById("status");

  if (!inviteCode || !testerLabel) {
    status.style.color = "#dc2626";
    status.textContent = !inviteCode ? "Enter an invite code first." : "Enter your name to join this shared session.";
    return;
  }

  const response = await sendMessage({ type: "JOIN_SESSION", inviteCode, testerLabel });
  if (response && response.error) {
    status.style.color = "#dc2626";
    status.textContent = response.error;
    return;
  }
  status.style.color = "#16a34a";
  status.textContent = "Joined — go interact with the page.";
  refreshSessionStatus();
});

document.getElementById("leaveSessionBtn").addEventListener("click", async () => {
  await sendMessage({ type: "LEAVE_SESSION" });
  document.getElementById("status").textContent = "You left this session on this browser. The QA session is still active.";
  refreshSessionStatus();
});

// ---------- Setup ----------

document.getElementById("saveBtn").addEventListener("click", async () => {
  const apiBase = document.getElementById("apiBase").value.trim().replace(/\/$/, "");
  const status = document.getElementById("status");

  if (!apiBase) {
    status.style.color = "#dc2626";
    status.textContent = "Server URL is required.";
    return;
  }

  await sendMessage({ type: "SET_CONFIG", config: { apiBase } });
  status.style.color = "#16a34a";
  status.textContent = "Setup saved.";
});

document.getElementById("openDashboard").addEventListener("click", async () => {
  const config = await sendMessage({ type: "GET_CONFIG" });
  if (!config || !config.apiBase) return;
  const dashboardUrl = config.apiBase.replace(/\/api\/?$/, "/dashboard/");
  chrome.tabs.create({ url: dashboardUrl });
});

// ---------- Picker (arms the content script on the active tab) ----------

document.getElementById("pickBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  const armed = await sendToPage(tab, { type: "ARM_PICKER" });
  if (!armed) {
    const status = document.getElementById("status");
    status.style.color = "#dc2626";
    status.textContent = "Could not start the picker on this page. Reload the page and try again.";
    return;
  }
  document.getElementById("pickBtn").style.display = "none";
  document.getElementById("armedBanner").style.display = "flex";
});

document.getElementById("cancelPickBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab) await sendToPage(tab, { type: "DISARM_PICKER" });
  disarmUi();
});

function disarmUi() {
  document.getElementById("pickBtn").style.display = "block";
  document.getElementById("armedBanner").style.display = "none";
}

// content.js broadcasts this once the tester clicks an element
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "ELEMENT_PICKED") {
    disarmUi();
    openCompose(message.payload);
  }
});

// ---------- Compose ----------

// Positions a pin at (clickX, clickY) — CSS px relative to the captured
// viewport — as a percentage over the rendered screenshot. Works regardless
// of display size since the screenshot's aspect ratio matches the viewport's.
function positionPin(pinEl, clickX, clickY, viewport) {
  if (!viewport || !viewport.width || !viewport.height || clickX == null || clickY == null) {
    pinEl.style.display = "none";
    return;
  }
  pinEl.style.display = "block";
  pinEl.style.left = `${(clickX / viewport.width) * 100}%`;
  pinEl.style.top = `${(clickY / viewport.height) * 100}%`;
}

function openCompose(payload) {
  pendingElement = payload;
  selectedIntent = "observation";

  const composeSection = document.getElementById("composeSection");
  composeSection.style.display = "block";

  const wrap = document.getElementById("composeScreenshotWrap");
  const img = document.getElementById("composeScreenshot");
  const pin = document.getElementById("composePin");

  if (payload.screenshotData) {
    img.src = payload.screenshotData;
    wrap.style.display = "block";
    positionPin(pin, payload.clickX, payload.clickY, payload.viewport);
  } else {
    wrap.style.display = "none";
  }

  document.getElementById("composeLabel").textContent = `${payload.elementLabel || "unlabeled element"} · ${payload.pageTitle || payload.pageUrl}`;
  document.getElementById("composeComment").value = "";

  const intentButtons = document.getElementById("intentButtons");
  intentButtons.innerHTML = INTENTS.map(
    (i) => `<button data-intent="${i}" class="${i === selectedIntent ? "selected" : ""}">${i}</button>`
  ).join("");
  intentButtons.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      selectedIntent = b.dataset.intent;
      intentButtons.querySelectorAll("button").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
    });
  });

  composeSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeCompose() {
  pendingElement = null;
  document.getElementById("composeSection").style.display = "none";
}

document.getElementById("composeCancel").addEventListener("click", closeCompose);

document.getElementById("composeSend").addEventListener("click", async () => {
  const comment = document.getElementById("composeComment").value.trim();
  if (!comment || !pendingElement) return;

  const sendBtn = document.getElementById("composeSend");
  sendBtn.textContent = "Sending…";
  sendBtn.disabled = true;

  const response = await sendMessage({
    type: "SUBMIT_FEEDBACK",
    payload: { ...pendingElement, intent: selectedIntent, comment },
  });

  sendBtn.textContent = "Send";
  sendBtn.disabled = false;

  if (response && response.error) {
    document.getElementById("status").style.color = "#dc2626";
    document.getElementById("status").textContent = response.error;
    return;
  }

  closeCompose();
  refreshFeed();
});

// ---------- Live feed for the current session ----------

let feedPollTimer = null;

async function refreshFeed() {
  if (!currentSessionId) return;
  const config = await sendMessage({ type: "GET_CONFIG" });
  if (!config || !config.apiBase) return;

  try {
    const session = await sendMessage({ type: "GET_ACTIVE_SESSION" });
    if (!session?.participantToken) return;
    const res = await fetch(`${config.apiBase}/sessions/${currentSessionId}/participant-feedback`, {
      headers: { "X-Participant-Token": session.participantToken },
    });
    if (!res.ok) return;
    const data = await res.json();
    renderFeed(data.feedback || []);
    scheduleFeedPoll(data.feedback || []);
  } catch (err) {
    console.warn("[Continuous Sanity] feed refresh failed", err);
  }
}

function scheduleFeedPoll(feedback) {
  clearTimeout(feedPollTimer);
  const stillClassifying = feedback.some((f) => !f.quick_classification);
  if (!stillClassifying) return;
  feedPollTimer = setTimeout(refreshFeed, 2500);
}

function renderFeed(items) {
  const feed = document.getElementById("feed");
  if (items.length === 0) {
    feed.innerHTML = `<p class="empty">No observations yet.</p>`;
    return;
  }
  feed.innerHTML = items
    .slice()
    .reverse()
    .map((f) => {
      const hasPin = f.viewport && f.click_x != null && f.click_y != null;
      const pinLeft = hasPin ? (f.click_x / f.viewport.width) * 100 : 0;
      const pinTop = hasPin ? (f.click_y / f.viewport.height) * 100 : 0;
      const needsFollowup = f.signal_sufficient === false && !f.followup_answer && !f.followup_skipped;

      return `
    <div class="feed-item">
      <span class="tag">${escapeHtml(f.intent)}</span>
      ${
        f.quick_classification
          ? `<span class="tag classification">${escapeHtml(f.quick_classification)}</span>`
          : `<span class="tag classifying">classifying…</span>`
      }
      ${
        f.screenshot_data
          ? `<div class="screenshot-wrap"><img src="${f.screenshot_data}" alt="Screenshot" />${
              hasPin ? `<div class="pin" style="left:${pinLeft}%;top:${pinTop}%;"></div>` : ""
            }</div>`
          : ""
      }
      <div>${escapeHtml(f.comment)}</div>
      <div class="context">${escapeHtml(f.element_label || "")}</div>
      ${
        f.followup_question && f.followup_answer
          ? `<div class="followup answered"><span class="followup-q">${escapeHtml(f.followup_question)}</span><span class="followup-a">${escapeHtml(f.followup_answer)}</span></div>`
          : ""
      }
      ${
        needsFollowup
          ? `<div class="followup-needed" data-feedback-id="${f.id}" data-question="${escapeHtml(f.followup_question)}">
               <span class="followup-q">${escapeHtml(f.followup_question)}</span>
               <div class="followup-actions">
                 <button class="link followup-skip-btn">skip</button>
                 <button class="followup-answer-btn">Answer</button>
               </div>
             </div>`
          : ""
      }
    </div>
  `;
    })
    .join("");

  feed.querySelectorAll(".followup-needed").forEach((el) => {
    const feedbackId = el.dataset.feedbackId;
    const question = el.dataset.question;

    el.querySelector(".followup-answer-btn").addEventListener("click", () => {
      openFollowup(feedbackId, question);
    });

    el.querySelector(".followup-skip-btn").addEventListener("click", async () => {
      await sendMessage({ type: "SUBMIT_FOLLOWUP", feedbackId, skipped: true });
      refreshFeed();
    });
  });
}

// ---------- Follow-up answer (stable section — never destroyed by feed polling) ----------

let pendingFollowupId = null;

function openFollowup(feedbackId, question) {
  pendingFollowupId = feedbackId;
  document.getElementById("followupQuestionText").textContent = question;
  document.getElementById("followupAnswerInput").value = "";
  document.getElementById("followupSection").style.display = "block";
  document.getElementById("followupAnswerInput").focus();
  document.getElementById("followupSection").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeFollowup() {
  pendingFollowupId = null;
  document.getElementById("followupSection").style.display = "none";
}

document.getElementById("followupCancel").addEventListener("click", closeFollowup);

document.getElementById("followupSend").addEventListener("click", async () => {
  const answer = document.getElementById("followupAnswerInput").value.trim();
  if (!answer || !pendingFollowupId) return;

  const sendBtn = document.getElementById("followupSend");
  sendBtn.textContent = "Sending…";
  sendBtn.disabled = true;

  const response = await sendMessage({ type: "SUBMIT_FOLLOWUP", feedbackId: pendingFollowupId, answer });

  sendBtn.textContent = "Send";
  sendBtn.disabled = false;

  if (response && response.error) {
    document.getElementById("status").style.color = "#dc2626";
    document.getElementById("status").textContent = response.error;
    return;
  }

  closeFollowup();
  refreshFeed();
});

document.getElementById("followupAnswerInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("followupSend").click();
});

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Continuous Sanity — background service worker
//
// All network I/O and tab screenshot capture happens here, not in the content
// script. This sidesteps page-level CORS/CSP restrictions entirely and keeps
// the extension's fetch calls scoped to a context Chrome trusts.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[Continuous Sanity] sidePanel setup failed", err));

// Message types this background worker actually owns. Other types (e.g.
// ELEMENT_PICKED, broadcast by the content script straight to the side panel)
// are notifications meant for a different listener — background just ignores
// them rather than treating them as errors.
const OWNED_TYPES = new Set([
  "GET_CONFIG",
  "SET_CONFIG",
  "JOIN_SESSION",
  "LEAVE_SESSION",
  "GET_ACTIVE_SESSION",
  "SUBMIT_FEEDBACK",
  "SUBMIT_FOLLOWUP",
  "CAPTURE_SCREENSHOT",
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!OWNED_TYPES.has(message.type)) return false; // let other listeners (side panel) handle it

  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error("[Continuous Sanity background]", err);
      sendResponse({ error: err.message });
    });
  return true; // keep the message channel open for the async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "GET_CONFIG":
      return getConfig();
    case "SET_CONFIG":
      await chrome.storage.sync.set(message.config);
      return { ok: true };
    case "JOIN_SESSION":
      return joinSession(message.inviteCode, message.testerLabel);
    case "LEAVE_SESSION":
      return leaveSession();
    case "GET_ACTIVE_SESSION":
      return getActiveSession();
    case "SUBMIT_FEEDBACK":
      return submitFeedback(message.payload);
    case "SUBMIT_FOLLOWUP":
      return submitFollowup(message.feedbackId, message.answer, message.skipped);
    case "CAPTURE_SCREENSHOT":
      return captureScreenshot(sender.tab.windowId);
    default:
      return null;
  }
}

async function getConfig() {
  return chrome.storage.sync.get(["apiBase"]);
}

const ACTIVE_SESSION_KEY = "cs_active_session";

// Joining replaces the old "Start sanity session" flow — the tester types a
// short code (created by whoever owns the test plan, from the dashboard)
// instead of configuring project/persona/task themselves. testerLabel is the
// one thing still entered locally, since it identifies which physical person
// is testing, not which test plan they're running.
//
// Each browser keeps its own active-session pointer. Multiple testers can join
// the same invite code; the tester label is sent with every feedback item so
// the shared session remains attributable without changing its creator metadata.
async function joinSession(inviteCode, testerLabel) {
  const config = await getConfig();
  if (!config.apiBase) {
    throw new Error("Set the server URL in Setup first.");
  }
  if (!inviteCode) {
    throw new Error("Enter an invite code.");
  }

  if (!testerLabel || !testerLabel.trim()) {
    throw new Error("Enter your name to join this shared session.");
  }

  const res = await fetch(`${config.apiBase}/sessions/join/${encodeURIComponent(inviteCode.trim())}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ testerLabel }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to join session (HTTP ${res.status})`);
  }
  const data = await res.json();

  const active = { ...data, joinedAt: Date.now() };
  await chrome.storage.session.set({ [ACTIVE_SESSION_KEY]: active });
  return active;
}

// Testers can leave this browser's copy of a session, but they must never be
// able to end the shared session for every other participant. That action is
// owned by the QA dashboard and requires the session owner's capability token.
async function leaveSession() {
  await chrome.storage.session.remove(ACTIVE_SESSION_KEY);
  return { ok: true };
}

async function getActiveSession() {
  const stored = await chrome.storage.session.get(ACTIVE_SESSION_KEY);
  return stored[ACTIVE_SESSION_KEY] || null;
}

async function submitFeedback(payload) {
  const config = await getConfig();
  const active = await getActiveSession();
  if (!active) {
    throw new Error("No active sanity session — join one from the Continuous Sanity side panel first.");
  }

  const res = await fetch(`${config.apiBase}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, sessionId: active.sessionId, participantToken: active.participantToken }),
  });
  if (!res.ok) throw new Error(`Failed to submit feedback (HTTP ${res.status})`);
  return res.json();
}

async function submitFollowup(feedbackId, answer, skipped) {
  const config = await getConfig();
  const active = await getActiveSession();
  if (!active) throw new Error("No active sanity session — rejoin before answering a follow-up.");
  const res = await fetch(`${config.apiBase}/feedback/${feedbackId}/followup`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(skipped ? { skipped: true, participantToken: active.participantToken } : { answer, participantToken: active.participantToken }),
  });
  if (!res.ok) throw new Error(`Failed to save follow-up (HTTP ${res.status})`);
  return res.json();
}

async function captureScreenshot(windowId) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  return { dataUrl };
}

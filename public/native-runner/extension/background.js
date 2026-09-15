import * as legacyController from './background-v0.2.js';

// v0.3.1 lean gateway. The compatibility controller is statically imported
// because MV3 does not support dynamic import() in extension service workers.
// The gateway owns wake/execution policy; the controller owns the proven 0.2.x
// browser protocol and checkout behavior.
const POLL_ALARM = 'magic-city-runner-poll';
const RESUME_ALARM = 'magic-city-runner-resume';
const POLL_PERIOD_MINUTES = 1;
const ACTIVE_MISSION_RECOVERY_DELAY_MS = 30_000;
const ACTIVE_MISSION_PROGRESS_INTERVAL_MS = 15_000;
const INLINE_CHECKPOINT_RECONCILIATION_DELAY_MS = 200;
const MAX_INLINE_CHECKPOINT_RECONCILIATIONS = 8;
const LEAN_RUNTIME_MODE = 'v0.5.17-asin-bound-selection-intelligence';
const PROGRESS_STREAM_ID = globalThis.crypto?.randomUUID?.() || `progress-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const ALLOWED_EXTERNAL_ORIGINS = new Set([
  'https://magic-city.ai',
  'https://magic-city-staging.fly.dev'
]);

async function setLeanRuntimeMode() {
  await chrome.storage.local.set({ runtimeMode: LEAN_RUNTIME_MODE });
}

async function hasPairedDevice() {
  const config = await chrome.storage.local.get({ deviceToken: '' });
  return Boolean(config.deviceToken);
}

async function ensureHeartbeatAlarm() {
  if (await hasPairedDevice()) {
    await chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MINUTES });
  } else {
    await chrome.alarms.clear(POLL_ALARM);
  }
}

async function clearLegacyResumeAlarm() {
  await chrome.alarms.clear(RESUME_ALARM);
}

async function dispatch(message, sender = null) {
  const result = await legacyController.handleMessage(message, sender);
  await ensureHeartbeatAlarm();
  return result;
}

function externalSenderContext(sender = null, origin = '') {
  const tabId = Number(sender?.tab?.id);
  const windowId = Number(sender?.tab?.windowId);
  return {
    origin,
    tab: {
      ...(Number.isInteger(tabId) && tabId >= 0 ? { id: tabId } : {}),
      ...(Number.isInteger(windowId) && windowId >= 0 ? { windowId } : {})
    }
  };
}

function retryingRecoverableExecution(result) {
  if (['retrying_control_plane', 'retrying_browser_step'].includes(result?.status)) return result;
  return Array.isArray(result?.executed)
    ? result.executed.find((entry) => ['retrying_control_plane', 'retrying_browser_step'].includes(entry?.status)) || null
    : null;
}

function replaceExecutionResult(result, recovered) {
  if (!Array.isArray(result?.executed)) return recovered;
  return {
    ...result,
    executed: result.executed.map((entry) => (
      String(entry?.sessionId || '') === String(recovered?.sessionId || '') ? recovered : entry
    ))
  };
}

async function reconcileCommittedCheckpoint(result) {
  let reconciledResult = result;
  for (let attempt = 0; attempt < MAX_INLINE_CHECKPOINT_RECONCILIATIONS; attempt += 1) {
    const interrupted = retryingRecoverableExecution(reconciledResult);
    if (!interrupted?.sessionId) return reconciledResult;
    const stored = await chrome.storage.local.get({ activeRun: null, lastExecution: null });
    const actionId = String(stored.lastExecution?.actionId || '');
    const sessionId = String(interrupted.sessionId || '');
    const recoveryStatus = String(interrupted.status || stored.lastExecution?.status || '');
    const recoverableAction = recoveryStatus === 'retrying_browser_step'
      ? /^select-match(?:-\d+)?$/.test(actionId)
      : /^(?:open-site|(?:prepare|open|inspect)-cart|continue-checkout|reconcile-payment-profile|inspect-review|submit-final-order|confirm-pending-order|confirm-merchant-order)(?:-\d+)?$/.test(actionId);
    if (!recoverableAction
      || String(stored.lastExecution?.sessionId || '') !== sessionId
      || String(stored.activeRun?.sessionId || '') !== sessionId) {
      return reconciledResult;
    }
    const now = new Date().toISOString();
    await chrome.storage.local.set({
      activeRun: {
        ...stored.activeRun,
        progressLabel: 'Reconnecting Runner',
        progressState: 'reconnecting_control_plane',
        progressSequence: Number(stored.activeRun?.progressSequence || 0) + 1,
        progressUpdatedAt: now,
        updatedAt: now
      }
    });
    await new Promise((resolve) => setTimeout(resolve, INLINE_CHECKPOINT_RECONCILIATION_DELAY_MS));
    try {
      const recovered = await legacyController.resumeActiveRun();
      if (recovered?.sessionId !== sessionId) return reconciledResult;
      reconciledResult = replaceExecutionResult(reconciledResult, recovered);
    } catch {
      // The controller already armed the normal recovery alarm before yielding.
      return reconciledResult;
    }
  }
  return reconciledResult;
}

async function dispatchAlarm(alarm = null) {
  if (!await hasPairedDevice()) return;
  if (alarm?.name === RESUME_ALARM) {
    // Resume only the session that was already authorized and persisted by
    // the executor. This is recovery, not autonomous mission discovery.
    const result = await legacyController.resumeActiveRun();
    // If the original worker is still finishing an action, leave one quiet
    // continuation behind it. If that worker is suspended later, the alarm
    // resumes the already-signed next plan step instead of losing the run.
    if (result?.status === 'already_running') {
      await chrome.alarms.create(RESUME_ALARM, {
        when: Date.now() + ACTIVE_MISSION_RECOVERY_DELAY_MS
      });
    }
    return result;
  }
  const { activeSessionId = '', activeRun = null } = await chrome.storage.local.get({ activeSessionId: '', activeRun: null });
  const activeRunSessionId = String(activeRun?.sessionId || activeSessionId || '').trim();
  if (activeRunSessionId) {
    // A worker restart may clear the one-shot alarm. Recover only this
    // already-authorized session; ordinary heartbeats remain poll-only.
    return legacyController.resumeActiveRun();
  }
  // A heartbeat may resume only a short-lived, user-authorized dispatch.
  // It is recovery for a missed website wake, never open-ended discovery.
  await legacyController.pollOnly();
}

async function bootLeanRuntime() {
  await setLeanRuntimeMode();
  const { activeSessionId = '', activeRun = null } = await chrome.storage.local.get({ activeSessionId: '', activeRun: null });
  if (String(activeRun?.sessionId || activeSessionId || '').trim()) {
    // Preserve recovery across a service-worker restart. The marker is set
    // before the user-approved mission claim and retained through startup.
    await chrome.alarms.create(RESUME_ALARM, { when: Date.now() + 1_000 });
  } else {
    await clearLegacyResumeAlarm();
  }
  await ensureHeartbeatAlarm();
}

chrome.runtime.onInstalled.addListener(() => { void bootLeanRuntime(); });

chrome.runtime.onStartup.addListener(() => { void bootLeanRuntime(); });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (![POLL_ALARM, RESUME_ALARM].includes(alarm.name)) return;
  try {
    await dispatchAlarm(alarm);
  } catch (error) {
    await chrome.storage.local.set({
      lastError: error?.message || String(error),
      lastExecution: { status: 'heartbeat_failed', at: new Date().toISOString() }
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  dispatch(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  (async () => {
    let origin = '';
    try {
      origin = new URL(sender?.url || sender?.origin || '').origin;
    } catch {
      origin = '';
    }
    if (!ALLOWED_EXTERNAL_ORIGINS.has(origin)) throw new Error('origin_not_allowed');
    // Keep the external message open through the exact-session claim. MV3
    // can suspend detached promises after sendResponse, so a fire-and-forget
    // wake is not a valid execution boundary. The page handles its brief
    // pending state while this user-authorized run starts.
    return dispatch(message, externalSenderContext(sender, origin));
  })()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

chrome.runtime.onConnectExternal.addListener((port) => {
  let origin = '';
  try {
    origin = new URL(port.sender?.url || port.sender?.origin || '').origin;
  } catch {
    origin = '';
  }
  if (!ALLOWED_EXTERNAL_ORIGINS.has(origin) || port.name !== 'magic-city-active-run-v1') {
    port.disconnect();
    return;
  }

  let started = false;
  let progressTimer = null;
  let progressSequence = 0;
  let progressQueued = false;
  const postProgress = async () => {
    try {
      const { activeRun = null, lastExecution = null } = await chrome.storage.local.get({ activeRun: null, lastExecution: null });
      progressSequence += 1;
      port.postMessage({
        type: 'RUNNER_PROGRESS',
        streamId: PROGRESS_STREAM_ID,
        sequence: progressSequence,
        activeRun: activeRun ? {
          sessionId: activeRun.sessionId || '',
          phase: activeRun.phase || '',
          progressLabel: activeRun.progressLabel || '',
          progressState: activeRun.progressState || '',
          progressSequence: Number(activeRun.progressSequence || 0) || 0,
          progressUpdatedAt: activeRun.progressUpdatedAt || activeRun.updatedAt || '',
          actionId: activeRun.actionId || '',
          workerId: activeRun.workerId || '',
          lastAwaitedOperation: activeRun.lastAwaitedOperation || null,
          startupTiming: activeRun.startupTiming || null
        } : null,
        lastExecution: lastExecution || null,
        at: new Date().toISOString()
      });
    } catch {
      // A progress pulse is advisory; the durable checkpoints remain primary.
    }
  };
  const queueProgress = () => {
    if (progressQueued) return;
    progressQueued = true;
    queueMicrotask(() => {
      progressQueued = false;
      void postProgress();
    });
  };
  const onStorageChanged = (changes, areaName) => {
    if (areaName !== 'local') return;
    const activeRunChanged = Boolean(changes.activeRun && (
      Number(changes.activeRun.newValue?.progressSequence || 0) !== Number(changes.activeRun.oldValue?.progressSequence || 0)
      || String(changes.activeRun.newValue?.actionId || '') !== String(changes.activeRun.oldValue?.actionId || '')
      || String(changes.activeRun.newValue?.workerId || '') !== String(changes.activeRun.oldValue?.workerId || '')
    ));
    const lastExecutionChanged = Boolean(changes.lastExecution && (
      String(changes.lastExecution.newValue?.status || '') !== String(changes.lastExecution.oldValue?.status || '')
      || String(changes.lastExecution.newValue?.sessionId || '') !== String(changes.lastExecution.oldValue?.sessionId || '')
    ));
    if (!activeRunChanged && !lastExecutionChanged) return;
    queueProgress();
  };

  port.onDisconnect.addListener(() => {
    if (progressTimer) clearInterval(progressTimer);
    chrome.storage.onChanged?.removeListener?.(onStorageChanged);
  });
  port.onMessage.addListener((message) => {
    if (started) return;
    started = true;
    chrome.storage.onChanged?.addListener?.(onStorageChanged);
    void postProgress();
    progressTimer = setInterval(() => { void postProgress(); }, ACTIVE_MISSION_PROGRESS_INTERVAL_MS);
    dispatch(message, externalSenderContext(port.sender, origin))
      .then(reconcileCommittedCheckpoint)
      .then((result) => port.postMessage({ type: 'RUNNER_RESULT', ok: true, result }))
      .catch((error) => port.postMessage({ type: 'RUNNER_RESULT', ok: false, error: error?.message || String(error) }))
      .finally(() => {
        if (progressTimer) clearInterval(progressTimer);
        progressTimer = null;
        try { port.disconnect(); } catch {}
      });
  });
});

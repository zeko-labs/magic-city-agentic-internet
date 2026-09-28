    const CHAT_THREADS_KEY = 'magic_city_chat_threads_v2';
    const ACTIVE_THREAD_KEY = 'magic_city_active_thread_v2';
    const LOCAL_CHAT_MEMORY_KEY = 'magic_city_local_chat_memory_v1';
    const MAX_SAVED_THREADS = 24;
    const DEFAULT_LOCAL_MEMORY_SETTINGS = Object.freeze({
      enabled: true,
      resumeLastThread: false,
      note: '',
      facts: []
    });
    let platformWorkflows = Object.create(null);
    let authSessionUser = null;
    let googleConnectorStatus = null;
    let googleConnectorActivity = [];
    let githubConnectorStatus = null;
    let githubConnectorActivity = [];
    let evmWalletStatus = null;
    let evmWalletActivity = [];
    let evmPaymentAuthorizations = [];
    let evmShadowRelayerStatus = null;
    let evmConfirmationIndexerStatus = null;
    let settlementRegistryEntries = [];
    const PROFILE_VAULT_KEY = 'magic_city_profile_vault_v1';
    const PROFILE_VAULT_AUTH_KEY = 'magic_city_profile_vault_auth_v1';
    const PROFILE_VAULT_DB = 'magic_city_local_secure_store_v1';
    const PROFILE_VAULT_DB_STORE = 'vaultKeys';
    const attemptedLiveFoodDiscovery = new Set();
    const executionPendingSessions = new Set();
    let adminAccess = false;
    let vaultSecurityDbPromise = null;
    let localMemorySettings = { ...DEFAULT_LOCAL_MEMORY_SETTINGS };
    let sessionBootstrapPromise = null;
    let backgroundRefreshTimer = null;
    const lazyBootState = {
      workflows: false,
      identity: false,
      wallet: false,
      accounts: false,
      advanced: false
    };

    function base64ToUint8Array(value) {
      return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    }

    function base64UrlToUint8Array(value) {
      const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
      const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
      return Uint8Array.from(atob(`${normalized}${padding}`), (c) => c.charCodeAt(0));
    }

    async function sha256Hex(input) {
      const data = new TextEncoder().encode(input);
      const digest = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    function arrayBufferToBase64(buffer) {
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }

    function uint8ArrayToBase64Url(bytes) {
      return arrayBufferToBase64(bytes)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    }

    function randomBytes(length = 32) {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      return bytes;
    }

    function hasWebAuthnSupport() {
      return Boolean(window.isSecureContext && window.PublicKeyCredential && navigator.credentials);
    }

    async function hasPlatformAuthenticator() {
      if (!hasWebAuthnSupport() || typeof window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return false;
      try {
        return Boolean(await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
      } catch {
        return false;
      }
    }

    function getStoredVaultRecord() {
      const raw = localStorage.getItem(PROFILE_VAULT_KEY);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }

    function getStoredVaultAuth() {
      const raw = localStorage.getItem(PROFILE_VAULT_AUTH_KEY);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }

    function hasStoredVaultDeviceAuth() {
      const auth = getStoredVaultAuth();
      return Boolean(auth?.credentialId && auth?.method === 'webauthn');
    }

    function hasLegacyVaultRecord() {
      const record = getStoredVaultRecord();
      if (!record) return false;
      return Number(record.version || 1) < 2 || record.unlock === 'passphrase' || Boolean(record.salt);
    }

    function openVaultSecurityDb() {
      if (!window.indexedDB) return Promise.reject(new Error('indexeddb_unavailable'));
      if (vaultSecurityDbPromise) return vaultSecurityDbPromise;
      vaultSecurityDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(PROFILE_VAULT_DB, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(PROFILE_VAULT_DB_STORE)) {
            db.createObjectStore(PROFILE_VAULT_DB_STORE);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('vault_db_open_failed'));
      });
      return vaultSecurityDbPromise;
    }

    async function withVaultKeyStore(mode, run) {
      const db = await openVaultSecurityDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PROFILE_VAULT_DB_STORE, mode);
        const store = tx.objectStore(PROFILE_VAULT_DB_STORE);
        let settled = false;
        const settleResolve = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const settleReject = (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        tx.onabort = () => settleReject(tx.error || new Error('vault_tx_aborted'));
        tx.onerror = () => settleReject(tx.error || new Error('vault_tx_failed'));
        try {
          const maybeValue = run(store, settleResolve, settleReject);
          if (maybeValue !== undefined) {
            tx.oncomplete = () => settleResolve(maybeValue);
          }
        } catch (error) {
          settleReject(error);
        }
      });
    }

    async function storeVaultContentKey(credentialId, key) {
      return withVaultKeyStore('readwrite', (store) => {
        store.put(key, credentialId);
      });
    }

    async function loadVaultContentKey(credentialId) {
      return withVaultKeyStore('readonly', (store, resolve, reject) => {
        const request = store.get(credentialId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('vault_key_load_failed'));
      });
    }

    async function deleteVaultContentKey(credentialId) {
      if (!credentialId) return;
      return withVaultKeyStore('readwrite', (store) => {
        store.delete(credentialId);
      });
    }

    async function deriveVaultKey(passphrase, saltBytes) {
      const baseKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(passphrase),
        'PBKDF2',
        false,
        ['deriveKey']
      );
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: saltBytes, iterations: 120000, hash: 'SHA-256' },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    }

    async function encryptVault(payload, passphrase) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveVaultKey(passphrase, salt);
      const plaintext = new TextEncoder().encode(JSON.stringify(payload));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
      return {
        version: 1,
        salt: arrayBufferToBase64(salt.buffer),
        iv: arrayBufferToBase64(iv.buffer),
        ciphertext: arrayBufferToBase64(ciphertext)
      };
    }

    async function decryptVault(record, passphrase) {
      const key = await deriveVaultKey(passphrase, base64ToUint8Array(record.salt));
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToUint8Array(record.iv) },
        key,
        base64ToUint8Array(record.ciphertext)
      );
      return JSON.parse(new TextDecoder().decode(plaintext));
    }

    async function generateVaultContentKey() {
      return crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    }

    async function encryptVaultWithKey(payload, key) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = new TextEncoder().encode(JSON.stringify(payload));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
      return {
        version: 2,
        unlock: 'webauthn',
        iv: arrayBufferToBase64(iv.buffer),
        ciphertext: arrayBufferToBase64(ciphertext)
      };
    }

    async function decryptVaultWithKey(record, key) {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToUint8Array(record.iv) },
        key,
        base64ToUint8Array(record.ciphertext)
      );
      return JSON.parse(new TextDecoder().decode(plaintext));
    }

    async function createVaultAuthenticator() {
      if (!hasWebAuthnSupport()) throw new Error('device_unlock_not_supported');
      const challenge = randomBytes(32);
      const userId = randomBytes(32);
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: 'Magic City' },
          user: {
            id: userId,
            name: `local-vault@${window.location.hostname}`,
            displayName: 'Magic City Local Data Vault'
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 }
          ],
          authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'required'
          },
          timeout: 60000,
          attestation: 'none'
        }
      });
      if (!credential) throw new Error('device_unlock_setup_cancelled');
      const credentialId = uint8ArrayToBase64Url(new Uint8Array(credential.rawId));
      const transports = typeof credential.response?.getTransports === 'function' ? credential.response.getTransports() : [];
      const platformAvailable = await hasPlatformAuthenticator().catch(() => false);
      const auth = {
        version: 1,
        method: 'webauthn',
        credentialId,
        transports,
        platformAvailable,
        createdAt: new Date().toISOString()
      };
      localStorage.setItem(PROFILE_VAULT_AUTH_KEY, JSON.stringify(auth));
      return auth;
    }

    async function requestVaultAssertion(reason = 'Authorize secure local data access') {
      const auth = getStoredVaultAuth();
      if (!auth?.credentialId) throw new Error('device_unlock_not_configured');
      const status = $('vaultStatus');
      if (status) status.textContent = `${reason}. Approve on this device or security key to continue.`;
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: randomBytes(32),
          allowCredentials: [{
            id: base64UrlToUint8Array(auth.credentialId),
            type: 'public-key',
            transports: Array.isArray(auth.transports) && auth.transports.length ? auth.transports : undefined
          }],
          userVerification: 'required',
          timeout: 60000
        }
      });
      if (!assertion) throw new Error('device_authorization_cancelled');
      return assertion;
    }

    async function configureVaultDeviceUnlock(payload) {
      const auth = await createVaultAuthenticator();
      const key = await generateVaultContentKey();
      await storeVaultContentKey(auth.credentialId, key);
      const encrypted = await encryptVaultWithKey(payload, key);
      encrypted.credentialId = auth.credentialId;
      localStorage.setItem(PROFILE_VAULT_KEY, JSON.stringify(encrypted));
      sessionStorage.removeItem('magic_city_profile_vault_unlocked');
      writeVaultDraftToInputs({});
      return auth;
    }

    async function unlockVaultWithDevice(reason = 'Unlock local data vault') {
      const record = getStoredVaultRecord();
      if (!record) throw new Error('vault_not_found');
      if (Number(record.version || 1) < 2 || record.unlock === 'passphrase' || record.salt) {
        throw new Error('legacy_vault_requires_passphrase');
      }
      await requestVaultAssertion(reason);
      const key = await loadVaultContentKey(record.credentialId);
      if (!key) throw new Error('device_unlock_key_missing');
      const payload = await decryptVaultWithKey(record, key);
      sessionStorage.setItem('magic_city_profile_vault_unlocked', JSON.stringify(payload));
      writeVaultDraftToInputs(payload);
      return payload;
    }

    async function saveVaultWithDeviceUnlock() {
      const payload = readVaultDraftFromInputs();
      const record = getStoredVaultRecord();
      if (record?.credentialId && hasStoredVaultDeviceAuth()) {
        await requestVaultAssertion('Authorize saving and locking your local data vault');
        const key = await loadVaultContentKey(record.credentialId);
        if (!key) throw new Error('device_unlock_key_missing');
        const encrypted = await encryptVaultWithKey(payload, key);
        encrypted.credentialId = record.credentialId;
        localStorage.setItem(PROFILE_VAULT_KEY, JSON.stringify(encrypted));
      } else {
        await configureVaultDeviceUnlock(payload);
      }
      sessionStorage.removeItem('magic_city_profile_vault_unlocked');
      writeVaultDraftToInputs({});
    }

    async function unlockLegacyVaultWithPassphrase(passphrase) {
      const record = getStoredVaultRecord();
      if (!record) throw new Error('vault_not_found');
      if (!(Number(record.version || 1) < 2 || record.unlock === 'passphrase' || record.salt)) {
        throw new Error('legacy_vault_not_found');
      }
      return decryptVault(record, passphrase);
    }

    async function authorizeSensitiveAction(reason = 'Authorize this sensitive action') {
      if (!hasStoredVaultDeviceAuth()) return true;
      await requestVaultAssertion(reason);
      return true;
    }

    function readVaultDraftFromInputs() {
      return {
        zipCode: $('vaultZipCode').value.trim(),
        streetAddress: $('vaultStreetAddress').value.trim(),
        deliveryNotes: $('vaultDeliveryNotes').value.trim(),
        homeAirport: $('vaultHomeAirport').value.trim(),
        travelWindow: $('vaultTravelWindow').value.trim(),
        contactName: $('vaultContactName').value.trim(),
        contactPhone: $('vaultContactPhone').value.trim()
      };
    }

    function writeVaultDraftToInputs(payload = {}) {
      $('vaultZipCode').value = payload.zipCode || '';
      $('vaultStreetAddress').value = payload.streetAddress || '';
      $('vaultDeliveryNotes').value = payload.deliveryNotes || '';
      $('vaultHomeAirport').value = payload.homeAirport || '';
      $('vaultTravelWindow').value = payload.travelWindow || '';
      $('vaultContactName').value = payload.contactName || '';
      $('vaultContactPhone').value = payload.contactPhone || '';
    }

    function getVaultSummary() {
      const raw = sessionStorage.getItem('magic_city_profile_vault_unlocked');
      if (!raw) return {};
      try {
        const payload = JSON.parse(raw);
        return {
          zipCode: payload.zipCode || '',
          addressReady: Boolean(payload.streetAddress),
          homeAirport: payload.homeAirport || '',
          travelWindow: payload.travelWindow || '',
          contactName: payload.contactName || '',
          contactPhone: Boolean(payload.contactPhone)
        };
      } catch {
        return {};
      }
    }

    function getUnlockedVaultPayload() {
      const raw = sessionStorage.getItem('magic_city_profile_vault_unlocked');
      if (!raw) return {};
      try {
        return JSON.parse(raw) || {};
      } catch {
        return {};
      }
    }

    function isVaultUnlocked() {
      return Boolean(sessionStorage.getItem('magic_city_profile_vault_unlocked'));
    }

    function updateVaultUiState() {
      const unlocked = isVaultUnlocked();
      const deviceReady = hasStoredVaultDeviceAuth();
      const legacyVisible = hasLegacyVaultRecord() || !hasWebAuthnSupport();
      const lockBtn = $('saveVaultBtn');
      const unlockBtn = $('unlockVaultBtn');
      const mode = $('vaultMode');
      const legacyDetails = $('vaultLegacyDetails');
      if (lockBtn) {
        lockBtn.textContent = deviceReady ? 'Save & lock' : 'Set up device unlock';
        lockBtn.classList.toggle('active-mode', !unlocked || !deviceReady);
        lockBtn.classList.toggle('inactive-mode', unlocked && deviceReady);
        lockBtn.disabled = !hasWebAuthnSupport();
      }
      if (unlockBtn) {
        unlockBtn.textContent = 'Unlock with device';
        unlockBtn.classList.toggle('active-mode', unlocked);
        unlockBtn.classList.toggle('inactive-mode', !unlocked);
        unlockBtn.disabled = !deviceReady;
      }
      if (mode) {
        mode.className = `vault-state ${unlocked ? 'unlocked' : 'locked'}`;
        mode.textContent = unlocked
          ? 'Unlocked: a coarse profile summary is available in this browser session after device verification.'
          : deviceReady
            ? 'Locked. Your info is encrypted and stored locally.'
            : hasWebAuthnSupport()
              ? 'Set up device lock to protect exact details.'
              : 'Locked: this browser cannot use device unlock here, so legacy passphrase migration stays available.';
      }
      if (legacyDetails) {
        legacyDetails.hidden = !legacyVisible;
      }
      if ($('vaultLegacyStatus')) {
        $('vaultLegacyStatus').textContent = hasLegacyVaultRecord()
          ? 'A legacy passphrase vault is available. Unlock it once and migrate it to device unlock.'
          : hasWebAuthnSupport()
            ? 'Legacy passphrase fallback is hidden unless needed.'
            : 'This browser cannot use WebAuthn here, so legacy passphrase fallback stays available.';
      }
    }

    function hasSensitiveLocalPayload(payload = {}) {
      return Object.values(payload || {}).some((value) => {
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'string') return value.trim().length > 0;
        return Boolean(value);
      });
    }

    async function ensureClientCryptoMaterial() {
      let keyId = sessionStorage.getItem('magic_city_client_key_id');
      let keyRaw = sessionStorage.getItem('magic_city_client_key_raw');
      if (!keyId || !keyRaw) {
        const key = crypto.getRandomValues(new Uint8Array(32));
        keyRaw = arrayBufferToBase64(key.buffer);
        keyId = `cek_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        sessionStorage.setItem('magic_city_client_key_id', keyId);
        sessionStorage.setItem('magic_city_client_key_raw', keyRaw);
      }
      return { keyId, keyBytes: Uint8Array.from(atob(keyRaw), (c) => c.charCodeAt(0)) };
    }

    async function buildClientEncryptedPayload(prompt, context, privacyMode) {
      if (!prompt || !['confidential', 'agent-private'].includes(privacyMode)) return null;
      const { keyId, keyBytes } = await ensureClientCryptoMaterial();
      const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = JSON.stringify({ prompt, context: context || null, createdAt: new Date().toISOString() });
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
      return {
        mode: privacyMode,
        alg: 'AES-GCM-256',
        keyScope: 'browser-session',
        keyId,
        iv: arrayBufferToBase64(iv.buffer),
        ciphertext: arrayBufferToBase64(ciphertext),
        promptDigest: await sha256Hex(prompt)
      };
    }

    function getEphemeralSessionId() {
      const existing = sessionStorage.getItem('magic_city_ephemeral_session');
      if (existing) return existing;
      const generated = `sess_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      sessionStorage.setItem('magic_city_ephemeral_session', generated);
      return generated;
    }

    function authHeaders() {
      const apiKey = document.getElementById('apiKey')?.value.trim();
      return apiKey ? { 'x-api-key': apiKey } : {};
    }

    async function api(path, opts = {}) {
      const headers = { 'content-type': 'application/json', ...authHeaders(), ...(opts.headers || {}) };
      const res = await fetch(path, {
        ...opts,
        headers,
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) throw new Error(data.error || ('Request failed: ' + path));
      return data;
    }

    function applyPlatformWorkflowRegistry(workflows = []) {
      platformWorkflows = Object.create(null);
      for (const workflow of Array.isArray(workflows) ? workflows : []) {
        if (!workflow?.capability) continue;
        platformWorkflows[String(workflow.capability)] = workflow;
      }
      const capabilitySelect = $('intentCapability');
      if (capabilitySelect) {
        for (const option of Array.from(capabilitySelect.options || [])) {
          const workflow = platformWorkflows[option.value];
          if (workflow?.selectLabel) option.textContent = workflow.selectLabel;
        }
      }
    }

    async function refreshPlatformWorkflowRegistry() {
      const data = await api('/platform/workflows');
      applyPlatformWorkflowRegistry(data?.workflows || []);
      return platformWorkflows;
    }

    async function ensurePlatformWorkflowRegistryLoaded(force = false) {
      if (lazyBootState.workflows && !force) return platformWorkflows;
      const workflows = await refreshPlatformWorkflowRegistry().catch(() => platformWorkflows);
      lazyBootState.workflows = true;
      return workflows;
    }

    function getRequesterId() {
      return authSessionUser?.requesterId || $('intentBuyer')?.value.trim() || localStorage.getItem('magic_city_last_requester_id') || null;
    }

    function getUrlReferralCode() {
      return new URLSearchParams(window.location.search).get('ref') || '';
    }

    function buildInviteLink(referralCode) {
      return referralCode ? `${window.location.origin}/?ref=${encodeURIComponent(referralCode)}` : '';
    }

    function applyRewardSummary(rewards) {
      const code = rewards?.referralCode || '';
      if ($('controlsReferralCode')) $('controlsReferralCode').value = code;
      if ($('controlsRewardsSummary')) {
        $('controlsRewardsSummary').textContent = rewards
          ? `Invite code ${code || 'not ready'} · ${rewards.referralRedemptions || 0} referrals · ${formatCreditCount(rewards.referralCreditsEarned || 0)} referral credits earned · ${formatCreditCount(rewards.shareCreditsEarned || 0)} share credits earned`
          : 'Sign in to unlock invite and share bonuses.';
      }
    }

    function renderConnectorActivityList(rootId, activity = [], emptyText = 'No activity yet.') {
      const root = $(rootId);
      if (!root) return;
      if (!activity.length) {
        root.innerHTML = `<div class="connector-activity-empty">${escapeHtml(emptyText)}</div>`;
        return;
      }
      root.innerHTML = activity.map((entry) => {
        const label = String(entry.action || 'connector event').replace(/_/g, ' ');
        const status = String(entry.status || 'success');
        const source = String(entry.source || 'user');
        const createdAt = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '';
        const detailParts = [
          source === 'agent' ? 'agent-run' : 'user-triggered',
          entry.sessionId ? `session ${escapeHtml(entry.sessionId)}` : '',
          entry.pluginId ? `plugin ${escapeHtml(entry.pluginId)}` : '',
          entry.metadata?.error ? `error: ${escapeHtml(String(entry.metadata.error))}` : ''
        ].filter(Boolean);
        return `
          <div class="connector-activity-item">
            <div class="connector-activity-head">
              <strong>${escapeHtml(label.charAt(0).toUpperCase() + label.slice(1))}</strong>
              <span class="settings-badge">${escapeHtml(status)}</span>
            </div>
            <div class="connector-activity-meta">${escapeHtml(createdAt)}</div>
            ${detailParts.length ? `<div class="connector-activity-meta">${detailParts.join(' · ')}</div>` : ''}
          </div>
        `;
      }).join('');
    }

    function renderGoogleConnectorActivity(activity = []) {
      googleConnectorActivity = Array.isArray(activity) ? activity : [];
      renderConnectorActivityList('googleConnectorActivity', googleConnectorActivity, 'No Google connector activity yet.');
    }

    function renderGitHubConnectorActivity(activity = []) {
      githubConnectorActivity = Array.isArray(activity) ? activity : [];
      renderConnectorActivityList('githubConnectorActivity', githubConnectorActivity, 'No GitHub connector activity yet.');
    }

    function renderEvmWalletActivity(activity = []) {
      evmWalletActivity = Array.isArray(activity) ? activity : [];
      renderConnectorActivityList('evmWalletActivity', evmWalletActivity, 'No wallet-link activity yet.');
    }

    function humanizeRuntimeLabel(value = '') {
      const text = String(value || '').trim();
      if (!text) return '';
      return text
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    function shortenHex(value = '') {
      const text = String(value || '').trim();
      if (!text) return '';
      if (text.length <= 14) return text;
      return `${text.slice(0, 10)}…${text.slice(-6)}`;
    }

    function paymentAuthorizationTone(authorization = {}) {
      const stage = String(authorization.authorizationState || '').toLowerCase();
      if (stage === 'confirmed') return 'ready';
      if (stage === 'failed') return 'failed';
      if (stage === 'submitted' || stage === 'observed' || stage.startsWith('shadow_relayer_')) return 'warning';
      return '';
    }

    function paymentAuthorizationStageLabel(authorization = {}) {
      const stage = String(authorization.authorizationState || authorization.confirmationState || '').toLowerCase();
      if (stage === 'requested') return 'Invoice ready';
      if (stage === 'submitted') return 'Wallet submitted';
      if (stage === 'observed') return 'Transfer observed';
      if (stage === 'confirmed') return authorization.mode === 'credit_topup' ? 'Credits finalized' : 'Payment confirmed';
      if (stage === 'failed') return 'Failed';
      if (stage === 'shadow_relayer_planned') return 'Relayer planned';
      if (stage === 'shadow_relayer_simulated') return 'Shadow simulated';
      return humanizeRuntimeLabel(stage || 'requested');
    }

    function paymentAuthorizationTitle(authorization = {}) {
      const modeLabel = authorization.mode === 'credit_topup' ? 'USDC top-up' : 'Wallet payment';
      if (authorization.mode === 'credit_topup' && Number(authorization.credits || 0) > 0) {
        return `${modeLabel} · ${formatCreditCount(authorization.credits)} credits`;
      }
      if (Number(authorization.amountUsdCents || 0) > 0) {
        return `${modeLabel} · ${formatUsd(Number(authorization.amountUsdCents || 0) / 100)} ${authorization.assetSymbol || 'USDC'}`;
      }
      return `${modeLabel} · ${authorization.assetSymbol || 'USDC'}`;
    }

    function paymentAuthorizationRouteLine(authorization = {}) {
      const recipient = authorization.recipientType === 'magic_city_treasury'
        ? 'Magic City treasury'
        : shortenWalletAddress(authorization.recipientAddress || '');
      const parts = [
        authorization.network || null,
        recipient ? `to ${recipient}` : null,
        authorization.walletTxHash ? `tx ${shortenHex(authorization.walletTxHash)}` : null
      ].filter(Boolean);
      return parts.join(' · ');
    }

    function paymentAuthorizationProgressLine(authorization = {}) {
      const parts = [];
      if (authorization.verificationState) parts.push(humanizeRuntimeLabel(authorization.verificationState));
      if (authorization.confirmationState && authorization.confirmationState !== authorization.authorizationState) {
        parts.push(humanizeRuntimeLabel(authorization.confirmationState));
      }
      if (authorization.requiredConfirmations) {
        parts.push(`${Number(authorization.confirmationsObserved || 0)}/${Number(authorization.requiredConfirmations || 0)} confirmations`);
      }
      if (authorization.shadowRelayerState && authorization.shadowRelayerState !== 'not_required') {
        parts.push(`relayer ${humanizeRuntimeLabel(authorization.shadowRelayerState)}`);
      }
      return parts.join(' · ');
    }

    function renderEvmPaymentAuthorizationList(authorizations = []) {
      evmPaymentAuthorizations = Array.isArray(authorizations) ? authorizations : [];
      const root = $('evmPaymentAuthorizationList');
      if (!root) return;
      if (!evmPaymentAuthorizations.length) {
        root.innerHTML = '<div class="connector-activity-empty">No wallet payments or top-ups yet.</div>';
        return;
      }
      root.innerHTML = evmPaymentAuthorizations.slice(0, 6).map((authorization) => {
        const tone = paymentAuthorizationTone(authorization);
        const createdAt = authorization.updatedAt || authorization.confirmedAt || authorization.submittedAt || authorization.createdAt;
        const progressLine = paymentAuthorizationProgressLine(authorization);
        const metaLinks = [
          authorization.requestId ? `request ${escapeHtml(authorization.requestId)}` : '',
          authorization.registryEntryId ? `registry ${escapeHtml(authorization.registryEntryId)}` : ''
        ].filter(Boolean).join(' · ');
        return `
          <div class="connector-activity-item">
            <div class="connector-activity-head">
              <strong>${escapeHtml(paymentAuthorizationTitle(authorization))}</strong>
              <span class="settings-badge ${tone}">${escapeHtml(paymentAuthorizationStageLabel(authorization))}</span>
            </div>
            <div class="connector-activity-meta">${escapeHtml(createdAt ? new Date(createdAt).toLocaleString() : 'Pending')}</div>
            <div class="connector-activity-meta">${escapeHtml(paymentAuthorizationRouteLine(authorization) || 'Wallet routing prepared')}</div>
            ${progressLine ? `<div class="connector-activity-meta">${escapeHtml(progressLine)}</div>` : ''}
            ${metaLinks ? `<div class="payment-authorization-links">${metaLinks}</div>` : ''}
          </div>
        `;
      }).join('');
    }

    function renderEvmWalletRuntimeStatus({ connector = evmWalletStatus, relayer = null, confirmation = null, authorizations = [] } = {}) {
      evmShadowRelayerStatus = relayer || null;
      evmConfirmationIndexerStatus = confirmation || null;
      const summary = $('evmWalletRuntimeSummary');
      const config = $('evmWalletConfigStatus');
      const badges = $('evmWalletRuntimeBadges');
      if (!summary || !config || !badges) return;
      if (!authSessionUser) {
        summary.textContent = 'Sign in to watch wallet payment requests, confirmations, and finalized credit top-ups.';
        config.textContent = '';
        badges.innerHTML = '';
        renderEvmPaymentAuthorizationList([]);
        return;
      }
      const wallets = Array.isArray(connector?.wallets) ? connector.wallets : [];
      const topupConfig = connector?.topupConfig || {};
      if (!wallets.length) {
        summary.textContent = 'Link an Ethereum-compatible wallet to watch wallet payment requests, confirmations, and finalized credit top-ups.';
        config.textContent = '';
        badges.innerHTML = '';
        renderEvmPaymentAuthorizationList([]);
        return;
      }
      const latest = Array.isArray(authorizations) && authorizations.length ? authorizations[0] : null;
      summary.textContent = latest
        ? `${authorizations.length} recent wallet action${authorizations.length === 1 ? '' : 's'} · latest ${paymentAuthorizationStageLabel(latest).toLowerCase()}. ${latest.mode === 'credit_topup' ? 'Wallet-funded top-ups finalize credits after verified receipt.' : 'Direct wallet payments stay reviewable and traceable here.'}`
        : 'Wallet linked. New top-ups and direct wallet payment requests will show up here as soon as you approve them in your wallet.';
      const configParts = [];
      if (confirmation?.enabled) {
        configParts.push(
          confirmation.rpcConfigured
            ? `Ethereum confirmation reader live · ${Number(confirmation.requiredConfirmations || 1)} confirmation${Number(confirmation.requiredConfirmations || 1) === 1 ? '' : 's'} required`
            : 'Ethereum confirmation reader is waiting for RPC configuration'
        );
      }
      if (relayer?.enabled) {
        const relayerMax = Number(relayer?.policy?.maxUsdCents || 0) > 0 ? ` · cap ${formatUsd(Number(relayer.policy.maxUsdCents || 0) / 100)}` : '';
        configParts.push(
          relayer.liveExecutionEnabled
            ? `Guarded treasury relayer live${relayerMax}`
            : 'Treasury relayer is in shadow mode'
        );
      }
      if (!topupConfig.enabled) {
        configParts.push('USDC treasury routing is not fully configured on this environment');
      }
      config.textContent = configParts.join(' · ');
      const runtimeBadges = [];
      if (topupConfig.enabled) runtimeBadges.push({ tone: 'ready', label: `${topupConfig.assetSymbol || 'USDC'} on ${topupConfig.networkLabel || 'Ethereum'}` });
      else runtimeBadges.push({ tone: 'warning', label: 'Top-up routing limited' });
      if (confirmation?.enabled) {
        runtimeBadges.push({
          tone: confirmation.rpcConfigured ? 'ready' : 'warning',
          label: confirmation.rpcConfigured ? 'Confirmation reader live' : 'Confirmation reader waiting'
        });
      }
      if (relayer?.enabled) {
        runtimeBadges.push({
          tone: relayer.liveExecutionEnabled ? 'ready' : 'warning',
          label: relayer.liveExecutionEnabled ? 'Treasury relayer live' : 'Treasury relayer shadow'
        });
      }
      badges.innerHTML = runtimeBadges.map((item) => `<span class="settings-badge ${escapeHtml(item.tone || '')}">${escapeHtml(item.label)}</span>`).join('');
      renderEvmPaymentAuthorizationList(authorizations);
    }

    function renderSettlementRegistry(entries = []) {
      settlementRegistryEntries = Array.isArray(entries) ? entries : [];
      const summary = $('settlementRegistrySummary');
      const root = $('settlementRegistryList');
      if (!summary || !root) return;
      if (!adminAccess) {
        summary.textContent = 'Registry is hidden until admin access is available.';
        root.innerHTML = '';
        return;
      }
      if (!settlementRegistryEntries.length) {
        summary.textContent = 'No settlement commitments or anchor records yet.';
        root.innerHTML = '<div class="connector-activity-empty">No registry entries yet.</div>';
        return;
      }
      const anchorReady = settlementRegistryEntries.filter((entry) => ['prepared', 'submitted', 'confirmed', 'recorded', 'relay_submitted'].includes(String(entry.anchorStatus || '').toLowerCase())).length;
      summary.textContent = `${settlementRegistryEntries.length} registry entries · ${anchorReady} anchor-ready or submitted · network ${settlementRegistryEntries[0]?.network || 'zeko_testnet'}`;
      root.innerHTML = settlementRegistryEntries.map((entry) => {
        const signer = entry.walletAddress || entry.signer || 'unknown signer';
        const meta = [
          entry.settlementStatus ? `settlement ${entry.settlementStatus}` : '',
          entry.registryMode ? entry.registryMode.replace(/_/g, ' ') : '',
          entry.anchorStatus ? `anchor ${entry.anchorStatus}` : '',
          entry.statementKind ? entry.statementKind : '',
          entry.chainId ? `chain ${entry.chainId}` : ''
        ].filter(Boolean).join(' · ');
        return `
          <div class="connector-activity-item">
            <div class="connector-activity-head">
              <strong>${escapeHtml(entry.settlementId || entry.sessionId || entry.id)}</strong>
              <span class="settings-badge">${escapeHtml(entry.scope || 'registry')}</span>
            </div>
            <div class="connector-activity-meta">${escapeHtml(meta || 'registry entry')}</div>
            <div class="connector-activity-meta">${escapeHtml(signer)}${entry.walletLinked ? ' · linked wallet' : ''}${entry.signatureVerified ? ' · signature verified' : ''}</div>
          </div>
        `;
      }).join('');
    }

    function applyGoogleConnectorPolicy(connector) {
      const policy = connector?.policy || {};
      const capabilities = connector?.capabilities || {};
      const controls = [
        ['googlePolicyCalendar', 'googlePolicyCardCalendar', 'calendar', Boolean(policy.allowCalendarWrite)],
        ['googlePolicyContacts', 'googlePolicyCardContacts', 'contacts', Boolean(policy.allowContactWrite)],
        ['googlePolicyGmailDrafts', 'googlePolicyCardGmail', 'gmailDrafts', Boolean(policy.allowGmailDraftWrite)],
        ['googlePolicyGmailSend', 'googlePolicyCardGmailSend', 'gmailSend', Boolean(policy.allowGmailSend)]
      ];
      for (const [inputId, cardId, capabilityKey, desiredValue] of controls) {
        const input = $(inputId);
        const card = $(cardId);
        if (!input || !card) continue;
        const granted = capabilities?.[capabilityKey]?.granted !== false;
        input.checked = desiredValue;
        input.disabled = !authSessionUser;
        card.classList.toggle('is-unavailable', Boolean(connector?.connected) && !granted);
      }
      if ($('googlePolicyRequireReview')) {
        $('googlePolicyRequireReview').checked = Boolean(policy.requireManualReview);
        $('googlePolicyRequireReview').disabled = !authSessionUser;
      }
      if ($('googleSavePolicyBtn')) $('googleSavePolicyBtn').disabled = !authSessionUser;
      if ($('googleConnectorPolicyStatus')) {
        const enabledLabels = Object.values(capabilities || {})
          .filter((item) => item?.enabled)
          .map((item) => item.label);
        if (!authSessionUser) {
          $('googleConnectorPolicyStatus').textContent = 'Sign in to set agent-access policy.';
        } else if (!connector?.connected) {
          $('googleConnectorPolicyStatus').textContent = 'Choose the Google permissions you want before connecting. Magic City will request only those scopes.';
        } else {
          $('googleConnectorPolicyStatus').textContent = enabledLabels.length
            ? `Enabled for agents: ${enabledLabels.join(' · ')}${policy.requireManualReview ? ' · manual review required' : ''}`
            : 'Google is connected, but every write capability is currently disabled by policy.';
        }
      }
    }

    function currentGooglePolicyPayload() {
      return {
        allowCalendarWrite: Boolean($('googlePolicyCalendar')?.checked),
        allowContactWrite: Boolean($('googlePolicyContacts')?.checked),
        allowGmailDraftWrite: Boolean($('googlePolicyGmailDrafts')?.checked),
        allowGmailSend: Boolean($('googlePolicyGmailSend')?.checked),
        requireManualReview: Boolean($('googlePolicyRequireReview')?.checked)
      };
    }

    function applyGoogleConnectorStatus(connector) {
      googleConnectorStatus = connector || null;
      const status = $('googleConnectorStatus');
      const connectBtn = $('googleConnectBtn');
      const disconnectBtn = $('googleDisconnectBtn');
      if (!status) return;
      if (!authSessionUser) {
        status.textContent = 'Sign in above first. Connected Accounts is only for private calendar, contacts, and Gmail permissions.';
        if (connectBtn) {
          connectBtn.disabled = true;
          connectBtn.hidden = false;
          connectBtn.textContent = 'Enable Google agent access';
        }
        if (disconnectBtn) {
          disconnectBtn.disabled = true;
          disconnectBtn.hidden = true;
        }
        applyGoogleConnectorPolicy(null);
        renderGoogleConnectorActivity([]);
        return;
      }
      const configured = connector?.configured !== false;
      if (!configured) {
        status.textContent = 'Google connector is not configured on this environment yet.';
        if (connectBtn) {
          connectBtn.disabled = true;
          connectBtn.hidden = false;
          connectBtn.textContent = 'Enable Google agent access';
        }
        if (disconnectBtn) {
          disconnectBtn.disabled = true;
          disconnectBtn.hidden = true;
        }
        applyGoogleConnectorPolicy(connector);
        renderGoogleConnectorActivity([]);
        return;
      }
      if (!connector?.connected) {
        status.textContent = 'Google agent access is not enabled yet. Approve it here when you want Magic City to create calendar events, contacts, Gmail drafts, or send approved emails for you.';
        if (connectBtn) {
          connectBtn.disabled = false;
          connectBtn.hidden = false;
          connectBtn.textContent = 'Enable Google agent access';
        }
        if (disconnectBtn) {
          disconnectBtn.disabled = true;
          disconnectBtn.hidden = true;
        }
        applyGoogleConnectorPolicy(connector);
        return;
      }
      const labels = Array.isArray(connector.grantedLabels) ? connector.grantedLabels.join(' · ') : 'Google scopes granted';
      status.textContent = `Google agent access is enabled as ${connector.email || authSessionUser.email} · ${labels}`;
      if (connectBtn) {
        connectBtn.disabled = false;
        connectBtn.hidden = true;
      }
      if (disconnectBtn) {
        disconnectBtn.disabled = false;
        disconnectBtn.hidden = false;
      }
      applyGoogleConnectorPolicy(connector);
    }

    function currentGitHubPolicyPayload() {
      return {
        allowRepoRead: Boolean($('githubPolicyRepoRead')?.checked),
        allowPatchArtifacts: Boolean($('githubPolicyPatchArtifacts')?.checked),
        allowPrDraftWrite: Boolean($('githubPolicyPrDrafts')?.checked),
        requireManualReview: Boolean($('githubPolicyRequireReview')?.checked),
        repoAllowlist: $('githubRepoAllowlist')?.value || '',
        branchPrefix: $('githubBranchPrefix')?.value || 'magic-city/'
      };
    }

    function currentEvmWalletPolicyPayload() {
      return {
        allowSettlementSignatures: Boolean($('evmPolicySettlementSignatures')?.checked),
        allowPaymentRequests: Boolean($('evmPolicyPaymentRequests')?.checked),
        allowUsdcTopups: Boolean($('evmPolicyUsdcTopups')?.checked),
        requireManualReview: Boolean($('evmPolicyRequireReview')?.checked)
      };
    }

    function shortenWalletAddress(value = '') {
      const text = String(value || '').trim();
      if (!text) return '';
      if (text.length <= 14) return text;
      return `${text.slice(0, 8)}…${text.slice(-4)}`;
    }

    function parseUsdToCents(value) {
      const normalized = String(value || '').replace(/[$,\s]/g, '').trim();
      if (!normalized) return 0;
      const numeric = Number(normalized);
      if (!Number.isFinite(numeric) || numeric <= 0) return 0;
      return Math.round(numeric * 100);
    }

    function applyGitHubConnectorPolicy(connector) {
      const policy = connector?.policy || {};
      const capabilities = connector?.capabilities || {};
      const controls = [
        ['githubPolicyRepoRead', 'githubPolicyCardRepoRead', 'repoRead', Boolean(policy.allowRepoRead)],
        ['githubPolicyPatchArtifacts', 'githubPolicyCardPatchArtifacts', 'patchArtifacts', Boolean(policy.allowPatchArtifacts)],
        ['githubPolicyPrDrafts', 'githubPolicyCardPrDrafts', 'prDrafts', Boolean(policy.allowPrDraftWrite)]
      ];
      for (const [inputId, cardId, capabilityKey, desiredValue] of controls) {
        const input = $(inputId);
        const card = $(cardId);
        if (!input || !card) continue;
        const granted = capabilities?.[capabilityKey]?.granted !== false;
        input.checked = desiredValue;
        input.disabled = !authSessionUser;
        card.classList.toggle('is-unavailable', Boolean(connector?.connected) && !granted);
      }
      if ($('githubPolicyRequireReview')) {
        $('githubPolicyRequireReview').checked = policy.requireManualReview !== false;
        $('githubPolicyRequireReview').disabled = !authSessionUser;
      }
      if ($('githubRepoAllowlist')) {
        $('githubRepoAllowlist').value = Array.isArray(policy.repoAllowlist) ? policy.repoAllowlist.join('\n') : '';
        $('githubRepoAllowlist').disabled = !authSessionUser;
      }
      if ($('githubBranchPrefix')) {
        $('githubBranchPrefix').value = policy.branchPrefix || 'magic-city/';
        $('githubBranchPrefix').disabled = !authSessionUser;
      }
      if ($('githubSavePolicyBtn')) $('githubSavePolicyBtn').disabled = !authSessionUser;
      if ($('githubConnectorPolicyStatus')) {
        const enabledLabels = Object.values(capabilities || {})
          .filter((item) => item?.enabled)
          .map((item) => item.label);
        const repoLabel = Array.isArray(policy.repoAllowlist) && policy.repoAllowlist.length
          ? `${policy.repoAllowlist.length} allowed repo rule${policy.repoAllowlist.length === 1 ? '' : 's'}`
          : 'no repo allowlist yet';
        if (!authSessionUser) {
          $('githubConnectorPolicyStatus').textContent = 'Sign in to set GitHub execution policy.';
        } else if (!connector?.connected) {
          $('githubConnectorPolicyStatus').textContent = `Choose the GitHub permissions and allowlisted repos you want before connecting. Current scope: ${repoLabel}.`;
        } else {
          $('githubConnectorPolicyStatus').textContent = enabledLabels.length
            ? `Enabled for agents: ${enabledLabels.join(' · ')} · ${repoLabel} · branch prefix ${policy.branchPrefix || 'magic-city/'}${policy.requireManualReview ? ' · manual review required' : ''}`
            : 'GitHub is connected, but every developer capability is currently disabled by policy.';
        }
      }
    }

    function applyGitHubConnectorStatus(connector) {
      githubConnectorStatus = connector || null;
      const status = $('githubConnectorStatus');
      const connectBtn = $('githubConnectBtn');
      const disconnectBtn = $('githubDisconnectBtn');
      if (!status) return;
      if (!authSessionUser) {
        status.textContent = 'Sign in above first to enable repo-scoped developer execution.';
        if (connectBtn) {
          connectBtn.disabled = true;
          connectBtn.hidden = false;
        }
        if (disconnectBtn) {
          disconnectBtn.disabled = true;
          disconnectBtn.hidden = true;
        }
        applyGitHubConnectorPolicy(null);
        renderGitHubConnectorActivity([]);
        return;
      }
      const configured = connector?.configured !== false;
      if (!configured) {
        status.textContent = 'GitHub connector is not configured on this environment yet.';
        if (connectBtn) {
          connectBtn.disabled = true;
          connectBtn.hidden = false;
        }
        if (disconnectBtn) {
          disconnectBtn.disabled = true;
          disconnectBtn.hidden = true;
        }
        applyGitHubConnectorPolicy(connector);
        renderGitHubConnectorActivity([]);
        return;
      }
      if (!connector?.connected) {
        status.textContent = 'GitHub repo execution is not enabled yet. Connect it when you want the developer lane to inspect allowlisted repos and build patch or PR draft packages around real repo context.';
        if (connectBtn) {
          connectBtn.disabled = false;
          connectBtn.hidden = false;
        }
        if (disconnectBtn) {
          disconnectBtn.disabled = true;
          disconnectBtn.hidden = true;
        }
        applyGitHubConnectorPolicy(connector);
        return;
      }
      const labels = Array.isArray(connector.grantedLabels) ? connector.grantedLabels.join(' · ') : 'GitHub scopes granted';
      status.textContent = `GitHub repo execution is enabled as ${connector.login || connector.email || authSessionUser.email} · ${labels}`;
      if (connectBtn) {
        connectBtn.disabled = false;
        connectBtn.hidden = true;
      }
      if (disconnectBtn) {
        disconnectBtn.disabled = false;
        disconnectBtn.hidden = false;
      }
      applyGitHubConnectorPolicy(connector);
    }

    function applyEvmWalletPolicy(connector) {
      const policy = connector?.policy || {};
      const capabilities = connector?.capabilities || {};
      const controls = [
        ['evmPolicySettlementSignatures', 'evmPolicyCardSettlement', 'settlementSignatures', Boolean(policy.allowSettlementSignatures)],
        ['evmPolicyPaymentRequests', 'evmPolicyCardPayments', 'paymentRequests', Boolean(policy.allowPaymentRequests)],
        ['evmPolicyUsdcTopups', 'evmPolicyCardTopups', 'usdcTopups', Boolean(policy.allowUsdcTopups)]
      ];
      for (const [inputId, cardId, capabilityKey, desiredValue] of controls) {
        const input = $(inputId);
        const card = $(cardId);
        if (!input || !card) continue;
        const granted = capabilities?.[capabilityKey]?.granted !== false;
        input.checked = desiredValue;
        input.disabled = !authSessionUser;
        card.classList.toggle('is-unavailable', Boolean(connector?.connected) && !granted);
      }
      if ($('evmPolicyRequireReview')) {
        $('evmPolicyRequireReview').checked = policy.requireManualReview !== false;
        $('evmPolicyRequireReview').disabled = !authSessionUser;
      }
      if ($('evmSavePolicyBtn')) $('evmSavePolicyBtn').disabled = !authSessionUser;
      if ($('evmWalletPolicyStatus')) {
        const enabledLabels = Object.values(capabilities || {})
          .filter((item) => item?.enabled)
          .map((item) => item.label);
        if (!authSessionUser) {
          $('evmWalletPolicyStatus').textContent = 'Sign in to set linked-wallet policy.';
        } else if (!connector?.connected) {
          $('evmWalletPolicyStatus').textContent = 'Choose the wallet permissions you want before linking. Every wallet action still needs a wallet approval prompt.';
        } else {
          $('evmWalletPolicyStatus').textContent = enabledLabels.length
            ? `Enabled for wallet actions: ${enabledLabels.join(' · ')}${policy.requireManualReview ? ' · agent review required' : ''}`
            : 'Wallet is linked, but every wallet capability is currently disabled by policy.';
        }
      }
    }

    function applyEvmWalletStatus(connector, activity = null) {
      evmWalletStatus = connector || null;
      if (Array.isArray(activity)) renderEvmWalletActivity(activity);
      const status = $('evmWalletStatus');
      const connectBtn = $('evmWalletConnectBtn');
      const disconnectBtn = $('evmWalletDisconnectBtn');
      const topupSummary = $('evmTopupSummary');
      if (!status) return;
      if (!authSessionUser) {
        status.textContent = 'Sign in above first to link an Ethereum-compatible wallet.';
        if (connectBtn) {
          connectBtn.disabled = true;
          connectBtn.hidden = false;
          connectBtn.textContent = 'Link Ethereum wallet';
        }
        if (disconnectBtn) {
          disconnectBtn.hidden = true;
          disconnectBtn.disabled = true;
        }
        if ($('evmTopup5Btn')) $('evmTopup5Btn').disabled = true;
        if ($('evmTopup25Btn')) $('evmTopup25Btn').disabled = true;
        if (topupSummary) topupSummary.textContent = 'Link an Ethereum-compatible wallet to prepare a USDC top-up request. You approve the transaction in your wallet, then Magic City verifies it before credits are finalized.';
        applyEvmWalletPolicy(null);
        if (activity == null) renderEvmWalletActivity([]);
        return;
      }
      const wallets = Array.isArray(connector?.wallets) ? connector.wallets : [];
      if (!wallets.length) {
        status.textContent = 'No Ethereum wallet linked yet. Link MetaMask, Rabby, Coinbase Wallet, Brave, or another compatible mobile wallet browser.';
        if (connectBtn) {
          connectBtn.disabled = false;
          connectBtn.hidden = false;
          connectBtn.textContent = 'Link Ethereum wallet';
        }
        if (disconnectBtn) {
          disconnectBtn.hidden = true;
          disconnectBtn.disabled = true;
        }
        if ($('evmTopup5Btn')) $('evmTopup5Btn').disabled = true;
        if ($('evmTopup25Btn')) $('evmTopup25Btn').disabled = true;
        if (topupSummary) topupSummary.textContent = 'Once linked, Magic City can prepare wallet-backed signatures, direct payment requests, and USDC credit top-up requests that you approve in your wallet.';
        applyEvmWalletPolicy(connector);
        return;
      }
      const primary = wallets[0];
      const labels = Array.isArray(connector?.grantedLabels) && connector.grantedLabels.length ? connector.grantedLabels.join(' · ') : 'wallet permissions ready';
      const topupConfig = connector?.topupConfig || {};
      status.textContent = `Linked ${shortenWalletAddress(primary.address)} on ${topupConfig.networkLabel || `chain ${primary.chainId}`}${primary.label ? ` · ${primary.label}` : ''} · ${labels}`;
      if (connectBtn) {
        connectBtn.disabled = false;
        connectBtn.hidden = false;
        connectBtn.textContent = 'Link another wallet';
      }
      if (disconnectBtn) {
        disconnectBtn.hidden = false;
        disconnectBtn.disabled = false;
      }
      if ($('evmTopup5Btn')) $('evmTopup5Btn').disabled = !connector?.capabilities?.usdcTopups?.enabled;
      if ($('evmTopup25Btn')) $('evmTopup25Btn').disabled = !connector?.capabilities?.usdcTopups?.enabled;
      if (topupSummary) {
        topupSummary.textContent = connector?.capabilities?.usdcTopups?.enabled
          ? `Wallet top-up is ready via ${topupConfig.assetSymbol || 'USDC'} on ${topupConfig.networkLabel || 'the linked chain'}. Magic City prepares the transfer, your wallet asks for approval, and credits finalize after verification.`
          : 'Wallet linked. USDC credit top-up is not enabled yet on this environment or is disabled by your wallet policy.';
      }
      applyEvmWalletPolicy(connector);
    }

    function applyAuthSession(user) {
      const previousUserId = authSessionUser?.id || null;
      authSessionUser = user || null;
      const authActions = $('identityAuthActions');
      const signedInActions = $('identitySignedInActions');
      if (user?.requesterId) {
        if ($('intentBuyer')) $('intentBuyer').value = user.requesterId;
        if ($('authEmail')) {
          $('authEmail').value = user.email || '';
          $('authEmail').disabled = true;
        }
        if ($('authPassphrase')) {
          $('authPassphrase').value = '';
          $('authPassphrase').disabled = true;
        }
        if (authActions) authActions.hidden = true;
        if (signedInActions) signedInActions.hidden = false;
        localStorage.setItem('magic_city_last_requester_id', user.requesterId);
        $('authStatus').textContent = `Signed in as ${user.email} · wallet ${user.requesterId} · this account now carries your credits, chat history on this device, and connected-agent permissions.`;
        applyRewardSummary(user.rewards || null);
      } else {
        if ($('authEmail')) $('authEmail').disabled = false;
        if ($('authPassphrase')) {
          $('authPassphrase').value = '';
          $('authPassphrase').disabled = false;
        }
        if (authActions) authActions.hidden = false;
        if (signedInActions) signedInActions.hidden = true;
        $('authStatus').textContent = 'Not signed in yet. Sign in or continue with Google or GitHub to load your wallet, history, and agent permissions.';
        applyRewardSummary(null);
      }
      if (user?.id && user.id !== previousUserId) maybeAdoptGuestThreads();
      if (user?.id !== previousUserId) restoreCurrentIdentityThread();
      adminAccess = Boolean(user?.adminAccess || user?.adminAccount);
      applyAdminAccessUi(adminAccess);
      applyGoogleConnectorStatus(user?.connectors?.google || null);
      applyGitHubConnectorStatus(user?.connectors?.github || null);
      applyEvmWalletStatus(user?.connectors?.evmWallets || null);
    }

    function applyAdminAccessUi(enabled) {
      adminAccess = Boolean(enabled);
      if ($('networkHealthSection')) $('networkHealthSection').hidden = !adminAccess;
      if ($('operatorSection')) $('operatorSection').hidden = !adminAccess;
      if ($('settlementRegistrySection')) $('settlementRegistrySection').hidden = !adminAccess;
      if (!adminAccess) renderSettlementRegistry([]);
    }

    async function refreshRewardsSummary() {
      if (!authSessionUser) {
        applyRewardSummary(null);
        return null;
      }
      const data = await api('/billing/rewards').catch(() => null);
      if (data?.user) authSessionUser = data.user;
      applyRewardSummary(data?.rewards || authSessionUser?.rewards || null);
      return data;
    }

    async function refreshAuthSession() {
      const data = await api('/auth/session');
      applyAuthSession(data.user || null);
      return data;
    }

    async function bootstrapSessionIfNeeded(force = false) {
      if (!force && authSessionUser) {
        syncRequesterFields();
        lazyBootState.identity = true;
        return authSessionUser;
      }
      if (!force && sessionBootstrapPromise) return sessionBootstrapPromise;
      sessionBootstrapPromise = refreshAuthSession()
        .catch(() => ({ user: null }))
        .finally(() => {
          syncRequesterFields();
          sessionBootstrapPromise = null;
        });
      const data = await sessionBootstrapPromise;
      lazyBootState.identity = true;
      return data?.user || authSessionUser;
    }

    function ensureBackgroundRefreshLoop() {
      if (backgroundRefreshTimer) return;
      backgroundRefreshTimer = window.setInterval(() => {
        if (!lazyBootState.advanced && !$('settingsAdvancedSection')?.open) return;
        refresh().catch(() => {});
      }, 15000);
    }

    async function ensureIdentitySectionData(force = false) {
      await bootstrapSessionIfNeeded(force);
      return authSessionUser;
    }

    async function ensureWalletSectionData(force = false) {
      if (lazyBootState.wallet && !force) return null;
      await bootstrapSessionIfNeeded(force);
      await Promise.all([
        refreshCreditsBalance().catch(() => null),
        refreshRewardsSummary().catch(() => null),
        refreshEvmWalletStatus().catch(() => null)
      ]);
      lazyBootState.wallet = true;
      return true;
    }

    async function ensureConnectedAccountsSectionData(force = false) {
      if (lazyBootState.accounts && !force) return null;
      await bootstrapSessionIfNeeded(force);
      await Promise.all([
        refreshGoogleConnectorStatus().catch(() => null),
        refreshGitHubConnectorStatus().catch(() => null),
        refreshEvmWalletStatus().catch(() => null)
      ]);
      lazyBootState.accounts = true;
      return true;
    }

    async function ensureAdvancedSectionData(force = false) {
      if (lazyBootState.advanced && !force) return null;
      await bootstrapSessionIfNeeded(force);
      await refresh().catch((error) => {
        if ($('health')) $('health').textContent = error.message;
      });
      lazyBootState.advanced = true;
      ensureBackgroundRefreshLoop();
      return true;
    }

    async function refreshGoogleConnectorStatus() {
      if (!authSessionUser) {
        applyGoogleConnectorStatus(null);
        renderGoogleConnectorActivity([]);
        return null;
      }
      const data = await api('/connectors/google/status').catch(() => null);
      applyGoogleConnectorStatus(data?.connector || null);
      renderGoogleConnectorActivity(data?.activity || []);
      return data;
    }

    async function refreshGitHubConnectorStatus() {
      if (!authSessionUser) {
        applyGitHubConnectorStatus(null);
        renderGitHubConnectorActivity([]);
        return null;
      }
      const data = await api('/connectors/github/status').catch(() => null);
      applyGitHubConnectorStatus(data?.connector || null);
      renderGitHubConnectorActivity(data?.activity || []);
      return data;
    }

    async function refreshEvmWalletStatus() {
      if (!authSessionUser) {
        applyEvmWalletStatus(null, []);
        renderEvmWalletRuntimeStatus({
          connector: null,
          relayer: null,
          confirmation: null,
          authorizations: []
        });
        return null;
      }
      const [statusData, authorizationData, relayerData, confirmationData] = await Promise.all([
        api('/connectors/evm-wallet/status').catch(() => null),
        api('/connectors/evm-wallet/payment-authorizations?limit=8').catch(() => null),
        api('/connectors/evm-wallet/shadow-relayer').catch(() => null),
        api('/connectors/evm-wallet/confirmation-indexer').catch(() => null)
      ]);
      const connector = statusData?.connector || authorizationData?.connector || authSessionUser?.connectors?.evmWallets || null;
      applyEvmWalletStatus(connector, statusData?.activity || []);
      renderEvmWalletRuntimeStatus({
        connector,
        relayer: relayerData,
        confirmation: confirmationData,
        authorizations: authorizationData?.authorizations || []
      });
      return {
        connector,
        activity: statusData?.activity || [],
        authorizations: authorizationData?.authorizations || [],
        relayer: relayerData,
        confirmation: confirmationData
      };
    }

    async function refreshSettlementRegistry() {
      if (!adminAccess) {
        renderSettlementRegistry([]);
        return null;
      }
      const data = await api('/zeko/settlement-registry?limit=25').catch(() => null);
      renderSettlementRegistry(data?.registry || []);
      return data;
    }

    async function startGoogleConnectorFlow() {
      const requestedCapabilities = [];
      if ($('googlePolicyCalendar')?.checked) requestedCapabilities.push('calendar');
      if ($('googlePolicyContacts')?.checked) requestedCapabilities.push('contacts');
      if ($('googlePolicyGmailDrafts')?.checked) requestedCapabilities.push('gmailDrafts');
      if ($('googlePolicyGmailSend')?.checked) requestedCapabilities.push('gmailSend');
      if (!requestedCapabilities.length) {
        $('googleConnectorPolicyStatus').textContent = 'Choose at least one Google capability before connecting.';
        return;
      }
      const data = await api(`/connectors/google/start?preset=meeting_sync&capabilities=${encodeURIComponent(requestedCapabilities.join(','))}`, {
        method: 'GET'
      });
      const useSameWindow = window.matchMedia?.('(max-width: 760px)')?.matches || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
      if (useSameWindow) {
        window.location.href = data.authorizationUrl;
        return;
      }
      const popup = window.open(data.authorizationUrl, 'magic_city_google_connector', 'popup=yes,width=540,height=720');
      if (!popup) {
        window.location.href = data.authorizationUrl;
        return;
      }
      popup.focus();
    }

    async function startGitHubConnectorFlow() {
      const data = await api('/connectors/github/start', {
        method: 'GET'
      });
      const useSameWindow = window.matchMedia?.('(max-width: 760px)')?.matches || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
      if (useSameWindow) {
        window.location.href = data.authorizationUrl;
        return;
      }
      const popup = window.open(data.authorizationUrl, 'magic_city_github_connector', 'popup=yes,width=540,height=720');
      if (!popup) {
        window.location.href = data.authorizationUrl;
        return;
      }
      popup.focus();
    }

    async function startGoogleAuthFlow() {
      const data = await api('/auth/google/start', {
        method: 'GET'
      });
      const useSameWindow = window.matchMedia?.('(max-width: 760px)')?.matches || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
      if (useSameWindow) {
        window.location.href = data.authorizationUrl;
        return;
      }
      const popup = window.open(data.authorizationUrl, 'magic_city_google_auth', 'popup=yes,width=540,height=720');
      if (!popup) {
        window.location.href = data.authorizationUrl;
        return;
      }
      popup.focus();
    }

    async function startGitHubAuthFlow() {
      const data = await api('/auth/github/start', {
        method: 'GET'
      });
      const useSameWindow = window.matchMedia?.('(max-width: 760px)')?.matches || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
      if (useSameWindow) {
        window.location.href = data.authorizationUrl;
        return;
      }
      const popup = window.open(data.authorizationUrl, 'magic_city_github_auth', 'popup=yes,width=540,height=720');
      if (!popup) {
        window.location.href = data.authorizationUrl;
        return;
      }
      popup.focus();
    }

    async function disconnectGoogleConnector() {
      const data = await api('/connectors/google/disconnect', {
        method: 'POST',
        body: JSON.stringify({})
      });
      applyGoogleConnectorStatus(data.connector || null);
      renderGoogleConnectorActivity(data.activity || []);
      return data;
    }

    async function saveGoogleConnectorPolicy() {
      const data = await api('/connectors/google/policy', {
        method: 'POST',
        body: JSON.stringify(currentGooglePolicyPayload())
      });
      applyGoogleConnectorStatus(data.connector || null);
      renderGoogleConnectorActivity(data.activity || []);
      return data;
    }

    async function disconnectGitHubConnector() {
      const data = await api('/connectors/github/disconnect', {
        method: 'POST',
        body: JSON.stringify({})
      });
      applyGitHubConnectorStatus(data.connector || null);
      renderGitHubConnectorActivity(data.activity || []);
      return data;
    }

    async function saveGitHubConnectorPolicy() {
      const data = await api('/connectors/github/policy', {
        method: 'POST',
        body: JSON.stringify(currentGitHubPolicyPayload())
      });
      applyGitHubConnectorStatus(data.connector || null);
      renderGitHubConnectorActivity(data.activity || []);
      return data;
    }

    async function connectEvmWallet() {
      if (!window.ethereum?.request) throw new Error('ethereum_wallet_not_available');
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const address = Array.isArray(accounts) && accounts[0] ? String(accounts[0]) : '';
      if (!address) throw new Error('wallet_account_not_selected');
      const chainHex = await window.ethereum.request({ method: 'eth_chainId' }).catch(() => null);
      const chainId = chainHex ? parseInt(chainHex, 16) : 1;
      const challengeData = await api('/connectors/evm-wallet/challenge', {
        method: 'POST',
        body: JSON.stringify({ address, chainId })
      });
      const challenge = challengeData.challenge;
      if (!challenge?.message || !challenge?.id) throw new Error('wallet_challenge_failed');
      const signature = await window.ethereum.request({
        method: 'personal_sign',
        params: [challenge.message, address]
      });
      const data = await api('/connectors/evm-wallet/verify', {
        method: 'POST',
        body: JSON.stringify({
          challengeId: challenge.id,
          signature,
          chainId
        })
      });
      applyEvmWalletStatus(data.connector || null, data.activity || []);
      await refreshEvmWalletStatus().catch(() => null);
      return data;
    }

    async function disconnectEvmWallet() {
      const wallet = Array.isArray(evmWalletStatus?.wallets) ? evmWalletStatus.wallets[0] : null;
      if (!wallet?.address) throw new Error('no_wallet_connected');
      const data = await api('/connectors/evm-wallet/disconnect', {
        method: 'POST',
        body: JSON.stringify({ address: wallet.address })
      });
      applyEvmWalletStatus(data.connector || null, data.activity || []);
      await refreshEvmWalletStatus().catch(() => null);
      return data;
    }

    async function saveEvmWalletPolicy() {
      const data = await api('/connectors/evm-wallet/policy', {
        method: 'POST',
        body: JSON.stringify(currentEvmWalletPolicyPayload())
      });
      applyEvmWalletStatus(data.connector || null, data.activity || []);
      await refreshEvmWalletStatus().catch(() => null);
      return data;
    }

    async function prepareAndSubmitEvmWalletPayment({ mode = 'direct_payment', credits = null, amountUsdCents = null, recipientAddress = '', note = '' } = {}) {
      if (!authSessionUser) throw new Error('auth_required');
      const data = await api('/connectors/evm-wallet/payment-request', {
        method: 'POST',
        body: JSON.stringify({ mode, credits, amountUsdCents, recipientAddress, note })
      });
      applyEvmWalletStatus(data.connector || null, data.activity || []);
      const request = data.request;
      if (!request) throw new Error('evm_wallet_request_failed');
      if (!window.ethereum?.request) {
        if (request.paymentUri) {
          window.location.href = request.paymentUri;
          return { request, txHash: null, submitted: null, openedInWallet: true };
        }
        throw new Error('wallet_provider_not_available_in_this_browser');
      }
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const activeAddress = Array.isArray(accounts) && accounts[0] ? String(accounts[0]).toLowerCase() : '';
      if (activeAddress !== String(request.senderAddress || '').toLowerCase()) {
        throw new Error(`switch the wallet app to ${shortenWalletAddress(request.senderAddress)} before approving this transaction`);
      }
      const chainHex = await window.ethereum.request({ method: 'eth_chainId' }).catch(() => null);
      const currentChainId = chainHex ? parseInt(chainHex, 16) : null;
      if (currentChainId && currentChainId !== Number(request.chainId)) {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: `0x${Number(request.chainId).toString(16)}` }]
        });
      }
      const txHash = await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [request.tx]
      });
      const submitted = await api('/connectors/evm-wallet/payment-submitted', {
        method: 'POST',
        body: JSON.stringify({
          requestId: request.id,
          txHash,
          mode: request.mode,
          chainId: request.chainId,
          recipientAddress: request.recipientAddress,
          amountUsdCents: request.amountUsdCents,
          credits: request.credits
        })
      });
      await refreshEvmWalletStatus().catch(() => null);
      return { request, txHash, submitted, openedInWallet: false };
    }

    async function registerAccount() {
      const email = $('authEmail')?.value.trim();
      const passphrase = $('authPassphrase')?.value || '';
      const referralCode = $('controlsRedeemReferralInput')?.value.trim() || getUrlReferralCode();
      const data = await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, passphrase, referralCode })
      });
      applyAuthSession(data.user || null);
      await refreshCreditsBalance().catch(() => null);
      await refreshRewardsSummary().catch(() => null);
      await refreshEvmWalletStatus().catch(() => null);
      if (data.referral?.applied) {
        $('controlsCreditsMsg').textContent = `Referral applied. You earned ${formatCreditCount(data.referral.friendBonusCredits || 0)} credits.`;
      }
      return data;
    }

    async function loginAccount() {
      const email = $('authEmail')?.value.trim();
      const passphrase = $('authPassphrase')?.value || '';
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, passphrase })
      });
      applyAuthSession(data.user || null);
      await refreshCreditsBalance().catch(() => null);
      await refreshRewardsSummary().catch(() => null);
      await refreshEvmWalletStatus().catch(() => null);
      return data;
    }

    async function logoutAccount() {
      await api('/auth/logout', { method: 'POST', body: JSON.stringify({}) });
      applyAuthSession(null);
      await refreshCreditsBalance().catch(() => null);
      await refreshRewardsSummary().catch(() => null);
      await refreshEvmWalletStatus().catch(() => null);
    }

    function syncRequesterFields() {
      const requesterId = getRequesterId() || '';
      if ($('intentBuyer') && $('intentBuyer').value.trim() !== requesterId) $('intentBuyer').value = requesterId;
      if (requesterId) localStorage.setItem('magic_city_last_requester_id', requesterId);
    }

    async function refreshCreditsBalance() {
      const requesterId = getRequesterId();
      if (!requesterId) {
        $('controlsCreditsSummary').textContent = 'Sign in to load your Magic City credits.';
        $('controlsCreditsLocks').textContent = '';
        $('controlsCreditsMsg').textContent = '';
        return null;
      }
      const data = await api(`/billing/account?requesterId=${encodeURIComponent(requesterId)}`);
      const account = data.account || {};
      const availableCredits = Number(account.availableCredits || 0);
      const lockedCredits = Number(account.lockedCredits || 0);
      const spentCredits = Number(account.totalSpentCredits || 0);
      const creditMeta = [
        lockedCredits > 0 ? `${formatCreditCount(lockedCredits)} credits in active runs` : '',
        spentCredits > 0 ? `${formatCreditCount(spentCredits)} credits used lifetime` : ''
      ].filter(Boolean);
      $('controlsCreditsSummary').innerHTML = `
        <div class="wallet-balance-hero">
          <div class="wallet-balance-hero-label">Available credits</div>
          <div class="wallet-balance-hero-value">${formatCreditCount(availableCredits)}</div>
        </div>
        ${creditMeta.length ? `<div class="wallet-credit-meta">${creditMeta.map((item) => `<span>${item}</span>`).join('')}</div>` : ''}
      `;
      $('controlsCreditsLocks').textContent = '';
      $('controlsCreditsMsg').textContent = '';
      if ($('controlsAlphaSummary')) $('controlsAlphaSummary').textContent = '';
      if (data.rewards) applyRewardSummary(data.rewards);
      return data;
    }

    async function releaseStaleCreditLocks() {
      const requesterId = getRequesterId();
      if (!requesterId) throw new Error('requester_id_required');
      return api('/billing/account/release-stale-locks', {
        method: 'POST',
        body: JSON.stringify({ requesterId })
      });
    }

    async function copyInviteLink() {
      const code = $('controlsReferralCode')?.value.trim();
      if (!code) throw new Error('sign_in_required_for_invites');
      const inviteLink = buildInviteLink(code);
      await navigator.clipboard.writeText(inviteLink);
      return inviteLink;
    }

    async function redeemReferralCode() {
      const referralCode = $('controlsRedeemReferralInput')?.value.trim() || getUrlReferralCode();
      if (!referralCode) throw new Error('referral_code_required');
      const data = await api('/billing/referrals/redeem', {
        method: 'POST',
        body: JSON.stringify({ referralCode })
      });
      await refreshCreditsBalance().catch(() => null);
      await refreshRewardsSummary().catch(() => null);
      return data;
    }

    function buildPublicResultShareText(session) {
      const kind = session?.handoffData?.kind || 'task';
      if (kind === 'meeting') return 'I just used Magic City to turn a meeting into a clean summary, actions, and follow-up package.';
      if (kind === 'job') {
        const shipped = Number(session?.fulfillment?.result?.applicationsShipped || 0);
        return shipped > 0
          ? `I just used Magic City to ship ${shipped} job applications with a local-first agent workflow.`
          : 'I just used Magic City to prep job applications with a local-first agent workflow.';
      }
      if (kind === 'food') return 'I just used Magic City to prepare a real food order with agent execution and private local context.';
      if (kind === 'reminder') return 'I just used Magic City to complete a reminder workflow with private local context.';
      return 'I just used Magic City to complete a real agent workflow end to end.';
    }

    function openTaskResultShare(platform, session) {
      const text = buildPublicResultShareText(session);
      if (platform === 'x') {
        window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(window.location.origin)}`, '_blank', 'noopener,noreferrer');
        return;
      }
      window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(window.location.origin)}`, '_blank', 'noopener,noreferrer');
    }

    async function claimTaskShareReward(session, platform) {
      const data = await api('/billing/rewards/share-task-result', {
        method: 'POST',
        body: JSON.stringify({ sessionId: session.id, platform })
      });
      await refreshCreditsBalance().catch(() => null);
      await refreshRewardsSummary().catch(() => null);
      return data;
    }

    function inferSpreadsheetRowBand(rawData = '') {
      const rows = String(rawData || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .filter((line) => line.trim().length > 0);
      const rowCount = Math.max(0, rows.length - 1);
      if (rowCount <= 50) return 'Up to 50 rows';
      if (rowCount <= 500) return '51-500 rows';
      return '500+ rows';
    }

    let xlsxLibPromise = null;

    async function loadXlsxLib() {
      if (window.XLSX) return window.XLSX;
      if (!xlsxLibPromise) {
        xlsxLibPromise = new Promise((resolve, reject) => {
          const existing = document.querySelector('script[data-xlsx-loader="true"]');
          if (existing) {
            existing.addEventListener('load', () => resolve(window.XLSX), { once: true });
            existing.addEventListener('error', () => reject(new Error('xlsx_parser_not_loaded')), { once: true });
            return;
          }
          const script = document.createElement('script');
          script.src = '/vendor/xlsx.full.min.js';
          script.async = true;
          script.dataset.xlsxLoader = 'true';
          script.addEventListener('load', () => resolve(window.XLSX), { once: true });
          script.addEventListener('error', () => reject(new Error('xlsx_parser_not_loaded')), { once: true });
          document.head.appendChild(script);
        });
      }
      return xlsxLibPromise;
    }

    function isSpreadsheetWorkbookFile(file) {
      const name = String(file?.name || '').toLowerCase();
      return name.endsWith('.xlsx') || name.endsWith('.xls');
    }

    function summarizeWorkbookSheet(sheetName, rows) {
      const rowCount = Math.max(0, rows.length - 1);
      return `${sheetName} · ${rowCount.toLocaleString()} row${rowCount === 1 ? '' : 's'}`;
    }

    function extractBestWorkbookSheet(workbook) {
      const candidates = workbook.SheetNames.map((sheetName) => {
        const worksheet = workbook.Sheets[sheetName];
        const rows = window.XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', blankrows: false });
        return { sheetName, rows };
      }).filter((entry) => entry.rows.some((row) => Array.isArray(row) && row.some((cell) => String(cell ?? '').trim().length > 0)));
      if (!candidates.length) return null;
      candidates.sort((a, b) => b.rows.length - a.rows.length);
      return candidates[0];
    }

    async function parseSpreadsheetFileLocally(file) {
      if (!isSpreadsheetWorkbookFile(file)) {
        return {
          text: await file.text(),
          sourceLabel: file.name || 'text upload'
        };
      }
      const XLSX = await loadXlsxLib();
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const selected = extractBestWorkbookSheet(workbook);
      if (!selected) throw new Error('workbook_has_no_rows');
      const worksheet = workbook.Sheets[selected.sheetName];
      const text = XLSX.utils.sheet_to_csv(worksheet, { FS: ',', RS: '\n', strip: false, blankrows: false });
      return {
        text,
        sourceLabel: summarizeWorkbookSheet(selected.sheetName, selected.rows)
      };
    }

    let pdfjsLibPromise = null;

    async function loadPdfjsLib() {
      if (pdfjsLibPromise) return pdfjsLibPromise;
      pdfjsLibPromise = import('/vendor/pdf.mjs').then((mod) => {
        const lib = mod?.default || mod;
        if (lib?.GlobalWorkerOptions) {
          lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
        }
        return lib;
      });
      return pdfjsLibPromise;
    }

    function extractResumeHints(text = '') {
      const lines = String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const emailMatch = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      const phoneMatch = String(text || '').match(/(?:\+?\d[\d\s().-]{7,}\d)/);
      const linkedInMatch = String(text || '').match(/https?:\/\/[^\s]*linkedin\.com\/[^\s)]+/i);
      const portfolioMatch = String(text || '').match(/https?:\/\/[^\s)]+/i);
      const nameLine = lines.find((line) => !/@|https?:\/\/|\+?\d/.test(line) && line.length > 2 && line.length < 60) || '';
      return {
        applicantName: nameLine,
        applicantEmail: emailMatch ? emailMatch[0].toLowerCase() : '',
        applicantPhone: phoneMatch ? phoneMatch[0].replace(/\s+/g, ' ').trim() : '',
        linkedinUrl: linkedInMatch ? linkedInMatch[0] : '',
        portfolioUrl: portfolioMatch ? portfolioMatch[0] : ''
      };
    }

    async function parseResumeFileLocally(file) {
      const name = String(file?.name || '').toLowerCase();
      if (!name.endsWith('.pdf')) {
        return {
          text: await file.text(),
          sourceLabel: file.name || 'text resume'
        };
      }
      const pdfjsLib = await loadPdfjsLib();
      const buffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i += 1) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
        if (pageText) pages.push(pageText);
      }
      return {
        text: pages.join('\n\n'),
        sourceLabel: `${file.name || 'resume.pdf'} · ${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`
      };
    }

    async function parseMeetingFileLocally(file) {
      const name = String(file?.name || '').toLowerCase();
      if (!name.endsWith('.pdf')) {
        return {
          text: await file.text(),
          sourceLabel: file.name || 'meeting notes'
        };
      }
      const pdfjsLib = await loadPdfjsLib();
      const buffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i += 1) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
        if (pageText) pages.push(pageText);
      }
      return {
        text: pages.join('\n\n'),
        sourceLabel: `${file.name || 'meeting.pdf'} · ${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`
      };
    }

    function bindLocalTextUpload({ inputId, targetId, rowBandId = null, statusId = null }) {
      const input = $(inputId);
      const target = $(targetId);
      const rowBand = rowBandId ? $(rowBandId) : null;
      const status = statusId ? $(statusId) : null;
      if (!input || !target || input.dataset.boundUpload === 'true') return;
      input.dataset.boundUpload = 'true';
      input.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
          if (status) status.textContent = `Reading ${file.name} locally…`;
          const parsed = await parseSpreadsheetFileLocally(file);
          target.value = parsed.text;
          if (rowBand) {
            const inferred = inferSpreadsheetRowBand(parsed.text);
            if ([...rowBand.options].some((option) => option.value === inferred)) {
              rowBand.value = inferred;
            }
          }
          if (status) status.textContent = `Loaded locally: ${parsed.sourceLabel}. Raw workbook stays in this browser session.`;
        } catch (error) {
          if (status) status.textContent = `Upload failed: ${error.message || 'unable to read file locally'}`;
        }
      });
    }

    function bindLocalResumeUpload({
      inputId,
      targetId,
      fileNameId = null,
      statusId = null,
      hintIds = {}
    }) {
      const input = $(inputId);
      const target = $(targetId);
      const fileNameField = fileNameId ? $(fileNameId) : null;
      const status = statusId ? $(statusId) : null;
      if (!input || !target || input.dataset.boundUpload === 'true') return;
      input.dataset.boundUpload = 'true';
      input.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
          if (status) status.textContent = `Reading ${file.name} locally…`;
          const parsed = await parseResumeFileLocally(file);
          target.value = parsed.text;
          if (fileNameField) fileNameField.value = file.name || 'resume.pdf';
          const hints = extractResumeHints(parsed.text);
          Object.entries(hintIds || {}).forEach(([key, fieldId]) => {
            const field = $(fieldId);
            if (field && !field.value && hints[key]) field.value = hints[key];
          });
          if (status) status.textContent = `Loaded locally: ${parsed.sourceLabel}. Raw resume text stays in this browser session until execution starts.`;
        } catch (error) {
          if (status) status.textContent = `Upload failed: ${error.message || 'unable to read resume locally'}`;
        }
      });
    }

    function bindLocalMeetingUpload({ inputId, targetId, statusId = null }) {
      const input = $(inputId);
      const target = $(targetId);
      const status = statusId ? $(statusId) : null;
      if (!input || !target || input.dataset.boundUpload === 'true') return;
      input.dataset.boundUpload = 'true';
      input.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
          if (status) status.textContent = `Reading ${file.name} locally…`;
          const parsed = await parseMeetingFileLocally(file);
          target.value = parsed.text;
          if (status) status.textContent = `Loaded locally: ${parsed.sourceLabel}. Raw transcript stays in this browser session until execution starts.`;
        } catch (error) {
          if (status) status.textContent = `Upload failed: ${error.message || 'unable to read meeting file locally'}`;
        }
      });
    }

    async function openStripeTopup(amountCredits = 25, options = {}) {
      const requesterId = getRequesterId();
      if (!requesterId) throw new Error('requester_id_required');
      const config = await api('/billing/stripe/config');
      if (!config.configured) throw new Error('stripe_not_configured');
      const successParams = new URLSearchParams({
        stripe: 'success',
        session_id: '{CHECKOUT_SESSION_ID}'
      });
      if (options.sessionId) successParams.set('session', options.sessionId);
      const cancelParams = new URLSearchParams({ stripe: 'cancel' });
      if (options.sessionId) cancelParams.set('session', options.sessionId);
      const data = await api('/billing/stripe/checkout-session', {
        method: 'POST',
        body: JSON.stringify({
          requesterId,
          amountCredits,
          successUrl: `${window.location.origin}/?${successParams.toString()}`,
          cancelUrl: `${window.location.origin}/?${cancelParams.toString()}`
        })
      });
      if (data.url) window.open(data.url, '_blank', 'noopener,noreferrer');
      return data;
    }

    async function openSquareSessionPayment(sessionId) {
      const squareConfig = await api('/billing/square/config');
      if (!squareConfig.configured) throw new Error('square_not_configured');
      const selectedMode = $('executionSquareEnvironment')?.value || squareConfig.defaultMode || 'sandbox';
      const selectedFundingMode = $('executionFundingModeOverride')?.value || $('executionFundingMode')?.value || 'magic_city_credits';
      const data = await api(`/connectors/sessions/${sessionId}/square-payment-link`, {
        method: 'POST',
        body: JSON.stringify({
          redirectUrl: `${window.location.origin}/?square=success&session=${encodeURIComponent(sessionId)}`,
          mode: selectedMode,
          fundingMode: selectedFundingMode,
          buyerEmail: authSessionUser?.email || '',
          localPrivateInputs: {
            streetAddress: $('executionStreetAddress')?.value.trim() || '',
            zipCode: $('executionZipCode')?.value.trim() || '',
            contactPhone: $('executionContactPhone')?.value.trim() || ''
          }
        })
      });
      if (data.paymentLinkUrl) window.open(data.paymentLinkUrl, '_blank', 'noopener,noreferrer');
      return data;
    }

    function formatCreditCount(value) {
      const numeric = Number(value || 0);
      if (!Number.isFinite(numeric) || numeric <= 0) return '0';
      return numeric.toLocaleString();
    }

    function formatUsd(value) {
      const numeric = Number(value || 0);
      if (!Number.isFinite(numeric)) return '$0.00';
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(numeric);
    }
    window.formatUsd = formatUsd;

    function isAlphaWorkflowPricing(payment = null) {
      return String(payment?.pricingMode || '') === 'alpha_flat';
    }

    function describeAlphaWorkflowPrice(payment = null, fallbackCredits = 1) {
      const credits = Math.max(1, Number(payment?.requiredCredits || fallbackCredits || 1));
      return payment?.pricingLabel || `${formatCreditCount(credits)} credit${credits === 1 ? '' : 's'}`;
    }

    function describeExecutionFundingInput(payment = null, fallback = 'Magic City pricing loads here') {
      if (!payment) return fallback;
      if (payment.fundingMode === 'free_preview') return 'Free preview · 0 credits locked';
      if (payment.fundingMode === 'direct_square') return 'Direct merchant checkout';
      if (isAlphaWorkflowPricing(payment)) return describeAlphaWorkflowPrice(payment);
      if (Number(payment.requiredCredits || 0) > 0) return `${formatCreditCount(payment.requiredCredits)} Magic City credits`;
      return fallback;
    }

    function describeExecutionFundingDetail(payment = null, fallback = 'Magic City checkout spends credits first, settles the merchant in the background, and only falls back to a direct rail if you explicitly choose it below.') {
      if (!payment) return fallback;
      if (payment.fundingMode === 'free_preview') {
        return 'Free preview keeps this review-first, with no credits locked until you decide to upgrade.';
      }
      if (payment.fundingMode === 'direct_square') {
        return `Direct merchant checkout will charge ${formatUsd(payment.subtotalUsd || 0)} at the merchant rail.`;
      }
      if (isAlphaWorkflowPricing(payment)) {
        if (payment.serviceSurface === 'off_platform') {
          return `Magic City service price: ${describeAlphaWorkflowPrice(payment)}. External subtotal: ${formatUsd(payment.costUsd || 0)}. Magic City keeps the external settlement in sync behind the scenes.`;
        }
        return `Magic City service price: ${describeAlphaWorkflowPrice(payment)}.`;
      }
      if (payment.serviceSurface === 'off_platform') {
        return `Magic City service price: ${formatCreditCount(payment.requiredCredits)} credits. External subtotal: ${formatUsd(payment.costUsd || 0)}.`;
      }
      return `Magic City service price: ${formatCreditCount(payment.requiredCredits || 0)} credits.`;
    }

    function describeExecutionContractFunding(payment = {}, squareState = {}) {
      if (payment.fundingMode === 'free_preview') {
        return `Free preview selected${payment.taskName ? ` for ${payment.taskName}` : ''} · no credits locked yet · upgrade later only if you want the full deliverable`;
      }
      if (payment.fundingMode === 'direct_square') {
        return `Direct Square payment selected${payment.restaurantName ? ` for ${payment.restaurantName}` : ''}${payment.orderProviderLabel ? ` · via ${payment.orderProviderLabel}` : ''}${squareState.orderState ? ` · square order ${squareState.orderState.toLowerCase()}` : ''}`;
      }
      if (Number(payment.requiredCredits || 0) <= 0) {
        return 'No upfront credit funding is required for this task right now.';
      }
      if (isAlphaWorkflowPricing(payment)) {
        return payment.serviceSurface === 'off_platform'
          ? `Magic City service · ${describeAlphaWorkflowPrice(payment)}${payment.restaurantName ? ` · ${payment.restaurantName}` : ''}${payment.orderProviderLabel ? ` · via ${payment.orderProviderLabel}` : ''} · external subtotal ${formatUsd(payment.costUsd || 0)}`
          : `Magic City service · ${describeAlphaWorkflowPrice(payment)}${payment.taskName ? ` · ${payment.taskName}` : ''}${payment.serviceTier ? ` · ${payment.serviceTier}` : ''}${payment.rowCountBand ? ` · ${payment.rowCountBand}` : ''}${payment.lengthBand ? ` · ${payment.lengthBand}` : ''}`;
      }
      return payment.serviceSurface === 'off_platform'
        ? `Magic City service · ${formatCreditCount(payment.requiredCredits)} credits${payment.restaurantName ? ` · ${payment.restaurantName}` : ''}${payment.orderProviderLabel ? ` · via ${payment.orderProviderLabel}` : ''} · external subtotal ${formatUsd(payment.costUsd || 0)}`
        : `Magic City service · ${formatCreditCount(payment.requiredCredits)} credits${payment.taskName ? ` · ${payment.taskName}` : ''}${payment.serviceTier ? ` · ${payment.serviceTier}` : ''}${payment.rowCountBand ? ` · ${payment.rowCountBand}` : ''}${payment.lengthBand ? ` · ${payment.lengthBand}` : ''}`;
    }

    function buildWorkflowLine(capability = '') {
      if (!capability) return '';
      return `Workflow: ${getPendingLaneDefinition(capability).laneLabel}`;
    }

    async function maybeVerifyStripeSuccess() {
      const params = new URLSearchParams(window.location.search);
      if (params.get('stripe') !== 'success') return;
      const sessionId = params.get('session_id');
      if (!sessionId) return;
      await api(`/billing/stripe/session-status?sessionId=${encodeURIComponent(sessionId)}`).catch(() => null);
      await refreshCreditsBalance().catch(() => null);
      const executionSessionId = params.get('session');
      if (executionSessionId) {
        await renderExecutionSheet(executionSessionId, { focus: false }).catch(() => null);
        $('controlsCreditsMsg').textContent = 'Stripe payment completed. Magic City refreshed the session funding state.';
      }
      if (params.get('verified') !== '1') {
        params.set('verified', '1');
        window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
      }
    }

    async function maybeVerifySquareSuccess() {
      const params = new URLSearchParams(window.location.search);
      if (params.get('square') !== 'success') return;
      const sessionId = params.get('session');
      if (!sessionId) return;
      await api(`/connectors/sessions/${encodeURIComponent(sessionId)}/square-state`).catch(() => null);
      await renderExecutionSheet(sessionId, { focus: false }).catch(() => null);
      $('controlsCreditsMsg').textContent = 'Square checkout returned to Magic City. Session state refreshed.';
      if (params.get('verified') !== '1') {
        params.set('verified', '1');
        window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
      }
    }

    async function streamIntent(payload, handlers) {
      const res = await fetch('/intent/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const text = await res.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch {}
        throw new Error(data.error || 'intent_stream_failed');
      }
      if (!res.body) throw new Error('intent_stream_missing_body');

      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const lines = part.split('\n');
          const eventLine = lines.find((line) => line.startsWith('event:'));
          const dataLine = lines.find((line) => line.startsWith('data:'));
          if (!eventLine || !dataLine) continue;
          const event = eventLine.slice(6).trim();
          let data = {};
          try {
            data = JSON.parse(dataLine.slice(5).trim());
          } catch {
            data = {};
          }
          if (handlers[event]) await handlers[event](data);
        }
      }
    }

    function $(id) { return document.getElementById(id); }

    let backgroundVisualRequired = false;
    let backgroundVisualReady = false;
    let backgroundPlaybackStarted = false;
    let heroCopySettled = false;
    let bootFallbackTimeout = null;

    function syncHeroVisibility() {
      const shouldShowHero = heroCopySettled && (!backgroundVisualRequired || backgroundVisualReady);
      document.body.classList.toggle('hero-ready', shouldShowHero);
      document.body.classList.toggle('hero-copy-pending', !shouldShowHero);
      if (shouldShowHero) {
        document.body.classList.add('fonts-ready');
      }
    }

    function revealAppShell() {
      const shell = $('shell');
      document.body.classList.remove('app-loading');
      document.body.classList.add('app-ready');
      if (shell) {
        shell.hidden = false;
        shell.style.opacity = '';
        shell.style.visibility = '';
        shell.style.pointerEvents = '';
        shell.style.transform = '';
        shell.removeAttribute('aria-hidden');
      }
    }

    function markHeroCopyReady() {
      heroCopySettled = true;
      syncHeroVisibility();
    }

    function waitForHeroCopyReady() {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        markHeroCopyReady();
      };
      const fallback = window.setTimeout(finish, 850);
      if (document.fonts?.ready && typeof document.fonts.ready.then === 'function') {
        document.fonts.ready.then(() => {
          window.clearTimeout(fallback);
          finish();
        }).catch(() => {
          window.clearTimeout(fallback);
          finish();
        });
        return;
      }
      finish();
    }

    function clearBootFallback() {
      if (!bootFallbackTimeout) return;
      window.clearTimeout(bootFallbackTimeout);
      bootFallbackTimeout = null;
    }

    function scheduleBootFallback() {
      clearBootFallback();
      bootFallbackTimeout = window.setTimeout(() => {
        backgroundVideoScheduled = true;
      }, 6000);
    }

    function markBackgroundVisualReady() {
      if (backgroundVisualReady) return;
      backgroundVisualReady = true;
      pageBg?.classList.add('video-ready');
      clearBootFallback();
      revealAppOnce();
      syncHeroVisibility();
      const beginPlayback = () => {
        if (!pageBgVideo || backgroundPlaybackStarted) return;
        backgroundPlaybackStarted = true;
        const playPromise = pageBgVideo.play?.();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {});
        }
      };
      if (typeof pageBgVideo?.requestVideoFrameCallback === 'function') {
        pageBgVideo.requestVideoFrameCallback(() => {
          window.requestAnimationFrame(() => window.requestAnimationFrame(beginPlayback));
        });
        return;
      }
      window.requestAnimationFrame(() => window.requestAnimationFrame(beginPlayback));
    }

    function schedulePostPaintWork(task, timeout = 1200) {
      if (typeof task !== 'function') return;
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(() => task(), { timeout });
        return;
      }
      window.setTimeout(task, 220);
    }

    function getStorageScope() {
      return authSessionUser?.id ? `acct:${authSessionUser.id}` : 'guest';
    }

    function getPendingLaneDefinition(capability = 'general-chat') {
      const workflow = platformWorkflows[String(capability || 'general-chat')];
      if (workflow?.laneLabel) {
        const phaseEntries = Object.entries(workflow.phases || {});
        const defaultPhaseKey = (phaseEntries.find(([key]) => key !== 'routing') || phaseEntries[0] || ['reviewing'])[0];
        return {
          laneLabel: workflow.laneLabel,
          defaultPhase: defaultPhaseKey.charAt(0).toUpperCase() + defaultPhaseKey.slice(1),
          actions: Object.fromEntries(phaseEntries)
        };
      }
      const key = String(capability || '').toLowerCase();
      if (key.includes('meeting')) {
        return {
          laneLabel: 'Meeting package',
          defaultPhase: 'Reviewing',
          actions: {
            routing: 'routing request',
            reviewing: 'reviewing transcript',
            building: 'preparing package',
            syncing: 'syncing outputs',
            retrying: 'retrying package'
          }
        };
      }
      if (key.includes('food')) {
        return {
          laneLabel: 'Food order',
          defaultPhase: 'Ordering',
          actions: {
            routing: 'routing request',
            ordering: 'ordering dinner options',
            searching: 'searching restaurants',
            building: 'preparing checkout',
            retrying: 'switching provider'
          }
        };
      }
      if (key.includes('travel')) {
        return {
          laneLabel: 'Travel concierge',
          defaultPhase: 'Comparing',
          actions: {
            routing: 'routing request',
            searching: 'searching routes',
            comparing: 'comparing options',
            booking: 'preparing itinerary',
            retrying: 'refreshing results'
          }
        };
      }
      if (key.includes('job')) {
        return {
          laneLabel: 'Job applications',
          defaultPhase: 'Filtering',
          actions: {
            routing: 'routing request',
            filtering: 'filtering openings',
            reviewing: 'reviewing fit',
            building: 'preparing application',
            retrying: 'switching sources'
          }
        };
      }
      if (key.includes('call-mom') || key.includes('reminder')) {
        return {
          laneLabel: 'Reminder',
          defaultPhase: 'Preparing',
          actions: {
            routing: 'routing request',
            preparing: 'preparing follow-up',
            syncing: 'syncing calendar',
            building: 'finalizing reminder',
            retrying: 'retrying reminder'
          }
        };
      }
      return {
        laneLabel: 'Magic City',
        defaultPhase: 'Reviewing',
        actions: {
          routing: 'routing request',
          reviewing: 'reviewing request',
          researching: 'researching answer',
          building: 'preparing response',
          retrying: 'switching provider'
        }
      };
    }

    function getPendingPresentation(capability = 'general-chat', phase = 'Routing') {
      const lane = getPendingLaneDefinition(capability);
      const normalized = String(phase || lane.defaultPhase || 'Reviewing').trim().toLowerCase();
      const statusLabel = normalized.charAt(0).toUpperCase() + normalized.slice(1);
      const actionText = lane.actions[normalized] || lane.actions[lane.defaultPhase.toLowerCase()] || 'reviewing request';
      return {
        status: statusLabel,
        body: `${lane.laneLabel} · ${actionText}`,
        laneLabel: lane.laneLabel
      };
    }

    function setAssistantPendingState(target, phase = 'Routing', capability = 'general-chat') {
      if (!target?.el || !target?.body) return;
      const pendingState = getPendingPresentation(capability, phase);
      target.el.dataset.pendingCapability = capability || target.el.dataset.pendingCapability || 'general-chat';
      target.el.dataset.pendingLaneLabel = pendingState.laneLabel;
      let status = target.el.querySelector('.msg-status');
      if (!status) {
        status = document.createElement('div');
        status.className = 'msg-status';
        target.el.insertBefore(status, target.body);
      }
      let progress = target.el.querySelector('.msg-progress');
      if (!progress) {
        progress = document.createElement('div');
        progress.className = 'msg-progress';
        target.el.appendChild(progress);
      }
      status.textContent = pendingState.status;
      setAssistantBodyContent(target.body, pendingState.body);
    }

    function stopAssistantPendingState(target) {
      if (!target?.el) return;
      target.el.classList.remove('pending');
      delete target.el.dataset.pendingCapability;
      delete target.el.dataset.pendingLaneLabel;
      target.el.querySelector('.msg-status')?.remove();
      target.el.querySelector('.msg-progress')?.remove();
    }

    function inferExecutionPhase(row = {}, fulfillment = null) {
      const statusValue = String(row?.state || '').toLowerCase();
      const label = String(row?.label || '').toLowerCase();
      const detail = String(row?.detail || '').toLowerCase();
      const source = `${statusValue} ${label} ${detail}`;
      if (fulfillment?.status === 'failed' || /failed|error/.test(source)) return { label: 'Failed', cls: 'failed' };
      if (fulfillment?.status === 'fulfilled' || /fulfilled|completed|finished/.test(source)) return { label: 'Completed', cls: 'completed' };
      if (/queued|requested/.test(source)) return { label: 'Queued', cls: 'queued' };
      if (/claim/.test(source)) return { label: 'Working', cls: 'running' };
      if (/routing/.test(source)) return { label: 'Routing', cls: 'running' };
      if (/parse|reading/.test(source)) return { label: 'Parsing', cls: 'running' };
      if (/research|source|repo/.test(source)) return { label: 'Researching', cls: 'running' };
      if (/search|flight|job|target/.test(source)) return { label: 'Searching', cls: 'running' };
      if (/build|package|artifact|write|export|clean|deduplicat|summary/.test(source)) return { label: 'Building', cls: 'running' };
      if (/sync|calendar|gmail|contact/.test(source)) return { label: 'Syncing', cls: 'running' };
      if (/checkout|provider|launch|browser|cart|reservation|apply/.test(source)) return { label: 'Working', cls: 'running' };
      return { label: fulfillment ? 'Completed' : 'Working', cls: fulfillment ? 'completed' : 'running' };
    }

    function getScopedStorageKey(baseKey, scope = getStorageScope()) {
      return `${baseKey}:${scope}`;
    }

    function normalizeLocalMemorySettings(value = null) {
      const source = value && typeof value === 'object' ? value : {};
      const facts = Array.isArray(source.facts)
        ? source.facts
            .map((item) => String(item || '').trim())
            .filter(Boolean)
            .slice(0, 12)
        : [];
      return {
        enabled: source.enabled !== false,
        resumeLastThread: Boolean(source.resumeLastThread),
        note: String(source.note || '').trim().slice(0, 1600),
        facts
      };
    }

    function loadLocalMemorySettings() {
      try {
        const raw = localStorage.getItem(getScopedStorageKey(LOCAL_CHAT_MEMORY_KEY));
        return normalizeLocalMemorySettings(raw ? JSON.parse(raw) : null);
      } catch {
        return { ...DEFAULT_LOCAL_MEMORY_SETTINGS };
      }
    }

    function saveLocalMemorySettings(nextSettings = {}) {
      localMemorySettings = normalizeLocalMemorySettings(nextSettings);
      localStorage.setItem(getScopedStorageKey(LOCAL_CHAT_MEMORY_KEY), JSON.stringify(localMemorySettings));
      return localMemorySettings;
    }

    function applyLocalMemorySettingsUi(settings = localMemorySettings) {
      const normalized = normalizeLocalMemorySettings(settings);
      localMemorySettings = normalized;
      if ($('localMemoryEnabled')) $('localMemoryEnabled').checked = normalized.enabled;
      if ($('localMemoryResumeThread')) $('localMemoryResumeThread').checked = normalized.resumeLastThread;
      if ($('localMemoryNote')) $('localMemoryNote').value = normalized.note;
      if ($('localMemoryFacts')) {
        $('localMemoryFacts').innerHTML = normalized.enabled && normalized.facts.length
          ? normalized.facts.map((fact) => `<span class="settings-badge">${escapeHtml(fact)}</span>`).join('')
          : '';
      }
      if ($('localMemoryStatus')) {
        $('localMemoryStatus').textContent = normalized.enabled
          ? normalized.note
            ? `Local memory is on by default on this browser. Saved context will be used for follow-ups and future sessions on this device${normalized.facts.length ? ` · ${normalized.facts.length} remembered cue${normalized.facts.length === 1 ? '' : 's'}` : ''}.`
            : `Local memory is on by default on this browser. Add a note if you want Magic City to remember stable preferences too${normalized.facts.length ? ` · ${normalized.facts.length === 1 ? '1 remembered cue is' : `${normalized.facts.length} remembered cues are`} already detected` : ''}.`
          : 'Local memory is off. Magic City will only use the visible in-chat context from this session.';
      }
    }

    function clearLocalMemorySettings() {
      localStorage.removeItem(getScopedStorageKey(LOCAL_CHAT_MEMORY_KEY));
      localMemorySettings = { ...DEFAULT_LOCAL_MEMORY_SETTINGS };
      applyLocalMemorySettingsUi(localMemorySettings);
      return localMemorySettings;
    }

    function mergeLocalMemoryFacts(existing = [], additions = []) {
      const merged = [];
      for (const item of [...existing, ...additions]) {
        const text = String(item || '').trim();
        if (!text) continue;
        if (merged.some((entry) => entry.toLowerCase() === text.toLowerCase())) continue;
        merged.push(text);
        if (merged.length >= 12) break;
      }
      return merged;
    }

    function extractLocalMemoryFacts(text = '') {
      const source = String(text || '').trim();
      if (!source) return [];
      const normalized = source.replace(/\s+/g, ' ').trim();
      const lower = normalized.toLowerCase();
      const facts = [];
      const pushFact = (value) => {
        const clean = String(value || '').trim();
        if (!clean) return;
        if (clean.length > 72) return;
        if (!facts.some((item) => item.toLowerCase() === clean.toLowerCase())) facts.push(clean);
      };

      const preferMatch = normalized.match(/\b(?:i prefer|prefer|default to|please use)\s+(.+)$/i);
      if (preferMatch) {
        const cleaned = preferMatch[1].replace(/[.?!]+$/, '').trim();
        if (cleaned && cleaned.length <= 52) pushFact(`Prefers ${cleaned}`);
      }

      if (/\bconcise\b/i.test(lower)) pushFact('Prefers concise answers');
      if (/\bdetailed\b/i.test(lower)) pushFact('Open to detailed answers');
      if (/\bcalendar invite|calendar event|put it on my calendar\b/i.test(lower)) pushFact('Prefers calendar invites');
      if (/\bgmail draft|email draft\b/i.test(lower)) pushFact('Prefers Gmail drafts');
      if (/\bvegetarian\b/i.test(lower)) pushFact('Vegetarian');
      if (/\bvegan\b/i.test(lower)) pushFact('Vegan');
      if (/\bgluten[- ]?free\b/i.test(lower)) pushFact('Gluten-free');
      if (/\bpescatarian\b/i.test(lower)) pushFact('Pescatarian');

      const airportMatch = normalized.match(/\b(?:my home airport is|home airport is|use)\s+([A-Z]{3})\b(?:\s+for travel)?/);
      if (airportMatch) pushFact(`Home airport ${airportMatch[1].toUpperCase()}`);

      const timezoneMatch = normalized.match(/\bmy timezone is\s+([A-Za-z_\/-]+)/i);
      if (timezoneMatch) pushFact(`Timezone ${timezoneMatch[1]}`);

      return facts.slice(0, 4);
    }

    function rememberLocalMemoryFromUserText(text = '') {
      if (!localMemorySettings.enabled) return;
      const facts = extractLocalMemoryFacts(text);
      if (!facts.length) return;
      const next = {
        ...localMemorySettings,
        facts: mergeLocalMemoryFacts(localMemorySettings.facts, facts)
      };
      saveLocalMemorySettings(next);
      applyLocalMemorySettingsUi(next);
    }

    applyLocalMemorySettingsUi(loadLocalMemorySettings());

    function maybeAdoptGuestThreads() {
      if (!authSessionUser?.id) return;
      const accountThreadsKey = getScopedStorageKey(CHAT_THREADS_KEY);
      if (localStorage.getItem(accountThreadsKey)) return;
      const legacyThreads = localStorage.getItem(getScopedStorageKey(CHAT_THREADS_KEY, 'guest')) || localStorage.getItem(CHAT_THREADS_KEY);
      if (legacyThreads) localStorage.setItem(accountThreadsKey, legacyThreads);
      const legacyActive = localStorage.getItem(getScopedStorageKey(ACTIVE_THREAD_KEY, 'guest')) || localStorage.getItem(ACTIVE_THREAD_KEY);
      if (legacyActive) localStorage.setItem(getScopedStorageKey(ACTIVE_THREAD_KEY), legacyActive);
    }

    function restoreCurrentIdentityThread() {
      renderThreadOptions();
      localMemorySettings = loadLocalMemorySettings();
      applyLocalMemorySettingsUi(localMemorySettings);
      const threads = loadThreads();
      const activeId = getActiveThreadId();
      if (activeId && !threads.some((thread) => thread.id === activeId)) {
        setActiveThreadId(null);
      }
      const resolvedActiveId = getActiveThreadId();
      $('messages').innerHTML = '';
      if (localMemorySettings.resumeLastThread && resolvedActiveId) {
        restoreThread(resolvedActiveId);
        return;
      }
      updateHero();
    }

    function updateHero() {
      $('hero').classList.toggle('hidden', $('messages').children.length > 0);
    }

    function loadThreads() {
      try {
        const raw = localStorage.getItem(getScopedStorageKey(CHAT_THREADS_KEY)) || (!authSessionUser ? localStorage.getItem(CHAT_THREADS_KEY) : null);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function saveThreads(threads) {
      const trimmed = [...threads]
        .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime())
        .slice(0, MAX_SAVED_THREADS);
      localStorage.setItem(getScopedStorageKey(CHAT_THREADS_KEY), JSON.stringify(trimmed));
    }

    function getActiveThreadId() {
      return localStorage.getItem(getScopedStorageKey(ACTIVE_THREAD_KEY)) || (!authSessionUser ? localStorage.getItem(ACTIVE_THREAD_KEY) : null) || null;
    }

    function setActiveThreadId(threadId) {
      const key = getScopedStorageKey(ACTIVE_THREAD_KEY);
      if (threadId) localStorage.setItem(key, threadId);
      else localStorage.removeItem(key);
    }

    function createThread(title = 'New chat') {
      const threads = loadThreads();
      const thread = {
        id: `thread_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        title,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: []
      };
      threads.unshift(thread);
      saveThreads(threads);
      setActiveThreadId(thread.id);
      return thread;
    }

    function renameThread(threadId, title) {
      if (!threadId) return;
      const nextTitle = String(title || '').trim();
      if (!nextTitle) return;
      const threads = loadThreads().map((thread) =>
        thread.id === threadId
          ? { ...thread, title: nextTitle, updatedAt: new Date().toISOString() }
          : thread
      );
      saveThreads(threads);
      renderThreadOptions();
    }

    function deleteThread(threadId) {
      if (!threadId) return;
      const threads = loadThreads().filter((thread) => thread.id !== threadId);
      saveThreads(threads);
      if (getActiveThreadId() === threadId) {
        setActiveThreadId(null);
      }
      renderThreadOptions();
    }

    function getCurrentThread() {
      const threads = loadThreads();
      const activeId = getActiveThreadId();
      return threads.find((thread) => thread.id === activeId) || null;
    }

    function inferThreadTitle(messages) {
      const firstUser = messages.find((row) => row.role === 'user' && row.text);
      return firstUser ? String(firstUser.text).slice(0, 42) : 'New chat';
    }

    function escapeHtml(value = '') {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function normalizeAssistantUrl(url = '') {
      const value = String(url || '').trim();
      if (!/^https?:\/\//i.test(value)) return '';
      try {
        return new URL(value).toString();
      } catch {
        return '';
      }
    }

    function renderInlineAssistantText(text = '') {
      let html = escapeHtml(String(text || ''));
      html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, label, url) => {
        const normalizedUrl = normalizeAssistantUrl(url);
        if (!normalizedUrl) return match;
        return `<a href="${escapeHtml(normalizedUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
      });
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
      html = html.replace(/(^|[\s(])\*([^*\n][^*\n]*?)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
      html = html.replace(/(^|[\s(])_([^_\n][^_\n]*?)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
      html = html.replace(/(^|[\s(])(https?:\/\/[^\s<]+)(?=[\s),.!?:;]|$)/g, (match, prefix, url) => {
        const normalizedUrl = normalizeAssistantUrl(url);
        if (!normalizedUrl) return match;
        return `${prefix}<a href="${escapeHtml(normalizedUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
      });
      html = html.replace(/\*\*/g, '');
      html = html.replace(/__/g, '');
      return html;
    }

    function stripAssistantInlineMarkers(text = '') {
      return String(text || '')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
        .replace(/[`*_]/g, '')
        .trim();
    }

    function extractAssistantCalloutLabel(lines = []) {
      if (!Array.isArray(lines) || !lines.length) return '';
      const first = String(lines[0] || '').trim();
      if (!first) return '';
      const strongOnly = first.match(/^(?:\*\*|__)(.+?)(?:\*\*|__):?\s*$/);
      if (strongOnly) {
        const label = stripAssistantInlineMarkers(strongOnly[1]).replace(/:$/, '').trim();
        return label.length && label.length <= 44 ? label : '';
      }
      if (!/:$/.test(first)) return '';
      const plain = stripAssistantInlineMarkers(first).replace(/:$/, '').trim();
      if (!plain || plain.length > 44) return '';
      if (/[.!?]$/.test(plain)) return '';
      return plain;
    }

    function renderAssistantList(lines = []) {
      if (!Array.isArray(lines) || !lines.length) return '';
      if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
        return `<ul>${lines.map((line) => `<li>${renderInlineAssistantText(line.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
        return `<ol>${lines.map((line) => `<li>${renderInlineAssistantText(line.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
      }
      return '';
    }

    function renderAssistantParagraph(lines = []) {
      return `<p>${lines.map((line) => renderInlineAssistantText(line)).join('<br />')}</p>`;
    }

    function parseAssistantTableCells(line = '') {
      return String(line || '')
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());
    }

    function isAssistantTableDivider(line = '') {
      const value = String(line || '').trim();
      return Boolean(value) && /^[:\-\s|]+$/.test(value) && value.includes('-');
    }

    function isAssistantMarkdownTable(lines = []) {
      if (!Array.isArray(lines) || lines.length < 2) return false;
      const header = String(lines[0] || '');
      if (!header.includes('|')) return false;
      if (!isAssistantTableDivider(lines[1])) return false;
      return parseAssistantTableCells(header).length >= 2;
    }

    function renderAssistantTable(lines = []) {
      const headerCells = parseAssistantTableCells(lines[0]);
      const bodyRows = lines.slice(2)
        .filter((line) => String(line || '').trim())
        .map((line) => parseAssistantTableCells(line))
        .filter((cells) => cells.length);
      const normalizeRow = (cells) => headerCells.map((_, index) => cells[index] || '');
      return `
        <div class="msg-table-wrap">
          <table>
            <thead>
              <tr>${headerCells.map((cell) => `<th>${renderInlineAssistantText(cell)}</th>`).join('')}</tr>
            </thead>
            <tbody>
              ${bodyRows.map((cells) => `<tr>${normalizeRow(cells).map((cell) => `<td>${renderInlineAssistantText(cell)}</td>`).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    function renderAssistantRichText(rawText = '') {
      const source = String(rawText || '').replace(/\r\n/g, '\n').trim();
      if (!source) return '';
      const blocks = source.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
      return blocks.map((block) => {
        if (/^```[\s\S]*```$/.test(block)) {
          const code = block.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
          return `<pre><code>${escapeHtml(code)}</code></pre>`;
        }
        const lines = block.split('\n');
        if (/^-{3,}$/.test(block)) {
          return '<hr />';
        }
        if (isAssistantMarkdownTable(lines)) {
          return renderAssistantTable(lines);
        }
        const standaloneList = renderAssistantList(lines);
        if (standaloneList) {
          return standaloneList;
        }
        if (/^#{1,4}\s+/.test(lines[0])) {
          const level = Math.min(4, (lines[0].match(/^#+/)?.[0].length || 4));
          const heading = lines[0].replace(/^#{1,4}\s+/, '');
          const restLines = lines.slice(1).filter((line) => String(line || '').trim());
          const restList = renderAssistantList(restLines);
          return `<h${level}>${renderInlineAssistantText(heading)}</h${level}>${restLines.length ? (restList || renderAssistantParagraph(restLines)) : ''}`;
        }
        const calloutLabel = extractAssistantCalloutLabel(lines);
        if (calloutLabel) {
          const restLines = lines.slice(1).filter((line) => String(line || '').trim());
          const restList = renderAssistantList(restLines);
          return `<div class="msg-callout-pill">${renderInlineAssistantText(calloutLabel)}</div>${restLines.length ? (restList || renderAssistantParagraph(restLines)) : ''}`;
        }
        return renderAssistantParagraph(lines);
      }).join('');
    }

    function setAssistantBodyContent(body, text = '') {
      if (!body) return;
      const rawText = String(text || '');
      body.dataset.rawText = rawText;
      body.innerHTML = renderAssistantRichText(rawText);
    }

    function getMessageRawText(el) {
      if (!el) return '';
      const body = el.querySelector('.msg-body');
      if (body?.dataset?.rawText !== undefined) return body.dataset.rawText || '';
      return body?.textContent || el.textContent || '';
    }

    function renderThreadOptions() {
      const query = String($('threadSearchInput')?.value || '').trim().toLowerCase();
      const allThreads = loadThreads();
      const threads = query ? allThreads.filter((thread) => threadMatchesHistorySearch(thread, query)) : allThreads;
      const activeId = getActiveThreadId();
      $('threadList').innerHTML = threads.map((thread) => `
        <div class="thread-row">
          <button class="thread-item ${thread.id === activeId ? 'active' : ''}" data-thread-open="${thread.id}">${escapeHtml(thread.title || 'New chat')}</button>
          <button class="thread-mini" data-thread-rename="${thread.id}" title="Rename">Edit</button>
          <button class="thread-mini" data-thread-delete="${thread.id}" title="Delete">X</button>
        </div>
      `).join('') || `<div class="muted">${query ? 'No matching chats.' : 'No saved chats yet.'}</div>`;
    }

    function threadMatchesHistorySearch(thread, query = '') {
      const needle = String(query || '').trim().toLowerCase();
      if (!needle) return true;
      const haystack = [
        thread?.title || '',
        ...(Array.isArray(thread?.messages) ? thread.messages.map((row) => `${row?.content || row?.text || ''}\n${row?.details || ''}`) : [])
      ].join('\n').toLowerCase();
      return haystack.includes(needle);
    }

    function saveChatHistory() {
      const rows = [...$('messages').children].map((el) => ({
        role: el.classList.contains('user') ? 'user' : 'assistant',
        text: getMessageRawText(el),
        details: el.querySelector('.msg-details div')?.textContent || '',
        pending: el.classList.contains('pending')
      })).filter((row) => row.text && !row.pending);
      let threads = loadThreads();
      let activeId = getActiveThreadId();
      if (!activeId) {
        activeId = createThread(inferThreadTitle(rows)).id;
        threads = loadThreads();
      }
      threads = threads.map((thread) =>
        thread.id === activeId
          ? {
              ...thread,
              title: inferThreadTitle(rows),
              updatedAt: new Date().toISOString(),
              messages: rows
            }
          : thread
      );
      saveThreads(threads);
      renderThreadOptions();
    }

    function recentConversationContext(limit = 6) {
      const rows = [...$('messages').children]
        .map((el) => ({
          role: el.classList.contains('user') ? 'user' : 'assistant',
          content: getMessageRawText(el),
          pending: el.classList.contains('pending')
        }))
        .filter((row) => row.content && !row.pending);
      return rows.slice(-limit);
    }

    function storedThreadConversationContext(limit = 12) {
      const thread = getCurrentThread();
      const rows = Array.isArray(thread?.messages)
        ? thread.messages.map((row) => ({
            role: row.role === 'assistant' ? 'assistant' : 'user',
            content: String(row.text || row.content || ''),
            pending: Boolean(row.pending)
          }))
        : [];
      return rows.filter((row) => row.content && !row.pending).slice(-limit);
    }

    function buildThreadMemorySummary(rows = []) {
      const cleanRows = Array.isArray(rows) ? rows.filter((row) => row?.content) : [];
      if (!cleanRows.length) return '';
      const userRows = cleanRows.filter((row) => row.role === 'user');
      const assistantRows = cleanRows.filter((row) => row.role === 'assistant');
      const firstUser = userRows[0]?.content ? String(userRows[0].content).trim() : '';
      const latestAssistantQuestion = [...assistantRows].reverse().find((row) => /\?\s*$/.test(String(row.content || '').trim()))?.content || '';
      const recentUserAnswers = userRows.slice(-3).map((row) => String(row.content || '').trim()).filter(Boolean);
      const summaryParts = [];
      if (firstUser) summaryParts.push(`Original request: ${firstUser.slice(0, 220)}`);
      if (latestAssistantQuestion) summaryParts.push(`Last assistant question: ${latestAssistantQuestion.slice(0, 220)}`);
      if (recentUserAnswers.length) summaryParts.push(`Recent user answers: ${recentUserAnswers.map((item) => item.slice(0, 160)).join(' | ')}`);
      return summaryParts.join('\n');
    }

    function buildConversationContext(limit = 12) {
      const liveRows = recentConversationContext(Math.max(limit, 10));
      const storedRows = localMemorySettings.enabled ? storedThreadConversationContext(Math.max(limit, 12)) : [];
      const baseRows = storedRows.length >= liveRows.length ? storedRows : liveRows;
      return baseRows.slice(-limit);
    }

    function buildPromptMemoryContext(limit = 12) {
      const baseRows = buildConversationContext(limit);
      const context = [];
      if (localMemorySettings.enabled && localMemorySettings.note) {
        context.push({
          role: 'system',
          content: `Local user context from this browser:\n${localMemorySettings.note}`
        });
      }
      if (localMemorySettings.enabled && Array.isArray(localMemorySettings.facts) && localMemorySettings.facts.length) {
        context.push({
          role: 'system',
          content: `Remembered user cues from this browser:\n- ${localMemorySettings.facts.join('\n- ')}`
        });
      }
      if (localMemorySettings.enabled) {
        const summary = buildThreadMemorySummary(baseRows);
        if (summary) {
          context.push({
            role: 'system',
            content: `Conversation memory:\n${summary}`
          });
        }
      }
      return context;
    }

    function getLatestAssistantMessageText() {
      const rows = [...$('messages').children].reverse();
      for (const el of rows) {
        if (!el.classList.contains('assistant')) continue;
        if (el.classList.contains('pending')) continue;
        const text = getMessageRawText(el).trim();
        if (text) return text;
      }
      return '';
    }

    function parseInlineEmailRequest(prompt = '') {
      const text = String(prompt || '').trim();
      if (!/\b(email|mail|send)\b/i.test(text)) return null;
      const emails = [...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((match) => match[0].toLowerCase());
      const to = emails.length
        ? emails
        : (/\bto me\b/i.test(text) && authSessionUser?.email ? [String(authSessionUser.email).trim().toLowerCase()] : []);
      if (!to.length) return null;
      return { to };
    }

    function parseInlineReminderRequest(prompt = '') {
      const text = String(prompt || '').trim();
      const lower = text.toLowerCase();
      if (!/\b(remind|reminder|calendar invite|calendar event|set a calendar|schedule|put (it|this) on my calendar|add (it|this) to my calendar)\b/.test(lower)) {
        return null;
      }
      const parenthetical = text.match(/\(([^)]+)\)/);
      let note = parenthetical?.[1]?.trim() || '';
      if (!note) {
        const explicit = text.match(/(?:remind me to|set (?:a )?(?:calendar )?(?:invite|event) for|schedule|add (?:it|this) to my calendar)\s+(.+)$/i);
        if (explicit?.[1]) note = explicit[1].trim();
      }
      note = note
        .replace(/\bfor\s+(tomorrow|today|tonight|this weekend|next week)\b/gi, '')
        .replace(/[().]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!note) note = 'Follow up';

      let dueTime = 'Tomorrow at 9:00 AM';
      if (/\btoday\b/i.test(text)) dueTime = 'Today at 9:00 AM';
      else if (/\btonight\b/i.test(text)) dueTime = 'Tonight at 6:00 PM';
      else if (/\bthis weekend\b/i.test(text)) dueTime = 'This weekend';
      else if (/\bnext week\b/i.test(text)) dueTime = 'Next week';
      else if (/\btomorrow\b/i.test(text)) dueTime = 'Tomorrow at 9:00 AM';

      return { note, dueTime };
    }

    function parseInlineEvmWalletRequest(prompt = '') {
      const text = String(prompt || '').trim();
      const lower = text.toLowerCase();
      if (!/\b(wallet|evm|ethereum|metamask|rabby|coinbase wallet|usdc|payment|pay|transfer|top up|credits|invoice|sign|signature)\b/.test(lower)) {
        return null;
      }
      if (/\b(why did i link|why link|what can you do with|what can i do with|what else can we do|why do i have|what is this for)\b/.test(lower) && /\b(wallet|evm|ethereum|metamask)\b/.test(lower)) {
        return { kind: 'explain' };
      }
      if (/\b(buy|top up|fund|add)\b/.test(lower) && /\bcredits?\b/.test(lower)) {
        const creditsMatch = text.match(/(\d[\d,]*)\s*credits?/i);
        return {
          kind: 'credit_topup',
          credits: creditsMatch ? Number(String(creditsMatch[1]).replace(/,/g, '')) : 2500
        };
      }
      if (/\b(send|pay|transfer|payment)\b/.test(lower)) {
        const recipientAddress = text.match(/\b0x[a-fA-F0-9]{40}\b/)?.[0] || '';
        const amountMatch = text.match(/(\d+(?:\.\d{1,2})?)\s*(usdc|usd)\b/i);
        if (recipientAddress && amountMatch) {
          return {
            kind: 'direct_payment',
            recipientAddress,
            amountUsdCents: parseUsdToCents(amountMatch[1])
          };
        }
        return { kind: 'needs_payment_details' };
      }
      return null;
    }

    function inferEmailSubject(prompt = '', body = '') {
      const source = `${prompt}\n${body}`;
      if (/itinerary|flight|hotel|trip|travel/i.test(source)) return 'Magic City itinerary';
      if (/meeting|transcript|follow-up|follow up/i.test(source)) return 'Magic City follow-up';
      if (/spreadsheet|csv|xlsx|cleanup|clean up/i.test(source)) return 'Magic City cleaned export';
      if (/job|application|resume/i.test(source)) return 'Magic City application summary';
      const heading = String(body || '').split('\n').map((line) => line.trim()).find(Boolean);
      return heading ? heading.slice(0, 96) : 'Message from Magic City';
    }

    async function maybeHandleInlineEvmWalletRequest(prompt) {
      const request = parseInlineEvmWalletRequest(prompt);
      if (!request) return false;

      const wallet = Array.isArray(evmWalletStatus?.wallets) ? evmWalletStatus.wallets[0] : null;
      const connected = Boolean(evmWalletStatus?.connected && wallet?.address);
      const capabilityLabels = Object.values(evmWalletStatus?.capabilities || {})
        .filter((item) => item?.enabled)
        .map((item) => item.label);
      const topupConfig = evmWalletStatus?.topupConfig || {};

      if (request.kind === 'explain') {
        const detailLines = renderDetailLines([
          `Linked wallet: ${wallet?.address ? shortenWalletAddress(wallet.address) : 'not linked yet'}`,
          connected ? `Enabled now: ${capabilityLabels.join(' · ') || 'wallet permissions ready'}` : 'Wallet actions become available after linking',
          topupConfig?.enabled ? `Top-up rail: ${topupConfig.assetSymbol || 'USDC'} on ${topupConfig.networkLabel || 'Ethereum'}` : 'Top-up rail: not configured on this environment yet',
          'Works with Ethereum-compatible browser wallets; MetaMask is one option, not the only one.'
        ]);
        addAssistantResult(
          connected
            ? 'Your linked Ethereum wallet lets Magic City prepare settlement signatures, direct payment requests, and USDC credit top-ups that you still approve in your wallet.'
            : 'A linked Ethereum wallet lets Magic City prepare wallet-backed signatures and payment requests without ever holding your private key.',
          detailLines
        );
        return true;
      }

      if (!authSessionUser) {
        addMessage('assistant', 'Sign in first, then link an Ethereum-compatible wallet in Connected Accounts if you want Magic City to prepare wallet-backed payments, top-ups, or signatures.');
        return true;
      }
      if (!connected) {
        addMessage('assistant', 'Your wallet is not linked yet. Open Connected Accounts, link your Ethereum wallet, and I can prepare a payment request that opens in your wallet for approval.');
        return true;
      }

      if (request.kind === 'needs_payment_details') {
        addAssistantResult(
          'Yes — I can prepare a wallet payment request that opens in your wallet for approval.',
          renderDetailLines([
            `Linked wallet: ${shortenWalletAddress(wallet.address)}`,
            'Send me the recipient address and amount, for example: pay 25 USDC to 0x…',
            'For Magic City credits, say: buy 2,500 credits with USDC'
          ])
        );
        return true;
      }

      if (request.kind === 'credit_topup') {
        try {
          const { request: prepared, txHash, openedInWallet } = await prepareAndSubmitEvmWalletPayment({
            mode: 'credit_topup',
            credits: request.credits
          });
          $('controlsCreditsMsg').textContent = openedInWallet
            ? `Opened a ${prepared.amountDisplay} ${prepared.assetSymbol} wallet invoice for Magic City. Credits appear after the transfer is submitted and verified.`
            : `Submitted ${prepared.amountDisplay} ${prepared.assetSymbol} top-up to Magic City. Credits will appear after onchain verification. Tx ${String(txHash).slice(0, 10)}…`;
          addAssistantResult(
            openedInWallet
              ? `Prepared a ${prepared.amountDisplay} ${prepared.assetSymbol} wallet invoice for ${formatCreditCount(prepared.credits || 0)} credits.`
              : `Opened a ${prepared.amountDisplay} ${prepared.assetSymbol} wallet top-up request for ${formatCreditCount(prepared.credits || 0)} credits.`,
            renderDetailLines([
              `Linked wallet: ${shortenWalletAddress(prepared.senderAddress)}`,
              `Network: ${prepared.networkLabel}`,
              `Treasury: ${shortenWalletAddress(prepared.recipientAddress)}`,
              openedInWallet ? 'Approve the transfer in your wallet app to continue.' : `Transaction: ${String(txHash).slice(0, 10)}…`
            ])
          );
        } catch (error) {
          addMessage('assistant', `Wallet top-up needs attention: ${error.message}`);
        }
        return true;
      }

      if (request.kind === 'direct_payment') {
        if (!evmWalletStatus?.capabilities?.paymentRequests?.enabled) {
          addMessage('assistant', 'Your wallet is linked, but Payment requests are disabled in Connected Accounts right now.');
          return true;
        }
        try {
          const { request: prepared, txHash, openedInWallet } = await prepareAndSubmitEvmWalletPayment({
            mode: 'direct_payment',
            amountUsdCents: request.amountUsdCents,
            recipientAddress: request.recipientAddress
          });
          addAssistantResult(
            openedInWallet
              ? `Prepared a ${prepared.amountDisplay} ${prepared.assetSymbol} wallet invoice for approval.`
              : `Opened a ${prepared.amountDisplay} ${prepared.assetSymbol} wallet payment request for approval.`,
            renderDetailLines([
              `Linked wallet: ${shortenWalletAddress(prepared.senderAddress)}`,
              `Recipient: ${shortenWalletAddress(prepared.recipientAddress)}`,
              `Network: ${prepared.networkLabel}`,
              openedInWallet ? 'Approve the transfer in your wallet app to continue.' : `Transaction: ${String(txHash).slice(0, 10)}…`
            ])
          );
        } catch (error) {
          addMessage('assistant', `Wallet payment setup needs attention: ${error.message}`);
        }
        return true;
      }

      return false;
    }

    async function maybeHandleInlineEmailRequest(prompt) {
      const request = parseInlineEmailRequest(prompt);
      if (!request) return false;

      const bodyText = getLatestAssistantMessageText();
      if (!bodyText) {
        addMessage('assistant', 'I need a recent Magic City result first so I have something concrete to email.');
        return true;
      }
      if (!authSessionUser) {
        addMessage('assistant', 'Sign in first, then enable Google agent access if you want me to send or draft email for you.');
        return true;
      }
      if (!googleConnectorStatus?.connected) {
        addMessage('assistant', 'You’re signed in, but Google agent access is not enabled yet. Open Connected Accounts and enable Gmail send or Gmail drafts there first.');
        return true;
      }
      const canSend = Boolean(googleConnectorStatus?.capabilities?.gmailSend?.enabled);
      const canDraft = Boolean(googleConnectorStatus?.capabilities?.gmailDrafts?.enabled);
      if (!canSend && !canDraft) {
        addMessage('assistant', 'Google is connected, but Gmail send and Gmail drafts are currently disabled in Connected Accounts.');
        return true;
      }

      const subject = inferEmailSubject(prompt, bodyText);
      const mode = canSend ? 'send' : 'draft';
      try {
        const data = await api('/connectors/google/send-message', {
          method: 'POST',
          body: JSON.stringify({
            to: request.to,
            subject,
            body: bodyText,
            mode
          })
        });
        const summary = mode === 'send'
          ? `Sent with Google to ${request.to.join(', ')}.`
          : `Created a Gmail draft for ${request.to.join(', ')}.`;
        const details = renderDetailLines([
          buildWorkflowLine('general-chat'),
          data.connectedEmail ? `From: ${data.connectedEmail}` : '',
          mode === 'send' ? (data.gmailSentUrl ? `Open Sent: ${data.gmailSentUrl}` : '') : (data.gmailDraftUrl ? `Open draft: ${data.gmailDraftUrl}` : ''),
          `Subject: ${subject}`
        ]);
        addAssistantResult(summary, details);
      } catch (error) {
        addMessage('assistant', `Email setup needs attention: ${error.message}`);
      }
      return true;
    }

    async function maybeHandleInlineReminderRequest(prompt) {
      const request = parseInlineReminderRequest(prompt);
      if (!request) return false;

      if (!authSessionUser) {
        addMessage('assistant', 'Sign in first, then enable Google agent access if you want me to create calendar events for you.');
        return true;
      }
      if (!googleConnectorStatus?.connected) {
        addMessage('assistant', 'You’re signed in, but Google agent access is not enabled yet. Open Connected Accounts and enable Calendar events there first.');
        return true;
      }
      const canCalendar = Boolean(googleConnectorStatus?.capabilities?.calendar?.enabled);
      if (!canCalendar) {
        addMessage('assistant', 'Google is connected, but Calendar events are currently disabled in Connected Accounts.');
        return true;
      }
      try {
        const data = await api('/connectors/google/create-reminder', {
          method: 'POST',
          body: JSON.stringify({
            reminder: {
              note: request.note,
              dueTime: request.dueTime,
              syncTarget: 'Google sync if connected'
            }
          })
        });
        const sync = data.sync || {};
        const details = renderDetailLines([
          buildWorkflowLine('call-mom-agent'),
          sync.connectedEmail ? `Calendar: ${sync.connectedEmail}` : '',
          sync.calendarHtmlLink ? `Open event: ${sync.calendarHtmlLink}` : '',
          `Due: ${request.dueTime}`
        ]);
        addAssistantResult(`Created a Google Calendar reminder for "${request.note}".`, details);
      } catch (error) {
        addMessage('assistant', `Calendar setup needs attention: ${error.message}`);
      }
      return true;
    }

    function restoreThread(threadId) {
      $('messages').innerHTML = '';
      const thread = loadThreads().find((row) => row.id === threadId);
      if (!thread) {
        updateHero();
        return;
      }
      for (const row of thread.messages || []) {
        if (row.role === 'user') addMessage('user', row.text, false);
        else addAssistantResult(row.text, row.details || '', false, row.pending);
      }
      updateHero();
    }

    function addMessage(role, text, persist = true) {
      const el = document.createElement('div');
      el.className = `msg ${role}`;
      el.textContent = text;
      $('messages').appendChild(el);
      $('messages').scrollTop = $('messages').scrollHeight;
      updateHero();
      if (role === 'user') rememberLocalMemoryFromUserText(text);
      if (persist) saveChatHistory();
      return el;
    }

    function addAssistantResult(text, detailsText, persist = true, pending = false) {
      const el = document.createElement('div');
      el.className = `msg assistant${pending ? ' pending' : ''}`;

      const body = document.createElement('div');
      body.className = 'msg-body';
      setAssistantBodyContent(body, text);
      el.appendChild(body);

      if (detailsText) {
        const details = document.createElement('details');
        details.className = 'msg-details';
        const summary = document.createElement('summary');
        summary.textContent = 'Details';
        const meta = document.createElement('div');
        meta.textContent = detailsText;
        details.appendChild(summary);
        details.appendChild(meta);
        el.appendChild(details);
      }

      $('messages').appendChild(el);
      $('messages').scrollTop = $('messages').scrollHeight;
      updateHero();
      if (pending) setAssistantPendingState({ el, body }, 'Routing', 'general-chat');
      if (persist) saveChatHistory();
      return { el, body };
    }

    function attachDetails(el, detailsText) {
      if (!detailsText) return null;
      let details = el.querySelector('.msg-details');
      if (!details) {
        details = document.createElement('details');
        details.className = 'msg-details';
        const summary = document.createElement('summary');
        summary.textContent = 'Details';
        const meta = document.createElement('div');
        details.appendChild(summary);
        details.appendChild(meta);
        el.appendChild(details);
      }
      const meta = details.querySelector('div');
      if (meta) meta.textContent = detailsText;
      return details;
    }

    function attachActionCard(target, payload) {
      target.el.classList.add('action-pending');
      let card = target.el.querySelector('.action-card');
      if (!card) {
        card = document.createElement('div');
        card.className = 'action-card';
        target.el.appendChild(card);
      }
      card.dataset.actionRunId = payload.actionRun.id;
      card.innerHTML = `
        <div class="action-label">${payload.actionRun.actionLabel || 'Ready when you are'}</div>
        <div class="action-preview">${payload.actionRun.preview || payload.actionRun.summary || ''}</div>
        ${(payload.actionRun.connectorSpec?.helperAgents || []).length ? `<div class="action-tools">Helper agents: ${payload.actionRun.connectorSpec.helperAgents.join(', ')}</div>` : ''}
        ${(payload.actionRun.privacyNotes || []).length ? `<div class="action-tools">${summarizeActionPrivacy(payload.actionRun.privacyNotes)}</div>` : ''}
        <div class="action-buttons">
	          <button class="action-btn approve" data-action-approve="${payload.actionRun.id}">${payload.actionRun.approveLabel || 'Approve'}</button>
          <button class="action-btn reject" data-action-reject="${payload.actionRun.id}">${payload.actionRun.rejectLabel || 'Reject'}</button>
        </div>
      `;
      saveChatHistory();
      return card;
    }

    function summarizeActionPrivacy(privacyNotes = []) {
      const text = String((privacyNotes || []).join(' ')).toLowerCase();
      if (/address|street/.test(text)) return 'Privacy: Address and identifying metadata remain local only.';
      if (/zip|delivery zone/.test(text)) return 'Privacy: Exact address and identifying metadata remain local only.';
      return 'Privacy: Sensitive local details remain on this device.';
    }

    function openHelperPopup() {
      const popup = $('helperPopup');
      if (!popup) return;
      popup.classList.toggle('open');
      $('threadPopup')?.classList.remove('open');
      $('navMenuPopup')?.classList.remove('open');
      syncComposerLauncherState();
      if (popup.classList.contains('open')) {
        positionHelperPopup();
        ensurePlatformWorkflowRegistryLoaded().catch(() => {});
      }
    }

    function closeHelperPopup() {
      $('helperPopup')?.classList.remove('open');
      syncComposerLauncherState();
    }

    function isNarrowComposerView() {
      return window.matchMedia('(max-width: 760px)').matches;
    }

    function openNavMenu() {
      $('navMenuPopup')?.classList.add('open');
      $('threadPopup')?.classList.remove('open');
      $('helperPopup')?.classList.remove('open');
      syncComposerLauncherState();
    }

    function closeNavMenu() {
      $('navMenuPopup')?.classList.remove('open');
      syncComposerLauncherState();
    }

    function collapseWorkspaceChrome() {
      $('shell')?.classList.remove('sidebar-open');
      closeNavMenu();
      $('threadPopup')?.classList.remove('open');
      $('helperPopup')?.classList.remove('open');
      executionSessionOrder.forEach((sessionId) => {
        executionCollapsedSessions.add(sessionId);
      });
      renderExecutionDock();
      syncComposerLauncherState();
    }

    function isInteractiveUiTarget(target) {
      return Boolean(target?.closest(
        'button, a, input, textarea, select, summary, label, details, [role="button"], .composer, .sidebar, #executionSheet'
      ));
    }

    function positionPopupAboveButton(popupId, toggleId, popupWidth = 280) {
      const popup = $(popupId);
      const toggle = $(toggleId);
      const foot = toggle?.closest('.composer-nav') || toggle?.closest('.composer-foot');
      if (!popup || !toggle || !foot) return;
      const footRect = foot.getBoundingClientRect();
      const toggleRect = toggle.getBoundingClientRect();
      const width = popup.offsetWidth || popupWidth;
      const centeredLeft = (toggleRect.left - footRect.left) + (toggleRect.width / 2) - (width / 2);
      const maxLeft = Math.max(0, footRect.width - width);
      const clampedLeft = Math.max(0, Math.min(centeredLeft, maxLeft));
      popup.style.left = `${Math.round(clampedLeft)}px`;
    }

    function positionHelperPopup() {
      positionPopupAboveButton('helperPopup', isNarrowComposerView() ? 'navMenuToggleBtn' : 'helperToggleBtn', 280);
    }

    function positionThreadPopup() {
      positionPopupAboveButton('threadPopup', isNarrowComposerView() ? 'navMenuToggleBtn' : 'threadToggleBtn', 260);
    }

    function syncComposerLauncherState() {
      $('openSidebarBtn')?.classList.toggle('active', $('shell')?.classList.contains('sidebar-open'));
      $('threadToggleBtn')?.classList.toggle('active', $('threadPopup')?.classList.contains('open'));
      $('helperToggleBtn')?.classList.toggle('active', $('helperPopup')?.classList.contains('open'));
      $('navMenuToggleBtn')?.classList.toggle('active',
        $('navMenuPopup')?.classList.contains('open') ||
        $('threadPopup')?.classList.contains('open') ||
        $('helperPopup')?.classList.contains('open') ||
        $('shell')?.classList.contains('sidebar-open'));
    }

    function syncComposerPlaceholder() {
      const prompt = $('chatPrompt');
      if (!prompt) return;
      prompt.placeholder = window.matchMedia('(max-width: 760px)').matches
        ? 'Ask for agent work'
        : 'Ask for agent work, private inference, or a routed workflow.';
    }

    function setComposerPrompt(value, capability = 'general-chat') {
      $('chatPrompt').value = value;
      $('intentCapability').value = capability;
      $('chatPrompt').dispatchEvent(new Event('input'));
      $('chatPrompt').focus();
    }

    function launchHelper(kind) {
      closeHelperPopup();
      if (kind === 'meeting') {
        setComposerPrompt('Please prepare a meeting workflow. Meeting type: team sync. Workflow target: Google workspace follow-through. Deliverables: Summary + actions.', 'meeting-package-agent');
        void submitIntentFromChat();
        return;
      }
      if (kind === 'job') {
        const role = window.prompt('What role are you targeting?', 'Software Engineer');
        if (role == null) return;
        const location = window.prompt('What location preference should we use?', 'Remote');
        if (location == null) return;
        setComposerPrompt(`Please prepare a job application run. Target role: ${role}. Location: ${location}.`, 'job-application-agent');
        return;
      }
      if (kind === 'food') {
        const zipHint = getVaultSummary()?.zipCode ? ` My local ZIP is ${getVaultSummary().zipCode}.` : '';
        setComposerPrompt(`Please prepare dinner options near me.${zipHint} Budget: around $25-$35.`, 'food-delivery-agent');
        void submitIntentFromChat();
        return;
      }
      if (kind === 'travel') {
        const destination = window.prompt('Where do you want to go?', 'Munich, Germany');
        if (destination == null) return;
        const dates = window.prompt('What timing should we use?', 'May, 2 weeks');
        if (dates == null) return;
        setComposerPrompt(`Please prepare a travel concierge package. Destination: ${destination}. Timing: ${dates}.`, 'travel-agent');
        return;
      }
      if (kind === 'reminder') {
        setComposerPrompt('Please set a reminder: Call mom. Due: tomorrow morning.', 'call-mom-agent');
        void submitIntentFromChat();
        return;
      }
    }

    let activeExecutionSessionId = null;
    let executionPollHandle = null;
    const executionSessionOrder = [];
    const executionSessionCache = new Map();
    const executionCollapsedSessions = new Set();
    const executionDraftCache = new Map();

    function closeExecutionSheet() {
      $('executionSheet').classList.remove('open');
      $('executionDock').innerHTML = '';
      activeExecutionSessionId = null;
      executionSessionOrder.splice(0, executionSessionOrder.length);
      executionSessionCache.clear();
      executionCollapsedSessions.clear();
      executionDraftCache.clear();
      executionPendingSessions.clear();
      if (executionPollHandle) {
        clearInterval(executionPollHandle);
        executionPollHandle = null;
      }
    }

    function removeExecutionPanel(sessionId) {
      const idx = executionSessionOrder.indexOf(sessionId);
      if (idx >= 0) executionSessionOrder.splice(idx, 1);
      executionSessionCache.delete(sessionId);
      executionCollapsedSessions.delete(sessionId);
      executionDraftCache.delete(sessionId);
      executionPendingSessions.delete(sessionId);
      if (activeExecutionSessionId === sessionId) {
        activeExecutionSessionId = executionSessionOrder[executionSessionOrder.length - 1] || null;
      }
      renderExecutionDock();
      if (!executionSessionOrder.length) {
        $('executionSheet').classList.remove('open');
        if (executionPollHandle) {
          clearInterval(executionPollHandle);
          executionPollHandle = null;
        }
      }
    }

    function toggleExecutionPanel(sessionId) {
      if (activeExecutionSessionId !== sessionId) {
        activeExecutionSessionId = sessionId;
        executionCollapsedSessions.delete(sessionId);
      } else if (executionCollapsedSessions.has(sessionId)) {
        executionCollapsedSessions.delete(sessionId);
      } else {
        executionCollapsedSessions.add(sessionId);
      }
      renderExecutionDock();
    }

    function ensureExecutionPolling() {
      const shouldPoll = Array.from(executionPendingSessions).length > 0;
      if (!shouldPoll) {
        if (executionPollHandle) {
          clearInterval(executionPollHandle);
          executionPollHandle = null;
        }
        return;
      }
      if (executionPollHandle) return;
      executionPollHandle = setInterval(() => {
        const pending = Array.from(executionPendingSessions);
        if (!pending.length) {
          clearInterval(executionPollHandle);
          executionPollHandle = null;
          return;
        }
        pending.forEach((sessionId) => {
          renderExecutionSheet(sessionId, { focus: false }).catch(() => {});
        });
      }, 2500);
    }

    function renderExecutionDock() {
      const dock = $('executionDock');
      if (!dock) return;
      if (!executionSessionOrder.length) {
        dock.innerHTML = '';
        $('executionSheet').classList.remove('open');
        return;
      }
      $('executionSheet').classList.add('open');
      dock.innerHTML = executionSessionOrder.slice().reverse().map((sessionId) => {
        const session = executionSessionCache.get(sessionId);
        if (!session) return '';
        const expanded = activeExecutionSessionId === sessionId && !executionCollapsedSessions.has(sessionId);
        const statusValue = String(session.status || 'ready');
        const statusBadge = statusValue === 'queued'
          ? { label: 'In queue', cls: 'queued' }
          : (statusValue === 'claimed' || statusValue === 'executing')
            ? { label: 'In progress', cls: 'running' }
            : statusValue === 'fulfilled'
              ? { label: 'Completed', cls: 'completed' }
              : statusValue === 'failed'
                ? { label: 'Failed', cls: 'failed' }
                : { label: 'Ready', cls: '' };
        const fundingStatus = session.creditReservation?.status === 'locked'
          ? ` · ${describeAlphaWorkflowPrice(session.paymentOrchestration || { requiredCredits: session.creditReservation.requiredCredits })} held`
          : '';
        const title = session.handoffData?.title || session.connectorId || session.id;
        const subtitle = session.handoffData?.subtitle || 'Prepared for a local-first execution flow.';
        const statusLine = `Session ${session.id} · ${session.status || 'ready'} · ${session.completionMode || 'waiting for mode'}${fundingStatus}`;
        const latestStep = [...(Array.isArray(session.executionTrace) ? session.executionTrace : [])].reverse()[0] || null;
        const latestPhase = inferExecutionPhase(latestStep, session.fulfillment);
        const latestSummary = latestStep?.label ? `${latestPhase.label} · ${latestStep.label}` : latestPhase.label;
        return `
          <div class="execution-panel ${expanded ? 'expanded' : 'collapsed'}" data-session-panel="${session.id}">
            <div class="execution-panel-head">
              <div class="execution-panel-head-main">
                <button class="execution-panel-open-target" type="button" data-execution-open="${session.id}" aria-label="Open execution panel">
                  <span class="execution-panel-title">${escapeExecutionValue(title)}</span>
                  <span class="execution-panel-meta">${escapeExecutionValue(statusLine)}${latestSummary ? ` · ${escapeExecutionValue(latestSummary)}` : ''}</span>
                </button>
                ${['queued', 'claimed', 'executing'].includes(statusValue) ? '<div class="execution-activity-bar"></div>' : ''}
              </div>
              <div class="execution-panel-controls">
                <span class="execution-status-badge ${statusBadge.cls}">${escapeExecutionValue(statusBadge.label)}</span>
                <button class="execution-collapse ${expanded ? '' : 'open-label'}" type="button" data-execution-toggle="${session.id}" aria-label="${expanded ? 'Collapse execution panel' : 'Open execution panel'}">${expanded ? '&raquo;' : 'Open'}</button>
                <button class="execution-close" type="button" data-execution-close="${session.id}">Close</button>
              </div>
            </div>
            <div class="execution-panel-body">
              <div class="execution-head">
                <div>
                  <p class="execution-kicker">Magic City Execution</p>
                  <h2 class="execution-title">${escapeExecutionValue(title)}</h2>
                  <p class="execution-subtitle">${escapeExecutionValue(subtitle)}</p>
                </div>
              </div>
              ${expanded ? `
                <div class="execution-stack">
                  <div class="execution-card">
                    <h3>Session</h3>
                    <div class="execution-muted" id="executionStatusText">${escapeExecutionValue(statusLine)}</div>
                  </div>
                  <div class="execution-card">
                    <h3>Execution Contract</h3>
                    <div class="execution-contract-grid" id="executionContractText">${renderExecutionContract(session)}</div>
                  </div>
                  <div class="execution-card">
                    <h3>Context</h3>
                    <div class="execution-grid" id="executionFields">${renderExecutionFields(session)}</div>
                  </div>
                  <div class="execution-card">
                    <h3>Execution Agent</h3>
                    <div class="execution-muted" id="executionAgentText">${escapeExecutionValue(session.preferredExecutionAgentId ? `Recommended execution agent: ${session.preferredExecutionAgentId}` : 'No execution agent selected yet.')}</div>
                  </div>
                  <div class="execution-card">
                    <h3>Result</h3>
                    <div class="execution-muted" id="executionResult">${renderExecutionResult(session)}</div>
                  </div>
                  <div class="execution-card">
                    <h3>Live View</h3>
                    <div class="execution-muted" id="executionLiveView">${renderExecutionLiveView(session)}</div>
                  </div>
                  <div class="execution-card">
                    <h3>Progress</h3>
                    <div class="execution-trace" id="executionTrace">${renderExecutionTrace(session)}</div>
                  </div>
                  <div class="execution-card">
                    <h3>Next Step</h3>
                    <div class="execution-actions" id="executionActions"></div>
                  </div>
                </div>
              ` : ''}
            </div>
          </div>
        `;
      }).join('');

      dock.querySelectorAll('[data-execution-toggle]').forEach((button) => {
        button.addEventListener('click', () => toggleExecutionPanel(button.dataset.executionToggle));
      });
      dock.querySelectorAll('[data-execution-open]').forEach((button) => {
        button.addEventListener('click', () => {
          const sessionId = button.dataset.executionOpen;
          if (!sessionId) return;
          activeExecutionSessionId = sessionId;
          executionCollapsedSessions.delete(sessionId);
          renderExecutionDock();
        });
      });
      dock.querySelectorAll('[data-execution-close]').forEach((button) => {
        button.addEventListener('click', () => removeExecutionPanel(button.dataset.executionClose));
      });
    }

    function escapeExecutionValue(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function safeExecutionPreviewUrl(value) {
      const raw = String(value || '').trim();
      if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return '';
      try {
        const parsed = new URL(raw, window.location.origin);
        if (parsed.username || parsed.password) return '';
        if (parsed.origin === window.location.origin) {
          return parsed.pathname.startsWith('/artifacts/') ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '';
        }
        return parsed.protocol === 'https:' ? parsed.href : '';
      } catch {
        return '';
      }
    }

    function renderExecutionPreviewLink(value, {
      className = '',
      label = '',
      imageAlt = ''
    } = {}) {
      const url = safeExecutionPreviewUrl(value);
      if (!url) return '';
      const anchor = document.createElement('a');
      anchor.className = className;
      anchor.setAttribute('href', url);
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
      if (imageAlt) {
        const image = document.createElement('img');
        image.setAttribute('src', url);
        image.setAttribute('alt', imageAlt);
        anchor.append(image);
      } else {
        anchor.textContent = label;
      }
      return anchor.outerHTML;
    }

    function renderExecutionFields(session) {
      const handoff = session.handoffData || {};
      const choices = handoff.choices || {};
      const defaults = handoff.defaults || {};
      const selected = session.selections || session.finalSelections || {};
      const providerMeta = session.paymentOrchestration || null;
      const googleConnected = Boolean(googleConnectorStatus?.connected);
      const meetingSyncDefault = selected.syncTarget
        || (googleConnected
          ? (defaults.syncTarget || 'Google sync if connected')
          : (defaults.syncTarget && defaults.syncTarget !== 'Google sync if connected' ? defaults.syncTarget : 'Calendar + contact exports'));
      const reminderSyncDefault = selected.syncTarget
        || (googleConnected
          ? (defaults.syncTarget || 'Google sync if connected')
          : (defaults.syncTarget && defaults.syncTarget !== 'Google sync if connected' ? defaults.syncTarget : 'Calendar export only'));
      const hasLocationContext = Boolean(
        session.localPrivateContext?.zipCode ||
        session.localPrivateContext?.streetAddress ||
        session.profileSummary?.zipCode
      );
      const fallbackRestaurants = Array.isArray(choices.restaurants) && choices.restaurants.length
        ? choices.restaurants
        : providerMeta?.restaurantName
          ? [{ name: providerMeta.restaurantName, eta: null, total: providerMeta.subtotalUsd ? `$${Number(providerMeta.subtotalUsd).toFixed(2)}` : null, highlight: 'Magic City pinned catalog' }]
          : [];
      const liveRestaurants = Array.isArray(session.liveDiscovery?.restaurants) && session.liveDiscovery.restaurants.length
        ? session.liveDiscovery.restaurants
        : fallbackRestaurants;
      const usingCatalogFallback = !Array.isArray(session.liveDiscovery?.restaurants) || !session.liveDiscovery.restaurants.length;
      const menusByRestaurant = session.liveDiscovery?.menusByRestaurant || {};
      const selectedRestaurant = selected.restaurant || liveRestaurants[0]?.name || '';
      const menuItems = menusByRestaurant[selectedRestaurant] || choices.menuItems || [];
      const vault = getUnlockedVaultPayload();
      if (handoff.kind === 'food') {
        return `
          <div class="execution-field">
            <label>Restaurant</label>
            <select id="executionRestaurant">
              ${liveRestaurants.length ? liveRestaurants.map((option) => {
                const label = [option.name, option.eta, option.total, option.highlight].filter(Boolean).join(' · ');
                const isSelected = (selected.restaurant || '') === option.name || (!selected.restaurant && option.name === (liveRestaurants[0]?.name || ''));
                return `<option value="${escapeExecutionValue(option.name)}" ${isSelected ? 'selected' : ''}>${escapeExecutionValue(label)}</option>`;
              }).join('') : `<option value="">${escapeExecutionValue('Select a restaurant')}</option>`}
            </select>
            <small>${session.liveDiscovery?.notes || (usingCatalogFallback ? 'Showing the pinned Magic City catalog first so this lane stays usable while live discovery catches up.' : 'Use live local discovery to replace placeholder options with provider results for your ZIP and address.')}${providerMeta?.restaurantName ? `<br />Execution target: ${providerMeta.restaurantName} via ${providerMeta.providerLabel || 'live provider'}${providerMeta.policies?.length ? ` · ${providerMeta.policies.join(' / ')}` : ''}` : ''}</small>
          </div>
          <div class="execution-field">
            <label>Cart note</label>
            <input id="executionCartNote" value="${escapeExecutionValue(selected.cartNote || defaults.cartNote || '')}" />
            <small>This is context-driven from the chat, but you can edit it before the agent executes.</small>
          </div>
          <div class="execution-field">
            <label>Primary item</label>
            ${session.liveDiscovery?.source === 'openstreetmap' ? `
            <input id="executionItem1" value="${escapeExecutionValue(selected.item1 || defaults.item1 || '')}" placeholder="Enter the menu item you want" />
            <small>Real menu scraping is the next provider-specific step. For now, tell the execution agent exactly what to put in the cart.</small>
            ` : `<select id="executionItem1">
              ${menuItems.length ? '' : '<option value="">Select an item</option>'}
              ${menuItems.map((item) => `<option value="${item.name}" ${((selected.item1 || defaults.item1 || '') === item.name) ? 'selected' : ''}>${item.name} · ${item.price}</option>`).join('')}
            </select>`}
          </div>
          <div class="execution-field">
            <label>Qty</label>
            <select id="executionItem1Qty">
              ${['1','2','3','4'].map((value) => `<option value="${value}" ${((selected.item1Qty || defaults.item1Qty || '1') === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Second item</label>
            ${session.liveDiscovery?.source === 'openstreetmap' ? `
            <input id="executionItem2" value="${escapeExecutionValue(selected.item2 || defaults.item2 || '')}" placeholder="Optional second item" />
            ` : `<select id="executionItem2">
              <option value="">None</option>
              ${menuItems.map((item) => `<option value="${item.name}" ${((selected.item2 || defaults.item2 || '') === item.name) ? 'selected' : ''}>${item.name} · ${item.price}</option>`).join('')}
            </select>`}
          </div>
          <div class="execution-field">
            <label>Qty</label>
            <select id="executionItem2Qty">
              ${['1','2','3','4'].map((value) => `<option value="${value}" ${((selected.item2Qty || defaults.item2Qty || '1') === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Order mode</label>
            <select id="executionDeliveryMode">
              ${(choices.deliveryModes || []).map((value) => `<option value="${value}" ${((selected.deliveryMode || defaults.deliveryMode || 'Delivery') === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Party size</label>
            <input id="executionPartySize" value="${escapeExecutionValue(selected.partySize || defaults.partySize || session.localContext?.partySize || '2 people')}" />
          </div>
          <div class="execution-field">
            <label>Budget</label>
            <select id="executionBudgetHint">
              ${(choices.budgetHints || []).map((value) => `<option value="${value}" ${((selected.budgetHint || defaults.budgetHint || '') === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>${escapeExecutionValue((selected.deliveryMode || defaults.deliveryMode || 'Delivery') === 'Reservation' ? 'Reservation window' : 'Timing')}</label>
            <select id="executionTimingHint">
              ${(choices.timingHints || []).map((value) => `<option value="${value}" ${((selected.timingHint || defaults.timingHint || '') === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Reservation date or note</label>
            <input id="executionReservationWindow" value="${escapeExecutionValue(selected.reservationWindow || '')}" placeholder="Friday 7:30 PM" />
          </div>
          <div class="execution-field">
            <label>Exact delivery address (local only)</label>
            <input id="executionStreetAddress" value="${escapeExecutionValue(session.localPrivateContext?.streetAddress || vault.streetAddress || '')}" placeholder="kept local until execution time" />
            <small>This field stays out of the model and proof payloads, but the local execution agent can use it.</small>
          </div>
          <div class="execution-field">
            <label>ZIP code (local only)</label>
            <input id="executionZipCode" value="${escapeExecutionValue(session.localPrivateContext?.zipCode || '94107')}" placeholder="94107" />
          </div>
          <div class="execution-field">
            <label>Delivery notes (local only)</label>
            <input id="executionDeliveryNotes" value="${escapeExecutionValue(session.localPrivateContext?.deliveryNotes || vault.deliveryNotes || '')}" placeholder="Gate code, apartment, etc." />
          </div>
          <div class="execution-field">
            <label>Contact phone (local only)</label>
            <input id="executionContactPhone" value="${escapeExecutionValue(session.localPrivateContext?.contactPhone || vault.contactPhone || '')}" placeholder="Used only if you open a live Square checkout" />
          </div>
          <div class="execution-field">
            <label>Checkout mode</label>
            <input value="Magic City checkout (credits)" disabled />
            <input id="executionFundingMode" type="hidden" value="${escapeExecutionValue((selected.paymentFundingMode || providerMeta?.fundingMode || 'magic_city_credits') === 'direct_square' ? 'direct_square' : 'magic_city_credits')}" />
            <small>${escapeExecutionValue(describeExecutionFundingDetail(providerMeta))}</small>
          </div>
          <details class="execution-advanced-payment" ${(selected.paymentFundingMode || providerMeta?.fundingMode || 'magic_city_credits') === 'direct_square' ? 'open' : ''}>
            <summary>Direct merchant fallback</summary>
            <div class="execution-advanced-payment-body">
              <div class="execution-field">
                <label>Fallback rail</label>
                <select id="executionFundingModeOverride">
                  <option value="magic_city_credits" ${((selected.paymentFundingMode || providerMeta?.fundingMode || 'magic_city_credits') === 'magic_city_credits') ? 'selected' : ''}>Keep Magic City checkout</option>
                  <option value="direct_square" ${((selected.paymentFundingMode || providerMeta?.fundingMode || '') === 'direct_square') ? 'selected' : ''}>Switch to direct merchant checkout</option>
                </select>
                <small>Only use this if you want to pay the merchant directly instead of spending Magic City credits.</small>
              </div>
              <div class="execution-field">
                <label>Square mode</label>
                <select id="executionSquareEnvironment">
                  <option value="sandbox" ${((selected.squareEnvironment || providerMeta?.squareEnvironment || 'sandbox') === 'sandbox') ? 'selected' : ''}>Sandbox</option>
                  <option value="live" ${((selected.squareEnvironment || providerMeta?.squareEnvironment || '') === 'live') ? 'selected' : ''}>Live</option>
                </select>
                <small>Only used if you switch to direct merchant checkout.</small>
              </div>
              <div class="execution-field">
                <label>Payment method note (local only)</label>
                <input id="executionPaymentLabel" placeholder="Use browser autofill or a saved Magic City / Square payment source" />
                ${providerMeta ? `<small>${providerMeta.fundingMode === 'direct_square' ? 'Square stays available as the merchant fallback rail.' : session.merchantSettlement?.status ? `Merchant settlement ledger: ${String(session.merchantSettlement.status).replace(/_/g, ' ')}.` : 'Magic City checkout stays primary. Stripe handles top-ups, and Square only appears if the merchant rail truly needs it.'}</small>` : '<small>Magic City checkout stays primary. Stripe handles top-ups, and Square only appears if the merchant rail truly needs it.</small>'}
              </div>
            </div>
          </details>
        `;
      }
      if (handoff.kind === 'travel') {
        return `
          <div class="execution-field">
            <label>Destination</label>
            <input id="executionDestination" value="${escapeExecutionValue(selected.destination || defaults.destination || '')}" />
          </div>
          <div class="execution-field">
            <label>Trip goal</label>
            <input id="executionTripGoal" value="${escapeExecutionValue(selected.tripGoal || defaults.tripGoal || '')}" />
          </div>
          <div class="execution-field">
            <label>Flight option</label>
            <select id="executionFlight">
              ${(choices.flights || []).map((option) => `<option value="${option.label}" ${((selected.flight || defaults.flight || '') === option.label) ? 'selected' : ''}>${option.label} · ${option.price}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Stay option</label>
            <select id="executionStay">
              ${(choices.stays || []).map((option) => `<option value="${option.label}" ${((selected.stay || defaults.stay || '') === option.label) ? 'selected' : ''}>${option.label} · ${option.price}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Nights</label>
            <select id="executionNights">
              ${(choices.nights || []).map((value) => `<option value="${value}" ${((selected.nights || defaults.nights || '') === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Home airport (local only)</label>
            <input id="executionHomeAirport" value="${escapeExecutionValue(session.localPrivateContext?.homeAirport || vault.homeAirport || '')}" />
          </div>
          <div class="execution-field">
            <label>Travel window (local only)</label>
            <input id="executionTravelWindow" value="${escapeExecutionValue(session.localPrivateContext?.travelWindow || vault.travelWindow || '')}" />
          </div>
          <div class="execution-field">
            <label>Departure date (local only)</label>
            <input id="executionDepartureDate" type="date" value="${escapeExecutionValue(session.localPrivateContext?.departureDate || '')}" />
          </div>
          <div class="execution-field">
            <label>Return date (local only)</label>
            <input id="executionReturnDate" type="date" value="${escapeExecutionValue(session.localPrivateContext?.returnDate || '')}" />
          </div>
          <div class="execution-field">
            <label>Magic City checkout</label>
            <input value="${escapeExecutionValue(providerMeta ? `${describeExecutionFundingInput(providerMeta, 'Travel concierge pricing loads here')} for itinerary concierge` : 'Travel concierge pricing loads here')}" disabled />
            <small>${escapeExecutionValue(providerMeta ? `Magic City service: ${describeAlphaWorkflowPrice(providerMeta)}. Estimated external travel spend: ${formatUsd(providerMeta.estimatedTripUsd || 0)}. Flights and hotel are still booked on live provider pages after review.` : 'Magic City will show the itinerary concierge service price here. Flights and hotel are still booked on live provider pages later.')}</small>
          </div>
          <div class="execution-field execution-span">
            <label>What this does</label>
            <input value="No email or secure payment link is generated here. Magic City will only show a real Stripe checkout or live provider booking link when one actually exists." disabled />
          </div>
        `;
      }
      if (handoff.kind === 'spreadsheet') {
        const providerMeta = session.paymentOrchestration || null;
        return `
          <div class="execution-field">
            <label>Raw sheet or CSV/TSV</label>
            <input id="executionSpreadsheetFile" type="file" accept=".csv,.tsv,.txt,.json,.xlsx,.xls,text/csv,text/tab-separated-values,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" />
            <textarea id="executionSpreadsheetRaw" rows="10" placeholder="Paste the spreadsheet here. Header row first, then data rows.">${escapeExecutionValue(session.localPrivateContext?.rawData || '')}</textarea>
            <small id="executionSpreadsheetFileStatus">Upload CSV, TSV, TXT, JSON, XLSX, or XLS locally. The raw workbook stays behind the local-private boundary until execution starts.</small>
          </div>
          <div class="execution-field">
            <label>Cleanup goals</label>
            <input id="executionSpreadsheetGoals" value="${escapeExecutionValue(selected.cleanupGoals || defaults.cleanupGoals || '')}" />
          </div>
          <div class="execution-field">
            <label>Service tier</label>
            <select id="executionSpreadsheetTier">
              ${(choices.serviceTiers || []).map((value) => `<option value="${value}" ${((selected.serviceTier || defaults.serviceTier || '') === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Row count band</label>
            <select id="executionSpreadsheetRows">
              ${(choices.rowCountBands || []).map((value) => `<option value="${value}" ${((selected.rowCountBand || defaults.rowCountBand || '') === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Output format</label>
            <select id="executionSpreadsheetFormat">
              ${(choices.outputFormats || []).map((value) => `<option value="${value}" ${((selected.outputFormat || defaults.outputFormat || '').toLowerCase() === String(value).toLowerCase()) ? 'selected' : ''}>${String(value).toUpperCase()}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Checkout mode</label>
            <select id="executionSpreadsheetFundingMode">
              ${(choices.paymentModes || ['free_preview', 'magic_city_credits']).map((value) => {
                const label = value === 'magic_city_credits' ? 'Use Magic City credits' : 'Free preview';
                return `<option value="${value}" ${((selected.paymentFundingMode || defaults.paymentFundingMode || 'free_preview') === value ? 'selected' : '')}>${escapeExecutionValue(label)}</option>`;
              }).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Sensitive columns (local only)</label>
            <input id="executionSpreadsheetSensitive" value="${escapeExecutionValue(session.localPrivateContext?.sensitiveColumns || '')}" placeholder="email, phone, address" />
            <small>These stay local and are excluded from shared summaries or proofs.</small>
          </div>
          <div class="execution-field">
            <label>Funding</label>
            <input value="${escapeExecutionValue(describeExecutionFundingInput(providerMeta, 'Calculated from tier and row count'))}" disabled />
            <small>${escapeExecutionValue(providerMeta?.fundingMode === 'free_preview' ? 'Preview the cleaned export first. Upgrade later only if you want the full export.' : providerMeta ? describeExecutionFundingDetail(providerMeta, 'Magic City reserves credits before the cleanup agent runs.') : 'Magic City reserves credits before the cleanup agent runs.')}</small>
          </div>
        `;
      }
      if (handoff.kind === 'meeting') {
        const providerMeta = session.paymentOrchestration || null;
        return `
          <div class="execution-field">
            <label>Transcript or notes</label>
            <input id="executionMeetingUpload" type="file" accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf" />
            <textarea id="executionMeetingTranscript" rows="10" placeholder="Paste the meeting transcript or notes.">${escapeExecutionValue(session.localPrivateContext?.transcript || '')}</textarea>
            <small id="executionMeetingStatus">Upload TXT, Markdown, or PDF locally. The raw transcript stays behind the local-private boundary until execution starts.</small>
          </div>
          <div class="execution-field">
            <label>Meeting type</label>
            <select id="executionMeetingType">
              ${(choices.meetingTypes || []).map((value) => `<option value="${value}" ${((selected.meetingType || defaults.meetingType || '') === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Meeting length</label>
            <select id="executionMeetingLength">
              ${(choices.lengthBands || []).map((value) => `<option value="${value}" ${((selected.lengthBand || defaults.lengthBand || '') === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Sync output</label>
            <select id="executionMeetingSyncTarget">
              ${(choices.syncTargets || ['Artifacts only', 'Google sync if connected', 'Calendar + contact exports']).map((value) => `<option value="${value}" ${(meetingSyncDefault === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
            <small>${googleConnected ? `Google is connected as ${escapeExecutionValue(googleConnectorStatus?.email || authSessionUser?.email || 'your account')}. Magic City can write the follow-up event, contacts, and email follow-up directly when Gmail send is enabled.` : 'Choose whether Magic City should keep this as private artifacts only, use the connected Google account for live follow-through, or include local calendar/contact exports.'}</small>
          </div>
          <div class="execution-field">
            <label>Output package</label>
            <select id="executionMeetingPackage">
              ${(choices.outputPackages || []).map((value) => `<option value="${value}" ${((selected.outputPackage || defaults.outputPackage || '') === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Checkout mode</label>
            <select id="executionMeetingFundingMode">
              ${(choices.paymentModes || ['free_preview', 'magic_city_credits']).map((value) => {
                const label = value === 'magic_city_credits' ? 'Use Magic City credits' : 'Free preview';
                return `<option value="${value}" ${((selected.paymentFundingMode || defaults.paymentFundingMode || 'free_preview') === value ? 'selected' : '')}>${escapeExecutionValue(label)}</option>`;
              }).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Audience</label>
            <select id="executionMeetingAudience">
              ${(choices.audiences || []).map((value) => `<option value="${value}" ${((selected.audience || defaults.audience || '') === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Urgency</label>
            <select id="executionMeetingUrgency">
              ${(choices.urgencies || []).map((value) => `<option value="${value}" ${((selected.urgency || defaults.urgency || '') === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Participant emails (local only)</label>
            <input id="executionMeetingParticipants" value="${escapeExecutionValue(session.localPrivateContext?.participantEmails || '')}" placeholder="alice@example.com, bob@example.com" />
            <small>Participant addresses stay local unless you explicitly hand off a follow-up bridge later.</small>
          </div>
          <div class="execution-field">
            <label>Funding</label>
            <input value="${escapeExecutionValue(describeExecutionFundingInput(providerMeta, 'Calculated from package and meeting length'))}" disabled />
            <small>${escapeExecutionValue(providerMeta?.fundingMode === 'free_preview' ? 'Preview the summary and action package first. Upgrade later if you want sync and follow-through.' : providerMeta ? describeExecutionFundingDetail(providerMeta, 'Magic City reserves credits before the meeting agent runs.') : 'Magic City reserves credits before the meeting agent runs.')}</small>
          </div>
        `;
      }
      if (handoff.kind === 'job') {
        const providerMeta = session.paymentOrchestration || null;
        return `
          <div class="execution-field execution-span">
            <label>Resume upload (local only)</label>
            <input id="executionResumeUpload" type="file" accept=".pdf,.txt,.md,text/plain,application/pdf,text/markdown" />
            <textarea id="executionResumeText" rows="10" placeholder="Paste your resume text if you do not want to upload a file.">${escapeExecutionValue(session.localPrivateContext?.resumeText || '')}</textarea>
            <input id="executionResumeFileName" type="hidden" value="${escapeExecutionValue(session.localPrivateContext?.resumeFileName || '')}" />
            <small id="executionResumeStatus">Upload a PDF, TXT, or Markdown resume locally. Raw resume text stays behind the local-private boundary until execution starts.</small>
          </div>
          <div class="execution-field">
            <label>Target role</label>
            <input id="executionJobRole" value="${escapeExecutionValue(selected.targetRole || defaults.targetRole || '')}" />
          </div>
          <div class="execution-field">
            <label>Location preference</label>
            <input id="executionJobLocation" value="${escapeExecutionValue(selected.locationPreference || defaults.locationPreference || '')}" />
          </div>
          <div class="execution-field execution-span">
            <label>Company targets</label>
            <input id="executionJobCompanies" value="${escapeExecutionValue(selected.companyTargets || defaults.companyTargets || '')}" placeholder="Optional company list" />
          </div>
          <div class="execution-field execution-span">
            <label>Job boards</label>
            <input id="executionJobBoards" value="${escapeExecutionValue(selected.jobBoards || defaults.jobBoards || 'linkedin, greenhouse, lever')}" placeholder="linkedin, greenhouse, lever" />
            <small>Magic City turns this into provider-specific search and application targets.</small>
          </div>
          <div class="execution-field">
            <label>Application limit</label>
            <select id="executionJobLimit">
              ${(choices.applicationLimits || ['1', '3', '5', '10']).map((value) => `<option value="${value}" ${((selected.applicationLimit || defaults.applicationLimit || '3') === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Submission mode</label>
            <select id="executionJobSubmissionMode">
              ${(choices.submissionModes || ['review_before_submit', 'auto_submit_simple_forms']).map((value) => {
                const label = value === 'auto_submit_simple_forms' ? 'Auto submit simple forms' : 'Final review before submit';
                return `<option value="${value}" ${((selected.submissionMode || defaults.submissionMode || 'review_before_submit') === value) ? 'selected' : ''}>${escapeExecutionValue(label)}</option>`;
              }).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Funding</label>
            <select id="executionJobFundingMode">
              ${(choices.paymentModes || ['free_preview', 'magic_city_credits']).map((value) => {
                const label = value === 'magic_city_credits' ? 'Use Magic City credits' : 'Free preview';
                return `<option value="${value}" ${((selected.paymentFundingMode || defaults.paymentFundingMode || 'free_preview') === value) ? 'selected' : ''}>${escapeExecutionValue(label)}</option>`;
              }).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Applicant name (local only)</label>
            <input id="executionApplicantName" value="${escapeExecutionValue(session.localPrivateContext?.applicantName || '')}" />
          </div>
          <div class="execution-field">
            <label>Applicant email (local only)</label>
            <input id="executionApplicantEmail" value="${escapeExecutionValue(session.localPrivateContext?.applicantEmail || '')}" />
          </div>
          <div class="execution-field">
            <label>Applicant phone (local only)</label>
            <input id="executionApplicantPhone" value="${escapeExecutionValue(session.localPrivateContext?.applicantPhone || '')}" />
          </div>
          <div class="execution-field">
            <label>LinkedIn URL (local only)</label>
            <input id="executionApplicantLinkedIn" value="${escapeExecutionValue(session.localPrivateContext?.linkedinUrl || '')}" />
          </div>
          <div class="execution-field">
            <label>Portfolio / GitHub (local only)</label>
            <input id="executionApplicantPortfolio" value="${escapeExecutionValue(session.localPrivateContext?.portfolioUrl || '')}" />
          </div>
          <div class="execution-field execution-span">
            <label>Cover letter notes (local only)</label>
            <textarea id="executionCoverLetterNotes" rows="4" placeholder="Short, truthful notes for short cover letter fields.">${escapeExecutionValue(session.localPrivateContext?.coverLetterNotes || '')}</textarea>
          </div>
          <div class="execution-field">
            <label>Funding summary</label>
            <input value="${escapeExecutionValue(providerMeta?.requiredCredits ? describeExecutionFundingInput(providerMeta, 'Free preview') : 'Free preview')}" disabled />
            <small>${escapeExecutionValue(providerMeta?.requiredCredits ? describeExecutionFundingDetail(providerMeta, 'Free preview keeps this review-first and does not lock credits.') : 'Free preview keeps this review-first and does not lock credits.')}</small>
          </div>
        `;
      }
      if (handoff.kind === 'reminder') {
        const providerMeta = session.paymentOrchestration || null;
        return `
          <div class="execution-field">
            <label>Reminder note</label>
            <input id="executionReminderNote" value="${escapeExecutionValue(selected.note || defaults.note || '')}" />
          </div>
          <div class="execution-field">
            <label>Due time</label>
            <select id="executionDueTime">
              ${(choices.dueTimes || []).map((value) => `<option value="${value}" ${((selected.dueTime || defaults.dueTime || '') === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field">
            <label>Sync output</label>
            <select id="executionReminderSyncTarget">
              ${(choices.syncTargets || ['Artifacts only', 'Google sync if connected', 'Calendar export only']).map((value) => `<option value="${value}" ${(reminderSyncDefault === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
            <small>${googleConnected ? `Google is connected as ${escapeExecutionValue(googleConnectorStatus?.email || authSessionUser?.email || 'your account')}. Magic City can create the reminder event there and send follow-up email directly when enabled.` : 'Keep this as artifacts only, or use Google sync once a connected account is available.'}</small>
          </div>
          <div class="execution-field">
            <label>Contact name (local only)</label>
            <input id="executionReminderContactName" value="${escapeExecutionValue(session.localPrivateContext?.contactName || vault.contactName || '')}" />
          </div>
          <div class="execution-field">
            <label>Contact email (local only)</label>
            <input id="executionReminderContactEmail" value="${escapeExecutionValue(session.localPrivateContext?.contactEmail || '')}" placeholder="Optional for Google contact or direct email send" />
          </div>
          <div class="execution-field">
            <label>Contact phone (local only)</label>
            <input id="executionContactPhone" value="${escapeExecutionValue(session.localPrivateContext?.contactPhone || vault.contactPhone || '')}" />
          </div>
          <div class="execution-field execution-span">
            <label>Funding</label>
            <input value="${escapeExecutionValue(describeExecutionFundingInput(providerMeta, '10 credits'))}" disabled />
            <small>${escapeExecutionValue(providerMeta ? describeExecutionFundingDetail(providerMeta, 'Magic City service price: 10 credits.') : 'Magic City service price: 10 credits.')}</small>
          </div>
        `;
      }
      if (handoff.kind === 'developer') {
        const githubConnected = Boolean(githubConnectorStatus?.connected);
        const githubPolicy = githubConnectorStatus?.policy || {};
        const repoAllowlist = Array.isArray(githubPolicy.repoAllowlist) ? githubPolicy.repoAllowlist : [];
        const repoSummary = repoAllowlist.length ? repoAllowlist.join(' · ') : 'No allowlisted repos yet';
        const providerMeta = session.paymentOrchestration || null;
        return `
          <div class="execution-field">
            <label>Execution mode</label>
            <select id="executionDeveloperMode">
              ${(choices.executionModes || ['review_only', 'draft_patch', 'draft_pr']).map((value) => {
                const label = value === 'draft_pr' ? 'Draft PR package' : value === 'draft_patch' ? 'Patch package' : 'Package only';
                return `<option value="${value}" ${((selected.executionMode || defaults.executionMode || 'review_only') === value) ? 'selected' : ''}>${escapeExecutionValue(label)}</option>`;
              }).join('')}
            </select>
          </div>
          <div class="execution-field execution-span">
            <label>Repo (owner/repo)</label>
            <input id="executionDeveloperRepo" value="${escapeExecutionValue(selected.repoFullName || defaults.repoFullName || '')}" placeholder="owner/repo" />
            <small>${githubConnected ? `GitHub is connected as ${escapeExecutionValue(githubConnectorStatus?.login || githubConnectorStatus?.email || authSessionUser?.email || 'your account')} · allowlisted: ${escapeExecutionValue(repoSummary)}` : 'Connect GitHub in Settings to scope repo execution and use the repo allowlist safely.'}</small>
          </div>
          <div class="execution-field execution-span">
            <label>Issue or PR URL</label>
            <input id="executionDeveloperIssueUrl" value="${escapeExecutionValue(selected.issueOrPrUrl || defaults.issueOrPrUrl || '')}" placeholder="https://github.com/owner/repo/issues/123" />
          </div>
          <div class="execution-field">
            <label>Base branch</label>
            <input id="executionDeveloperBaseBranch" value="${escapeExecutionValue(selected.baseBranch || defaults.baseBranch || 'main')}" />
          </div>
          <div class="execution-field">
            <label>Branch prefix</label>
            <input id="executionDeveloperBranchPrefix" value="${escapeExecutionValue(selected.branchPrefix || defaults.branchPrefix || githubPolicy.branchPrefix || 'magic-city/')}" />
          </div>
          <div class="execution-field">
            <label>Objective</label>
            <select id="executionObjective">
              ${(choices.objectives || []).map((value) => `<option value="${value}" ${((selected.objective || defaults.objective || '') === value) ? 'selected' : ''}>${value}</option>`).join('')}
            </select>
          </div>
          <div class="execution-field execution-span">
            <label>Implementation request</label>
            <input id="executionWorkbenchNote" value="${escapeExecutionValue(selected.note || defaults.note || '')}" placeholder="What should the patch or PR actually accomplish?" />
          </div>
          <div class="execution-field execution-span">
            <label>Funding</label>
            <input value="${escapeExecutionValue(describeExecutionFundingInput(providerMeta, '10 credits'))}" disabled />
            <small>${escapeExecutionValue(providerMeta ? describeExecutionFundingDetail(providerMeta, 'Magic City service price: 10 credits.') : 'Magic City service price: 10 credits.')}</small>
          </div>
        `;
      }
      return '<div class="execution-muted">No editable execution fields for this lane yet.</div>';
    }

    function collectExecutionSelections(session) {
      const kind = session?.handoffData?.kind;
      if (kind === 'food') {
        const fundingMode = $('executionFundingModeOverride')?.value || $('executionFundingMode')?.value || 'magic_city_credits';
        return {
          restaurant: $('executionRestaurant')?.value || '',
          cartNote: $('executionCartNote')?.value.trim() || '',
          item1: $('executionItem1')?.value || '',
          item1Qty: $('executionItem1Qty')?.value || '1',
          item2: $('executionItem2')?.value || '',
          item2Qty: $('executionItem2Qty')?.value || '1',
          deliveryMode: $('executionDeliveryMode')?.value || 'Delivery',
          partySize: $('executionPartySize')?.value.trim() || '',
          budgetHint: $('executionBudgetHint')?.value || '',
          timingHint: $('executionTimingHint')?.value || '',
          reservationWindow: $('executionReservationWindow')?.value.trim() || '',
          paymentFundingMode: fundingMode,
          squareEnvironment: $('executionSquareEnvironment')?.value || 'sandbox'
        };
      }
      if (kind === 'travel') {
        return {
          destination: $('executionDestination')?.value.trim() || '',
          tripGoal: $('executionTripGoal')?.value.trim() || '',
          flight: $('executionFlight')?.value || '',
          stay: $('executionStay')?.value || '',
          nights: $('executionNights')?.value || '',
          paymentFundingMode: 'magic_city_credits'
        };
      }
      if (kind === 'spreadsheet') {
        return {
          cleanupGoals: $('executionSpreadsheetGoals')?.value.trim() || '',
          serviceTier: $('executionSpreadsheetTier')?.value || '',
          rowCountBand: $('executionSpreadsheetRows')?.value || '',
          outputFormat: $('executionSpreadsheetFormat')?.value || '',
          paymentFundingMode: $('executionSpreadsheetFundingMode')?.value || 'free_preview'
        };
      }
      if (kind === 'meeting') {
        return {
          meetingType: $('executionMeetingType')?.value || '',
          lengthBand: $('executionMeetingLength')?.value || '',
          syncTarget: $('executionMeetingSyncTarget')?.value || '',
          outputPackage: $('executionMeetingPackage')?.value || '',
          audience: $('executionMeetingAudience')?.value || '',
          urgency: $('executionMeetingUrgency')?.value || '',
          paymentFundingMode: $('executionMeetingFundingMode')?.value || 'free_preview'
        };
      }
      if (kind === 'job') {
        return {
          targetRole: $('executionJobRole')?.value.trim() || '',
          locationPreference: $('executionJobLocation')?.value.trim() || '',
          companyTargets: $('executionJobCompanies')?.value.trim() || '',
          jobBoards: $('executionJobBoards')?.value.trim() || '',
          applicationLimit: $('executionJobLimit')?.value || '3',
          submissionMode: $('executionJobSubmissionMode')?.value || 'review_before_submit',
          paymentFundingMode: $('executionJobFundingMode')?.value || 'free_preview'
        };
      }
      if (kind === 'reminder') {
        return {
          note: $('executionReminderNote')?.value.trim() || '',
          dueTime: $('executionDueTime')?.value || '',
          syncTarget: $('executionReminderSyncTarget')?.value || '',
          paymentFundingMode: 'magic_city_credits'
        };
      }
      if (kind === 'developer') {
        return {
          paymentFundingMode: 'magic_city_credits'
        };
      }
      return {};
    }

    function collectExecutionPrivateInputs(session) {
      const kind = session?.handoffData?.kind;
      if (kind === 'food') {
        return {
          zipCode: $('executionZipCode')?.value.trim() || '',
          streetAddress: $('executionStreetAddress')?.value.trim() || '',
          deliveryNotes: $('executionDeliveryNotes')?.value.trim() || '',
          paymentLabel: $('executionPaymentLabel')?.value.trim() || '',
          contactPhone: $('executionContactPhone')?.value.trim() || ''
        };
      }
      if (kind === 'travel') {
        return {
          homeAirport: $('executionHomeAirport')?.value.trim() || '',
          travelWindow: $('executionTravelWindow')?.value.trim() || '',
          departureDate: $('executionDepartureDate')?.value || '',
          returnDate: $('executionReturnDate')?.value || ''
        };
      }
      if (kind === 'spreadsheet') {
        return {
          rawData: $('executionSpreadsheetRaw')?.value || '',
          sensitiveColumns: $('executionSpreadsheetSensitive')?.value.trim() || ''
        };
      }
      if (kind === 'meeting') {
        return {
          transcript: $('executionMeetingTranscript')?.value || '',
          participantEmails: $('executionMeetingParticipants')?.value.trim() || ''
        };
      }
      if (kind === 'job') {
        return {
          resumeText: $('executionResumeText')?.value || '',
          resumeFileName: $('executionResumeFileName')?.value || '',
          applicantName: $('executionApplicantName')?.value.trim() || '',
          applicantEmail: $('executionApplicantEmail')?.value.trim() || '',
          applicantPhone: $('executionApplicantPhone')?.value.trim() || '',
          linkedinUrl: $('executionApplicantLinkedIn')?.value.trim() || '',
          portfolioUrl: $('executionApplicantPortfolio')?.value.trim() || '',
          coverLetterNotes: $('executionCoverLetterNotes')?.value.trim() || ''
        };
      }
      if (kind === 'reminder') {
        return {
          contactName: $('executionReminderContactName')?.value.trim() || '',
          contactEmail: $('executionReminderContactEmail')?.value.trim() || '',
          contactPhone: $('executionContactPhone')?.value.trim() || ''
        };
      }
      return {};
    }

    function snapshotExecutionDraft(session) {
      if (!session?.id) return null;
      const draft = {
        selections: collectExecutionSelections(session),
        localPrivateInputs: collectExecutionPrivateInputs(session)
      };
      executionDraftCache.set(session.id, draft);
      return draft;
    }

    function getExecutionDraft(sessionId) {
      return executionDraftCache.get(sessionId) || null;
    }

    function clearExecutionDraft(sessionId) {
      executionDraftCache.delete(sessionId);
    }

    function renderExecutionContract(session) {
      const taskPackage = session.fulfillment?.result?.taskPackage || session.taskPackage || {};
      const funding = taskPackage.funding || {};
      const preferredTarget = taskPackage.preferredTarget || (Array.isArray(taskPackage.targets) ? taskPackage.targets[0] : null);
      const result = session.fulfillment?.result || {};
      const squareState = session.squareState || {};
      const localSummary = taskPackage.localPrivateSummary || session.localPrivateSummary || {};
      const boundaryBits = [];
      if (localSummary.zipCode) boundaryBits.push(`ZIP ${localSummary.zipCode}`);
      if (localSummary.addressReady) boundaryBits.push('exact address available locally');
      if (localSummary.homeAirport) boundaryBits.push(`home airport ${localSummary.homeAirport}`);
      if (localSummary.travelWindow) boundaryBits.push(`travel window ${localSummary.travelWindow}`);
      if (localSummary.departureDate) boundaryBits.push(`departure ${localSummary.departureDate}`);
      if (localSummary.returnDate) boundaryBits.push(`return ${localSummary.returnDate}`);
      if (localSummary.contactPhone) boundaryBits.push('contact phone available locally');
      if (localSummary.sensitiveColumnsReady) boundaryBits.push('sensitive columns marked local-only');
      if (localSummary.participantEmailsReady) boundaryBits.push('participant emails available locally');
      if (localSummary.rawDataReady) boundaryBits.push('raw sheet available locally');
      if (localSummary.transcriptReady) boundaryBits.push('raw transcript available locally');
      if (localSummary.resumeReady) boundaryBits.push('resume ready locally');
      if (localSummary.applicantEmailReady) boundaryBits.push('applicant email ready locally');
      if (localSummary.applicantPhoneReady) boundaryBits.push('applicant phone ready locally');
      const rows = [
        {
          label: 'Task',
          value: [
            taskPackage.title || session.handoffData?.title || session.connectorId || 'Execution session',
            taskPackage.kind ? `kind: ${taskPackage.kind}` : '',
            taskPackage.status ? `status: ${taskPackage.status}` : ''
          ].filter(Boolean).join(' · ')
        },
        {
          label: 'Preferred target',
          value: preferredTarget
            ? `${preferredTarget.label || 'Execution target'} · ${preferredTarget.provider || 'provider'}`
            : 'Magic City will resolve the best available execution target for this task.'
        },
        {
          label: 'Funding',
          value: describeExecutionContractFunding(funding, squareState)
        },
        {
          label: 'Local boundary',
          value: boundaryBits.length
            ? `${boundaryBits.join(' · ')}. Raw private values stay on this device; only summaries and hashes move through orchestration.`
            : 'Sensitive private values stay on this device; orchestration uses only summaries and hashes.'
        },
        {
          label: 'Next human step',
          value: result.nextHumanAction || 'Choose whether to let an execution agent finish the task or handle the last mile yourself.'
        }
      ];
      return rows.map((row) => `
        <div class="execution-contract-item">
          <div class="execution-contract-label">${escapeExecutionValue(row.label)}</div>
          <div class="execution-contract-value">${escapeExecutionValue(row.value)}</div>
        </div>
      `).join('');
    }

    function renderExecutionTrace(session) {
      const trace = Array.isArray(session.executionTrace) ? session.executionTrace : [];
      const fulfillment = session.fulfillment;
      if (!trace.length && !fulfillment) {
        return '<div class="execution-muted">No execution steps yet. Once you hand this to an execution agent, we will show search, cart, and completion checkpoints here.</div>';
      }
      const artifacts = Array.isArray(fulfillment?.result?.artifacts) ? fulfillment.result.artifacts : [];
      const terminalLabel = fulfillment?.status === 'failed' ? 'Failed' : 'Fulfilled';
      const traceHtml = trace.map((row) => {
        const phase = inferExecutionPhase(row);
        return `
        <div class="trace-row">
          <div class="trace-head">
            <span class="trace-phase ${phase.cls}">${escapeExecutionValue(phase.label)}</span>
            <div class="trace-label">${escapeExecutionValue(row.label || phase.label)}</div>
          </div>
          <div class="trace-meta">${escapeExecutionValue(row.detail || '')}${row.browser?.title ? `<br />page: ${escapeExecutionValue(row.browser.title)}` : ''}${row.browser?.url ? `<br /><a href="${row.browser.url}" target="_blank" rel="noopener noreferrer">Open current page</a>` : ''}${row.pluginId ? `<br />agent: ${escapeExecutionValue(row.pluginId)}` : ''}${row.createdAt ? `<br />${new Date(row.createdAt).toLocaleString()}` : ''}</div>
        </div>
      `;
      }).join('');
      const terminalHtml = fulfillment ? `
        <div class="trace-row">
          <div class="trace-head">
            <span class="trace-phase ${fulfillment?.status === 'failed' ? 'failed' : 'completed'}">${terminalLabel === 'Fulfilled' ? 'Completed' : 'Failed'}</span>
            <div class="trace-label">${terminalLabel}</div>
          </div>
          <div class="trace-meta">${fulfillment.notes || 'Execution finished.'}${fulfillment.proof?.commitmentHash ? `<br />proof: ${fulfillment.proof.commitmentHash.slice(0, 24)}…` : ''}${artifacts.length ? `<br />artifacts: ${artifacts.map((artifact) => artifact.label).join(', ')}` : ''}</div>
        </div>
      ` : '';
      return traceHtml + terminalHtml;
    }

    function renderExecutionLiveView(session) {
      const trace = Array.isArray(session.executionTrace) ? session.executionTrace : [];
      const liveRow = [...trace].reverse().find((row) => row.browser) || null;
      const fulfillmentBrowser = session.fulfillment?.result?.browserExecution || null;
      const liveBrowser = liveRow?.browser || fulfillmentBrowser || null;
      if (!liveBrowser) {
        if (['queued', 'claimed', 'executing'].includes(String(session.status || ''))) {
          return '<div class="execution-muted">The execution agent is running. As soon as it opens a live browser or provider surface, you will see the current page and latest action here.</div>';
        }
        return '<div class="execution-muted">No live browser activity yet.</div>';
      }
      const phase = inferExecutionPhase(liveRow || { state: fulfillmentBrowser?.mode || 'live' });
      const title = liveRow?.label || liveBrowser.title || 'Live execution';
      const detail = liveRow?.detail || session.fulfillment?.notes || 'The execution agent is working through a live web step.';
      const preview = liveBrowser.previewArtifact || fulfillmentBrowser?.previewArtifact || null;
      const pageUrl = liveBrowser.url || fulfillmentBrowser?.finalUrl || fulfillmentBrowser?.targetUrl || session.fulfillment?.handoff?.url || null;
      return `
        <div class="execution-live">
          <div class="execution-live-head">
            <div>
              <div class="trace-head"><span class="trace-phase ${phase.cls}">${escapeExecutionValue(phase.label)}</span><div class="trace-label">${escapeExecutionValue(title)}</div></div>
              <div class="trace-meta">${escapeExecutionValue(detail)}</div>
            </div>
            <div class="execution-live-state">${escapeExecutionValue(phase.label)}</div>
          </div>
          ${renderExecutionPreviewLink(preview?.url, { className: 'execution-live-media', imageAlt: 'Live execution preview' })}
          <div class="execution-live-links">
            ${pageUrl ? `<a class="execution-live-link" href="${pageUrl}" target="_blank" rel="noopener noreferrer">Open current live page</a>` : ''}
            ${renderExecutionPreviewLink(preview?.url, { className: 'execution-live-link', label: 'Open latest snapshot' })}
          </div>
        </div>
      `;
    }

    function renderExecutionVerification(session) {
      const verification = session.fulfillment?.executionVerification || session.executionVerification || null;
      if (!verification) return '';
      const proofBadgeClass = ['ready', 'verified'].includes(String(verification.proofStatus || '')) ? 'ready' : verification.proofStatus === 'failed' ? 'failed' : '';
      const anchorBadgeClass = verification.anchorStatus === 'failed'
        ? 'failed'
        : ['prepared', 'submitted', 'confirmed'].includes(String(verification.anchorStatus || ''))
          ? 'prepared'
          : '';
      const anchorLabel = verification.anchorStatus === 'failed'
        ? 'Anchor failed'
        : verification.anchorStatus === 'submitted' || verification.anchorStatus === 'confirmed'
          ? 'Anchored on Zeko'
          : verification.anchorStatus === 'prepared'
            ? 'Recorded for Zeko'
            : 'Anchor pending';
      const proofLabel = verification.proofStatus === 'verified'
        ? 'Verified locally'
        : verification.proofStatus === 'ready'
          ? 'Proof ready'
          : verification.proofStatus === 'failed'
            ? 'Proof failed'
            : 'Proof pending';
      return `
        <div class="trace-row">
          <div class="trace-label">Verification</div>
          <div class="trace-meta">
            <div class="execution-proof-row">
              <span class="execution-proof-badge ${proofBadgeClass}">${escapeExecutionValue(proofLabel)}</span>
              <span class="execution-proof-badge ${anchorBadgeClass}">${escapeExecutionValue(anchorLabel)}</span>
            </div>
            ${verification.statementHash ? `<div style="margin-top:10px">statement: ${escapeExecutionValue(String(verification.statementHash).slice(0, 28))}…</div>` : ''}
            <div style="margin-top:6px">${escapeExecutionValue(verification.network || 'zeko:zeko-mainnet')}${verification.submitMode ? ` · ${escapeExecutionValue(verification.submitMode)} mode` : ''}</div>
            <div style="margin-top:6px">Only compact public hashes and settlement statements enter the Zeko trail. Private inputs stay local.</div>
            ${verification.error ? `<div style="margin-top:6px;color:#ffb0b0">${escapeExecutionValue(verification.error)}</div>` : ''}
            <div class="execution-proof-links">
              ${verification.receiptId ? `<a href="/proofs/receipt/${encodeURIComponent(verification.receiptId)}" target="_blank" rel="noopener noreferrer">Open proof export</a>` : ''}
              ${verification.anchorSubmissionId ? `<a href="/anchors/status/${encodeURIComponent(verification.anchorSubmissionId)}" target="_blank" rel="noopener noreferrer">Open anchor status</a>` : ''}
            </div>
          </div>
        </div>
      `;
    }

    function renderExecutionResult(session) {
      const fulfillment = session.fulfillment;
      const result = fulfillment?.result || {};
      const artifacts = Array.isArray(fulfillment?.result?.artifacts) ? fulfillment.result.artifacts : [];
      const syncLinks = result.syncLinks || {};
      const isFoodHold = session.handoffData?.kind === 'food' && session.creditReservation?.status === 'locked' && Boolean(result.needsFinalOrderConfirmation);
      const verification = renderExecutionVerification(session);
      const developerLiveGitHub = session.githubDraftPr || result.liveGitHub || null;
      const developerCanOpenDraftPr = (
        session.handoffData?.kind === 'developer' &&
        String(result.executionMode || '') === 'draft_pr' &&
        Boolean(result.liveGitHubEligible) &&
        !developerLiveGitHub?.pullRequestUrl
      );
      if (session.status === 'fulfilled' && fulfillment) {
        const shippedSummary = result.applicationsShipped
          ? `Applications shipped: ${result.applicationsShipped}`
          : result.applicationsPrepared
            ? `Applications prepared: ${result.applicationsPrepared}`
            : '';
        const previewOnly = Boolean(result.previewOnly);
        const needsLocalRunner = String(result.completionState || '').toLowerCase() === 'needs_local_runner';
        return `
          <div class="trace-row">
            <div class="trace-label">${previewOnly ? 'Preview ready' : needsLocalRunner ? 'Local runner needed' : 'Finished'}</div>
            <div class="trace-meta">${fulfillment.notes || (needsLocalRunner ? 'The server worker prepared a handoff, but checkout needs the local authenticated runner.' : 'Execution finished successfully.')}${shippedSummary ? `<br />${escapeExecutionValue(shippedSummary)}` : ''}${result.itemsAdded?.length ? `<br />Prepared cart: ${escapeExecutionValue(result.itemsAdded.join(', '))}` : ''}${result.providerChallenge ? '<br />The provider challenged automation before Magic City could safely finish the order.' : ''}${needsLocalRunner ? '<br />This run did not add an item to cart, enter payment, or place an order.' : ''}${previewOnly ? '<br />No credits were locked for this run. Upgrade later only if you want the full deliverable.' : ''}</div>
          </div>
          ${isFoodHold ? `
            <div class="trace-row">
              <div class="trace-label">Credits held pending order confirmation</div>
              <div class="trace-meta">
                Magic City is still holding ${escapeExecutionValue(describeAlphaWorkflowPrice(session.paymentOrchestration || { requiredCredits: session.creditReservation?.requiredCredits || 0 }))} for this order. It will not be captured until you confirm the real provider order went through.
                <div class="execution-actions" style="margin-top:10px">
                  <button class="execution-primary" id="executionFoodConfirmOrderBtn" type="button">I placed the order</button>
                  <button class="execution-secondary" id="executionFoodReleaseHoldBtn" type="button">Release held credits</button>
                </div>
              </div>
            </div>
          ` : ''}
          ${verification}
          ${artifacts.length ? artifacts.map((artifact) => `
            <div class="trace-row">
              <div class="trace-label">${artifact.label}</div>
              <div class="trace-meta"><a class="execution-result-link" href="${artifact.url}" target="_blank" rel="noopener noreferrer">Open ${artifact.label.toLowerCase()}</a></div>
            </div>
          `).join('') : '<div class="execution-muted">No artifacts were attached to this run.</div>'}
          ${session.handoffData?.kind === 'developer' ? `
            <div class="trace-row">
              <div class="trace-label">GitHub live write</div>
              <div class="trace-meta">
                ${developerLiveGitHub?.pullRequestUrl
                  ? `<a class="execution-result-link" href="${developerLiveGitHub.pullRequestUrl}" target="_blank" rel="noopener noreferrer">Open draft PR on GitHub</a>${developerLiveGitHub.branchUrl ? ` <a class="execution-result-link" href="${developerLiveGitHub.branchUrl}" target="_blank" rel="noopener noreferrer">Open branch</a>` : ''}`
                  : developerCanOpenDraftPr
                    ? `<button class="execution-secondary" id="executionDeveloperOpenPrBtn" type="button">Open draft PR on GitHub</button>`
                    : `<div class="execution-muted">${escapeExecutionValue(result.liveGitHubReason || 'Review the artifact bundle first, then enable GitHub write access to open the draft PR from Magic City.')}</div>`}
              </div>
            </div>
          ` : ''}
          ${syncLinks.googleCalendarUrl || syncLinks.followUpMailtoUrl || syncLinks.contactsImportUrl ? `
            <div class="trace-row">
              <div class="trace-label">Sync bridges</div>
              <div class="trace-meta">
                ${syncLinks.googleCalendarUrl ? `<a class="execution-result-link" href="${syncLinks.googleCalendarUrl}" target="_blank" rel="noopener noreferrer">${result.googleSync?.synced ? 'Open Google Calendar event' : 'Open Google Calendar draft'}</a>` : ''}
                ${syncLinks.followUpMailtoUrl ? `<a class="execution-result-link" href="${syncLinks.followUpMailtoUrl}" target="_blank" rel="noopener noreferrer">Draft follow-up email</a>` : ''}
                ${syncLinks.contactsImportUrl ? `<a class="execution-result-link" href="${syncLinks.contactsImportUrl}" target="_blank" rel="noopener noreferrer">Open contacts import</a>` : ''}
              </div>
            </div>
          ` : ''}
          ${session.fulfilledByPluginId ? `
            <div class="execution-actions" style="margin-top:10px">
              <button class="execution-secondary" id="executionShareX" type="button">Share on X (+bonus credits)</button>
              <button class="execution-rating positive" id="executionFeedbackGood" type="button">Rate strong performance</button>
              <button class="execution-rating negative" id="executionFeedbackBad" type="button">Rate needs work</button>
            </div>
          ` : ''}
        `;
      }
      if (session.status === 'failed') {
        return `${verification}<div class="execution-muted">This execution failed. The trace below shows the last checkpoint and any released funding hold.</div>`;
      }
      if (['queued', 'claimed', 'executing'].includes(String(session.status || ''))) {
        return `<div class="execution-muted">Execution is in progress. Buttons are paused until this run finishes so you do not create duplicate work or duplicate charges.</div>`;
      }
      return `<div class="execution-muted">No finished result yet. Once the agent completes the task, the final export or checkout link will be surfaced here first.</div>`;
    }

    async function renderExecutionSheet(sessionId, { focus = true } = {}) {
      const [{ session }, executionAgentData, squareConfig] = await Promise.all([
        api(`/connectors/sessions/${sessionId}`),
        api(`/connectors/sessions/${sessionId}/execution-agents`).catch(() => ({ executionAgents: [] })),
        api('/billing/square/config').catch(() => ({ configured: false }))
      ]);
      const draft = getExecutionDraft(sessionId);
      if (draft) {
        session.selections = { ...(session.selections || {}), ...(draft.selections || {}) };
        session.finalSelections = { ...(session.finalSelections || {}), ...(draft.selections || {}) };
        session.localPrivateContext = { ...(session.localPrivateContext || {}), ...(draft.localPrivateInputs || {}) };
      }
      const executionAgents = executionAgentData.executionAgents || [];
      const recommended = executionAgents[0] || null;
      executionSessionCache.set(session.id, session);
      if (!executionSessionOrder.includes(session.id)) executionSessionOrder.push(session.id);
      if (focus || !activeExecutionSessionId || !executionSessionCache.has(activeExecutionSessionId)) {
        activeExecutionSessionId = session.id;
        executionCollapsedSessions.delete(session.id);
      }
      renderExecutionDock();
      if (activeExecutionSessionId !== session.id || executionCollapsedSessions.has(session.id)) {
        if (['fulfilled', 'failed'].includes(String(session.status || ''))) {
          executionPendingSessions.delete(session.id);
          ensureExecutionPolling();
        }
        return;
      }
      const fundingStatus = session.creditReservation?.status === 'locked'
        ? ` · ${describeAlphaWorkflowPrice(session.paymentOrchestration || { requiredCredits: session.creditReservation.requiredCredits })} held`
        : '';
      $('executionStatusText').textContent = `Session ${session.id} · ${session.status || 'ready'} · ${session.completionMode || 'waiting for mode'}${fundingStatus}`;
      $('executionContractText').innerHTML = renderExecutionContract(session);
      $('executionFields').innerHTML = renderExecutionFields(session);
      if (session.handoffData?.kind === 'spreadsheet') {
        bindLocalTextUpload({
          inputId: 'executionSpreadsheetFile',
          targetId: 'executionSpreadsheetRaw',
          rowBandId: 'executionSpreadsheetRows',
          statusId: 'executionSpreadsheetFileStatus'
        });
      }
      if (session.handoffData?.kind === 'job') {
        bindLocalResumeUpload({
          inputId: 'executionResumeUpload',
          targetId: 'executionResumeText',
          fileNameId: 'executionResumeFileName',
          statusId: 'executionResumeStatus',
          hintIds: {
            applicantName: 'executionApplicantName',
            applicantEmail: 'executionApplicantEmail',
            applicantPhone: 'executionApplicantPhone',
            linkedinUrl: 'executionApplicantLinkedIn',
            portfolioUrl: 'executionApplicantPortfolio'
          }
        });
      }
      if (session.handoffData?.kind === 'meeting') {
        bindLocalMeetingUpload({
          inputId: 'executionMeetingUpload',
          targetId: 'executionMeetingTranscript',
          statusId: 'executionMeetingStatus'
        });
      }
      $('executionAgentText').innerHTML = recommended
        ? `Recommended execution agent: <strong>${recommended.pluginId}</strong> · score ${recommended.executionScore.score}<br /><span class="execution-muted">Fulfilled ${recommended.executionScore.stats.fulfilled} sessions, with ${recommended.executionScore.stats.humanAttestations} human attestations and ${recommended.executionScore.stats.acpAttestations} ACP attestations feeding its service record. This is the visible performance layer.</span>`
        : 'Magic City is warming this execution lane. You can keep configuring the task now, and the first available worker will pick it up as soon as it checks in.';
      $('executionResult').innerHTML = renderExecutionResult(session);
      $('executionLiveView').innerHTML = renderExecutionLiveView(session);
      $('executionTrace').innerHTML = renderExecutionTrace(session);
      if (['fulfilled', 'failed'].includes(session.status)) {
        executionPendingSessions.delete(session.id);
        ensureExecutionPolling();
      }

      const squareCheckoutUrl = session.fulfillment?.result?.squarePaymentLinkUrl || session.squarePaymentLink?.url || null;
      const preferredTarget = session.fulfillment?.result?.taskPackage?.preferredTarget || session.taskPackage?.preferredTarget || null;
      const fulfillmentHandoffUrl = session.fulfillment?.handoff?.url || null;
      const primaryProvider = squareCheckoutUrl || fulfillmentHandoffUrl || preferredTarget?.url || session.resolvedOrderUrl || session.handoffData?.providerLinks?.[0]?.url || session.actionSummary?.handoffUrl || null;
      const hasFundingTarget = Boolean(session.paymentOrchestration);
      const fundingTargetCredits = hasFundingTarget ? Number(session.paymentOrchestration?.requiredCredits ?? 0) : 2500;
      const selectedFundingMode = String(session.selections?.paymentFundingMode || session.paymentOrchestration?.fundingMode || 'magic_city_credits');
      const topupLabel = fundingTargetCredits > 0 ? `Add ${formatCreditCount(fundingTargetCredits)} credits` : 'Credits not required';
      const kind = session.handoffData?.kind || '';
      const isInternalLane = ['meeting', 'reminder', 'developer'].includes(kind);
      const isFoodLane = kind === 'food';
      const isTravelLane = kind === 'travel';
      const usingMagicCityCheckout = selectedFundingMode !== 'direct_square';
      const primaryLabel = kind === 'meeting'
          ? 'Generate package'
          : kind === 'job'
            ? 'Run application agent'
          : kind === 'reminder'
            ? 'Finalize reminder'
            : kind === 'developer'
              ? 'Generate implementation package'
              : isFoodLane
                ? (usingMagicCityCheckout ? 'Complete with Magic City' : 'Prepare direct merchant checkout')
                : (session.handoffData?.agentActionLabel || 'Let an agent complete this');
      const canUseSquare = Boolean(
        squareConfig?.configured &&
        kind === 'food' &&
        selectedFundingMode === 'direct_square'
      );
      const artifactLinks = Array.isArray(session.fulfillment?.result?.artifacts) ? session.fulfillment.result.artifacts : [];
      const executionBusy = executionPendingSessions.has(session.id) || ['queued', 'claimed', 'executing'].includes(String(session.status || ''));
      const showTopup = !['fulfilled', 'failed'].includes(String(session.status || '')) && fundingTargetCredits > 0 && selectedFundingMode !== 'direct_square';
      const topupButtonLabel = isTravelLane ? 'Pay with Stripe now' : topupLabel;
      const showHumanPath = !isInternalLane && !['fulfilled', 'failed'].includes(String(session.status || ''));
      const showSquare = !isInternalLane && canUseSquare && !executionBusy;
      const showProvider = !isInternalLane && primaryProvider;
      const showFallbackOptions = showHumanPath || showSquare || showProvider;
      const providerActionLabel = squareCheckoutUrl
        ? 'Open direct Square checkout'
        : kind === 'travel'
          ? 'Open live flight search'
          : kind === 'job'
            ? 'Open live job search'
          : 'Open provider page';
      $('executionActions').innerHTML = `
        <button class="execution-primary" id="executionAgentBtn" type="button" ${executionBusy || ['fulfilled', 'failed'].includes(String(session.status || '')) ? 'disabled' : ''}>${executionBusy ? 'Execution running…' : primaryLabel}</button>
        ${session.handoffData?.kind === 'food' ? `<button class="execution-secondary" id="executionDiscoverBtn" type="button" ${executionBusy ? 'disabled' : ''}>Find live local restaurants</button>` : ''}
        ${showTopup ? `<button class="execution-secondary" id="executionTopupBtn" type="button" ${executionBusy ? 'disabled' : ''}>${topupButtonLabel}</button>` : ''}
        ${isFoodLane && usingMagicCityCheckout ? `<div class="execution-inline-note">Magic City checkout is using credits first. If the merchant needs a direct rail, you can open the fallback options below.</div>` : ''}
        ${isTravelLane ? `<div class="execution-inline-note">Magic City checkout covers the itinerary concierge package. Flights and hotel are still booked on live provider pages after you review the prepared search results.</div>` : ''}
        ${showFallbackOptions ? `
          <details class="execution-fallbacks">
            <summary>Other payment options</summary>
            <div class="execution-fallback-actions">
              ${showHumanPath ? `<button class="execution-secondary" id="executionHumanBtn" type="button" ${executionBusy ? 'disabled' : ''}>${session.handoffData?.humanActionLabel || 'Finish checkout myself'}</button>` : ''}
              ${showSquare ? '<button class="execution-secondary" id="executionSquareBtn" type="button">Pay with Square</button>' : ''}
              ${showProvider ? `<a class="execution-secondary" href="${primaryProvider}" target="_blank" rel="noopener noreferrer">${providerActionLabel}</a>` : ''}
            </div>
          </details>` : ''}
      `;

      const syncExecutionFoodMenuOptions = () => {
        if (session.handoffData?.kind !== 'food') return;
        const menusByRestaurant = session.liveDiscovery?.menusByRestaurant || {};
        const restaurantName = $('executionRestaurant')?.value || '';
        const menuItems = Array.isArray(menusByRestaurant[restaurantName]) ? menusByRestaurant[restaurantName] : null;
        if (!menuItems || !menuItems.length) return;
        const item1 = $('executionItem1');
        const item2 = $('executionItem2');
        if (item1 && item1.tagName === 'SELECT') {
          const previous = item1.value;
          item1.innerHTML = menuItems.map((item, idx) => {
            const selected = previous ? previous === item.name : idx === 0;
            return `<option value="${escapeExecutionValue(item.name)}" ${selected ? 'selected' : ''}>${escapeExecutionValue(item.name)} · ${escapeExecutionValue(item.price)}</option>`;
          }).join('');
        }
        if (item2 && item2.tagName === 'SELECT') {
          const previous = item2.value;
          item2.innerHTML = '<option value="">None</option>' + menuItems.map((item) => {
            const selected = previous && previous === item.name ? 'selected' : '';
            return `<option value="${escapeExecutionValue(item.name)}" ${selected}>${escapeExecutionValue(item.name)} · ${escapeExecutionValue(item.price)}</option>`;
          }).join('');
        }
      };

      const discoverLiveFoodOptions = async (auto = false) => {
        const button = $('executionDiscoverBtn');
        if (button) {
          button.disabled = true;
          button.textContent = auto ? 'Finding local restaurants…' : 'Finding live local restaurants…';
        }
        try {
          await api(`/connectors/sessions/${session.id}/discover-food-options`, {
            method: 'POST',
            body: JSON.stringify({
              selections: collectExecutionSelections(session),
              localPrivateInputs: collectExecutionPrivateInputs(session)
            })
          });
          attemptedLiveFoodDiscovery.add(session.id);
          await renderExecutionSheet(session.id);
        } catch (error) {
          if (button) {
            button.disabled = false;
            button.textContent = 'Retry live local restaurants';
          }
          if (!auto) throw error;
        }
      };

      const syncSelectionsForFunding = async () => {
        const draft = snapshotExecutionDraft(session);
        const updated = await api(`/connectors/sessions/${session.id}/update`, {
          method: 'POST',
          body: JSON.stringify({
            selections: draft?.selections || {},
            localPrivateInputs: draft?.localPrivateInputs || {}
          })
        });
        clearExecutionDraft(session.id);
        return updated.session || null;
      };

      const rerenderForPricing = async () => {
        try {
          await syncSelectionsForFunding();
          await renderExecutionSheet(session.id);
        } catch (error) {
          $('executionStatusText').textContent = `Session ${session.id} · ${error.message}`;
        }
      };

      $('executionAgentBtn')?.addEventListener('click', async () => {
        try {
          const selections = collectExecutionSelections(session);
          const localPrivateInputs = collectExecutionPrivateInputs(session);
          const fundingMode = String(selections.paymentFundingMode || session.paymentOrchestration?.fundingMode || '');
          if (hasStoredVaultDeviceAuth() && (hasSensitiveLocalPayload(localPrivateInputs) || (fundingMode && fundingMode !== 'free_preview'))) {
            await authorizeSensitiveAction('Authorize private data or payment use for this execution');
          }
          executionPendingSessions.add(session.id);
          await renderExecutionSheet(session.id);
          const data = await api(`/connectors/sessions/${session.id}/start-execution`, {
            method: 'POST',
            body: JSON.stringify({
              mode: 'agent_checkout',
              requesterId: getRequesterId(),
              selections,
              localPrivateInputs
            })
          });
          $('executionAgentText').innerHTML = data.executionAgent
            ? `Execution handed to <strong>${data.executionAgent.pluginId}</strong> · score ${data.executionAgent.executionScore.score}<br /><span class="execution-muted">Magic City will keep polling this session and update the progress in place.</span>`
            : 'Execution requested. Waiting for an available execution agent to claim the session.';
          await renderExecutionSheet(session.id);
          ensureExecutionPolling();
        } catch (error) {
          executionPendingSessions.delete(session.id);
          ensureExecutionPolling();
          await renderExecutionSheet(session.id);
          $('executionStatusText').textContent = `Session ${session.id} · ${error.message}`;
        }
      });

      $('executionHumanBtn')?.addEventListener('click', async () => {
        try {
          const selections = collectExecutionSelections(session);
          const localPrivateInputs = collectExecutionPrivateInputs(session);
          const fundingMode = String(selections.paymentFundingMode || session.paymentOrchestration?.fundingMode || '');
          if (hasStoredVaultDeviceAuth() && (hasSensitiveLocalPayload(localPrivateInputs) || (fundingMode && fundingMode !== 'free_preview'))) {
            await authorizeSensitiveAction('Authorize private data or payment use for this execution');
          }
          executionPendingSessions.add(session.id);
          await renderExecutionSheet(session.id);
          const data = await api(`/connectors/sessions/${session.id}/start-execution`, {
            method: 'POST',
            body: JSON.stringify({
              mode: 'human_checkout',
              requesterId: getRequesterId(),
              selections,
              localPrivateInputs
            })
          });
          let target = data.session?.squarePaymentLink?.url || data.session?.taskPackage?.preferredTarget?.url || data.session?.handoffData?.providerLinks?.[0]?.url || data.session?.fulfillment?.handoff?.url || primaryProvider;
          const currentSelections = selections;
          if (!target && session.handoffData?.kind === 'food' && currentSelections.paymentFundingMode === 'direct_square') {
            const square = await openSquareSessionPayment(session.id);
            target = square.paymentLinkUrl || null;
          }
          if (target) window.open(target, '_blank', 'noopener,noreferrer');
          await renderExecutionSheet(session.id);
        } catch (error) {
          executionPendingSessions.delete(session.id);
          ensureExecutionPolling();
          await renderExecutionSheet(session.id);
          $('executionStatusText').textContent = `Session ${session.id} · ${error.message}`;
        }
      });

      $('executionTopupBtn')?.addEventListener('click', async () => {
        try {
          const refreshed = await syncSelectionsForFunding();
          const amountCredits = Number(refreshed?.paymentOrchestration?.requiredCredits ?? fundingTargetCredits);
          if (amountCredits <= 0) return;
          if (hasStoredVaultDeviceAuth()) {
            await authorizeSensitiveAction(isTravelLane ? `Authorize Stripe payment for the itinerary concierge package` : `Authorize a ${formatCreditCount(amountCredits)} credit top-up`);
          }
          await renderExecutionSheet(session.id);
          await openStripeTopup(amountCredits, { sessionId: session.id });
        } catch (error) {
          $('executionStatusText').textContent = `Session ${session.id} · ${error.message}`;
        }
      });

      $('executionSquareBtn')?.addEventListener('click', async () => {
        try {
          if (hasStoredVaultDeviceAuth()) {
            await authorizeSensitiveAction('Authorize direct merchant checkout');
          }
          await syncSelectionsForFunding();
          await renderExecutionSheet(session.id);
          await openSquareSessionPayment(session.id);
        } catch (error) {
          $('executionStatusText').textContent = `Session ${session.id} · ${error.message}`;
        }
      });

      $('executionFoodConfirmOrderBtn')?.addEventListener('click', async () => {
        try {
          if (hasStoredVaultDeviceAuth()) {
            await authorizeSensitiveAction('Authorize confirming this food order and capturing credits');
          }
          const data = await api(`/connectors/sessions/${session.id}/confirm-food-order`, {
            method: 'POST'
          });
          if (data.session) {
            executionSessionCache.set(session.id, data.session);
          }
          await renderExecutionSheet(session.id);
          $('executionStatusText').textContent = `Session ${session.id} · food order confirmed · credits captured`;
        } catch (error) {
          $('executionStatusText').textContent = `Session ${session.id} · ${error.message}`;
        }
      });

      $('executionFoodReleaseHoldBtn')?.addEventListener('click', async () => {
        try {
          const data = await api(`/connectors/sessions/${session.id}/release-food-hold`, {
            method: 'POST'
          });
          if (data.session) {
            executionSessionCache.set(session.id, data.session);
          }
          await renderExecutionSheet(session.id);
          $('executionStatusText').textContent = `Session ${session.id} · held credits released`;
        } catch (error) {
          $('executionStatusText').textContent = `Session ${session.id} · ${error.message}`;
        }
      });

      const sendExecutionFeedback = async (value) => {
        if (!session.fulfilledByPluginId) return;
        const requesterId = getRequesterId() || 'local-user';
        const commitmentHash = await sha256Hex(`${session.id}:${session.fulfilledByPluginId}:${value}:${Date.now()}`);
        const data = await api(`/execution-agents/${encodeURIComponent(session.fulfilledByPluginId)}/attestations`, {
          method: 'POST',
          body: JSON.stringify({
            issuer: requesterId,
            issuerType: 'human',
            commitmentHash,
            type: 'human_service_attestation',
            qualityScore: value === 'good' ? 5 : 1,
            serviceScore: value === 'good' ? 5 : 1,
            metadata: {
              sessionId: session.id,
              feedback: value,
              lane: session.handoffData?.kind || null
            }
          })
        });
        const verification = data.executionVerification || null;
        await renderExecutionSheet(session.id);
        if (verification?.anchorStatus) {
          $('executionStatusText').textContent = `Session ${session.id} · feedback attestation queued · ${verification.anchorStatus}`;
        }
      };

      $('executionFeedbackGood')?.addEventListener('click', async () => {
        await sendExecutionFeedback('good');
      });
      $('executionFeedbackBad')?.addEventListener('click', async () => {
        await sendExecutionFeedback('bad');
      });
      $('executionDeveloperOpenPrBtn')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        if (!button) return;
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Opening draft PR…';
        try {
          const data = await api(`/connectors/sessions/${session.id}/github/open-draft-pr`, {
            method: 'POST'
          });
          await renderExecutionSheet(session.id);
          if (data.pullRequest?.htmlUrl) {
            window.open(data.pullRequest.htmlUrl, '_blank', 'noopener,noreferrer');
          }
          $('executionStatusText').textContent = `Session ${session.id} · draft PR ready on GitHub`;
        } catch (error) {
          button.disabled = false;
          button.textContent = originalText;
          $('executionStatusText').textContent = `Session ${session.id} · ${error.message}`;
        }
      });
      $('executionShareX')?.addEventListener('click', async () => {
        try {
          openTaskResultShare('x', session);
          const data = await claimTaskShareReward(session, 'x');
          $('executionStatusText').textContent = `Session ${session.id} · shared on X · +${formatCreditCount(data.shareRewardCredits || 0)} credits`;
          await renderExecutionSheet(session.id);
        } catch (error) {
          $('executionStatusText').textContent = `Session ${session.id} · ${error.message}`;
        }
      });
      $('executionDiscoverBtn')?.addEventListener('click', async () => {
        try {
          await discoverLiveFoodOptions(false);
        } catch (error) {
          $('executionStatusText').textContent = `Session ${session.id} · ${error.message}`;
        }
      });
      $('executionFundingModeOverride')?.addEventListener('change', () => {
        const hiddenFundingMode = $('executionFundingMode');
        if (hiddenFundingMode) hiddenFundingMode.value = $('executionFundingModeOverride')?.value || 'magic_city_credits';
        rerenderForPricing();
      });
      $('executionSpreadsheetFundingMode')?.addEventListener('change', rerenderForPricing);
      $('executionSpreadsheetTier')?.addEventListener('change', rerenderForPricing);
      $('executionSpreadsheetRows')?.addEventListener('change', rerenderForPricing);
      $('executionSpreadsheetFormat')?.addEventListener('change', rerenderForPricing);
      $('executionMeetingFundingMode')?.addEventListener('change', rerenderForPricing);
      $('executionMeetingLength')?.addEventListener('change', rerenderForPricing);
      $('executionMeetingPackage')?.addEventListener('change', rerenderForPricing);
      $('executionMeetingSyncTarget')?.addEventListener('change', rerenderForPricing);
      $('executionJobFundingMode')?.addEventListener('change', rerenderForPricing);
      $('executionJobSubmissionMode')?.addEventListener('change', rerenderForPricing);
      $('executionJobLimit')?.addEventListener('change', rerenderForPricing);
      $('executionRestaurant')?.addEventListener('change', syncExecutionFoodMenuOptions);
      bindLocalTextUpload({
        inputId: 'executionSpreadsheetFile',
        targetId: 'executionSpreadsheetRaw',
        rowBandId: 'executionSpreadsheetRows',
        statusId: 'executionSpreadsheetFileStatus'
      });
      bindLocalMeetingUpload({
        inputId: 'executionMeetingUpload',
        targetId: 'executionMeetingTranscript',
        statusId: 'executionMeetingStatus'
      });

      if (
        session.handoffData?.kind === 'food' &&
        !session.liveDiscovery?.restaurants?.length &&
        !attemptedLiveFoodDiscovery.has(session.id)
      ) {
        const hasLocalContext = Boolean(
          $('executionZipCode')?.value?.trim() ||
          $('executionStreetAddress')?.value?.trim()
        );
        if (hasLocalContext) {
          attemptedLiveFoodDiscovery.add(session.id);
          discoverLiveFoodOptions(true).catch(() => {});
        }
      }
      syncExecutionFoodMenuOptions();
    }

    function renderDetailLines(lines) {
      return lines.filter(Boolean).join('\n');
    }

    function buildResponseDetails({ assistant, selectedAgent, privacy, attestation, proofArtifact, batch, intent, fallback }) {
      const capability = selectedAgent?.laneId || intent?.capability || '';
      const needsPrivacyDetails = ['confidential', 'agent-private', 'plain'].includes(privacy?.mode);
      const needsStandardDetails = Boolean(assistant?.providerId || capability);
      const needsFallbackDetails = false;
      if (!needsPrivacyDetails && !needsFallbackDetails && !needsStandardDetails) return '';

      return renderDetailLines([
        assistant?.providerId ? `Model: ${assistant.providerId}` : '',
        buildWorkflowLine(capability),
        buildPrivacyLine(privacy),
        privacy?.clientEnvelopeReceived ? 'Client envelope: attached' : '',
        fallback ? 'Fallback: built-in provider' : '',
        ...(needsPrivacyDetails ? buildAttestationLines(attestation, proofArtifact) : []),
        batch?.batchWindowId && needsPrivacyDetails ? `Batch: ${batch.batchWindowId}` : '',
        intent?.id && needsPrivacyDetails ? `Intent: ${intent.id}` : ''
      ]);
    }

    function buildPrivacyLine(privacy) {
      if (!privacy) return '';
      if (privacy.mode === 'confidential') return 'Privacy: Encrypted lane. Address and identifying metadata stay local only.';
      if (privacy.mode === 'agent-private') return 'Privacy: Agent-private lane. Address and identifying metadata stay local only.';
      if (privacy.mode === 'plain') return 'Privacy: Plain mode.';
      return '';
    }

    function buildAttestationLines(attestation, proofArtifact) {
      if (!attestation && !proofArtifact) return [];
      return [
        attestation?.type ? `Attestation: ${attestation.type}` : '',
        attestation?.executionEnvironment ? `Execution: ${attestation.executionEnvironment}` : '',
        attestation?.attestationHash ? `Attestation hash: ${attestation.attestationHash}` : '',
        proofArtifact?.publicInputs?.batchRoot ? `Batch root: ${proofArtifact.publicInputs.batchRoot}` : '',
        proofArtifact?.publicInputs?.requestCommitment ? `Commitment: ${proofArtifact.publicInputs.requestCommitment}` : '',
        proofArtifact?.publicInputs?.intentId ? `Proof export: /proofs/intent/${proofArtifact.publicInputs.intentId}` : ''
      ].filter(Boolean);
    }

    async function streamAssistantResult(target, text, detailsText) {
      stopAssistantPendingState(target);
      target.body.dataset.rawText = '';
      target.body.innerHTML = '';
      let streamedText = '';
      const words = String(text || '').split(/(\s+)/);
      for (const token of words) {
        streamedText += token;
        setAssistantBodyContent(target.body, streamedText);
        $('messages').scrollTop = $('messages').scrollHeight;
        await new Promise((resolve) => setTimeout(resolve, token.trim() ? 14 : 4));
      }
      const details = target.el.querySelector('.msg-details div');
      if (details) details.textContent = detailsText || '';
      saveChatHistory();
    }

    async function refresh() {
      const [health, config] = await Promise.all([
        api('/health'),
        api('/developer/config')
      ]);
      applyAdminAccessUi(Boolean(config?.adminAccess || authSessionUser?.adminAccess || authSessionUser?.adminAccount));
      if (authSessionUser && (lazyBootState.wallet || lazyBootState.accounts || $('settingsWalletSection')?.open || $('settingsAccountsSection')?.open)) {
        refreshEvmWalletStatus().catch(() => null);
      }

      let metrics = null;
      let board = null;
      let sessionData = { sessions: [] };
      let pluginData = { plugins: [] };
      let executionAgentData = { executionAgents: [] };
      let settlementRegistryData = { registry: [] };
      if (adminAccess) {
        [metrics, board, sessionData, pluginData, executionAgentData, settlementRegistryData] = await Promise.all([
          api('/metrics'),
          api('/leaderboard'),
          api('/connectors/sessions'),
          api('/plugins'),
          api('/execution-agents').catch(() => ({ executionAgents: [] })),
          api('/zeko/settlement-registry?limit=25').catch(() => ({ registry: [] }))
        ]);
      }

      $('health').textContent = `Status ${health.status.toUpperCase()} | ${health.now}`;
      $('metrics').textContent = adminAccess
        ? `Agents: ${metrics.agents} | Intents: ${metrics.intents} | Receipts: ${metrics.receipts} | Success: ${(metrics.successRate * 100).toFixed(1)}% | Fee: ${metrics.protocolFeeBps} bps`
        : '';
      $('providerHealth').innerHTML = adminAccess ? (metrics.providers || []).slice(0, 4).map((provider) => `
        <div class="chip">
          <div class="chip-title">${provider.label}</div>
          <div class="chip-meta">
            ${provider.avgLatencyMs != null ? `${provider.avgLatencyMs} ms avg` : 'No latency yet'}<br />
            ${provider.totalReceipts || 0} runs | ${provider.totalTokens || 0} tokens${provider.confidentialCapable ? '<br />Confidential-capable' : ''}
          </div>
        </div>
      `).join('') || `<div class="muted">No provider telemetry yet.</div>` : '';

      $('leaders').innerHTML = adminAccess ? (board.leaderboard || []).map((row) => `
        <tr>
          <td>${row.agentId}</td>
          <td>${row.reputation.score}</td>
          <td>${row.reputation.tracks.performance}</td>
          <td>${row.reputation.tracks.assurance}</td>
          <td>${row.reputation.stats.totalTasks}</td>
        </tr>
      `).join('') || `<tr><td colspan="5">No agents yet</td></tr>` : '';

      const providerSelect = $('preferredProvider');
      const current = providerSelect.value;
      const options = ['<option value="">Auto provider</option>']
        .concat((config.providers || []).map((provider) => `<option value="${provider.id}">${provider.label}</option>`));
      providerSelect.innerHTML = options.join('');
      if ([...providerSelect.options].some((option) => option.value === current)) {
        providerSelect.value = current;
      }

      $('operatorSessions').innerHTML = adminAccess ? (sessionData.sessions || []).slice(0, 5).map((session) => `
        <div class="chip">
          <div class="chip-title">${session.handoffData?.title || session.connectorId || session.id}</div>
          <div class="chip-meta">
            ${session.id}<br />
            status: ${session.status || 'ready'}<br />
            ${session.claimedByPluginId ? `claimed: ${session.claimedByPluginId}<br />` : ''}
            ${session.fulfilledByPluginId ? `fulfilled: ${session.fulfilledByPluginId}<br />` : ''}
            ${session.fulfillment?.proof?.commitmentHash ? `proof: ${session.fulfillment.proof.commitmentHash.slice(0, 16)}…` : ''}
          </div>
        </div>
      `).join('') || `<div class="muted">No connector sessions yet.</div>` : '';

      const executionAgents = executionAgentData.executionAgents || [];
      $('operatorPlugins').innerHTML = adminAccess ? executionAgents.slice(0, 5).map((agent) => `
        <div class="chip">
          <div class="chip-title">${agent.pluginId}</div>
          <div class="chip-meta">
            kind: ${agent.kind}<br />
            score: ${agent.executionScore?.score ?? 'n/a'}<br />
            fulfilled: ${agent.executionScore?.stats?.fulfilled ?? 0}<br />
            human attestations: ${agent.executionScore?.stats?.humanAttestations ?? 0}<br />
            ACP attestations: ${agent.executionScore?.stats?.acpAttestations ?? 0}<br />
            owner: ${agent.ownerAgentId}
          </div>
        </div>
      `).join('') || (pluginData.plugins || []).slice(0, 5).map((plugin) => `
        <div class="chip">
          <div class="chip-title">${plugin.pluginId}</div>
          <div class="chip-meta">
            kind: ${plugin.kind}<br />
            status: ${plugin.status}<br />
            owner: ${plugin.ownerAgentId}
          </div>
        </div>
      `).join('') || `<div class="muted">No execution agents registered yet.</div>` : '';

      renderSettlementRegistry(adminAccess ? (settlementRegistryData.registry || []) : []);

    }

    async function submitIntentFromChat() {
      const prompt = $('chatPrompt').value.trim();
      if (!prompt) return;

      addMessage('user', prompt);
      await bootstrapSessionIfNeeded().catch(() => null);
      $('chatPrompt').value = '';
      $('chatPrompt').style.height = '24px';
      if (await maybeHandleInlineReminderRequest(prompt)) return;
      if (await maybeHandleInlineEvmWalletRequest(prompt)) return;
      if (await maybeHandleInlineEmailRequest(prompt)) return;
      const capability = $('intentCapability').value.trim() || 'general-chat';
      const pending = addAssistantResult('Magic City · routing request', '', false, true);
      setAssistantPendingState(pending, 'Routing', capability);
      let streamStarted = false;
      const budget = Number($('intentBudget').value.trim() || '1');
      const requesterId = $('intentBuyer').value.trim() || null;
      if (requesterId) localStorage.setItem('magic_city_last_requester_id', requesterId);
      const requesterAgentId = $('intentRequester').value.trim() || null;
      const preferredProvider = $('preferredProvider').value || null;
      const privacyMode = $('privacyMode').value || 'private';
      const ephemeralSessionId = getEphemeralSessionId();
      const clientEncryptedPayload = await buildClientEncryptedPayload(prompt, null, privacyMode);
      const context = buildConversationContext(12);
      const memoryContext = buildPromptMemoryContext(12);
      const profileSummary = {
        ...getVaultSummary(),
        localMemoryEnabled: Boolean(localMemorySettings.enabled),
        localMemoryNote: localMemorySettings.enabled && localMemorySettings.note ? localMemorySettings.note : ''
      };

      try {
        let detailsText = '';
        await streamIntent({
          capability,
          budget,
          requesterId,
          requesterAgentId,
          preferredProvider,
          privacyMode,
          ephemeralSessionId,
          minBondTier: 1,
          prompt,
          context,
          memoryContext,
          profileSummary,
          clientEncryptedPayload,
          clientEncryption: clientEncryptedPayload
            ? {
                mode: privacyMode,
                keyScope: clientEncryptedPayload.keyScope,
                keyId: clientEncryptedPayload.keyId
              }
            : null
        }, {
          start: async (data) => {
            detailsText = '';
            setAssistantPendingState(pending, 'Routing', capability);
          },
          route: async (data) => {
            detailsText = '';
            const routedCapability = data.selectedAgent?.laneId || data.intent?.capability || capability;
            let nextPhase = 'Reviewing';
            const routedKey = String(routedCapability || '').toLowerCase();
            if (routedKey.includes('meeting')) nextPhase = 'Reviewing';
            else if (routedKey.includes('food')) nextPhase = 'Ordering';
            else if (routedKey.includes('travel')) nextPhase = 'Comparing';
            else if (routedKey.includes('job')) nextPhase = 'Filtering';
            else if (routedKey.includes('developer') || routedKey.includes('coding')) nextPhase = 'Reviewing';
            else if (routedKey.includes('call-mom') || routedKey.includes('reminder')) nextPhase = 'Preparing';
            setAssistantPendingState(pending, nextPhase, routedCapability);
          },
          delta: async (data) => {
            stopAssistantPendingState(pending);
            if (!streamStarted) {
              setAssistantBodyContent(pending.body, '');
              streamStarted = true;
            }
            const nextText = `${pending.body.dataset.rawText || ''}${data.content || ''}`;
            setAssistantBodyContent(pending.body, nextText);
            $('messages').scrollTop = $('messages').scrollHeight;
          },
          final: async (data) => {
            stopAssistantPendingState(pending);
            if (!streamStarted) {
              setAssistantBodyContent(pending.body, data.assistant?.content || 'Done.');
              streamStarted = true;
            } else if (!(pending.body.dataset.rawText || '').trim() && data.assistant?.content) {
              setAssistantBodyContent(pending.body, data.assistant.content);
            }

            detailsText = buildResponseDetails({
              assistant: data.assistant,
              selectedAgent: data.selectedAgent,
              privacy: data.privacy,
              attestation: data.attestation,
              proofArtifact: data.proofArtifact,
              batch: data.batch,
              intent: data.intent,
              fallback: String(data.assistant?.providerId || '').startsWith('seeded:')
            });

            const existing = pending.el.querySelector('.msg-details');
            if (detailsText && !existing) {
              attachDetails(pending.el, detailsText);
            } else if (detailsText && existing) {
              const details = existing.querySelector('div');
              if (details) details.textContent = detailsText;
            } else if (!detailsText && existing) {
              existing.remove();
            }
            saveChatHistory();
          },
          approval_required: async (data) => {
            stopAssistantPendingState(pending);
	            setAssistantBodyContent(pending.body, data.actionRun?.connector === 'browser-worker-demo-v1' ? '' : (data.actionRun?.summary || 'Action plan ready for approval.'));
            attachActionCard(pending, data);
            attachDetails(pending.el, renderDetailLines([
              buildWorkflowLine(data.selectedAgent?.laneId || data.intent?.capability || capability),
              buildPrivacyLine(data.privacy)
            ]));
          },
          attempt_error: async (data) => {
            setAssistantPendingState(
              pending,
              'Retrying',
              pending.el.dataset.pendingCapability || capability,
              pending.el.dataset.pendingLaneLabel || ''
            );
            detailsText = renderDetailLines([
              `Provider: ${data.providerId || data.agentId}`,
              `Reason: ${data.error}`
            ]);
            let existing = pending.el.querySelector('.msg-details');
            if (!existing) {
              existing = attachDetails(pending.el, detailsText);
            }
            const details = existing.querySelector('div');
            if (details) details.textContent = detailsText;
          },
          error: async (data) => {
            stopAssistantPendingState(pending);
            pending.el.remove();
            addMessage('assistant', `Error: ${data.error || 'provider_execution_failed'}`);
          }
        });
        if (lazyBootState.advanced || $('settingsAdvancedSection')?.open) {
          await refresh();
        }
      } catch (e) {
        stopAssistantPendingState(pending);
        pending.el.remove();
        addMessage('assistant', `Error: ${e.message}`);
      }
    }

    $('sendBtn').addEventListener('click', () => void submitIntentFromChat());
    $('chatPrompt').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void submitIntentFromChat();
      }
    });
    $('chatPrompt').addEventListener('input', (e) => {
      e.target.style.height = '24px';
      e.target.style.height = `${Math.min(e.target.scrollHeight, 88)}px`;
    });

    $('controlsClaimAlphaBtn').addEventListener('click', async () => {
      const requesterId = getRequesterId();
      try {
        if (!requesterId) throw new Error('requester_id_required');
        const res = await fetch('/billing/credits/bootstrap', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ requesterId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'topup_failed');
        $('controlsCreditsMsg').textContent = `Claimed ${formatCreditCount(data.grantedCredits)} free credits. Available: ${formatCreditCount(data.account.availableCredits)}.`;
        await refreshCreditsBalance();
      } catch (e) {
        $('controlsCreditsMsg').textContent = e.message;
      }
    });

    $('controlsCheckAlphaBtn').addEventListener('click', async () => {
      try {
        await refreshCreditsBalance();
        await refreshEvmWalletStatus().catch(() => null);
      } catch (e) {
        $('controlsCreditsMsg').textContent = e.message;
      }
    });

    $('controlsRefreshCreditsBtn').addEventListener('click', async () => {
      try {
        syncRequesterFields();
        await refreshCreditsBalance();
        await refreshEvmWalletStatus().catch(() => null);
      } catch (e) {
        $('controlsCreditsMsg').textContent = e.message;
      }
    });

    $('controlsReleaseLocksBtn').addEventListener('click', async () => {
      try {
        syncRequesterFields();
        const data = await releaseStaleCreditLocks();
        const released = Array.isArray(data.releasedSessionIds) ? data.releasedSessionIds : [];
        $('controlsCreditsMsg').textContent = released.length
          ? `Released stale holds for ${released.join(', ')}.`
          : 'No stale holds to release.';
        await refreshCreditsBalance();
        await refreshEvmWalletStatus().catch(() => null);
      } catch (e) {
        $('controlsCreditsMsg').textContent = e.message;
      }
    });

    $('controlsTopup5Btn').addEventListener('click', async () => {
      try {
        syncRequesterFields();
        if (hasStoredVaultDeviceAuth()) {
          await authorizeSensitiveAction('Authorize a 5,000 credit top-up');
        }
        await openStripeTopup(5000);
        $('controlsCreditsMsg').textContent = 'Opened Stripe checkout for 5,000 credits.';
      } catch (e) {
        $('controlsCreditsMsg').textContent = e.message;
      }
    });

    $('controlsTopup25Btn').addEventListener('click', async () => {
      try {
        syncRequesterFields();
        if (hasStoredVaultDeviceAuth()) {
          await authorizeSensitiveAction('Authorize a 2,500 credit top-up');
        }
        await openStripeTopup(2500);
        $('controlsCreditsMsg').textContent = 'Opened Stripe checkout for 2,500 credits.';
      } catch (e) {
        $('controlsCreditsMsg').textContent = e.message;
      }
    });

    $('controlsCopyInviteBtn').addEventListener('click', async () => {
      try {
        const inviteLink = await copyInviteLink();
        $('controlsCreditsMsg').textContent = `Copied invite link: ${inviteLink}`;
      } catch (e) {
        $('controlsCreditsMsg').textContent = e.message;
      }
    });

    $('controlsRedeemReferralBtn').addEventListener('click', async () => {
      try {
        const data = await redeemReferralCode();
        $('controlsCreditsMsg').textContent = `Referral redeemed. You earned ${formatCreditCount(data.friendBonusCredits || 0)} credits.`;
      } catch (e) {
        $('controlsCreditsMsg').textContent = e.message;
      }
    });

    $('saveLocalMemoryBtn').addEventListener('click', async () => {
      try {
        const saved = saveLocalMemorySettings({
          enabled: Boolean($('localMemoryEnabled')?.checked),
          resumeLastThread: Boolean($('localMemoryResumeThread')?.checked),
          note: $('localMemoryNote')?.value || ''
        });
        applyLocalMemorySettingsUi(saved);
      } catch (e) {
        $('localMemoryStatus').textContent = e.message;
      }
    });

    $('clearLocalMemoryBtn').addEventListener('click', async () => {
      try {
        clearLocalMemorySettings();
      } catch (e) {
        $('localMemoryStatus').textContent = e.message;
      }
    });

    $('authRegisterBtn').addEventListener('click', async () => {
      try {
        await registerAccount();
      } catch (e) {
        $('authStatus').textContent = e.message;
      }
    });

    $('authLoginBtn').addEventListener('click', async () => {
      try {
        await loginAccount();
      } catch (e) {
        $('authStatus').textContent = e.message;
      }
    });

    $('authGoogleBtn').addEventListener('click', async () => {
      try {
        await startGoogleAuthFlow();
      } catch (e) {
        $('authStatus').textContent = e.message;
      }
    });

    $('authLogoutBtn').addEventListener('click', async () => {
      try {
        await logoutAccount();
      } catch (e) {
        $('authStatus').textContent = e.message;
      }
    });

    $('googleConnectBtn').addEventListener('click', async () => {
      try {
        await startGoogleConnectorFlow();
      } catch (e) {
        $('googleConnectorStatus').textContent = e.message;
      }
    });

    $('googleSavePolicyBtn').addEventListener('click', async () => {
      try {
        await saveGoogleConnectorPolicy();
      } catch (e) {
        $('googleConnectorPolicyStatus').textContent = e.message;
      }
    });

    $('googleDisconnectBtn').addEventListener('click', async () => {
      try {
        await disconnectGoogleConnector();
      } catch (e) {
        $('googleConnectorStatus').textContent = e.message;
      }
    });

    $('githubConnectBtn').addEventListener('click', async () => {
      try {
        await startGitHubConnectorFlow();
      } catch (e) {
        $('githubConnectorStatus').textContent = e.message;
      }
    });

    $('githubSavePolicyBtn').addEventListener('click', async () => {
      try {
        await saveGitHubConnectorPolicy();
      } catch (e) {
        $('githubConnectorPolicyStatus').textContent = e.message;
      }
    });

    $('githubDisconnectBtn').addEventListener('click', async () => {
      try {
        await disconnectGitHubConnector();
      } catch (e) {
        $('githubConnectorStatus').textContent = e.message;
      }
    });

    $('evmWalletConnectBtn').addEventListener('click', async () => {
      try {
        await connectEvmWallet();
      } catch (e) {
        $('evmWalletStatus').textContent = e.message;
      }
    });

    $('evmSavePolicyBtn').addEventListener('click', async () => {
      try {
        await saveEvmWalletPolicy();
      } catch (e) {
        $('evmWalletPolicyStatus').textContent = e.message;
      }
    });

    $('evmWalletDisconnectBtn').addEventListener('click', async () => {
      try {
        await disconnectEvmWallet();
      } catch (e) {
        $('evmWalletStatus').textContent = e.message;
      }
    });

    $('evmTopup5Btn').addEventListener('click', async () => {
      try {
        const { request, txHash, openedInWallet } = await prepareAndSubmitEvmWalletPayment({
          mode: 'credit_topup',
          credits: 5000
        });
        $('controlsCreditsMsg').textContent = openedInWallet
          ? `Opened a ${request.amountDisplay} ${request.assetSymbol} wallet invoice for Magic City. Credits appear after the transfer is submitted and verified.`
          : `Submitted ${request.amountDisplay} ${request.assetSymbol} top-up to Magic City. Credits will appear after onchain verification. Tx ${String(txHash).slice(0, 10)}…`;
      } catch (e) {
        $('controlsCreditsMsg').textContent = e.message;
      }
    });

    $('evmTopup25Btn').addEventListener('click', async () => {
      try {
        const { request, txHash, openedInWallet } = await prepareAndSubmitEvmWalletPayment({
          mode: 'credit_topup',
          credits: 2500
        });
        $('controlsCreditsMsg').textContent = openedInWallet
          ? `Opened a ${request.amountDisplay} ${request.assetSymbol} wallet invoice for Magic City. Credits appear after the transfer is submitted and verified.`
          : `Submitted ${request.amountDisplay} ${request.assetSymbol} top-up to Magic City. Credits will appear after onchain verification. Tx ${String(txHash).slice(0, 10)}…`;
      } catch (e) {
        $('controlsCreditsMsg').textContent = e.message;
      }
    });

    $('refreshSettlementRegistryBtn').addEventListener('click', async () => {
      try {
        await refreshSettlementRegistry();
      } catch (e) {
        $('settlementRegistrySummary').textContent = e.message;
      }
    });

    $('intentBuyer').addEventListener('change', async () => {
      syncRequesterFields();
      await refreshCreditsBalance().catch(() => null);
    });
    $('collapseBtn').addEventListener('click', () => {
      $('shell').classList.remove('sidebar-open');
      syncComposerLauncherState();
    });

    $('openSidebarBtn').addEventListener('click', () => {
      $('shell').classList.add('sidebar-open');
      closeNavMenu();
      syncComposerLauncherState();
    });

    $('mobileSidebarBtn').addEventListener('click', () => {
      $('shell').classList.toggle('sidebar-open');
      syncComposerLauncherState();
    });

    $('clearChatBtn').addEventListener('click', () => {
      $('messages').innerHTML = '';
      setActiveThreadId(null);
      $('threadPopup').classList.remove('open');
      syncComposerLauncherState();
      renderThreadOptions();
      updateHero();
    });

    $('newThreadBtn').addEventListener('click', () => {
      $('messages').innerHTML = '';
      setActiveThreadId(null);
      renderThreadOptions();
      $('threadPopup').classList.remove('open');
      syncComposerLauncherState();
      updateHero();
    });

    $('threadToggleBtn').addEventListener('click', () => {
      $('threadPopup').classList.toggle('open');
      $('helperPopup').classList.remove('open');
      $('navMenuPopup').classList.remove('open');
      syncComposerLauncherState();
      if ($('threadPopup').classList.contains('open')) positionThreadPopup();
      renderThreadOptions();
    });

    $('threadSearchInput')?.addEventListener('input', renderThreadOptions);

    $('helperToggleBtn').addEventListener('click', openHelperPopup);

    $('navMenuToggleBtn').addEventListener('click', () => {
      $('navMenuPopup').classList.toggle('open');
      $('threadPopup').classList.remove('open');
      $('helperPopup').classList.remove('open');
      syncComposerLauncherState();
    });

    $('navMenuPopup').addEventListener('click', (event) => {
      const action = event.target.closest('[data-nav-action]')?.dataset.navAction;
      if (!action) return;
      closeNavMenu();
      if (action === 'settings') {
        $('shell').classList.add('sidebar-open');
        syncComposerLauncherState();
        return;
      }
      if (action === 'history') {
        $('threadPopup').classList.add('open');
        $('helperPopup').classList.remove('open');
        syncComposerLauncherState();
        positionThreadPopup();
        renderThreadOptions();
        return;
      }
      if (action === 'agents') {
        $('helperPopup').classList.add('open');
        $('threadPopup').classList.remove('open');
        syncComposerLauncherState();
        positionHelperPopup();
        ensurePlatformWorkflowRegistryLoaded().catch(() => {});
      }
    });

    $('helperPopup').addEventListener('click', (event) => {
      const helper = event.target.closest('[data-helper]')?.dataset.helper;
      if (!helper) return;
      launchHelper(helper);
    });

    $('saveVaultBtn').addEventListener('click', async () => {
      try {
        if (!hasWebAuthnSupport()) {
          $('vaultStatus').textContent = 'This browser cannot use device unlock here. Use the legacy passphrase section only if you need to recover an older vault.';
          updateVaultUiState();
          return;
        }
        await saveVaultWithDeviceUnlock();
        $('vaultStatus').textContent = hasStoredVaultDeviceAuth()
          ? 'Local data vault saved, encrypted, and locked behind device unlock.'
          : 'Device unlock setup complete. Your local data vault is now protected.'
          ;
        updateVaultUiState();
      } catch (error) {
        $('vaultStatus').textContent = error?.message === 'device_unlock_setup_cancelled' || error?.message === 'device_authorization_cancelled'
          ? 'Device unlock was cancelled.'
          : error?.message === 'device_unlock_not_supported'
            ? 'Device unlock is not supported in this browser context.'
            : `Could not secure the local vault: ${error.message}`;
        updateVaultUiState();
      }
    });

    $('unlockVaultBtn').addEventListener('click', async () => {
      const record = getStoredVaultRecord();
      if (!record) {
        $('vaultStatus').textContent = 'No saved private profile yet.';
        return;
      }
      if (hasLegacyVaultRecord() && !hasStoredVaultDeviceAuth()) {
        $('vaultStatus').textContent = 'This saved vault still uses the legacy passphrase flow. Use the legacy section once, then migrate it to device unlock.';
        updateVaultUiState();
        return;
      }
      try {
        await unlockVaultWithDevice('Unlock your local data vault');
        $('vaultStatus').textContent = 'Private profile unlocked locally after device verification.';
        updateVaultUiState();
      } catch (error) {
        $('vaultStatus').textContent = error?.message === 'device_authorization_cancelled'
          ? 'Device verification was cancelled.'
          : error?.message === 'legacy_vault_requires_passphrase'
            ? 'This saved vault still needs the legacy passphrase once before it can be migrated.'
            : `Could not unlock the private profile: ${error.message}`;
        updateVaultUiState();
      }
    });

    $('vaultLegacyUnlockBtn')?.addEventListener('click', async () => {
      const passphrase = $('vaultLegacyPassphrase')?.value || '';
      if (!passphrase) {
        $('vaultLegacyStatus').textContent = 'Enter the legacy passphrase to unlock the older saved vault.';
        return;
      }
      try {
        const payload = await unlockLegacyVaultWithPassphrase(passphrase);
        sessionStorage.setItem('magic_city_profile_vault_unlocked', JSON.stringify(payload));
        writeVaultDraftToInputs(payload);
        $('vaultLegacyStatus').textContent = 'Legacy vault unlocked locally. You can now migrate it to device unlock.';
        $('vaultStatus').textContent = 'Legacy vault unlocked locally. Save once to migrate it to device unlock.';
        updateVaultUiState();
      } catch {
        $('vaultLegacyStatus').textContent = 'Could not unlock the legacy vault. Check the passphrase.';
      }
    });

    $('vaultLegacyMigrateBtn')?.addEventListener('click', async () => {
      const passphrase = $('vaultLegacyPassphrase')?.value || '';
      if (!passphrase) {
        $('vaultLegacyStatus').textContent = 'Enter the legacy passphrase so Magic City can migrate this saved vault to device unlock.';
        return;
      }
      if (!hasWebAuthnSupport()) {
        $('vaultLegacyStatus').textContent = 'This browser cannot use device unlock here, so migration is unavailable.';
        return;
      }
      try {
        const payload = await unlockLegacyVaultWithPassphrase(passphrase);
        await configureVaultDeviceUnlock(payload);
        $('vaultLegacyPassphrase').value = '';
        $('vaultLegacyStatus').textContent = 'Legacy vault migrated to device unlock.';
        $('vaultStatus').textContent = 'Local data vault migrated to device unlock and locked.';
        updateVaultUiState();
      } catch (error) {
        $('vaultLegacyStatus').textContent = error?.message === 'device_unlock_setup_cancelled'
          ? 'Migration cancelled during device unlock setup.'
          : `Could not migrate the legacy vault: ${error.message}`;
      }
    });

    $('clearVaultBtn').addEventListener('click', async () => {
      const auth = getStoredVaultAuth();
      localStorage.removeItem(PROFILE_VAULT_KEY);
      localStorage.removeItem(PROFILE_VAULT_AUTH_KEY);
      sessionStorage.removeItem('magic_city_profile_vault_unlocked');
      if ($('vaultLegacyPassphrase')) $('vaultLegacyPassphrase').value = '';
      writeVaultDraftToInputs({});
      if (auth?.credentialId) {
        try {
          await deleteVaultContentKey(auth.credentialId);
        } catch {}
      }
      $('vaultStatus').textContent = 'Private profile cleared from this browser.';
      if ($('vaultLegacyStatus')) $('vaultLegacyStatus').textContent = 'Legacy passphrase fallback is hidden unless needed.';
      updateVaultUiState();
    });

    $('threadList').addEventListener('click', (event) => {
      const openId = event.target.closest('[data-thread-open]')?.dataset.threadOpen;
      const renameId = event.target.closest('[data-thread-rename]')?.dataset.threadRename;
      const deleteId = event.target.closest('[data-thread-delete]')?.dataset.threadDelete;

      if (openId) {
        setActiveThreadId(openId);
        restoreThread(openId);
        renderThreadOptions();
        $('threadPopup').classList.remove('open');
        syncComposerLauncherState();
        return;
      }

      if (renameId) {
        const current = loadThreads().find((thread) => thread.id === renameId);
        const title = window.prompt('Rename chat', current?.title || 'New chat');
        if (title !== null) renameThread(renameId, title);
        return;
      }

      if (deleteId) {
        const wasActive = getActiveThreadId() === deleteId;
        const ok = window.confirm('Delete this chat thread?');
        if (!ok) return;
        deleteThread(deleteId);
        if (wasActive) {
          $('messages').innerHTML = '';
          updateHero();
        }
        renderThreadOptions();
      }
    });

    function isAmbiguousActionApprovalError(error) {
      const message = String(error?.message || error || '').toLowerCase();
      return message.includes('network_request_failed')
        || message.includes('failed to fetch')
        || message.includes('networkerror')
        || message.includes('load failed');
    }

    async function approveActionWithRecovery(actionRunId) {
      const path = `/actions/${encodeURIComponent(actionRunId)}/approve`;
      const request = () => api(path, { method: 'POST', body: JSON.stringify({}) });
      try {
        return await request();
      } catch (error) {
        if (!isAmbiguousActionApprovalError(error)) throw error;
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        return request();
      }
    }

    $('messages').addEventListener('click', async (event) => {
      const approveId = event.target.closest('[data-action-approve]')?.dataset.actionApprove;
      const rejectId = event.target.closest('[data-action-reject]')?.dataset.actionReject;
      if (!approveId && !rejectId) return;

      const messageEl = event.target.closest('.msg.assistant');
      if (!messageEl) return;
      const card = messageEl.querySelector('.action-card');
      if (!card) return;
      const buttons = [...card.querySelectorAll('button')];
      buttons.forEach((button) => { button.disabled = true; });

      try {
        if (approveId) {
          const data = await approveActionWithRecovery(approveId);
          messageEl.classList.remove('action-pending');
          setAssistantBodyContent(messageEl.querySelector('.msg-body'), data.assistant?.content || 'Action executed.');
          card.remove();
          if (data.connectorSession?.id) {
            await renderExecutionSheet(data.connectorSession.id);
          }
          attachDetails(messageEl, renderDetailLines([
            data.assistant?.providerId ? `Model: ${data.assistant.providerId}` : '',
            buildWorkflowLine(data.intent?.capability),
            data.connectorSession?.id ? `Connector session: ${data.connectorSession.id}` : '',
            'Action: approved and executed'
          ]));
        } else if (rejectId) {
          await api(`/actions/${rejectId}/reject`, { method: 'POST', body: JSON.stringify({}) });
          messageEl.classList.remove('action-pending');
          setAssistantBodyContent(messageEl.querySelector('.msg-body'), 'Action rejected. Locked credits were released.');
          card.remove();
          attachDetails(messageEl, 'Action: rejected');
        }
        saveChatHistory();
        if (lazyBootState.advanced || $('settingsAdvancedSection')?.open) {
          await refresh();
        }
      } catch (error) {
        setAssistantBodyContent(messageEl.querySelector('.msg-body'), `Error: ${error.message}`);
        buttons.forEach((button) => { button.disabled = false; });
      }
    });

    document.addEventListener('click', (event) => {
      const inNavMenu = event.target.closest('#navMenuPopup') || event.target.closest('#navMenuToggleBtn');
      const inThreads = event.target.closest('#threadPopup') || event.target.closest('#threadToggleBtn');
      const inHelpers = event.target.closest('#helperPopup') || event.target.closest('#helperToggleBtn');
      if (!inNavMenu) $('navMenuPopup').classList.remove('open');
      if (!inThreads) $('threadPopup').classList.remove('open');
      if (!inHelpers) $('helperPopup').classList.remove('open');
      syncComposerLauncherState();
    });

    document.querySelector('.main')?.addEventListener('click', (event) => {
      if (isInteractiveUiTarget(event.target)) return;
      collapseWorkspaceChrome();
    });

    window.addEventListener('message', async (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'magic_city_google_auth') {
        await refreshAuthSession().catch(() => null);
        await refreshCreditsBalance().catch(() => null);
        if (!event.data?.ok && $('authStatus')) {
          $('authStatus').textContent = event.data?.error || 'Google sign-in did not complete.';
        }
        return;
      }
      if (event.data?.type === 'magic_city_github_auth') {
        await refreshAuthSession().catch(() => null);
        await refreshCreditsBalance().catch(() => null);
        if (!event.data?.ok && $('authStatus')) {
          $('authStatus').textContent = event.data?.error || 'GitHub sign-in did not complete.';
        }
        return;
      }
      if (event.data?.type === 'magic_city_google_connector') {
        await refreshAuthSession().catch(() => null);
        await refreshGoogleConnectorStatus().catch(() => null);
        await refreshGitHubConnectorStatus().catch(() => null);
        await refreshEvmWalletStatus().catch(() => null);
        if (!event.data?.ok && $('googleConnectorStatus')) {
          $('googleConnectorStatus').textContent = event.data?.error || 'Google connection did not complete.';
        }
        return;
      }
      if (event.data?.type === 'magic_city_github_connector') {
        await refreshAuthSession().catch(() => null);
        await refreshGitHubConnectorStatus().catch(() => null);
        if (!event.data?.ok && $('githubConnectorStatus')) {
          $('githubConnectorStatus').textContent = event.data?.error || 'GitHub connection did not complete.';
        }
      }
    });

    document.querySelectorAll('#sidebar > details').forEach((section) => {
      section.addEventListener('toggle', () => {
        if (!section.open) return;
        document.querySelectorAll('#sidebar > details').forEach((other) => {
          if (other !== section) other.open = false;
        });
        const sectionId = section.id || '';
        if (sectionId === 'settingsIdentitySection') {
          ensureIdentitySectionData().catch(() => {});
          return;
        }
        if (sectionId === 'settingsWalletSection') {
          ensureWalletSectionData().catch(() => {});
          return;
        }
        if (sectionId === 'settingsAccountsSection') {
          ensureConnectedAccountsSectionData().catch(() => {});
          return;
        }
        if (sectionId === 'settingsAdvancedSection') {
          ensureAdvancedSectionData().catch(() => {});
        }
      });
    });

    window.addEventListener('resize', () => {
      if ($('navMenuPopup')?.classList.contains('open')) closeNavMenu();
      if ($('threadPopup')?.classList.contains('open')) positionThreadPopup();
      if ($('helperPopup')?.classList.contains('open')) positionHelperPopup();
      syncComposerPlaceholder();
    });

    const pageBgVideo = $('pageBgVideo');
    const pageBg = pageBgVideo?.closest('.page-bg');
    let appShellRevealed = false;
    let deferredBootStarted = false;
    let backgroundVideoScheduled = false;
    const isMobileLikeViewport = () => {
      const width = window.innerWidth || document.documentElement.clientWidth || 0;
      const height = window.innerHeight || document.documentElement.clientHeight || 0;
      const shortSide = Math.min(width || 0, height || 0);
      return width <= 760 || shortSide <= 540 || height > width;
    };
    const chooseBackgroundVideoSource = () => {
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
      const saveData = Boolean(connection?.saveData);
      const effectiveType = String(connection?.effectiveType || '').toLowerCase();
      const width = window.innerWidth || document.documentElement.clientWidth || 0;
      const height = window.innerHeight || document.documentElement.clientHeight || 0;
      const shortSide = Math.min(width || 0, height || 0);
      const isPortrait = height > width;
      const lowBandwidth = effectiveType.includes('2g') || effectiveType === 'slow-2g';
      const lowPowerDevice = Number(navigator.deviceMemory || 0) > 0 && Number(navigator.deviceMemory || 0) <= 4;
      const lowCoreCount = Number(navigator.hardwareConcurrency || 0) > 0 && Number(navigator.hardwareConcurrency || 0) <= 4;
      if (reduceMotion || saveData || lowBandwidth) return null;
      if (isPortrait || shortSide <= 900 || lowPowerDevice || lowCoreCount) {
        return '/assets/magic-city-bg-540p.mp4';
      }
      return '/assets/magic-city-bg-1080p.mp4';
    };
    const scheduleBackgroundVideoStart = () => {
      if (backgroundVideoScheduled) return;
      backgroundVideoScheduled = true;
      const delay = isMobileLikeViewport() ? 420 : 120;
      const launch = () => {
        startBackgroundVideo();
      };
      window.setTimeout(launch, delay);
    };
    const startDeferredBootTasks = () => {
      if (deferredBootStarted) return;
      deferredBootStarted = true;
      syncRequesterFields();
      const shouldRefreshIdentity =
        Boolean(googleAuthResult || googleAuthError || githubAuthResult || githubAuthError || googleConnectorResult || googleConnectorError || githubConnectorResult || githubConnectorError);
      if (shouldRefreshIdentity) {
        bootstrapSessionIfNeeded(true)
          .then(() => Promise.all([
            (googleAuthResult || googleAuthError || googleConnectorResult || googleConnectorError)
              ? refreshGoogleConnectorStatus().catch(() => null)
              : null,
            (githubAuthResult || githubAuthError || githubConnectorResult || githubConnectorError)
              ? refreshGitHubConnectorStatus().catch(() => null)
              : null,
            (googleAuthResult || githubAuthResult || googleConnectorResult || githubConnectorResult)
              ? refreshCreditsBalance().catch(() => null)
              : null,
            (googleAuthResult || githubAuthResult || googleConnectorResult || githubConnectorResult)
              ? refreshRewardsSummary().catch(() => null)
              : null,
            (googleConnectorResult || githubConnectorResult)
              ? refreshEvmWalletStatus().catch(() => null)
              : null
          ]))
          .finally(() => {
            restoreCurrentIdentityThread();
          });
      }
      if (startupQuery.get('stripe') === 'success') {
        maybeVerifyStripeSuccess().catch(() => {});
      }
      if (startupQuery.get('square') === 'success') {
        maybeVerifySquareSuccess().catch(() => {});
      }
    };
    const startBackgroundVideo = () => {
      if (!pageBgVideo || pageBgVideo.dataset.started === 'true') return;
      const src = chooseBackgroundVideoSource();
      if (!src) {
        backgroundVisualRequired = true;
        backgroundVisualReady = false;
        revealAppOnce();
        return;
      }
      backgroundVisualRequired = true;
      scheduleBootFallback();
      pageBgVideo.dataset.started = 'true';
      backgroundPlaybackStarted = false;
      pageBgVideo.pause?.();
      pageBgVideo.src = src;
      pageBgVideo.load();
      if (pageBgVideo.readyState >= 2) {
        markBackgroundVisualReady();
      }
    };
    const revealAppOnce = () => {
      if (appShellRevealed) return;
      appShellRevealed = true;
      revealAppShell();
      schedulePostPaintWork(startDeferredBootTasks, 1500);
    };
    pageBgVideo?.addEventListener('loadeddata', markBackgroundVisualReady, { once: true });
    pageBgVideo?.addEventListener('canplay', markBackgroundVisualReady, { once: true });
    window.addEventListener('load', () => {
      scheduleBackgroundVideoStart();
      if (!pageBgVideo) revealAppOnce();
    }, { once: true });
    window.addEventListener('pageshow', () => {
      if (pageBgVideo?.readyState >= 2) {
        markBackgroundVisualReady();
        return;
      }
      scheduleBackgroundVideoStart();
    });
    window.setTimeout(scheduleBackgroundVideoStart, 80);

    renderThreadOptions();
    syncComposerLauncherState();
    syncComposerPlaceholder();
    waitForHeroCopyReady();
    const startupQuery = new URLSearchParams(window.location.search);
    const urlReferralCode = getUrlReferralCode();
    const googleAuthResult = startupQuery.get('google_auth');
    const googleAuthError = startupQuery.get('google_auth_error');
    const githubAuthResult = startupQuery.get('github_auth');
    const githubAuthError = startupQuery.get('github_auth_error');
    const googleConnectorResult = startupQuery.get('google_connector');
    const googleConnectorError = startupQuery.get('google_connector_error');
    const githubConnectorResult = startupQuery.get('github_connector');
    const githubConnectorError = startupQuery.get('github_connector_error');
    if (urlReferralCode) {
      if ($('controlsRedeemReferralInput') && !$('controlsRedeemReferralInput').value.trim()) $('controlsRedeemReferralInput').value = urlReferralCode;
    }
    if (googleAuthResult === 'success' && $('authStatus')) {
      $('authStatus').textContent = 'Google sign-in completed. Refreshing your Magic City account…';
    }
    if (googleAuthError && $('authStatus')) {
      $('authStatus').textContent = googleAuthError;
    }
    if (githubAuthResult === 'success' && $('authStatus')) {
      $('authStatus').textContent = 'GitHub sign-in completed. Refreshing your Magic City account…';
    }
    if (githubAuthError && $('authStatus')) {
      $('authStatus').textContent = githubAuthError;
    }
    if (googleConnectorResult === 'success' && $('googleConnectorStatus')) {
      $('googleConnectorStatus').textContent = 'Google agent access enabled. Refreshing connector status…';
    }
    if (googleConnectorError && $('googleConnectorStatus')) {
      $('googleConnectorStatus').textContent = googleConnectorError;
    }
    if (githubConnectorResult === 'success' && $('githubConnectorStatus')) {
      $('githubConnectorStatus').textContent = 'GitHub repo execution enabled. Refreshing connector status…';
    }
    if (githubConnectorError && $('githubConnectorStatus')) {
      $('githubConnectorStatus').textContent = githubConnectorError;
    }
    if (googleAuthResult || googleAuthError || githubAuthResult || githubAuthError || googleConnectorResult || googleConnectorError || githubConnectorResult || githubConnectorError) {
      startupQuery.delete('google_auth');
      startupQuery.delete('google_auth_error');
      startupQuery.delete('github_auth');
      startupQuery.delete('github_auth_error');
      startupQuery.delete('google_connector');
      startupQuery.delete('google_connector_error');
      startupQuery.delete('github_connector');
      startupQuery.delete('github_connector_error');
      const nextQuery = startupQuery.toString();
      const cleanUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash || ''}`;
      window.history.replaceState({}, '', cleanUrl);
    }
    try {
      const unlocked = sessionStorage.getItem('magic_city_profile_vault_unlocked');
      if (unlocked) writeVaultDraftToInputs(JSON.parse(unlocked));
    } catch {}
    updateVaultUiState();
    updateHero();
    schedulePostPaintWork(startDeferredBootTasks, 2200);

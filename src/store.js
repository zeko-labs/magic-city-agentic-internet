import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import pg from 'pg';
import { CREDIT_SCALE, toUnits } from './units.js';
import { buildPostgresPoolOptions } from './postgresConfig.js';

const { Pool } = pg;
const DATA_PATH = path.resolve(process.cwd(), 'data', 'state.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const STATE_ROW_KEY = 'global';
const STATE_SCHEMA_VERSION = 'magic-city-state-v2';
const REQUIRE_PRODUCTION_PERSISTENCE = String(process.env.MAGIC_CITY_REQUIRE_PRODUCTION_PERSISTENCE || '').toLowerCase() === 'true';
const REQUIRE_STATE_ENCRYPTION = String(process.env.MAGIC_CITY_REQUIRE_STATE_ENCRYPTION || (REQUIRE_PRODUCTION_PERSISTENCE ? 'true' : 'false')).toLowerCase() === 'true';
const STATE_ENCRYPTION_KEY_RAW = String(process.env.MAGIC_CITY_STATE_ENCRYPTION_KEY || '').trim();
const POSTGRES_SINGLE_WRITER = String(process.env.MAGIC_CITY_POSTGRES_SINGLE_WRITER || (REQUIRE_PRODUCTION_PERSISTENCE ? 'true' : 'false')).toLowerCase() === 'true';
const POSTGRES_WRITER_LOCK_KEY = String(process.env.MAGIC_CITY_POSTGRES_WRITER_LOCK_KEY || 'magic-city-state-writer-v1').trim();
const FILE_PERSIST_MODE = String(process.env.MAGIC_CITY_FILE_PERSIST_MODE || '').trim().toLowerCase();
const ASYNC_FILE_PERSIST = FILE_PERSIST_MODE === 'async' || FILE_PERSIST_MODE === 'coalesced';
const FILE_PERSIST_DELAY_MS = Math.max(25, Math.min(Number(process.env.MAGIC_CITY_FILE_PERSIST_DELAY_MS || 150) || 150, 1000));
const ALLOW_STATE_RESET_ON_READ_ERROR = String(process.env.MAGIC_CITY_ALLOW_STATE_RESET_ON_READ_ERROR || '').toLowerCase() === 'true';
const MAX_CONNECTOR_ACTIVITY_ROWS = Math.max(
  100,
  Math.min(Number(process.env.MAGIC_CITY_MAX_CONNECTOR_ACTIVITY_ROWS || 1000) || 1000, 10000)
);
const POSTGRES_PERSIST_TIMING_LOG_MS = Math.max(
  100,
  Number(process.env.MAGIC_CITY_POSTGRES_PERSIST_TIMING_LOG_MS || 1000) || 1000
);

const defaultState = () => ({
  agents: {},
  attestations: [],
  receipts: [],
  intents: [],
  actionRuns: [],
  connectorSessions: [],
  agentSdkMissions: [],
  pluginRegistrations: [],
  santaclawzPreflightSnapshots: [],
  santaclawzRuntimeHealth: [],
  anchorSubmissions: [],
  mbaMissionRegistryStates: {},
  settlementRegistry: [],
  balances: {},
  stakes: {},
  userAccounts: {},
  authUsers: {},
  authSessions: {},
  authPasswordResets: {},
  walletChallenges: {},
  oauthClients: {},
  oauthAuthorizationCodes: {},
  oauthAccessTokens: {},
  oauthRefreshTokens: {},
  escrowLocks: {},
  ledger: [],
  ledgerMeta: {
    lastHash: null,
    lastSequence: 0,
    updatedAt: null
  },
  ledgerIdempotency: {},
  referralClaims: [],
  shareRewardClaims: [],
  payoutRequests: [],
  agentSavedSignals: [],
  merchantSettlements: [],
  connectorActivity: [],
  personalAgentRuntimes: [],
  nativeRunnerDevices: [],
  nativeRunnerPairingSessions: [],
  paymentAuthorizations: [],
  ethereumShadowRelayerJobs: [],
  ethereumConfirmationIndexJobs: [],
  platformTreasury: {
    captured: 0,
    burned: 0,
    merchantPayable: 0,
    merchantSettled: 0,
    netRevenue: 0,
    capturedSessions: 0,
    pendingMerchantSettlements: 0,
    settledMerchantSessions: 0,
    updatedAt: null,
    lastIntentId: null,
    lastSettlementId: null
  },
  unitScale: CREDIT_SCALE,
  processedStripeEvents: {},
  payoutByTransferId: {}
});

function withDefaults(raw = {}) {
  delete raw.navaTransactions;
  raw.agents = raw.agents ?? {};
  raw.attestations = raw.attestations ?? [];
  raw.receipts = raw.receipts ?? [];
  raw.intents = raw.intents ?? [];
  raw.actionRuns = raw.actionRuns ?? [];
  raw.connectorSessions = raw.connectorSessions ?? [];
  raw.agentSdkMissions = raw.agentSdkMissions ?? [];
  raw.pluginRegistrations = raw.pluginRegistrations ?? [];
  raw.santaclawzPreflightSnapshots = raw.santaclawzPreflightSnapshots ?? [];
  raw.santaclawzRuntimeHealth = raw.santaclawzRuntimeHealth ?? [];
  raw.anchorSubmissions = raw.anchorSubmissions ?? [];
  raw.mbaMissionRegistryStates = raw.mbaMissionRegistryStates ?? {};
  raw.settlementRegistry = raw.settlementRegistry ?? [];
  raw.balances = raw.balances ?? {};
  raw.stakes = raw.stakes ?? {};
  raw.userAccounts = raw.userAccounts ?? {};
  raw.authUsers = raw.authUsers ?? {};
  raw.authSessions = raw.authSessions ?? {};
  raw.authPasswordResets = raw.authPasswordResets ?? {};
  raw.walletChallenges = raw.walletChallenges ?? {};
  raw.oauthClients = raw.oauthClients ?? {};
  raw.oauthAuthorizationCodes = raw.oauthAuthorizationCodes ?? {};
  raw.oauthAccessTokens = raw.oauthAccessTokens ?? {};
  raw.oauthRefreshTokens = raw.oauthRefreshTokens ?? {};
  raw.escrowLocks = raw.escrowLocks ?? {};
  raw.ledger = raw.ledger ?? [];
  raw.ledgerIdempotency = raw.ledgerIdempotency ?? {};
  raw.ledgerMeta = raw.ledgerMeta ?? {};
  for (const row of raw.ledger) {
    const eventKey = normalizeLedgerEventKey(row?.eventKey);
    if (eventKey && row?.id && !raw.ledgerIdempotency[eventKey]) {
      raw.ledgerIdempotency[eventKey] = row.id;
    }
  }
  raw.ledgerMeta = {
    lastHash: raw.ledgerMeta.lastHash || computeLegacyLedgerBaseHash(raw.ledger),
    lastSequence: Math.max(
      Number(raw.ledgerMeta.lastSequence || 0) || 0,
      ...raw.ledger.map((row, index) => Number(row?.sequence || index + 1) || 0),
      0
    ),
    updatedAt: raw.ledgerMeta.updatedAt || null
  };
  raw.referralClaims = raw.referralClaims ?? [];
  raw.shareRewardClaims = raw.shareRewardClaims ?? [];
  raw.payoutRequests = raw.payoutRequests ?? [];
  raw.agentSavedSignals = raw.agentSavedSignals ?? [];
  raw.merchantSettlements = raw.merchantSettlements ?? [];
  raw.connectorActivity = raw.connectorActivity ?? [];
  raw.personalAgentRuntimes = raw.personalAgentRuntimes ?? [];
  raw.nativeRunnerDevices = raw.nativeRunnerDevices ?? [];
  raw.nativeRunnerPairingSessions = raw.nativeRunnerPairingSessions ?? [];
  raw.paymentAuthorizations = raw.paymentAuthorizations ?? [];
  raw.ethereumShadowRelayerJobs = raw.ethereumShadowRelayerJobs ?? [];
  raw.ethereumConfirmationIndexJobs = raw.ethereumConfirmationIndexJobs ?? [];
  raw.platformTreasury = raw.platformTreasury ?? {
    captured: 0,
    burned: 0,
    merchantPayable: 0,
    merchantSettled: 0,
    netRevenue: 0,
    capturedSessions: 0,
    pendingMerchantSettlements: 0,
    settledMerchantSessions: 0,
    updatedAt: null,
    lastIntentId: null,
    lastSettlementId: null
  };
  raw.processedStripeEvents = raw.processedStripeEvents ?? {};
  raw.payoutByTransferId = raw.payoutByTransferId ?? {};
  raw.unitScale = raw.unitScale ?? CREDIT_SCALE;
  return raw;
}

function stateBackupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function stateHasDurableRows(candidate = {}) {
  return [
    candidate.authUsers,
    candidate.userAccounts,
    candidate.ledger,
    candidate.connectorSessions,
    candidate.receipts,
    candidate.processedStripeEvents
  ].some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return false;
  });
}

function copyStateFileSync(targetPath) {
  try {
    if (!fs.existsSync(DATA_PATH)) return null;
    fs.copyFileSync(DATA_PATH, targetPath);
    return targetPath;
  } catch (error) {
    console.error('[agent-verification] state_backup_failed', error instanceof Error ? error.message : String(error));
    return null;
  }
}

function writeFileAtomicSync(filePath, snapshot) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, snapshot);
  fs.renameSync(tempPath, filePath);
}

function canonicalizeForHash(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  return Object.keys(value)
    .sort()
    .reduce((out, key) => {
      if (value[key] !== undefined) out[key] = canonicalizeForHash(value[key]);
      return out;
    }, {});
}

function hashObject(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalizeForHash(value))).digest('hex');
}

function computeLegacyLedgerBaseHash(ledger = []) {
  const rows = Array.isArray(ledger) ? ledger : [];
  const last = rows[rows.length - 1] || null;
  return hashObject({
    scope: 'magic-city-ledger-legacy-base',
    count: rows.length,
    lastId: last?.id || null,
    lastCreatedAt: last?.createdAt || null,
    lastType: last?.type || null,
    lastAmount: last?.amount ?? null
  });
}

function normalizeLedgerEventKey(value = '') {
  return String(value || '').trim().slice(0, 240);
}

function findLedgerEntryByEventKey(eventKey) {
  const normalized = normalizeLedgerEventKey(eventKey);
  if (!normalized) return null;
  const mappedId = state.ledgerIdempotency?.[normalized];
  if (mappedId) {
    return state.ledger.find((row) => row.id === mappedId) ?? null;
  }
  return state.ledger.find((row) => normalizeLedgerEventKey(row.eventKey) === normalized) ?? null;
}

function ensureLedgerMeta() {
  state.ledgerIdempotency = state.ledgerIdempotency ?? {};
  for (const row of state.ledger) {
    const eventKey = normalizeLedgerEventKey(row?.eventKey);
    if (eventKey && row?.id && !state.ledgerIdempotency[eventKey]) {
      state.ledgerIdempotency[eventKey] = row.id;
    }
  }
  state.ledgerMeta = state.ledgerMeta ?? {};
  if (!state.ledgerMeta.lastHash) {
    state.ledgerMeta.lastHash = computeLegacyLedgerBaseHash(state.ledger);
  }
  state.ledgerMeta.lastSequence = Math.max(
    Number(state.ledgerMeta.lastSequence || 0) || 0,
    ...state.ledger.map((row, index) => Number(row?.sequence || index + 1) || 0),
    0
  );
  return state.ledgerMeta;
}

async function writeFileAtomic(filePath, snapshot) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.promises.writeFile(tempPath, snapshot);
  await fs.promises.rename(tempPath, filePath);
}

let startupStateBackupCreated = false;

function createStartupStateBackup(stateSnapshot) {
  if (startupStateBackupCreated || !stateHasDurableRows(stateSnapshot)) return;
  const backupPath = `${DATA_PATH}.startup-${stateBackupTimestamp()}.json`;
  const copied = copyStateFileSync(backupPath);
  if (copied) startupStateBackupCreated = true;
}

function safeReadState({ preserveBackup = !DATABASE_URL } = {}) {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const hydrated = withDefaults(JSON.parse(raw));
    if (preserveBackup) createStartupStateBackup(hydrated);
    return hydrated;
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultState();
    const corruptBackupPath = `${DATA_PATH}.unreadable-${stateBackupTimestamp()}.json`;
    const copied = preserveBackup ? copyStateFileSync(corruptBackupPath) : null;
    const detail = error instanceof Error ? error.message : String(error);
    const message = `state_read_failed:${detail}${copied ? `; backup=${copied}` : ''}`;
    if (!ALLOW_STATE_RESET_ON_READ_ERROR) {
      throw new Error(message);
    }
    console.error(`[agent-verification] ${message}; reset allowed by MAGIC_CITY_ALLOW_STATE_RESET_ON_READ_ERROR`);
    return defaultState();
  }
}

function decodeStateEncryptionKey(value = '') {
  if (!value) return null;
  const candidates = [Buffer.from(value, 'base64')];
  if (/^[0-9a-f]{64}$/i.test(value)) candidates.push(Buffer.from(value, 'hex'));
  const key = candidates.find((candidate) => candidate.length === 32);
  if (!key) throw new Error('invalid_magic_city_state_encryption_key');
  return key;
}

const stateEncryptionKey = decodeStateEncryptionKey(STATE_ENCRYPTION_KEY_RAW);

if (DATABASE_URL && REQUIRE_STATE_ENCRYPTION && !stateEncryptionKey) {
  throw new Error('magic_city_state_encryption_key_required');
}

function stateEncryptionStatus() {
  return {
    enabled: Boolean(stateEncryptionKey),
    required: REQUIRE_STATE_ENCRYPTION,
    algorithm: stateEncryptionKey ? 'aes-256-gcm' : null,
    keyId: stateEncryptionKey
      ? crypto.createHash('sha256').update(stateEncryptionKey).digest('hex').slice(0, 16)
      : null
  };
}

function serializePostgresState(snapshot = JSON.stringify(state)) {
  if (!stateEncryptionKey) return snapshot;
  const compressed = zlib.gzipSync(Buffer.from(snapshot, 'utf8'), {
    level: zlib.constants.Z_BEST_SPEED
  });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', stateEncryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    schema: 'magic-city-encrypted-state-v2',
    alg: 'aes-256-gcm',
    compression: 'gzip',
    keyId: stateEncryptionStatus().keyId,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  });
}

function hydratePostgresState(value) {
  const encryptedSchema = value?.schema === 'magic-city-encrypted-state-v1'
    || value?.schema === 'magic-city-encrypted-state-v2';
  if (!value || typeof value !== 'object' || !encryptedSchema) {
    if (REQUIRE_STATE_ENCRYPTION && value) {
      throw new Error('unencrypted_postgres_state_not_allowed');
    }
    return withDefaults(value || defaultState());
  }
  if (!stateEncryptionKey) throw new Error('magic_city_state_encryption_key_required');
  if (value.alg !== 'aes-256-gcm') throw new Error('unsupported_magic_city_state_encryption');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', stateEncryptionKey, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64')),
      decipher.final()
    ]);
    const plaintext = value.schema === 'magic-city-encrypted-state-v2'
      ? (() => {
          if (value.compression !== 'gzip') throw new Error('unsupported_magic_city_state_compression');
          return zlib.gunzipSync(decrypted).toString('utf8');
        })()
      : decrypted.toString('utf8');
    return withDefaults(JSON.parse(plaintext));
  } catch (error) {
    throw new Error(`postgres_state_decryption_failed:${error instanceof Error ? error.message : String(error)}`);
  }
}

const pool = DATABASE_URL
  ? new Pool(buildPostgresPoolOptions({
      connectionString: DATABASE_URL,
      requirePersistence: REQUIRE_PRODUCTION_PERSISTENCE
    }))
  : null;

const persistence = {
  driver: pool ? 'postgres' : 'file',
  databaseConfigured: Boolean(DATABASE_URL),
  dataPath: DATA_PATH,
  ready: false,
  healthy: false,
  schemaVersion: STATE_SCHEMA_VERSION,
  atRestEncryption: stateEncryptionStatus(),
  singleWriterRequired: POSTGRES_SINGLE_WRITER,
  writerLockAcquired: false,
  writerLockLastAcquiredAt: null,
  writerLockLastError: null,
  migrationSource: null,
  lastWriteAt: null,
  lastWriteError: null,
  writeFailureCount: 0
};

let persistQueue = Promise.resolve();
let postgresWriterLockClient = null;
let postgresWriterLockAcquirePromise = null;
let postgresPersistDirty = false;
let postgresPersistScheduled = false;
// Revisions let each response wait for its own captured snapshot boundary.
let postgresPersistRequestedRevision = 0;
let postgresPersistCommittedRevision = 0;
let postgresPersistFailure = null;
let postgresPersistWaiters = [];
let filePersistTimer = null;
let filePersistDirty = false;
let filePersistLastError = null;
let state = defaultState();

function handlePostgresWriterLockClientError(client, error) {
  if (postgresWriterLockClient === client) {
    postgresWriterLockClient = null;
    persistence.writerLockAcquired = false;
    persistence.writerLockLastError = error instanceof Error ? error.message : String(error);
  }
  markPostgresWriteFailure(error);
  try {
    client.release(error);
  } catch {
    // The pool may already have discarded a terminated connection.
  }
}

async function ensurePostgresWriterLock() {
  if (!pool || !POSTGRES_SINGLE_WRITER) return;
  if (postgresWriterLockClient && persistence.writerLockAcquired) return;
  if (postgresWriterLockAcquirePromise) return postgresWriterLockAcquirePromise;

  postgresWriterLockAcquirePromise = (async () => {
    let client = null;
    try {
      client = await pool.connect();
      client.on('error', (error) => {
        handlePostgresWriterLockClientError(client, error);
      });
      const lock = await client.query(
        'select pg_try_advisory_lock(hashtext($1)) as acquired',
        [POSTGRES_WRITER_LOCK_KEY]
      );
      if (!lock.rows[0]?.acquired) {
        throw new Error('postgres_single_writer_lock_unavailable');
      }
      postgresWriterLockClient = client;
      persistence.writerLockAcquired = true;
      persistence.writerLockLastAcquiredAt = new Date().toISOString();
      persistence.writerLockLastError = null;
      return;
    } catch (error) {
      persistence.writerLockAcquired = false;
      persistence.writerLockLastError = error instanceof Error ? error.message : String(error);
      if (client) {
        try {
          client.release(error);
        } catch {
          // The client can already be gone after a connection-level error.
        }
      }
      throw error;
    } finally {
      postgresWriterLockAcquirePromise = null;
    }
  })();

  return postgresWriterLockAcquirePromise;
}

function normalizeConnectorSessions() {
  for (const session of state.connectorSessions) {
    if (session.fulfillment?.status === 'failed') {
      session.status = 'failed';
      continue;
    }
    if (session.fulfilledAt || session.fulfilledByPluginId || session.fulfillment) {
      session.status = 'fulfilled';
      continue;
    }
    // A signed runner checkpoint advances the session to executing. Preserve
    // that durable phase across a process restart; otherwise the watchdog
    // loses the distinction between an unclaimed run and an interrupted one.
    if (String(session.status || '').trim().toLowerCase() === 'executing') {
      continue;
    }
    if (session.executionRequestedAt || session.completionRequestedAt) {
      session.status = 'queued';
    }
    if (session.claimedAt || session.claimedByPluginId) {
      session.status = 'claimed';
      continue;
    }
    if (session.confirmedAt || session.finalSelections) {
      session.status = 'confirmed';
      continue;
    }
  }
}

function normalizePluginRegistrations() {
  if (!Array.isArray(state.pluginRegistrations) || state.pluginRegistrations.length <= 1) return;
  const deduped = new Map();
  for (const row of state.pluginRegistrations) {
    if (!row?.pluginId) continue;
    deduped.set(row.pluginId, row);
  }
  state.pluginRegistrations = Array.from(deduped.values());
}

function normalizeUnits() {
  if (state.unitScale === CREDIT_SCALE) return;

  const convertRecord = (obj, keys) => {
    for (const key of keys) {
      if (obj[key] === undefined) continue;
      obj[key] = toUnits(obj[key]);
    }
  };

  for (const key of Object.keys(state.balances)) state.balances[key] = toUnits(state.balances[key]);
  for (const key of Object.keys(state.stakes)) state.stakes[key] = toUnits(state.stakes[key]);
  for (const acct of Object.values(state.userAccounts)) {
    convertRecord(acct, ['available', 'locked', 'totalDeposited', 'totalSpent', 'totalRewarded']);
  }
  for (const lock of Object.values(state.escrowLocks)) {
    convertRecord(lock, ['amount', 'providerAmount', 'protocolFee', 'platformCaptured', 'creditsBurned']);
  }
  for (const row of state.ledger) {
    convertRecord(row, ['amount', 'providerAmount', 'protocolFee', 'platformCaptured', 'creditsBurned']);
  }
  for (const row of state.referralClaims) {
    convertRecord(row, ['referrerReward', 'referredReward']);
  }
  for (const row of state.shareRewardClaims) {
    convertRecord(row, ['amount']);
  }
  for (const row of state.payoutRequests) {
    convertRecord(row, ['amount']);
  }
  for (const row of state.merchantSettlements) {
    convertRecord(row, ['grossAmount', 'merchantPayable', 'platformRevenue']);
  }
  convertRecord(state.platformTreasury, ['captured', 'burned', 'merchantPayable', 'merchantSettled', 'netRevenue']);
  state.unitScale = CREDIT_SCALE;
  persistState();
}

function markPostgresWriteSuccess() {
  persistence.healthy = true;
  persistence.lastWriteAt = new Date().toISOString();
  persistence.lastWriteError = null;
}

function markPostgresWriteFailure(error) {
  persistence.healthy = false;
  persistence.writeFailureCount += 1;
  persistence.lastWriteError = error instanceof Error ? error.message : String(error);
  console.error('[agent-verification] postgres_persist_failed', persistence.lastWriteError);
}

if (pool) {
  // node-postgres emits connection errors on idle pool clients. Without this
  // listener Node treats a dropped Postgres connection as an uncaught error
  // and restarts the web process, stranding live browser missions.
  pool.on('error', (error) => {
    markPostgresWriteFailure(error);
  });
}

async function writePostgresSnapshot(snapshot = JSON.stringify(state)) {
  const startedAt = Date.now();
  await ensurePostgresWriterLock();
  const serializeStartedAt = Date.now();
  const storedSnapshot = serializePostgresState(snapshot);
  const serializedAt = Date.now();
  await pool.query(
    `
      insert into app_state (state_key, state_json, updated_at)
      values ($1, $2::jsonb, now())
      on conflict (state_key)
      do update set state_json = excluded.state_json, updated_at = now()
    `,
    [STATE_ROW_KEY, storedSnapshot]
  );
  const completedAt = Date.now();
  persistence.lastWriteMetrics = {
    plaintextBytes: Buffer.byteLength(snapshot),
    storedBytes: Buffer.byteLength(storedSnapshot),
    lockWaitMs: serializeStartedAt - startedAt,
    serializeEncryptMs: serializedAt - serializeStartedAt,
    databaseWriteMs: completedAt - serializedAt,
    totalMs: completedAt - startedAt
  };
  if (persistence.lastWriteMetrics.totalMs >= POSTGRES_PERSIST_TIMING_LOG_MS) {
    console.info('[agent-verification] postgres_persist_timing', JSON.stringify(persistence.lastWriteMetrics));
  }
  markPostgresWriteSuccess();
}

function settlePostgresPersistWaiters() {
  const pending = [];
  for (const waiter of postgresPersistWaiters) {
    if (waiter.revision <= postgresPersistCommittedRevision) {
      waiter.resolve();
    } else if (postgresPersistFailure && waiter.revision <= postgresPersistFailure.revision) {
      waiter.reject(postgresPersistFailure.error);
    } else {
      pending.push(waiter);
    }
  }
  postgresPersistWaiters = pending;
}

function waitForPostgresRevision(revision) {
  if (revision <= postgresPersistCommittedRevision) return Promise.resolve();
  if (postgresPersistFailure && revision <= postgresPersistFailure.revision) {
    return Promise.reject(postgresPersistFailure.error);
  }
  return new Promise((resolve, reject) => {
    postgresPersistWaiters.push({ revision, resolve, reject });
  });
}

function schedulePostgresPersist() {
  if (postgresPersistScheduled || !postgresPersistDirty) return;
  postgresPersistScheduled = true;
  persistQueue = persistQueue
    .catch(() => undefined)
    .then(async () => {
      const snapshotRevision = postgresPersistRequestedRevision;
      const snapshot = JSON.stringify(state);
      postgresPersistDirty = false;
      try {
        await writePostgresSnapshot(snapshot);
        postgresPersistCommittedRevision = Math.max(postgresPersistCommittedRevision, snapshotRevision);
        if (postgresPersistFailure?.revision <= postgresPersistCommittedRevision) {
          postgresPersistFailure = null;
        }
      } catch (error) {
        markPostgresWriteFailure(error);
        postgresPersistFailure = { revision: snapshotRevision, error };
      }
      settlePostgresPersistWaiters();
    })
    .finally(() => {
      postgresPersistScheduled = false;
      if (postgresPersistDirty) schedulePostgresPersist();
    });
}

function persistState() {
  if (pool && persistence.driver === 'postgres') {
    postgresPersistRequestedRevision += 1;
    postgresPersistDirty = true;
    schedulePostgresPersist();
    return;
  }

  if (ASYNC_FILE_PERSIST) {
    queueFilePersist();
    return;
  }

  persistFileStateSync();
}

function persistFileStateSync(snapshot = JSON.stringify(state)) {
  copyStateFileSync(`${DATA_PATH}.previous`);
  writeFileAtomicSync(DATA_PATH, snapshot);
}

function queueFilePersist() {
  filePersistDirty = true;
  if (filePersistTimer) return;
  filePersistTimer = setTimeout(() => {
    filePersistTimer = null;
    flushFilePersistAsync();
  }, FILE_PERSIST_DELAY_MS);
  filePersistTimer.unref?.();
}

function flushFilePersistAsync() {
  if (!filePersistDirty) return persistQueue;
  filePersistDirty = false;
  const snapshot = JSON.stringify(state);
  persistQueue = persistQueue
    .then(async () => {
      try {
        await fs.promises.copyFile(DATA_PATH, `${DATA_PATH}.previous`);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await writeFileAtomic(DATA_PATH, snapshot);
      filePersistLastError = null;
    })
    .catch((error) => {
      filePersistLastError = error instanceof Error ? error.message : String(error);
      console.error('[agent-verification] file_persist_failed', filePersistLastError);
    });
  return persistQueue;
}

process.on('beforeExit', () => {
  if (!ASYNC_FILE_PERSIST || !filePersistDirty) return;
  if (filePersistTimer) {
    clearTimeout(filePersistTimer);
    filePersistTimer = null;
  }
  try {
    filePersistDirty = false;
    persistFileStateSync();
  } catch (error) {
    filePersistLastError = error instanceof Error ? error.message : String(error);
    console.error('[agent-verification] file_persist_before_exit_failed', filePersistLastError);
  }
});

async function initializeState() {
  if (!pool) {
    state = safeReadState();
    persistence.ready = true;
    persistence.healthy = true;
    normalizeConnectorSessions();
    normalizePluginRegistrations();
    normalizeUnits();
    persistState();
    return;
  }

  try {
    await ensurePostgresWriterLock();
    await pool.query(`
      create table if not exists app_state (
        state_key text primary key,
        state_json jsonb not null,
        updated_at timestamptz not null default now()
      )
    `);
    await pool.query(`
      create table if not exists app_state_archives (
        id bigserial primary key,
        state_key text not null,
        state_json jsonb not null,
        checksum text not null,
        source text not null,
        created_at timestamptz not null default now()
      )
    `);
    await pool.query(`
      create table if not exists app_schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now(),
        metadata jsonb not null default '{}'::jsonb
      )
    `);
    await pool.query(`
      create table if not exists amazon_selection_intelligence_attempts (
        request_id text primary key,
        session_id text not null,
        plan_hash text not null,
        action_id text not null,
        observation_hash text not null,
        candidate_count integer not null,
        status text not null,
        response_json jsonb,
        started_at timestamptz not null,
        completed_at timestamptz,
        updated_at timestamptz not null default now()
      )
    `);
    const result = await pool.query('select state_json from app_state where state_key = $1', [STATE_ROW_KEY]);
    if (result.rows[0]?.state_json) {
      state = hydratePostgresState(result.rows[0].state_json);
      persistence.migrationSource = 'postgres';
      persistence.healthy = true;
    } else {
      const fileState = safeReadState();
      state = stateHasDurableRows(fileState) ? fileState : defaultState();
      persistence.migrationSource = stateHasDurableRows(fileState) ? 'file_import' : 'empty_database';
      const snapshot = JSON.stringify(state);
      const storedSnapshot = serializePostgresState(snapshot);
      await pool.query(
        `insert into app_state_archives (state_key, state_json, checksum, source)
         values ($1, $2::jsonb, $3, $4)`,
        [STATE_ROW_KEY, storedSnapshot, hashObject(state), persistence.migrationSource]
      );
      await writePostgresSnapshot(snapshot);
    }
    await pool.query(
      `insert into app_schema_migrations (version, metadata)
       values ($1, $2::jsonb)
       on conflict (version) do nothing`,
      [STATE_SCHEMA_VERSION, JSON.stringify({ migrationSource: persistence.migrationSource })]
    );
    persistence.ready = true;
    normalizeConnectorSessions();
    normalizePluginRegistrations();
    normalizeUnits();
    persistState();
    await flushPersistence();
  } catch (error) {
    if (postgresWriterLockClient) {
      postgresWriterLockClient.release();
      postgresWriterLockClient = null;
    }
    persistence.writerLockAcquired = false;
    if (REQUIRE_PRODUCTION_PERSISTENCE) {
      throw error;
    }
    console.error('[agent-verification] postgres_init_failed_falling_back_to_file', error instanceof Error ? error.message : String(error));
    state = safeReadState();
    persistence.driver = 'file';
    persistence.ready = true;
    persistence.healthy = true;
    normalizeConnectorSessions();
    normalizePluginRegistrations();
    normalizeUnits();
    persistState();
  }
}

await initializeState();

export function getPersistenceStatus() {
  return {
    ...persistence,
    pendingWrites: persistence.driver === 'postgres'
      ? 'async'
      : ASYNC_FILE_PERSIST
        ? 'async_coalesced'
        : 'sync',
    filePersistDirty: persistence.driver === 'postgres' ? postgresPersistDirty : filePersistDirty,
    filePersistLastError,
    ledger: getCreditLedgerIntegritySummary()
  };
}

export async function flushPersistence() {
  if (persistence.driver === 'postgres') {
    const requiredRevision = postgresPersistRequestedRevision;
    if (postgresPersistDirty) schedulePostgresPersist();
    await waitForPostgresRevision(requiredRevision);
    return getPersistenceStatus();
  }
  if (ASYNC_FILE_PERSIST && filePersistDirty) {
    if (filePersistTimer) {
      clearTimeout(filePersistTimer);
      filePersistTimer = null;
    }
    flushFilePersistAsync();
  }
  await persistQueue;
  return getPersistenceStatus();
}

function formatAmazonSelectionIntelligenceAttempt(row = null) {
  if (!row) return null;
  return {
    requestId: String(row.request_id || ''),
    sessionId: String(row.session_id || ''),
    planHash: String(row.plan_hash || ''),
    actionId: String(row.action_id || ''),
    observationHash: String(row.observation_hash || ''),
    candidateCount: Number(row.candidate_count || 0),
    status: String(row.status || ''),
    response: row.response_json || null,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at || ''),
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at || null
  };
}

export async function reserveAmazonSelectionIntelligenceAttempt(attempt = {}) {
  if (!pool || persistence.driver !== 'postgres') {
    return { reserved: true, attempt: null, requiresStateFlush: true };
  }
  const result = await pool.query(
    `
      insert into amazon_selection_intelligence_attempts (
        request_id, session_id, plan_hash, action_id, observation_hash,
        candidate_count, status, response_json, started_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, 'pending', null, $7::timestamptz, now())
      on conflict (request_id) do nothing
      returning *
    `,
    [
      String(attempt.requestId || ''),
      String(attempt.sessionId || ''),
      String(attempt.planHash || ''),
      String(attempt.actionId || ''),
      String(attempt.observationHash || ''),
      Math.max(0, Number(attempt.candidateCount || 0) || 0),
      String(attempt.startedAt || new Date().toISOString())
    ]
  );
  if (result.rows[0]) {
    return { reserved: true, attempt: formatAmazonSelectionIntelligenceAttempt(result.rows[0]), requiresStateFlush: false };
  }
  const existing = await pool.query(
    'select * from amazon_selection_intelligence_attempts where request_id = $1',
    [String(attempt.requestId || '')]
  );
  return { reserved: false, attempt: formatAmazonSelectionIntelligenceAttempt(existing.rows[0]), requiresStateFlush: false };
}

export async function completeAmazonSelectionIntelligenceAttempt(requestId, response = null) {
  if (!pool || persistence.driver !== 'postgres') return null;
  const result = await pool.query(
    `
      update amazon_selection_intelligence_attempts
      set status = 'completed', response_json = $2::jsonb, completed_at = now(), updated_at = now()
      where request_id = $1
      returning *
    `,
    [String(requestId || ''), JSON.stringify(response || null)]
  );
  return formatAmazonSelectionIntelligenceAttempt(result.rows[0]);
}

export function registerAgent(agent) {
  const now = new Date().toISOString();
  const existing = state.agents[agent.agentId];

  state.agents[agent.agentId] = {
    ...existing,
    ...agent,
    registeredAt: existing?.registeredAt ?? now,
    updatedAt: now
  };

  state.balances[agent.agentId] = state.balances[agent.agentId] ?? 0;
  state.stakes[agent.agentId] = state.stakes[agent.agentId] ?? 0;
  persistState();
  return state.agents[agent.agentId];
}

export function patchAgent(agentId, patch) {
  const existing = state.agents[agentId];
  if (!existing) return null;
  state.agents[agentId] = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.agents[agentId];
}

export function addAttestation(attestation) {
  const now = new Date().toISOString();
  const row = {
    id: `att-${state.attestations.length + 1}`,
    createdAt: now,
    ...attestation
  };
  state.attestations.push(row);
  persistState();
  return row;
}

export function getAttestation(attestationId) {
  return state.attestations.find((row) => row.id === attestationId) ?? null;
}

export function updateAttestation(attestationId, patch) {
  const index = state.attestations.findIndex((row) => row.id === attestationId);
  if (index < 0) return null;
  state.attestations[index] = {
    ...state.attestations[index],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.attestations[index];
}

export function addReceipt(receipt) {
  const now = new Date().toISOString();
  const row = {
    id: `rcpt-${state.receipts.length + 1}`,
    createdAt: now,
    ...receipt
  };
  state.receipts.push(row);

  const price = Number(row.payment?.amountUnits ?? 0);
  if (Number.isFinite(price) && price > 0 && row.agentId) {
    state.balances[row.agentId] = (state.balances[row.agentId] ?? 0) + price;
  }

  persistState();
  return row;
}

export function addIntent(intent) {
  const now = new Date().toISOString();
  const row = {
    id: `intent-${state.intents.length + 1}`,
    status: 'created',
    createdAt: now,
    ...intent
  };
  state.intents.push(row);
  persistState();
  return row;
}

export function createAnchorSubmission(submission) {
  const now = new Date().toISOString();
  const row = {
    id: `anchor-${state.anchorSubmissions.length + 1}`,
    createdAt: now,
    updatedAt: now,
    ...submission
  };
  state.anchorSubmissions.push(row);
  persistState();
  return row;
}

// This mirror contains only public Merkle keys, roots, and transaction state.
// It lets the single Magic City writer resume a submitted MBA registry anchor
// without guessing whether a prior transaction landed on Zeko.
export function getMbaMissionRegistryState(registryAddress) {
  const key = String(registryAddress || '').trim();
  if (!key) return null;
  return state.mbaMissionRegistryStates[key] ?? null;
}

export function upsertMbaMissionRegistryState(registryAddress, patch = {}) {
  const key = String(registryAddress || '').trim();
  if (!key) throw new Error('mba_mission_registry_address_required');
  const now = new Date().toISOString();
  const current = state.mbaMissionRegistryStates[key] ?? {
    registryAddress: key,
    createdAt: now
  };
  const next = {
    ...current,
    ...patch,
    registryAddress: key,
    updatedAt: now
  };
  state.mbaMissionRegistryStates[key] = next;
  persistState();
  return next;
}

export function createSettlementRegistryEntry(entry) {
  const now = new Date().toISOString();
  const row = {
    id: `zreg-${state.settlementRegistry.length + 1}`,
    createdAt: now,
    updatedAt: now,
    ...entry
  };
  state.settlementRegistry.push(row);
  persistState();
  return row;
}

export function createPaymentAuthorization(entry) {
  const now = new Date().toISOString();
  const row = {
    id: `payauth-${state.paymentAuthorizations.length + 1}`,
    createdAt: now,
    updatedAt: now,
    ...entry
  };
  state.paymentAuthorizations.push(row);
  persistState();
  return row;
}

export function getPaymentAuthorization(id) {
  return state.paymentAuthorizations.find((row) => row.id === id) ?? null;
}

export function findPaymentAuthorizationByRequestId(requestId) {
  if (!requestId) return null;
  return state.paymentAuthorizations.find((row) => row.requestId === requestId) ?? null;
}

export function findPaymentAuthorizationByTxHash(txHash) {
  const normalized = String(txHash || '').trim().toLowerCase();
  if (!normalized) return null;
  return state.paymentAuthorizations.find((row) => String(row.walletTxHash || '').trim().toLowerCase() === normalized) ?? null;
}

export function listPaymentAuthorizations({ userId = null, limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  return state.paymentAuthorizations
    .filter((row) => (!userId || row.userId === userId))
    .slice(-safeLimit)
    .reverse();
}

export function updatePaymentAuthorization(id, patch) {
  const index = state.paymentAuthorizations.findIndex((row) => row.id === id);
  if (index < 0) return null;
  state.paymentAuthorizations[index] = {
    ...state.paymentAuthorizations[index],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.paymentAuthorizations[index];
}

export function createEthereumShadowRelayerJob(entry) {
  const now = new Date().toISOString();
  const row = {
    id: `erelay-${state.ethereumShadowRelayerJobs.length + 1}`,
    createdAt: now,
    updatedAt: now,
    ...entry
  };
  state.ethereumShadowRelayerJobs.push(row);
  persistState();
  return row;
}

export function getEthereumShadowRelayerJob(id) {
  return state.ethereumShadowRelayerJobs.find((row) => row.id === id) ?? null;
}

export function listEthereumShadowRelayerJobs({ authorizationId = null, limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  return state.ethereumShadowRelayerJobs
    .filter((row) => (!authorizationId || row.authorizationId === authorizationId))
    .slice(-safeLimit)
    .reverse();
}

export function updateEthereumShadowRelayerJob(id, patch) {
  const index = state.ethereumShadowRelayerJobs.findIndex((row) => row.id === id);
  if (index < 0) return null;
  state.ethereumShadowRelayerJobs[index] = {
    ...state.ethereumShadowRelayerJobs[index],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.ethereumShadowRelayerJobs[index];
}

export function createEthereumConfirmationIndexJob(entry) {
  const now = new Date().toISOString();
  const row = {
    id: `econfirm-${state.ethereumConfirmationIndexJobs.length + 1}`,
    createdAt: now,
    updatedAt: now,
    ...entry
  };
  state.ethereumConfirmationIndexJobs.push(row);
  persistState();
  return row;
}

export function getEthereumConfirmationIndexJob(id) {
  return state.ethereumConfirmationIndexJobs.find((row) => row.id === id) ?? null;
}

export function findEthereumConfirmationIndexJobByTxHash(txHash) {
  const normalized = String(txHash || '').trim().toLowerCase();
  if (!normalized) return null;
  return state.ethereumConfirmationIndexJobs.find((row) => String(row.txHash || '').trim().toLowerCase() === normalized) ?? null;
}

export function listEthereumConfirmationIndexJobs({ authorizationId = null, limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  return state.ethereumConfirmationIndexJobs
    .filter((row) => (!authorizationId || row.authorizationId === authorizationId))
    .slice(-safeLimit)
    .reverse();
}

export function updateEthereumConfirmationIndexJob(id, patch) {
  const index = state.ethereumConfirmationIndexJobs.findIndex((row) => row.id === id);
  if (index < 0) return null;
  state.ethereumConfirmationIndexJobs[index] = {
    ...state.ethereumConfirmationIndexJobs[index],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.ethereumConfirmationIndexJobs[index];
}

export function getSettlementRegistryEntry(id) {
  return state.settlementRegistry.find((row) => row.id === id) ?? null;
}

export function findSettlementRegistryEntryByAuthorizationId(authorizationId) {
  if (!authorizationId) return null;
  return state.settlementRegistry.find((row) => row.authorizationId === authorizationId) ?? null;
}

export function listSettlementRegistryEntries(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  return state.settlementRegistry.slice(-safeLimit).reverse();
}

export function updateSettlementRegistryEntry(id, patch) {
  const index = state.settlementRegistry.findIndex((row) => row.id === id);
  if (index < 0) return null;
  state.settlementRegistry[index] = {
    ...state.settlementRegistry[index],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.settlementRegistry[index];
}

export function findPlatformSettlementRegistryEntry(settlementId) {
  return state.settlementRegistry.find(
    (row) => row.settlementId === settlementId && row.scope === 'platform_auto'
  ) ?? null;
}

export function upsertPlatformSettlementRegistryEntry(settlementId, patch = {}) {
  const existing = findPlatformSettlementRegistryEntry(settlementId);
  if (!existing) {
    return createSettlementRegistryEntry({
      settlementId,
      scope: 'platform_auto',
      ...patch
    });
  }
  return updateSettlementRegistryEntry(existing.id, {
    ...patch,
    scope: existing.scope || 'platform_auto'
  });
}

export function createActionRun(actionRun) {
  const now = new Date().toISOString();
  const row = {
    id: `action-${state.actionRuns.length + 1}`,
    createdAt: now,
    updatedAt: now,
    ...actionRun
  };
  state.actionRuns.push(row);
  persistState();
  return row;
}

export function createConnectorSession(session) {
  const now = new Date().toISOString();
  const row = {
    id: `cs-${state.connectorSessions.length + 1}`,
    createdAt: now,
    updatedAt: now,
    status: 'ready',
    ...session
  };
  state.connectorSessions.push(row);
  persistState();
  return row;
}

export function getConnectorSession(id) {
  return state.connectorSessions.find((row) => row.id === id) ?? null;
}

export function updateConnectorSession(id, patch) {
  const idx = state.connectorSessions.findIndex((row) => row.id === id);
  if (idx < 0) return null;
  state.connectorSessions[idx] = {
    ...state.connectorSessions[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.connectorSessions[idx];
}

export function updateConnectorSessionEphemeral(id, patch) {
  const idx = state.connectorSessions.findIndex((row) => row.id === id);
  if (idx < 0) return null;
  state.connectorSessions[idx] = {
    ...state.connectorSessions[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  return state.connectorSessions[idx];
}

export function listConnectorSessions(limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  return state.connectorSessions.slice(-safeLimit).reverse();
}

export function createAgentSdkMission(mission) {
  const now = new Date().toISOString();
  const row = {
    id: `asm-${state.agentSdkMissions.length + 1}`,
    schemaVersion: 'magic-city-agent-sdk-mission-v1',
    status: 'proposed',
    createdAt: now,
    updatedAt: now,
    options: [],
    artifacts: [],
    events: [],
    receipts: [],
    ...mission
  };
  state.agentSdkMissions.push(row);
  persistState();
  return row;
}

export function getAgentSdkMission(id) {
  return state.agentSdkMissions.find((row) => row.id === id) ?? null;
}

export function updateAgentSdkMission(id, patch = {}) {
  const idx = state.agentSdkMissions.findIndex((row) => row.id === id);
  if (idx < 0) return null;
  state.agentSdkMissions[idx] = {
    ...state.agentSdkMissions[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.agentSdkMissions[idx];
}

export function listAgentSdkMissions({ agentId = '', requesterHash = '', limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  return state.agentSdkMissions
    .filter((row) => {
      if (agentId && row.agentId !== agentId) return false;
      if (requesterHash && row.requesterHash !== requesterHash) return false;
      return true;
    })
    .slice(-safeLimit)
    .reverse();
}

export function createPersonalAgentRuntime(runtime) {
  const now = new Date().toISOString();
  const row = {
    id: `par-${state.personalAgentRuntimes.length + 1}`,
    createdAt: now,
    updatedAt: now,
    status: 'registered',
    ...runtime
  };
  state.personalAgentRuntimes.push(row);
  persistState();
  return row;
}

export function getPersonalAgentRuntime(idOrAgentId) {
  return state.personalAgentRuntimes.find((row) => row.id === idOrAgentId || row.agentId === idOrAgentId) ?? null;
}

export function getPersonalAgentRuntimeByToken(token) {
  return state.personalAgentRuntimes.find((row) => row.secretToken === token) ?? null;
}

export function updatePersonalAgentRuntime(idOrAgentId, patch) {
  const idx = state.personalAgentRuntimes.findIndex((row) => row.id === idOrAgentId || row.agentId === idOrAgentId);
  if (idx < 0) return null;
  state.personalAgentRuntimes[idx] = {
    ...state.personalAgentRuntimes[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.personalAgentRuntimes[idx];
}

export function upsertPersonalAgentRuntime(runtime = {}) {
  const existing = runtime.agentId ? getPersonalAgentRuntime(runtime.agentId) : null;
  if (!existing) {
    return createPersonalAgentRuntime(runtime);
  }
  return updatePersonalAgentRuntime(existing.id, runtime);
}

export function listPersonalAgentRuntimes(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  return state.personalAgentRuntimes.slice(-safeLimit).reverse();
}

export function createNativeRunnerDevice(device = {}) {
  const now = new Date().toISOString();
  const row = {
    id: device.id || `nrd-${state.nativeRunnerDevices.length + 1}`,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    ...device
  };
  state.nativeRunnerDevices.push(row);
  persistState();
  return row;
}

export function getNativeRunnerDevice(id) {
  return state.nativeRunnerDevices.find((row) => row.id === id) ?? null;
}

export function getNativeRunnerDeviceByTokenHash(tokenHash) {
  return state.nativeRunnerDevices.find((row) => row.tokenHash === tokenHash) ?? null;
}

export function updateNativeRunnerDevice(id, patch = {}) {
  const idx = state.nativeRunnerDevices.findIndex((row) => row.id === id);
  if (idx < 0) return null;
  state.nativeRunnerDevices[idx] = {
    ...state.nativeRunnerDevices[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.nativeRunnerDevices[idx];
}

export function updateNativeRunnerDeviceEphemeral(id, patch = {}) {
  const idx = state.nativeRunnerDevices.findIndex((row) => row.id === id);
  if (idx < 0) return null;
  state.nativeRunnerDevices[idx] = {
    ...state.nativeRunnerDevices[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  return state.nativeRunnerDevices[idx];
}

export function listNativeRunnerDevices(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  return state.nativeRunnerDevices.slice(-safeLimit).reverse();
}

export function createNativeRunnerPairingSession(pairing = {}) {
  const now = new Date().toISOString();
  const row = {
    id: pairing.id || `nrp-${state.nativeRunnerPairingSessions.length + 1}`,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    ...pairing
  };
  state.nativeRunnerPairingSessions.push(row);
  persistState();
  return row;
}

export function getNativeRunnerPairingSession(id) {
  return state.nativeRunnerPairingSessions.find((row) => row.id === id) ?? null;
}

export function getNativeRunnerPairingSessionByCodeHash(codeHash) {
  return state.nativeRunnerPairingSessions.find((row) => row.codeHash === codeHash) ?? null;
}

export function updateNativeRunnerPairingSession(id, patch = {}) {
  const idx = state.nativeRunnerPairingSessions.findIndex((row) => row.id === id);
  if (idx < 0) return null;
  state.nativeRunnerPairingSessions[idx] = {
    ...state.nativeRunnerPairingSessions[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.nativeRunnerPairingSessions[idx];
}

export function listNativeRunnerPairingSessions(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  return state.nativeRunnerPairingSessions.slice(-safeLimit).reverse();
}

export function createPluginRegistration(plugin) {
  const now = new Date().toISOString();
  const row = {
    id: `plugin-${state.pluginRegistrations.length + 1}`,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    ...plugin
  };
  state.pluginRegistrations.push(row);
  persistState();
  return row;
}

export function upsertPluginRegistration(plugin) {
  const existingIndex = state.pluginRegistrations.findIndex((row) => row.pluginId === plugin.pluginId);
  if (existingIndex < 0) {
    return createPluginRegistration(plugin);
  }
  state.pluginRegistrations[existingIndex] = {
    ...state.pluginRegistrations[existingIndex],
    ...plugin,
    updatedAt: new Date().toISOString(),
    status: plugin.status ?? state.pluginRegistrations[existingIndex].status ?? 'active'
  };
  persistState();
  return state.pluginRegistrations[existingIndex];
}

export function listPluginRegistrations(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const deduped = new Map();
  for (const row of state.pluginRegistrations) {
    if (!row?.pluginId) continue;
    deduped.set(row.pluginId, row);
  }
  return Array.from(deduped.values()).slice(-safeLimit).reverse();
}

export function getPluginRegistration(idOrPluginId) {
  return state.pluginRegistrations.find((row) => row.id === idOrPluginId || row.pluginId === idOrPluginId) ?? null;
}

function normalizeSantaclawzSnapshotAgentId(agentId = '') {
  return String(agentId || '').trim().replace(/^santaclawz:/, '');
}

export function getSantaClawzRuntimeHealth(agentId) {
  const normalizedAgentId = normalizeSantaclawzSnapshotAgentId(agentId);
  if (!normalizedAgentId) return null;
  return state.santaclawzRuntimeHealth.find((row) => row.agentId === normalizedAgentId) ?? null;
}

export function listSantaClawzRuntimeHealth(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  return state.santaclawzRuntimeHealth
    .slice()
    .sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime())
    .slice(0, safeLimit);
}

export function recordSantaClawzRuntimeRejection({
  agentId,
  reasonCode = 'return_schema_rejected',
  message = 'SantaClawz rejected the agent return package.',
  sourceSessionId = null,
  blockedForMs = 30 * 60 * 1000,
  observedAt = new Date().toISOString()
} = {}) {
  const normalizedAgentId = normalizeSantaclawzSnapshotAgentId(agentId);
  if (!normalizedAgentId) return null;
  const existingIndex = state.santaclawzRuntimeHealth.findIndex((row) => row.agentId === normalizedAgentId);
  const existing = existingIndex >= 0 ? state.santaclawzRuntimeHealth[existingIndex] : null;
  const observedAtMs = Date.parse(observedAt);
  const safeObservedAt = Number.isFinite(observedAtMs) ? new Date(observedAtMs).toISOString() : new Date().toISOString();
  const safeBlockMs = Math.max(60 * 1000, Math.min(Number(blockedForMs) || 30 * 60 * 1000, 24 * 60 * 60 * 1000));
  const normalizedSourceSessionId = sourceSessionId ? String(sourceSessionId).slice(0, 120) : null;
  const sameIncident = Boolean(
    existing?.status === 'quarantined'
    && normalizedSourceSessionId
    && existing.sourceSessionId === normalizedSourceSessionId
    && existing.reasonCode === String(reasonCode || 'return_schema_rejected').slice(0, 120)
  );
  if (sameIncident) return existing;
  const row = {
    ...(existing || {}),
    schemaVersion: 'magic-city-santaclawz-runtime-health-v1',
    agentId: normalizedAgentId,
    magicAgentId: `santaclawz:${normalizedAgentId}`,
    status: 'quarantined',
    reasonCode: String(reasonCode || 'return_schema_rejected').slice(0, 120),
    message: String(message || 'SantaClawz rejected the agent return package.').slice(0, 500),
    sourceSessionId: normalizedSourceSessionId,
    failureCount: Number(existing?.failureCount || 0) + (sameIncident ? 0 : 1),
    firstRejectedAt: existing?.firstRejectedAt || safeObservedAt,
    lastRejectedAt: safeObservedAt,
    blockedUntil: sameIncident && existing?.blockedUntil
      ? existing.blockedUntil
      : new Date(Date.parse(safeObservedAt) + safeBlockMs).toISOString(),
    clearedAt: null,
    createdAt: existing?.createdAt || safeObservedAt,
    updatedAt: safeObservedAt
  };
  if (existingIndex >= 0) state.santaclawzRuntimeHealth[existingIndex] = row;
  else state.santaclawzRuntimeHealth.unshift(row);
  state.santaclawzRuntimeHealth = state.santaclawzRuntimeHealth.slice(0, 500);
  persistState();
  return row;
}

export function clearSantaClawzRuntimeRejection(agentId, { reason = 'accepted_result_delivered' } = {}) {
  const normalizedAgentId = normalizeSantaclawzSnapshotAgentId(agentId);
  if (!normalizedAgentId) return null;
  const existingIndex = state.santaclawzRuntimeHealth.findIndex((row) => row.agentId === normalizedAgentId);
  if (existingIndex < 0) return null;
  if (state.santaclawzRuntimeHealth[existingIndex]?.status === 'healthy') {
    return state.santaclawzRuntimeHealth[existingIndex];
  }
  const now = new Date().toISOString();
  const row = {
    ...state.santaclawzRuntimeHealth[existingIndex],
    status: 'healthy',
    blockedUntil: null,
    clearedAt: now,
    clearReason: String(reason || 'accepted_result_delivered').slice(0, 120),
    updatedAt: now
  };
  state.santaclawzRuntimeHealth[existingIndex] = row;
  persistState();
  return row;
}

export function getSantaClawzPreflightSnapshot(agentId) {
  const normalizedAgentId = normalizeSantaclawzSnapshotAgentId(agentId);
  if (!normalizedAgentId) return null;
  return state.santaclawzPreflightSnapshots.find((row) => row.agentId === normalizedAgentId) ?? null;
}

export function listSantaClawzPreflightSnapshots(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  return state.santaclawzPreflightSnapshots
    .slice()
    .sort((left, right) => new Date(right.updatedAt || right.createdAt || 0).getTime() - new Date(left.updatedAt || left.createdAt || 0).getTime())
    .slice(0, safeLimit);
}

export function upsertSantaClawzPreflightSnapshot(snapshot) {
  const normalizedAgentId = normalizeSantaclawzSnapshotAgentId(snapshot?.agentId);
  if (!normalizedAgentId) return null;
  const now = new Date().toISOString();
  const existingIndex = state.santaclawzPreflightSnapshots.findIndex((row) => row.agentId === normalizedAgentId);
  const existing = existingIndex >= 0 ? state.santaclawzPreflightSnapshots[existingIndex] : null;
  const row = {
    ...(existing || {}),
    schemaVersion: 'magic-city-santaclawz-preflight-snapshot-v1',
    agentId: normalizedAgentId,
    magicAgentId: `santaclawz:${normalizedAgentId}`,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastCheckedAt: snapshot.lastCheckedAt || now,
    expiresAt: snapshot.expiresAt || null,
    ok: Boolean(snapshot.ok),
    source: snapshot.source || null,
    error: snapshot.error || null,
    inputRequirements: snapshot.inputRequirements || null,
    metadata: snapshot.metadata || {}
  };
  if (existingIndex >= 0) state.santaclawzPreflightSnapshots[existingIndex] = row;
  else state.santaclawzPreflightSnapshots.unshift(row);
  state.santaclawzPreflightSnapshots = state.santaclawzPreflightSnapshots.slice(0, 500);
  persistState();
  return row;
}

export function getActionRun(id) {
  return state.actionRuns.find((row) => row.id === id) ?? null;
}

export function updateActionRun(id, patch) {
  const idx = state.actionRuns.findIndex((row) => row.id === id);
  if (idx < 0) return null;
  state.actionRuns[idx] = {
    ...state.actionRuns[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.actionRuns[idx];
}

export function listActionRuns(limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  return state.actionRuns.slice(-safeLimit).reverse();
}

export function getAnchorSubmission(id) {
  return state.anchorSubmissions.find((row) => row.id === id) ?? null;
}

export function listAnchorSubmissions(limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  return state.anchorSubmissions.slice(-safeLimit).reverse();
}

export function updateAnchorSubmission(id, patch) {
  const index = state.anchorSubmissions.findIndex((row) => row.id === id);
  if (index < 0) return null;
  state.anchorSubmissions[index] = {
    ...state.anchorSubmissions[index],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.anchorSubmissions[index];
}

export function getIntent(id) {
  return state.intents.find((x) => x.id === id) ?? null;
}

export function findIntentByExternalRequestId(externalRequestId) {
  return state.intents.find((x) => x.externalRequestId === externalRequestId) ?? null;
}

export function updateIntent(id, patch) {
  const idx = state.intents.findIndex((x) => x.id === id);
  if (idx < 0) return null;
  state.intents[idx] = {
    ...state.intents[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.intents[idx];
}

export function listIntents() {
  return state.intents;
}

export function listRecentIntentsSince(isoTimestamp) {
  const cutoff = new Date(isoTimestamp).getTime();
  return state.intents.filter((intent) => {
    const createdAt = new Date(intent.createdAt).getTime();
    return Number.isFinite(createdAt) && createdAt >= cutoff;
  });
}

export function listAgents() {
  return Object.values(state.agents);
}

export function getAgent(agentId) {
  return state.agents[agentId] ?? null;
}

export function listAgentReceipts(agentId) {
  return state.receipts.filter((r) => r.agentId === agentId);
}

export function listAgentAttestations(agentId) {
  return state.attestations.filter((a) => a.agentId === agentId);
}

export function listAllReceipts() {
  return state.receipts;
}

export function getReceipt(id) {
  return state.receipts.find((r) => r.id === id) ?? null;
}

export function updateReceipt(id, patch) {
  const idx = state.receipts.findIndex((x) => x.id === id);
  if (idx < 0) return null;
  state.receipts[idx] = {
    ...state.receipts[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.receipts[idx];
}

export function listAllAttestations() {
  return state.attestations;
}

export function getBalance(agentId) {
  return state.balances[agentId] ?? 0;
}

export function getStake(agentId) {
  return state.stakes[agentId] ?? 0;
}

export function depositStake(agentId, amount) {
  state.stakes[agentId] = (state.stakes[agentId] ?? 0) + amount;
  persistState();
  return state.stakes[agentId];
}

export function slashStake(agentId, amount, reason = 'policy_violation') {
  const current = state.stakes[agentId] ?? 0;
  const slashed = Math.max(0, Math.min(current, amount));
  state.stakes[agentId] = current - slashed;
  state.attestations.push({
    id: `att-${state.attestations.length + 1}`,
    createdAt: new Date().toISOString(),
    agentId,
    type: 'slash',
    issuer: 'protocol',
    commitmentHash: `slash:${reason}:${Date.now()}`,
    metadata: { reason, amount: slashed }
  });
  persistState();
  return { slashed, remainingStake: state.stakes[agentId] };
}

export function grantFaucetCredits(agentId, amount) {
  const delta = Math.max(0, Math.trunc(Number(amount ?? 0)));
  state.balances[agentId] = (state.balances[agentId] ?? 0) + delta;
  persistState();
  return state.balances[agentId];
}

function ensureUserAccount(userHash) {
  const existing = state.userAccounts[userHash];
  if (existing) return existing;
  const created = {
    userHash,
    available: 0,
    locked: 0,
    totalDeposited: 0,
    totalSpent: 0,
    totalRewarded: 0,
    chargebackOutstanding: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.userAccounts[userHash] = created;
  return created;
}

function appendLedger(entry) {
  const eventKey = normalizeLedgerEventKey(entry?.eventKey);
  const existing = eventKey ? findLedgerEntryByEventKey(eventKey) : null;
  if (existing) return { row: existing, duplicate: true };
  const meta = ensureLedgerMeta();
  const sequence = (Number(meta.lastSequence || 0) || 0) + 1;
  const row = {
    id: `ledger-${state.ledger.length + 1}`,
    sequence,
    createdAt: new Date().toISOString(),
    ...entry,
    ...(eventKey ? { eventKey } : {}),
    prevHash: meta.lastHash
  };
  row.ledgerHash = hashObject({ ...row, ledgerHash: undefined });
  state.ledger.push(row);
  meta.lastSequence = sequence;
  meta.lastHash = row.ledgerHash;
  meta.updatedAt = row.createdAt;
  if (eventKey) state.ledgerIdempotency[eventKey] = row.id;
  return { row, duplicate: false };
}

function ensurePlatformTreasury() {
  const current = state.platformTreasury;
  if (current) return current;
  state.platformTreasury = {
    captured: 0,
    burned: 0,
    merchantPayable: 0,
    merchantSettled: 0,
    netRevenue: 0,
    capturedSessions: 0,
    pendingMerchantSettlements: 0,
    settledMerchantSessions: 0,
    updatedAt: null,
    lastIntentId: null,
    lastSettlementId: null
  };
  return state.platformTreasury;
}

function isPendingMerchantSettlementStatus(status) {
  return new Set(['pending_execution', 'funded_pending_execution', 'pending_settlement']).has(String(status || ''));
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeReferralCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 16);
}

function generateReferralCode(email, displayName = '') {
  const base = normalizeReferralCode(displayName || String(email || '').split('@')[0] || 'MAGIC');
  const prefix = (base || 'MAGIC').slice(0, 6);
  let candidate = '';
  do {
    candidate = `${prefix}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  } while (Object.values(state.authUsers).some((row) => row.referralCode === candidate));
  return candidate;
}

export function buildDefaultGoogleConnectorPolicy() {
  return {
    allowCalendarWrite: true,
    allowContactWrite: true,
    allowGmailDraftWrite: true,
    allowGmailSend: true,
    requireManualReview: false,
    updatedAt: null
  };
}

function normalizeGitHubRepoRule(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/^github\.com\//, '')
    .replace(/\/+$/, '');
  if (!normalized) return '';
  if (normalized === '*') return '*';
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 2 && parts[1] === '*') return `${parts[0]}/*`;
  if (parts.length === 2) return `${parts[0]}/${parts[1]}`;
  return '';
}

function normalizeGitHubRepoAllowlist(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || '')
        .split(/[\n,]+/);
  return [...new Set(rawValues.map(normalizeGitHubRepoRule).filter(Boolean))];
}

function normalizeGitHubBranchPrefix(value) {
  const raw = String(value || '').trim().replace(/[^a-zA-Z0-9/_-]+/g, '-');
  if (!raw) return 'magic-city/';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

export function buildDefaultGitHubConnectorPolicy() {
  return {
    allowRepoRead: true,
    allowPatchArtifacts: true,
    allowPrDraftWrite: false,
    requireManualReview: true,
    repoAllowlist: [],
    branchPrefix: 'magic-city/',
    updatedAt: null
  };
}

export function buildDefaultEvmWalletPolicy() {
  return {
    allowSettlementSignatures: true,
    allowPaymentRequests: true,
    allowUsdcTopups: true,
    requireManualReview: true,
    updatedAt: null
  };
}

function ensureGoogleConnectorPolicy(policy) {
  const defaults = buildDefaultGoogleConnectorPolicy();
  return {
    ...defaults,
    ...(policy || {}),
    allowCalendarWrite: policy?.allowCalendarWrite !== false,
    allowContactWrite: policy?.allowContactWrite !== false,
    allowGmailDraftWrite: policy?.allowGmailDraftWrite !== false,
    allowGmailSend: policy?.allowGmailSend !== false,
    requireManualReview: Boolean(policy?.requireManualReview),
    updatedAt: policy?.updatedAt || null
  };
}

function ensureGitHubConnectorPolicy(policy) {
  const defaults = buildDefaultGitHubConnectorPolicy();
  return {
    ...defaults,
    ...(policy || {}),
    allowRepoRead: policy?.allowRepoRead !== false,
    allowPatchArtifacts: policy?.allowPatchArtifacts !== false,
    allowPrDraftWrite: Boolean(policy?.allowPrDraftWrite),
    requireManualReview: policy?.requireManualReview !== false,
    repoAllowlist: normalizeGitHubRepoAllowlist(policy?.repoAllowlist || defaults.repoAllowlist),
    branchPrefix: normalizeGitHubBranchPrefix(policy?.branchPrefix || defaults.branchPrefix),
    updatedAt: policy?.updatedAt || null
  };
}

function ensureEvmWalletPolicy(policy) {
  const defaults = buildDefaultEvmWalletPolicy();
  return {
    ...defaults,
    ...(policy || {}),
    allowSettlementSignatures: policy?.allowSettlementSignatures !== false,
    allowPaymentRequests: policy?.allowPaymentRequests !== false,
    allowUsdcTopups: policy?.allowUsdcTopups !== false,
    requireManualReview: policy?.requireManualReview !== false,
    updatedAt: policy?.updatedAt || null
  };
}

function ensureAuthUserDefaults(user) {
  if (!user) return null;
  let changed = false;
  if (!user.referralCode) {
    user.referralCode = generateReferralCode(user.email, user.displayName);
    changed = true;
  }
  if (user.referredByUserId === undefined) {
    user.referredByUserId = null;
    changed = true;
  }
  if (user.referredByCode === undefined) {
    user.referredByCode = null;
    changed = true;
  }
  if (user.referralRedeemedAt === undefined) {
    user.referralRedeemedAt = null;
    changed = true;
  }
  const nextGoogleConnectorPolicy = ensureGoogleConnectorPolicy(user.googleConnectorPolicy);
  if (JSON.stringify(nextGoogleConnectorPolicy) !== JSON.stringify(user.googleConnectorPolicy || null)) {
    user.googleConnectorPolicy = nextGoogleConnectorPolicy;
    changed = true;
  }
  const nextGitHubConnectorPolicy = ensureGitHubConnectorPolicy(user.githubConnectorPolicy);
  if (JSON.stringify(nextGitHubConnectorPolicy) !== JSON.stringify(user.githubConnectorPolicy || null)) {
    user.githubConnectorPolicy = nextGitHubConnectorPolicy;
    changed = true;
  }
  const nextEvmWalletPolicy = ensureEvmWalletPolicy(user.evmWalletPolicy);
  if (JSON.stringify(nextEvmWalletPolicy) !== JSON.stringify(user.evmWalletPolicy || null)) {
    user.evmWalletPolicy = nextEvmWalletPolicy;
    changed = true;
  }
  if (!Array.isArray(user.evmWallets)) {
    user.evmWallets = [];
    changed = true;
  }
  if (changed) {
    user.updatedAt = new Date().toISOString();
    persistState();
  }
  return user;
}

export function getUserAccount(userHash) {
  return state.userAccounts[userHash] ?? null;
}

export function getPlatformTreasury() {
  return ensurePlatformTreasury();
}

export function getMerchantSettlementBySession(sessionId) {
  return state.merchantSettlements.find((row) => row.sessionId === sessionId) ?? null;
}

export function getMerchantSettlement(idOrSessionId) {
  return state.merchantSettlements.find((row) => row.id === idOrSessionId || row.sessionId === idOrSessionId) ?? null;
}

export function listMerchantSettlements(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  return state.merchantSettlements.slice(-safeLimit).reverse();
}

export function upsertMerchantSettlementForSession(sessionId, patch = {}) {
  const now = new Date().toISOString();
  const idx = state.merchantSettlements.findIndex((row) => row.sessionId === sessionId);
  if (idx < 0) {
    const row = {
      id: `mset-${state.merchantSettlements.length + 1}`,
      sessionId,
      createdAt: now,
      updatedAt: now,
      status: patch.status ?? 'pending',
      ...patch
    };
    state.merchantSettlements.push(row);
    persistState();
    return row;
  }
  state.merchantSettlements[idx] = {
    ...state.merchantSettlements[idx],
    ...patch,
    updatedAt: now
  };
  persistState();
  return state.merchantSettlements[idx];
}

export function recordPendingMerchantSettlement({
  sessionId,
  intentId = null,
  userHash = null,
  providerAgentId = null,
  provider = null,
  merchantName = null,
  grossAmount = 0,
  merchantPayable = 0,
  platformRevenue = 0,
  settlementRail = 'magic_city_treasury',
  fundingMode = 'magic_city_credits',
  externalRef = null,
  metadata = null,
  status = 'pending_execution'
} = {}) {
  const treasury = ensurePlatformTreasury();
  const existing = getMerchantSettlementBySession(sessionId);
  if (!existing && isPendingMerchantSettlementStatus(status)) {
    treasury.pendingMerchantSettlements += 1;
  } else if (existing && !isPendingMerchantSettlementStatus(existing.status) && isPendingMerchantSettlementStatus(status)) {
    treasury.pendingMerchantSettlements += 1;
  } else if (existing && isPendingMerchantSettlementStatus(existing.status) && !isPendingMerchantSettlementStatus(status)) {
    treasury.pendingMerchantSettlements = Math.max(0, treasury.pendingMerchantSettlements - 1);
  }
  const row = upsertMerchantSettlementForSession(sessionId, {
    intentId,
    userHash,
    providerAgentId,
    provider,
    merchantName,
    grossAmount: Math.max(0, Math.trunc(Number(grossAmount || 0))),
    merchantPayable: Math.max(0, Math.trunc(Number(merchantPayable || 0))),
    platformRevenue: Math.max(0, Math.trunc(Number(platformRevenue || 0))),
    settlementRail,
    fundingMode,
    externalRef,
    metadata,
    status
  });
  treasury.updatedAt = row.updatedAt;
  treasury.lastSettlementId = row.id;
  persistState();
  return row;
}

export function markMerchantSettlementPendingSettlement(sessionId, patch = {}) {
  const treasury = ensurePlatformTreasury();
  const row = upsertMerchantSettlementForSession(sessionId, {
    ...patch,
    status: patch.status ?? 'pending_settlement',
    fulfilledAt: patch.fulfilledAt ?? new Date().toISOString()
  });
  treasury.updatedAt = row.updatedAt;
  treasury.lastSettlementId = row.id;
  persistState();
  return row;
}

export function releaseMerchantSettlement(sessionId, reason = 'released', patch = {}) {
  const treasury = ensurePlatformTreasury();
  const existing = getMerchantSettlementBySession(sessionId);
  if (!existing) return null;
  if (existing.status !== 'released' && treasury.pendingMerchantSettlements > 0) {
    treasury.pendingMerchantSettlements -= 1;
  }
  const row = upsertMerchantSettlementForSession(sessionId, {
    ...patch,
    status: 'released',
    releaseReason: reason,
    releasedAt: new Date().toISOString()
  });
  treasury.updatedAt = row.updatedAt;
  treasury.lastSettlementId = row.id;
  persistState();
  return row;
}

export function settleMerchantSettlement(sessionId, externalRef = null, patch = {}) {
  const treasury = ensurePlatformTreasury();
  const existing = getMerchantSettlementBySession(sessionId);
  if (!existing) return null;
  const merchantPayable = Math.max(0, Math.trunc(Number(existing.merchantPayable || 0)));
  if (existing.status !== 'settled') {
    treasury.merchantPayable = Math.max(0, treasury.merchantPayable - merchantPayable);
    treasury.merchantSettled += merchantPayable;
    treasury.pendingMerchantSettlements = Math.max(0, treasury.pendingMerchantSettlements - 1);
    treasury.settledMerchantSessions += 1;
  }
  const row = upsertMerchantSettlementForSession(sessionId, {
    ...patch,
    status: 'settled',
    externalRef: externalRef ?? existing.externalRef ?? null,
    settledAt: new Date().toISOString()
  });
  treasury.updatedAt = row.updatedAt;
  treasury.lastSettlementId = row.id;
  persistState();
  return row;
}

export function createAuthUser({ email, passwordSalt, passwordHash, displayName = '', requesterId = '', ...metadata }) {
  const normalizedEmail = normalizeEmail(email);
  const now = new Date().toISOString();
  const row = {
    id: `acct-${Object.keys(state.authUsers).length + 1}`,
    email: normalizedEmail,
    passwordSalt,
    passwordHash,
    displayName: String(displayName || '').trim() || normalizedEmail,
    requesterId: String(requesterId || normalizedEmail).trim() || normalizedEmail,
    referralCode: generateReferralCode(normalizedEmail, displayName),
    referredByUserId: null,
    referredByCode: null,
    referralRedeemedAt: null,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null
  };
  Object.assign(row, metadata);
  state.authUsers[row.id] = row;
  persistState();
  return row;
}

export function getAuthUser(userId) {
  return ensureAuthUserDefaults(state.authUsers[userId] ?? null);
}

export function getAuthUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  return ensureAuthUserDefaults(Object.values(state.authUsers).find((row) => row.email === normalizedEmail) ?? null);
}

export function getAuthUserByRequesterId(requesterId) {
  const normalizedRequesterId = String(requesterId || '').trim().toLowerCase();
  if (!normalizedRequesterId) return null;
  return ensureAuthUserDefaults(
    Object.values(state.authUsers).find((row) => String(row.requesterId || '').trim().toLowerCase() === normalizedRequesterId) ?? null
  );
}

export function getAuthUserByEvmWalletAddress(address) {
  const normalizedAddress = String(address || '').trim().toLowerCase();
  if (!normalizedAddress) return null;
  return ensureAuthUserDefaults(
    Object.values(state.authUsers).find((row) =>
      Array.isArray(row.evmWallets) &&
      row.evmWallets.some((wallet) => String(wallet?.address || '').trim().toLowerCase() === normalizedAddress)
    ) ?? null
  );
}

export function getAuthUserByReferralCode(referralCode) {
  const normalizedCode = normalizeReferralCode(referralCode);
  if (!normalizedCode) return null;
  return ensureAuthUserDefaults(Object.values(state.authUsers).find((row) => row.referralCode === normalizedCode) ?? null);
}

export function updateAuthUser(userId, patch) {
  const current = state.authUsers[userId];
  if (!current) return null;
  const nextPatch = { ...patch };
  if (Object.prototype.hasOwnProperty.call(nextPatch, 'googleConnectorPolicy')) {
    nextPatch.googleConnectorPolicy = ensureGoogleConnectorPolicy({
      ...current.googleConnectorPolicy,
      ...nextPatch.googleConnectorPolicy,
      updatedAt: new Date().toISOString()
    });
  }
  if (Object.prototype.hasOwnProperty.call(nextPatch, 'githubConnectorPolicy')) {
    nextPatch.githubConnectorPolicy = ensureGitHubConnectorPolicy({
      ...current.githubConnectorPolicy,
      ...nextPatch.githubConnectorPolicy,
      updatedAt: new Date().toISOString()
    });
  }
  state.authUsers[userId] = {
    ...current,
    ...nextPatch,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.authUsers[userId];
}

export function recordConnectorActivity({
  userId = null,
  provider = null,
  action = 'connector_event',
  status = 'success',
  source = 'user',
  sessionId = null,
  pluginId = null,
  capability = null,
  metadata = null
} = {}) {
  const now = new Date().toISOString();
  const row = {
    id: `cact-${state.connectorActivity.length + 1}`,
    createdAt: now,
    updatedAt: now,
    userId,
    provider,
    action,
    status,
    source,
    sessionId,
    pluginId,
    capability,
    metadata
  };
  state.connectorActivity.push(row);
  if (state.connectorActivity.length > MAX_CONNECTOR_ACTIVITY_ROWS) {
    state.connectorActivity.splice(0, state.connectorActivity.length - MAX_CONNECTOR_ACTIVITY_ROWS);
  }
  persistState();
  return row;
}

export function listConnectorActivity({ userId = null, provider = null, limit = 25 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  return state.connectorActivity
    .filter((row) => (!userId || row.userId === userId) && (!provider || row.provider === provider))
    .slice(-safeLimit)
    .reverse();
}

export function createAuthSession({ tokenHash, userId, requesterId, expiresAt, userAgent = null, authMethod = 'password' }) {
  const now = new Date().toISOString();
  const row = {
    id: `authsess-${Object.keys(state.authSessions).length + 1}`,
    tokenHash,
    userId,
    requesterId,
    userAgent,
    authMethod: String(authMethod || 'password').trim().toLowerCase() || 'password',
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    expiresAt,
    revokedAt: null
  };
  state.authSessions[tokenHash] = row;
  persistState();
  return row;
}

export function createWalletChallenge({
  challengeId,
  userId = null,
  address,
  chainId = 1,
  purpose = 'wallet_link',
  nonce,
  message,
  settlementId = null,
  sessionId = null,
  commitmentHash = null,
  statementHash = null,
  expiresAt,
  metadata = null
}) {
  const now = new Date().toISOString();
  const row = {
    id: challengeId,
    challengeId,
    userId,
    address,
    chainId,
    purpose,
    nonce,
    message,
    settlementId,
    sessionId,
    commitmentHash,
    statementHash,
    expiresAt,
    metadata,
    createdAt: now,
    updatedAt: now,
    consumedAt: null,
    revokedAt: null
  };
  state.walletChallenges[challengeId] = row;
  persistState();
  return row;
}

export function getWalletChallenge(challengeId) {
  if (!challengeId) return null;
  return state.walletChallenges[challengeId] ?? null;
}

export function consumeWalletChallenge(challengeId, patch = {}) {
  const current = state.walletChallenges[challengeId];
  if (!current) return null;
  state.walletChallenges[challengeId] = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    consumedAt: new Date().toISOString()
  };
  persistState();
  return state.walletChallenges[challengeId];
}

export function revokeWalletChallenge(challengeId, reason = null) {
  const current = state.walletChallenges[challengeId];
  if (!current) return null;
  state.walletChallenges[challengeId] = {
    ...current,
    updatedAt: new Date().toISOString(),
    revokedAt: new Date().toISOString(),
    metadata: {
      ...(current.metadata || {}),
      revokeReason: reason || null
    }
  };
  persistState();
  return state.walletChallenges[challengeId];
}

export function getAuthSession(tokenHash) {
  if (!tokenHash) return null;
  return state.authSessions[tokenHash] ?? null;
}

export function touchAuthSession(tokenHash) {
  const current = state.authSessions[tokenHash];
  if (!current) return null;
  const lastSeenAt = current.lastSeenAt ? new Date(current.lastSeenAt).getTime() : 0;
  if (Number.isFinite(lastSeenAt) && Date.now() - lastSeenAt < 5 * 60 * 1000) {
    return current;
  }
  state.authSessions[tokenHash] = {
    ...current,
    updatedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
  persistState();
  return state.authSessions[tokenHash];
}

export function revokeAuthSession(tokenHash) {
  const current = state.authSessions[tokenHash];
  if (!current) return null;
  state.authSessions[tokenHash] = {
    ...current,
    updatedAt: new Date().toISOString(),
    revokedAt: new Date().toISOString()
  };
  persistState();
  return state.authSessions[tokenHash];
}

export function createAuthPasswordReset({
  tokenHash,
  userId,
  email,
  expiresAt,
  userAgent = null,
  ip = null,
  metadata = null
}) {
  if (!tokenHash || !userId || !expiresAt) return null;
  const now = new Date().toISOString();
  const row = {
    id: `pwdreset-${Object.keys(state.authPasswordResets).length + 1}`,
    tokenHash,
    userId,
    email: normalizeEmail(email),
    userAgent,
    ip,
    metadata,
    createdAt: now,
    updatedAt: now,
    expiresAt,
    consumedAt: null,
    revokedAt: null
  };
  state.authPasswordResets[tokenHash] = row;
  persistState();
  return row;
}

export function getAuthPasswordReset(tokenHash) {
  if (!tokenHash) return null;
  return state.authPasswordResets[tokenHash] ?? null;
}

export function consumeAuthPasswordReset(tokenHash, patch = {}) {
  const current = state.authPasswordResets[tokenHash];
  if (!current) return null;
  state.authPasswordResets[tokenHash] = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    consumedAt: new Date().toISOString()
  };
  persistState();
  return state.authPasswordResets[tokenHash];
}

export function revokeAuthPasswordReset(tokenHash, reason = null) {
  const current = state.authPasswordResets[tokenHash];
  if (!current) return null;
  state.authPasswordResets[tokenHash] = {
    ...current,
    updatedAt: new Date().toISOString(),
    revokedAt: new Date().toISOString(),
    metadata: {
      ...(current.metadata || {}),
      revokeReason: reason || null
    }
  };
  persistState();
  return state.authPasswordResets[tokenHash];
}

export function createOAuthClient({
  clientId,
  clientSecretHash = null,
  clientName = '',
  redirectUris = [],
  grantTypes = ['authorization_code', 'refresh_token'],
  responseTypes = ['code'],
  tokenEndpointAuthMethod = 'none',
  scope = 'magiccity.mcp',
  metadata = null
}) {
  const now = new Date().toISOString();
  const row = {
    id: clientId,
    clientId,
    clientSecretHash,
    clientName: String(clientName || '').trim() || 'Magic City MCP Client',
    redirectUris: Array.isArray(redirectUris) ? redirectUris.map((value) => String(value || '').trim()).filter(Boolean) : [],
    grantTypes: Array.isArray(grantTypes) ? grantTypes.map((value) => String(value || '').trim()).filter(Boolean) : ['authorization_code', 'refresh_token'],
    responseTypes: Array.isArray(responseTypes) ? responseTypes.map((value) => String(value || '').trim()).filter(Boolean) : ['code'],
    tokenEndpointAuthMethod: String(tokenEndpointAuthMethod || 'none').trim() || 'none',
    scope: String(scope || 'magiccity.mcp').trim() || 'magiccity.mcp',
    metadata,
    createdAt: now,
    updatedAt: now
  };
  state.oauthClients[clientId] = row;
  persistState();
  return row;
}

export function getOAuthClient(clientId) {
  if (!clientId) return null;
  return state.oauthClients[clientId] ?? null;
}

export function createOAuthAuthorizationCode({
  codeHash,
  clientId,
  userId,
  redirectUri,
  scope = 'magiccity.mcp',
  codeChallenge = null,
  codeChallengeMethod = 'S256',
  expiresAt,
  metadata = null
}) {
  const now = new Date().toISOString();
  const row = {
    id: `oauthcode-${Object.keys(state.oauthAuthorizationCodes).length + 1}`,
    codeHash,
    clientId,
    userId,
    redirectUri,
    scope,
    codeChallenge,
    codeChallengeMethod,
    expiresAt,
    metadata,
    createdAt: now,
    updatedAt: now,
    consumedAt: null,
    revokedAt: null
  };
  state.oauthAuthorizationCodes[codeHash] = row;
  persistState();
  return row;
}

export function getOAuthAuthorizationCode(codeHash) {
  if (!codeHash) return null;
  return state.oauthAuthorizationCodes[codeHash] ?? null;
}

export function consumeOAuthAuthorizationCode(codeHash) {
  const current = state.oauthAuthorizationCodes[codeHash];
  if (!current) return null;
  state.oauthAuthorizationCodes[codeHash] = {
    ...current,
    updatedAt: new Date().toISOString(),
    consumedAt: new Date().toISOString()
  };
  persistState();
  return state.oauthAuthorizationCodes[codeHash];
}

export function revokeOAuthAuthorizationCode(codeHash) {
  const current = state.oauthAuthorizationCodes[codeHash];
  if (!current) return null;
  state.oauthAuthorizationCodes[codeHash] = {
    ...current,
    updatedAt: new Date().toISOString(),
    revokedAt: new Date().toISOString()
  };
  persistState();
  return state.oauthAuthorizationCodes[codeHash];
}

export function createOAuthAccessToken({
  tokenHash,
  refreshTokenHash = null,
  clientId,
  userId,
  scope = 'magiccity.mcp',
  expiresAt,
  metadata = null
}) {
  const now = new Date().toISOString();
  const row = {
    id: `oauthtok-${Object.keys(state.oauthAccessTokens).length + 1}`,
    tokenHash,
    refreshTokenHash,
    clientId,
    userId,
    scope,
    expiresAt,
    metadata,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    revokedAt: null
  };
  state.oauthAccessTokens[tokenHash] = row;
  persistState();
  return row;
}

export function getOAuthAccessToken(tokenHash) {
  if (!tokenHash) return null;
  return state.oauthAccessTokens[tokenHash] ?? null;
}

export function touchOAuthAccessToken(tokenHash) {
  const current = state.oauthAccessTokens[tokenHash];
  if (!current) return null;
  const lastSeenAt = current.lastSeenAt ? new Date(current.lastSeenAt).getTime() : 0;
  if (Number.isFinite(lastSeenAt) && Date.now() - lastSeenAt < 5 * 60 * 1000) {
    return current;
  }
  state.oauthAccessTokens[tokenHash] = {
    ...current,
    updatedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
  persistState();
  return state.oauthAccessTokens[tokenHash];
}

export function revokeOAuthAccessToken(tokenHash) {
  const current = state.oauthAccessTokens[tokenHash];
  if (!current) return null;
  state.oauthAccessTokens[tokenHash] = {
    ...current,
    updatedAt: new Date().toISOString(),
    revokedAt: new Date().toISOString()
  };
  persistState();
  return state.oauthAccessTokens[tokenHash];
}

export function createOAuthRefreshToken({
  tokenHash,
  clientId,
  userId,
  scope = 'magiccity.mcp',
  expiresAt,
  metadata = null
}) {
  const now = new Date().toISOString();
  const row = {
    id: `oauthrefresh-${Object.keys(state.oauthRefreshTokens).length + 1}`,
    tokenHash,
    clientId,
    userId,
    scope,
    expiresAt,
    metadata,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    revokedAt: null
  };
  state.oauthRefreshTokens[tokenHash] = row;
  persistState();
  return row;
}

export function getOAuthRefreshToken(tokenHash) {
  if (!tokenHash) return null;
  return state.oauthRefreshTokens[tokenHash] ?? null;
}

export function touchOAuthRefreshToken(tokenHash) {
  const current = state.oauthRefreshTokens[tokenHash];
  if (!current) return null;
  const lastSeenAt = current.lastSeenAt ? new Date(current.lastSeenAt).getTime() : 0;
  if (Number.isFinite(lastSeenAt) && Date.now() - lastSeenAt < 5 * 60 * 1000) {
    return current;
  }
  state.oauthRefreshTokens[tokenHash] = {
    ...current,
    updatedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
  persistState();
  return state.oauthRefreshTokens[tokenHash];
}

export function revokeOAuthRefreshToken(tokenHash) {
  const current = state.oauthRefreshTokens[tokenHash];
  if (!current) return null;
  state.oauthRefreshTokens[tokenHash] = {
    ...current,
    updatedAt: new Date().toISOString(),
    revokedAt: new Date().toISOString()
  };
  persistState();
  return state.oauthRefreshTokens[tokenHash];
}

function splitLedgerMetadata(metadata = {}) {
  const { eventKey, ...rest } = metadata && typeof metadata === 'object' ? metadata : {};
  return { eventKey: normalizeLedgerEventKey(eventKey), metadata: rest };
}

export function creditUserAccount(userHash, amount, source = 'manual_credit', metadata = {}) {
  const acct = ensureUserAccount(userHash);
  const { eventKey, metadata: ledgerMetadata } = splitLedgerMetadata(metadata);
  if (eventKey && findLedgerEntryByEventKey(eventKey)) return acct;
  const delta = Math.max(0, Math.trunc(Number(amount ?? 0)));
  acct.available += delta;
  acct.totalDeposited += delta;
  acct.updatedAt = new Date().toISOString();
  appendLedger({ type: 'credit', userHash, amount: delta, source, eventKey, ...ledgerMetadata });
  persistState();
  return acct;
}

export function grantRewardCredits(userHash, amount, source = 'reward_credit', metadata = {}) {
  const acct = ensureUserAccount(userHash);
  const { eventKey, metadata: ledgerMetadata } = splitLedgerMetadata(metadata);
  if (eventKey && findLedgerEntryByEventKey(eventKey)) return acct;
  const delta = Math.max(0, Math.trunc(Number(amount ?? 0)));
  acct.available += delta;
  acct.totalRewarded += delta;
  acct.updatedAt = new Date().toISOString();
  appendLedger({ type: 'reward_credit', userHash, amount: delta, source, eventKey, ...ledgerMetadata });
  persistState();
  return acct;
}

export function debitUserAccount(userHash, amount, source = 'manual_debit', metadata = {}) {
  const acct = ensureUserAccount(userHash);
  const { eventKey, metadata: ledgerMetadata } = splitLedgerMetadata(metadata);
  if (eventKey && findLedgerEntryByEventKey(eventKey)) return acct;
  const delta = Math.max(0, Math.trunc(Number(amount ?? 0)));
  const availableDebit = Math.min(acct.available, delta);
  acct.available -= availableDebit;
  const remainder = delta - availableDebit;
  if (remainder > 0) {
    acct.chargebackOutstanding += remainder;
  }
  acct.updatedAt = new Date().toISOString();
  appendLedger({
    type: 'debit',
    userHash,
    amount: delta,
    source,
    eventKey,
    availableDebited: availableDebit,
    outstandingCreated: remainder,
    ...ledgerMetadata
  });
  persistState();
  return acct;
}

export function lockUserCreditsForIntent(userHash, amount, intentId, metadata = {}) {
  const acct = ensureUserAccount(userHash);
  const existingLock = state.escrowLocks[intentId];
  if (existingLock?.status === 'locked') {
    return { ok: true, lock: existingLock, account: acct, deduped: true };
  }
  if (existingLock) {
    return { ok: false, reason: `lock_already_${existingLock.status || 'exists'}`, account: acct, lock: existingLock };
  }
  const { eventKey, metadata: ledgerMetadata } = splitLedgerMetadata(metadata);
  const delta = Math.max(0, Math.trunc(Number(amount ?? 0)));
  if (acct.available < delta) {
    return { ok: false, reason: 'insufficient_credits', account: acct };
  }
  acct.available -= delta;
  acct.locked += delta;
  acct.updatedAt = new Date().toISOString();
  state.escrowLocks[intentId] = {
    intentId,
    userHash,
    amount: delta,
    status: 'locked',
    createdAt: new Date().toISOString()
  };
  appendLedger({ type: 'lock', userHash, intentId, amount: delta, eventKey: eventKey || `lock:${intentId}`, ...ledgerMetadata });
  persistState();
  return { ok: true, lock: state.escrowLocks[intentId], account: acct };
}

export function restoreReleasedCreditsForIntent(userHash, amount, intentId, expectedReason = 'stale_session_lock_released') {
  const acct = ensureUserAccount(userHash);
  const lock = state.escrowLocks[intentId];
  const delta = Math.max(0, Math.trunc(Number(amount ?? 0)));
  if (lock?.status === 'locked' && lock.userHash === userHash && Number(lock.amount || 0) === delta) {
    return { ok: true, lock, account: acct, deduped: true };
  }
  if (!lock || lock.status !== 'released') {
    return { ok: false, reason: 'released_lock_required', account: acct, lock: lock || null };
  }
  if (lock.reason !== expectedReason) {
    return { ok: false, reason: 'release_reason_not_restorable', account: acct, lock };
  }
  if (lock.userHash !== userHash) {
    return { ok: false, reason: 'credit_lock_requester_mismatch', account: acct, lock };
  }
  if (Number(lock.amount || 0) !== delta) {
    return { ok: false, reason: 'credit_lock_amount_mismatch', account: acct, lock };
  }
  if (acct.available < delta) {
    return { ok: false, reason: 'insufficient_credits', account: acct, lock };
  }
  const restoredAt = new Date().toISOString();
  const releaseRevision = lock.updatedAt || restoredAt;
  const lockCycle = Math.max(0, Math.trunc(Number(lock.lockCycle || 0))) + 1;
  acct.available -= delta;
  acct.locked += delta;
  acct.updatedAt = restoredAt;
  lock.status = 'locked';
  lock.lockCycle = lockCycle;
  lock.restoredAt = restoredAt;
  lock.restoredFromReason = expectedReason;
  lock.reason = null;
  lock.updatedAt = restoredAt;
  appendLedger({
    type: 'lock',
    userHash,
    intentId,
    amount: delta,
    source: 'restore_released_credit_lock',
    eventKey: `restore_lock:${intentId}:${releaseRevision}`,
    lockCycle,
    restoredFromReason: expectedReason
  });
  persistState();
  return { ok: true, lock, account: acct, restored: true };
}

export function settleLockedCredits(intentId, providerAgentId, feeBps = 500, settlement = null) {
  const lock = state.escrowLocks[intentId];
  if (!lock || lock.status !== 'locked') {
    return { ok: false, reason: 'lock_not_found_or_not_locked' };
  }
  const acct = ensureUserAccount(lock.userHash);
  const treasury = ensurePlatformTreasury();
  const lockCycle = Math.max(0, Math.trunc(Number(lock.lockCycle || 0)));
  const settlementConfig = settlement && typeof settlement === 'object' ? settlement : {};
  const merchantPayable = Math.max(0, Math.min(
    lock.amount,
    Math.trunc(Number(settlementConfig.merchantPayable ?? 0))
  ));
  const grossAmount = Math.max(0, Math.trunc(Number(settlementConfig.grossAmount ?? lock.amount)));
  const platformRevenue = Math.max(0, Math.trunc(Number(
    settlementConfig.platformRevenue ?? Math.max(0, grossAmount - merchantPayable)
  )));
  acct.locked = Math.max(0, acct.locked - lock.amount);
  acct.totalSpent += lock.amount;
  acct.updatedAt = new Date().toISOString();
  const capturedAt = new Date().toISOString();
  const platformCaptured = lock.amount;
  const creditsBurned = lock.amount;
  treasury.captured += platformCaptured;
  treasury.burned += creditsBurned;
  treasury.merchantPayable += merchantPayable;
  treasury.netRevenue += platformRevenue;
  treasury.capturedSessions += 1;
  treasury.updatedAt = capturedAt;
  treasury.lastIntentId = intentId;

  lock.status = 'settled';
  lock.providerAgentId = providerAgentId;
  lock.providerAmount = 0;
  lock.protocolFee = 0;
  lock.platformCaptured = platformCaptured;
  lock.creditsBurned = creditsBurned;
  lock.merchantPayable = merchantPayable;
  lock.platformRevenue = platformRevenue;
  lock.settlementMode = merchantPayable > 0
    ? 'platform_capture_pending_merchant_settlement'
    : 'platform_revenue_capture';
  lock.updatedAt = capturedAt;

  appendLedger({
    type: 'settle',
    userHash: lock.userHash,
    intentId,
    amount: lock.amount,
    eventKey: lockCycle > 0 ? `settle:${intentId}:${lockCycle}` : `settle:${intentId}`,
    lockCycle,
    providerAgentId,
    providerAmount: 0,
    protocolFee: 0,
    platformCaptured,
    creditsBurned,
    merchantPayable,
    platformRevenue,
    settlementMode: lock.settlementMode
  });
  persistState();
  return { ok: true, lock, account: acct, treasury };
}

export function refundSettledCredits(intentId, reason = 'settlement_reversed') {
  const lock = state.escrowLocks[intentId];
  if (lock?.status === 'refunded') {
    return {
      ok: true,
      lock,
      account: ensureUserAccount(lock.userHash),
      treasury: ensurePlatformTreasury(),
      deduped: true
    };
  }
  if (!lock || lock.status !== 'settled') {
    return { ok: false, reason: 'lock_not_found_or_not_settled', lock: lock || null };
  }

  const acct = ensureUserAccount(lock.userHash);
  const treasury = ensurePlatformTreasury();
  const lockCycle = Math.max(0, Math.trunc(Number(lock.lockCycle || 0)));
  const refundedAt = new Date().toISOString();
  const platformCaptured = Math.max(0, Math.trunc(Number(lock.platformCaptured ?? lock.amount)));
  const creditsBurned = Math.max(0, Math.trunc(Number(lock.creditsBurned ?? lock.amount)));
  const merchantPayable = Math.max(0, Math.trunc(Number(lock.merchantPayable ?? 0)));
  const platformRevenue = Math.max(0, Math.trunc(Number(lock.platformRevenue ?? platformCaptured)));

  acct.available += lock.amount;
  acct.totalSpent = Math.max(0, acct.totalSpent - lock.amount);
  acct.updatedAt = refundedAt;

  treasury.captured = Math.max(0, Number(treasury.captured || 0) - platformCaptured);
  treasury.burned = Math.max(0, Number(treasury.burned || 0) - creditsBurned);
  treasury.merchantPayable = Math.max(0, Number(treasury.merchantPayable || 0) - merchantPayable);
  treasury.netRevenue = Math.max(0, Number(treasury.netRevenue || 0) - platformRevenue);
  treasury.capturedSessions = Math.max(0, Number(treasury.capturedSessions || 0) - 1);
  treasury.updatedAt = refundedAt;
  treasury.lastIntentId = intentId;

  lock.status = 'refunded';
  lock.refundReason = reason;
  lock.refundedAt = refundedAt;
  lock.updatedAt = refundedAt;

  appendLedger({
    type: 'settlement_refund',
    userHash: lock.userHash,
    intentId,
    amount: lock.amount,
    reason,
    eventKey: lockCycle > 0 ? `settlement-refund:${intentId}:${lockCycle}` : `settlement-refund:${intentId}`,
    lockCycle,
    platformCaptured,
    creditsBurned,
    merchantPayable,
    platformRevenue
  });
  persistState();
  return { ok: true, lock, account: acct, treasury };
}

export function releaseLockedCredits(intentId, reason = 'intent_unroutable') {
  const lock = state.escrowLocks[intentId];
  if (!lock || lock.status !== 'locked') {
    return { ok: false, reason: 'lock_not_found_or_not_locked' };
  }
  const acct = ensureUserAccount(lock.userHash);
  const lockCycle = Math.max(0, Math.trunc(Number(lock.lockCycle || 0)));
  acct.available += lock.amount;
  acct.locked = Math.max(0, acct.locked - lock.amount);
  acct.updatedAt = new Date().toISOString();

  lock.status = 'released';
  lock.reason = reason;
  lock.updatedAt = new Date().toISOString();
  appendLedger({
    type: 'release',
    userHash: lock.userHash,
    intentId,
    amount: lock.amount,
    reason,
    eventKey: lockCycle > 0 ? `release:${intentId}:${lockCycle}` : `release:${intentId}`,
    lockCycle
  });
  persistState();
  return { ok: true, lock, account: acct };
}

export function getEscrowLock(intentId) {
  return state.escrowLocks[intentId] ?? null;
}

export function listLedger() {
  return state.ledger;
}

function applyLedgerEntryToAccountProjection(projection, row) {
  const amount = Math.max(0, Math.trunc(Number(row?.amount ?? 0)));
  if (!projection || !amount) return;
  switch (String(row?.type || '').trim()) {
    case 'credit':
      projection.available += amount;
      projection.totalDeposited += amount;
      break;
    case 'reward_credit':
      projection.available += amount;
      projection.totalRewarded += amount;
      break;
    case 'debit': {
      const availableDebit = Math.max(0, Math.trunc(Number(row.availableDebited ?? Math.min(projection.available, amount))));
      const outstandingCreated = Math.max(0, Math.trunc(Number(row.outstandingCreated ?? Math.max(0, amount - availableDebit))));
      projection.available = Math.max(0, projection.available - availableDebit);
      projection.chargebackOutstanding += outstandingCreated;
      break;
    }
    case 'lock':
      projection.available = Math.max(0, projection.available - amount);
      projection.locked += amount;
      break;
    case 'release':
      projection.available += amount;
      projection.locked = Math.max(0, projection.locked - amount);
      break;
    case 'settle':
      projection.locked = Math.max(0, projection.locked - amount);
      projection.totalSpent += amount;
      break;
    case 'settlement_refund':
      projection.available += amount;
      projection.totalSpent = Math.max(0, projection.totalSpent - amount);
      break;
    default:
      break;
  }
}

function projectAccountsFromLedger() {
  const projected = {};
  for (const key of Object.keys(state.userAccounts)) {
    projected[key] = {
      userHash: key,
      available: 0,
      locked: 0,
      totalDeposited: 0,
      totalRewarded: 0,
      totalSpent: 0,
      chargebackOutstanding: 0
    };
  }
  for (const row of state.ledger) {
    if (!row?.userHash) continue;
    projected[row.userHash] = projected[row.userHash] ?? {
      userHash: row.userHash,
      available: 0,
      locked: 0,
      totalDeposited: 0,
      totalRewarded: 0,
      totalSpent: 0,
      chargebackOutstanding: 0
    };
    applyLedgerEntryToAccountProjection(projected[row.userHash], row);
  }
  return projected;
}

function compareAccountProjection(actual, projected) {
  const fields = ['available', 'locked', 'totalDeposited', 'totalRewarded', 'totalSpent', 'chargebackOutstanding'];
  const diffs = {};
  for (const field of fields) {
    const actualValue = Math.trunc(Number(actual?.[field] ?? 0));
    const projectedValue = Math.trunc(Number(projected?.[field] ?? 0));
    if (actualValue !== projectedValue) {
      diffs[field] = { actual: actualValue, projected: projectedValue, delta: actualValue - projectedValue };
    }
  }
  return diffs;
}

export function auditCreditLedger() {
  ensureLedgerMeta();
  const duplicateEventKeys = [];
  const seenEventKeys = new Map();
  let hashedEntries = 0;
  let legacyEntries = 0;
  let chainBreaks = 0;
  let hashMismatches = 0;
  let previousHashedRow = null;

  for (const row of state.ledger) {
    const eventKey = normalizeLedgerEventKey(row?.eventKey);
    if (eventKey) {
      const first = seenEventKeys.get(eventKey);
      if (first) duplicateEventKeys.push({ eventKey, firstId: first, duplicateId: row.id });
      else seenEventKeys.set(eventKey, row.id);
    }

    if (!row?.ledgerHash) {
      legacyEntries += 1;
      continue;
    }

    hashedEntries += 1;
    const expectedHash = hashObject({ ...row, ledgerHash: undefined });
    if (expectedHash !== row.ledgerHash) hashMismatches += 1;
    if (previousHashedRow && row.prevHash !== previousHashedRow.ledgerHash) chainBreaks += 1;
    previousHashedRow = row;
  }

  const projected = projectAccountsFromLedger();
  const accountMismatches = [];
  for (const userHash of new Set([...Object.keys(projected), ...Object.keys(state.userAccounts)])) {
    const diffs = compareAccountProjection(state.userAccounts[userHash], projected[userHash]);
    if (Object.keys(diffs).length) {
      accountMismatches.push({ userHash, diffs });
    }
  }

  const ok = duplicateEventKeys.length === 0 && chainBreaks === 0 && hashMismatches === 0 && accountMismatches.length === 0;
  return {
    ok,
    checkedAt: new Date().toISOString(),
    totalEntries: state.ledger.length,
    hashedEntries,
    legacyEntries,
    lastSequence: state.ledgerMeta?.lastSequence ?? 0,
    lastHash: state.ledgerMeta?.lastHash ?? null,
    duplicateEventKeys,
    chainBreaks,
    hashMismatches,
    accountMismatches
  };
}

export function getCreditLedgerIntegritySummary() {
  const audit = auditCreditLedger();
  return {
    ok: audit.ok,
    totalEntries: audit.totalEntries,
    hashedEntries: audit.hashedEntries,
    legacyEntries: audit.legacyEntries,
    lastSequence: audit.lastSequence,
    chainBreaks: audit.chainBreaks,
    hashMismatches: audit.hashMismatches,
    duplicateEventKeyCount: audit.duplicateEventKeys.length,
    accountMismatchCount: audit.accountMismatches.length
  };
}

export function hasReferralClaimForReferredUser(userId) {
  return state.referralClaims.some((row) => row.referredUserId === userId);
}

export function recordReferralClaim({
  referrerUserId,
  referredUserId,
  referralCode,
  referrerUserHash,
  referredUserHash,
  referrerReward,
  referredReward
}) {
  const now = new Date().toISOString();
  const row = {
    id: `referral-${state.referralClaims.length + 1}`,
    createdAt: now,
    referrerUserId,
    referredUserId,
    referralCode: normalizeReferralCode(referralCode),
    referrerUserHash,
    referredUserHash,
    referrerReward: Math.max(0, Math.trunc(Number(referrerReward ?? 0))),
    referredReward: Math.max(0, Math.trunc(Number(referredReward ?? 0)))
  };
  state.referralClaims.push(row);
  const referredUser = state.authUsers[referredUserId];
  if (referredUser) {
    referredUser.referredByUserId = referrerUserId;
    referredUser.referredByCode = row.referralCode;
    referredUser.referralRedeemedAt = now;
    referredUser.updatedAt = now;
  }
  persistState();
  return row;
}

export function listReferralClaimsForUser(userId) {
  return state.referralClaims.filter((row) => row.referrerUserId === userId || row.referredUserId === userId);
}

export function findShareRewardClaim(userId, sessionId, platform) {
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  return (
    state.shareRewardClaims.find(
      (row) =>
        row.userId === userId &&
        row.sessionId === sessionId &&
        String(row.platform || '').trim().toLowerCase() === normalizedPlatform
    ) ?? null
  );
}

export function recordShareRewardClaim({ userId, userHash, sessionId, platform, amount, sessionKind = null }) {
  const row = {
    id: `share-${state.shareRewardClaims.length + 1}`,
    createdAt: new Date().toISOString(),
    userId,
    userHash,
    sessionId,
    sessionKind,
    platform: String(platform || '').trim().toLowerCase(),
    amount: Math.max(0, Math.trunc(Number(amount ?? 0)))
  };
  state.shareRewardClaims.push(row);
  persistState();
  return row;
}

export function listShareRewardClaimsForUser(userId) {
  return state.shareRewardClaims.filter((row) => row.userId === userId);
}

export function anonymizeUser(userHash) {
  delete state.userAccounts[userHash];
  for (const lock of Object.values(state.escrowLocks)) {
    if (lock.userHash === userHash) {
      lock.userHash = 'anon';
    }
  }
  for (const intent of state.intents) {
    if (intent.requesterHash === userHash) {
      intent.requesterHash = 'anon';
    }
  }
  for (const row of state.ledger) {
    if (row.userHash === userHash) {
      row.userHash = 'anon';
    }
  }
  persistState();
}

export function createPayoutRequest({ agentId, amount, rail, destination }) {
  const current = state.balances[agentId] ?? 0;
  const delta = Math.max(0, Math.trunc(Number(amount ?? 0)));
  if (delta <= 0 || current < delta) {
    return { ok: false, reason: 'insufficient_provider_balance', available: current };
  }
  state.balances[agentId] = current - delta;
  const row = {
    id: `payout-${state.payoutRequests.length + 1}`,
    createdAt: new Date().toISOString(),
    status: 'requested',
    agentId,
    amount: delta,
    rail,
    destination
  };
  state.payoutRequests.push(row);
  appendLedger({ type: 'payout_request', agentId, amount: delta, rail, payoutRequestId: row.id });
  persistState();
  return { ok: true, payout: row };
}

export function settlePayoutRequest(id, settlementRef, status = 'paid') {
  const idx = state.payoutRequests.findIndex((x) => x.id === id);
  if (idx < 0) return null;
  state.payoutRequests[idx] = {
    ...state.payoutRequests[idx],
    status,
    settlementRef: settlementRef ?? null,
    settledAt: new Date().toISOString()
  };
  appendLedger({
    type: 'payout_settle',
    payoutRequestId: id,
    status,
    settlementRef: settlementRef ?? null
  });
  if (settlementRef && settlementRef.startsWith('stripe:tr_')) {
    const transferId = settlementRef.replace('stripe:tr_', '');
    state.payoutByTransferId[transferId] = id;
  }
  persistState();
  return state.payoutRequests[idx];
}

export function listPayoutRequests() {
  return state.payoutRequests;
}

export function linkPayoutTransferId(payoutRequestId, transferId) {
  state.payoutByTransferId[transferId] = payoutRequestId;
  persistState();
}

export function findPayoutByTransferId(transferId) {
  const payoutRequestId = state.payoutByTransferId[transferId];
  if (!payoutRequestId) return null;
  return state.payoutRequests.find((x) => x.id === payoutRequestId) ?? null;
}

export function hasProcessedStripeEvent(eventId) {
  return Boolean(state.processedStripeEvents[eventId]);
}

export function markProcessedStripeEvent(eventId, summary = {}) {
  state.processedStripeEvents[eventId] = {
    processedAt: new Date().toISOString(),
    ...summary
  };
  persistState();
}

function normalizeAgentSavedSignalAgentId(agentId = '') {
  return String(agentId || '').trim().toLowerCase();
}

function normalizeAgentSavedSignalPlatformId(platformId = '') {
  return String(platformId || 'magic-city').trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').slice(0, 80) || 'magic-city';
}

function normalizeAgentSavedSignalActorType(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return ['human', 'agent', 'app'].includes(normalized) ? normalized : 'human';
}

function normalizeAgentSavedSignalActorHash(value = '') {
  return String(value || '').trim().slice(0, 160);
}

function buildAgentSavedSignalId({ platformId, agentId, savedByType, savedByHash }) {
  return `saved_${crypto.createHash('sha256').update(JSON.stringify({
    platformId: normalizeAgentSavedSignalPlatformId(platformId),
    agentId: normalizeAgentSavedSignalAgentId(agentId),
    savedByType: normalizeAgentSavedSignalActorType(savedByType),
    savedByHash: normalizeAgentSavedSignalActorHash(savedByHash)
  })).digest('hex').slice(0, 24)}`;
}

export function recordAgentSavedSignal({
  agentId,
  platformId = 'magic-city',
  savedByType = 'human',
  savedByHash,
  metadata = {}
}) {
  const normalizedAgentId = normalizeAgentSavedSignalAgentId(agentId);
  const normalizedPlatformId = normalizeAgentSavedSignalPlatformId(platformId);
  const normalizedSavedByType = normalizeAgentSavedSignalActorType(savedByType);
  const normalizedSavedByHash = normalizeAgentSavedSignalActorHash(savedByHash);
  if (!normalizedAgentId) return { ok: false, error: 'agent_id_required' };
  if (!normalizedSavedByHash) return { ok: false, error: 'saved_by_hash_required' };
  const signalId = buildAgentSavedSignalId({
    platformId: normalizedPlatformId,
    agentId: normalizedAgentId,
    savedByType: normalizedSavedByType,
    savedByHash: normalizedSavedByHash
  });
  const now = new Date().toISOString();
  const existingIndex = state.agentSavedSignals.findIndex((row) => row.signalId === signalId);
  const existing = existingIndex >= 0 ? state.agentSavedSignals[existingIndex] : null;
  const row = {
    ...(existing || {}),
    signalId,
    schemaVersion: 'magic-city-agent-saved-signal/0.1',
    platformId: normalizedPlatformId,
    agentId: normalizedAgentId,
    savedByType: normalizedSavedByType,
    savedByHash: normalizedSavedByHash,
    active: true,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    metadata: {
      ...(existing?.metadata || {}),
      ...metadata
    }
  };
  delete row.removedAt;
  if (existingIndex >= 0) state.agentSavedSignals[existingIndex] = row;
  else state.agentSavedSignals.unshift(row);
  persistState();
  return {
    ok: true,
    saved: true,
    created: !existing,
    signal: {
      ...row,
      savedByHash: undefined
    },
    stats: getAgentSavedStats(normalizedAgentId, normalizedPlatformId)
  };
}

export function removeAgentSavedSignal({
  agentId,
  platformId = 'magic-city',
  savedByType = 'human',
  savedByHash,
  metadata = {}
}) {
  const normalizedAgentId = normalizeAgentSavedSignalAgentId(agentId);
  const normalizedPlatformId = normalizeAgentSavedSignalPlatformId(platformId);
  const normalizedSavedByType = normalizeAgentSavedSignalActorType(savedByType);
  const normalizedSavedByHash = normalizeAgentSavedSignalActorHash(savedByHash);
  if (!normalizedAgentId) return { ok: false, error: 'agent_id_required' };
  if (!normalizedSavedByHash) return { ok: false, error: 'saved_by_hash_required' };
  const signalId = buildAgentSavedSignalId({
    platformId: normalizedPlatformId,
    agentId: normalizedAgentId,
    savedByType: normalizedSavedByType,
    savedByHash: normalizedSavedByHash
  });
  const now = new Date().toISOString();
  const existingIndex = state.agentSavedSignals.findIndex((row) => row.signalId === signalId);
  const existing = existingIndex >= 0 ? state.agentSavedSignals[existingIndex] : null;
  const row = {
    ...(existing || {}),
    signalId,
    schemaVersion: 'magic-city-agent-saved-signal/0.1',
    platformId: normalizedPlatformId,
    agentId: normalizedAgentId,
    savedByType: normalizedSavedByType,
    savedByHash: normalizedSavedByHash,
    active: false,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    removedAt: now,
    metadata: {
      ...(existing?.metadata || {}),
      ...metadata
    }
  };
  if (existingIndex >= 0) state.agentSavedSignals[existingIndex] = row;
  else state.agentSavedSignals.unshift(row);
  persistState();
  return {
    ok: true,
    saved: false,
    created: false,
    signal: {
      ...row,
      savedByHash: undefined
    },
    stats: getAgentSavedStats(normalizedAgentId, normalizedPlatformId)
  };
}

export function getAgentSavedStats(agentId, platformId = 'magic-city') {
  const normalizedAgentId = normalizeAgentSavedSignalAgentId(agentId);
  const normalizedPlatformId = normalizeAgentSavedSignalPlatformId(platformId);
  const activeSignals = state.agentSavedSignals.filter((row) =>
    row?.active !== false &&
    normalizeAgentSavedSignalAgentId(row.agentId) === normalizedAgentId &&
    normalizeAgentSavedSignalPlatformId(row.platformId) === normalizedPlatformId
  );
  return {
    platformId: normalizedPlatformId,
    agentId: normalizedAgentId,
    savedCount: activeSignals.length,
    lastSavedAt: activeSignals
      .map((row) => row.updatedAt || row.createdAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null
  };
}

export function listAgentSavedStats({ platformId = 'magic-city', limit = 500 } = {}) {
  const normalizedPlatformId = normalizeAgentSavedSignalPlatformId(platformId);
  const byAgent = new Map();
  for (const row of state.agentSavedSignals) {
    if (row?.active === false) continue;
    if (normalizeAgentSavedSignalPlatformId(row.platformId) !== normalizedPlatformId) continue;
    const agentId = normalizeAgentSavedSignalAgentId(row.agentId);
    if (!agentId) continue;
    const stats = byAgent.get(agentId) || {
      platformId: normalizedPlatformId,
      agentId,
      savedCount: 0,
      lastSavedAt: null
    };
    stats.savedCount += 1;
    const updatedAt = row.updatedAt || row.createdAt || null;
    if (updatedAt && (!stats.lastSavedAt || updatedAt > stats.lastSavedAt)) stats.lastSavedAt = updatedAt;
    byAgent.set(agentId, stats);
  }
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 1000));
  return Array.from(byAgent.values())
    .sort((left, right) => {
      const countDiff = Number(right.savedCount || 0) - Number(left.savedCount || 0);
      if (countDiff !== 0) return countDiff;
      return String(right.lastSavedAt || '').localeCompare(String(left.lastSavedAt || ''));
    })
    .slice(0, safeLimit);
}

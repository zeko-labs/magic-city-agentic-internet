import { validateRelayerCredentials } from './relayerSecurity.js';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import {
  createOrGetSubmission,
  getSubmission,
  getZekoRelayerPersistenceStatus,
  listSubmissions,
  updateSubmission
} from './zekoSubmitterStore.js';
import {
  getMbaMissionRegistryBootstrapState,
  getMbaMissionRegistryConfig,
  submitMbaMissionRegistryAnchor
} from './mba/missionRegistryAnchor.js';
import { MBA_MISSION_REGISTRY_ADDRESS } from './mba/registryConfig.js';
import {
  getMbaMissionRegistryPersistenceStatus,
  getMbaMissionRegistryState,
  upsertMbaMissionRegistryState,
  withMbaMissionRegistryMutationLock
} from './mbaRegistryStore.js';

validateRelayerCredentials();

// The relayer is an internal capability. Expose it only when an operator opts in.
const HOST = process.env.ZEKO_RELAYER_HOST || process.env.ZEKO_SUBMITTER_HOST || process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.ZEKO_RELAYER_PORT ?? process.env.ZEKO_SUBMITTER_PORT ?? 4412);
const TOKEN = process.env.ZEKO_RELAYER_TOKEN || process.env.ZEKO_SUBMITTER_TOKEN || '';
const MODE = process.env.ZEKO_RELAYER_MODE || process.env.ZEKO_SUBMITTER_MODE || 'record';
const DEFAULT_MAGIC_CITY_MISSION_PROOF_NETWORK_ID = 'zeko:testnet';
function resolveMissionProofNetworkId() {
  const explicit = String(process.env.MAGIC_CITY_MISSION_PROOF_NETWORK_ID || '').trim();
  if (explicit) return explicit;
  const legacy = String(process.env.ZEKO_NETWORK_ID || '').trim();
  return legacy || DEFAULT_MAGIC_CITY_MISSION_PROOF_NETWORK_ID;
}

const ZEKO_NETWORK_ID = resolveMissionProofNetworkId();
const ZEKO_O1JS_NETWORK_ID =
  process.env.ZEKO_O1JS_NETWORK_ID ||
  (String(ZEKO_NETWORK_ID).includes('mainnet') ? 'zeko-mainnet' : 'testnet');
const ZEKO_IS_MAINNET = String(ZEKO_NETWORK_ID).includes('mainnet');
const ZEKO_IS_SEPOLIA = String(ZEKO_NETWORK_ID).includes('sepolia');
const ZEKO_GRAPHQL = process.env.ZEKO_GRAPHQL || (ZEKO_IS_SEPOLIA ? 'https://sepolia.zeko.io/graphql' : ZEKO_IS_MAINNET ? 'https://mainnet.zeko.io/graphql' : 'https://testnet.zeko.io/graphql');
const ZEKO_ARCHIVE = process.env.ZEKO_ARCHIVE || (ZEKO_IS_SEPOLIA ? ZEKO_GRAPHQL : ZEKO_IS_MAINNET ? 'https://archive.mainnet.zeko.io/graphql' : ZEKO_GRAPHQL);
const TX_FEE = process.env.TX_FEE || (ZEKO_IS_SEPOLIA ? '200000' : '100000000');
const RELAYER_PRIVATE_KEY =
  process.env.ZEKO_RELAYER_PRIVATE_KEY ||
  process.env.ZEKO_MISSION_AUTH_RELAYER_PRIVATE_KEY ||
  process.env.SUBMITTER_PRIVATE_KEY ||
  '';
const ANCHOR_PAYMENT_AMOUNT = process.env.ZEKO_ANCHOR_PAYMENT_AMOUNT || '1';
const ANCHOR_RECIPIENT = process.env.ZEKO_ANCHOR_RECIPIENT || '';
const MISSION_AUTH_REGISTRY_PUBLIC_KEY = process.env.ZEKO_MISSION_AUTH_REGISTRY_PUBLIC_KEY || '';
const MISSION_AUTH_REGISTRY_PRIVATE_KEY = process.env.ZEKO_MISSION_AUTH_REGISTRY_PRIVATE_KEY || '';
const MBA_MISSION_REGISTRY_PUBLIC_KEY = process.env.ZEKO_MBA_MISSION_REGISTRY_PUBLIC_KEY || process.env.MISSION_REGISTRY_PUBLIC_KEY || MBA_MISSION_REGISTRY_ADDRESS;
const PRE_BROADCAST_RETRY_LIMIT = Math.max(
  1,
  Math.min(Number(process.env.ZEKO_PRE_BROADCAST_RETRY_LIMIT || 2) || 2, 3)
);
const ZEKO_TX_SEND_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.ZEKO_TX_SEND_TIMEOUT_MS || 2 * 60 * 1000) || 2 * 60 * 1000
);
const ZEKO_TX_SEND_RETRY_LIMIT = Math.max(
  1,
  Math.min(Number(process.env.ZEKO_TX_SEND_RETRY_LIMIT || 3) || 3, 5)
);
const ZEKO_RELAYER_JOB_TIMEOUT_MS = Math.max(
  ZEKO_TX_SEND_TIMEOUT_MS + 30_000,
  Number(process.env.ZEKO_RELAYER_JOB_TIMEOUT_MS || 5 * 60 * 1000) || 5 * 60 * 1000
);
const SUBMIT_ONCE_ID = process.argv[2] === '--submit-once' ? String(process.argv[3] || '') : '';
const ZEKO_RELAYER_JOB_PRIORITY = Math.max(
  0,
  Math.min(Number(process.env.ZEKO_RELAYER_JOB_PRIORITY || 19) || 19, 19)
);

if (SUBMIT_ONCE_ID) {
  try {
    os.setPriority(process.pid, ZEKO_RELAYER_JOB_PRIORITY);
  } catch {
    // Best-effort isolation: the web server must stay responsive while o1js works.
  }
}

function withTimeout(promise, timeoutMs, buildError) {
  let timeout = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(typeof buildError === 'function' ? buildError() : new Error(String(buildError || 'operation_timeout')));
      }, timeoutMs);
      timeout.unref?.();
    })
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function sendJson(res, code, payload) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function readBody(req, maxBytes = 512 * 1024) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      const err = new Error('payload_too_large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('invalid_json');
    err.statusCode = 400;
    throw err;
  }
}

function assertToken(req) {
  if (!TOKEN) {
    const err = new Error('relayer_auth_not_configured');
    err.statusCode = 503;
    throw err;
  }
  const header = req.headers.authorization || '';
  const expected = `Bearer ${TOKEN}`;
  const actualBytes = Buffer.from(header);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) {
    const err = new Error('unauthorized');
    err.statusCode = 401;
    throw err;
  }
  return true;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function buildAnchorKey(anchorPayload, networkId = ZEKO_NETWORK_ID) {
  return `0x${stableHash({
    schema: 'magic-city-anchor-idempotency-v1',
    networkId,
    sourceKind: anchorPayload?.sourceKind ?? null,
    sourceId: anchorPayload?.sourceId ?? null,
    receiptId: anchorPayload?.receiptId ?? null,
    intentId: anchorPayload?.intentId ?? null,
    statementHash: anchorPayload?.statementHash ?? null,
    requestCommitment: anchorPayload?.requestCommitment ?? null,
    batchRoot: anchorPayload?.batchRoot ?? null
  })}`;
}

function fieldFromText(value, Field, Poseidon) {
  const text = String(value || '');
  if (!text) return Field(0);
  return Poseidon.hash(Array.from(text).map((char) => Field(char.charCodeAt(0))));
}

function fieldFromHashLike(value, Field, Poseidon) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return Field.fromJSON(text);
  return fieldFromText(text, Field, Poseidon);
}

function isTransientSendError(message) {
  return /502|504|Bad Gateway|Gateway Timeout|timeout|timed out|fetch failed|ECONNRESET|UND_ERR|socket/i.test(String(message || ''));
}

function extractZekoTxHash(value) {
  const match = String(value || '').match(/\btxHash=([1-9A-HJ-NP-Za-km-z]{20,})\b/);
  return match?.[1] || null;
}

async function computeSignedTransactionHash(signedTx, Transaction) {
  try {
    if (!signedTx || typeof signedTx.toJSON !== 'function' || !Transaction?.hash) return null;
    return await Transaction.hash(signedTx.toJSON());
  } catch {
    return null;
  }
}

const ACCOUNT_CACHE_QUERY = `query Account($pk: PublicKey!) {
  account(publicKey: $pk) {
    publicKey
    nonce
    balance { total }
    zkappState
    verificationKey { hash }
    provedState
  }
}`;

async function fetchAndCacheAccountWithGraphqlFallback({ publicKey, fetchAccount, addCachedAccount, parseFetchedAccount, graphqlUrl }) {
  const first = await fetchAccount({ publicKey });
  if (!first.error && first.account?.zkapp) return first;

  let response;
  let payload;
  try {
    response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: ACCOUNT_CACHE_QUERY,
        variables: { pk: publicKey.toBase58() }
      })
    });
    payload = await response.json();
  } catch {
    return first;
  }
  const fetchedAccount = payload?.data?.account;
  if (!response.ok || payload?.errors?.length || !fetchedAccount) return first;

  let parsedAccount = first.account || null;
  try {
    parsedAccount = parseFetchedAccount(fetchedAccount);
    addCachedAccount(parsedAccount, graphqlUrl);
  } catch {}
  return {
    account: parsedAccount,
    error: undefined,
    fallback: 'graphql_account_cache',
    sourceAccount: fetchedAccount
  };
}

function accountResultHasDeployedZkapp(result) {
  if (result?.account?.zkapp) return true;
  const source = result?.sourceAccount || {};
  const verificationKey = source?.verificationKey?.hash || source?.verificationKey?.verificationKey || null;
  const zkappState = Array.isArray(source?.zkappState) ? source.zkappState : [];
  return Boolean(verificationKey || zkappState.length > 0);
}

function requireAnchorPayload(body) {
  if (!body || typeof body !== 'object' || !body.anchorPayload) {
    const err = new Error('missing_anchor_payload');
    err.statusCode = 400;
    throw err;
  }
  const payload = body.anchorPayload;
  const mbaAnchor = payload.schema === 'magic-city-final-submit-chain-anchor-v1';
  if (payload.schema !== 'magic-city-anchor-v1' && !mbaAnchor) {
    const err = new Error('invalid_anchor_schema');
    err.statusCode = 400;
    throw err;
  }
  if (!payload.statementHash || (!mbaAnchor && (!payload.requestCommitment || !payload.batchRoot))) {
    const err = new Error('missing_anchor_fields');
    err.statusCode = 400;
    throw err;
  }
  return payload;
}

async function readMbaRegistryOnChain() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  timeout.unref?.();
  try {
    const response = await fetch(ZEKO_GRAPHQL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query MbaRegistry($pk: PublicKey!) { account(publicKey: $pk) { publicKey nonce zkappState verificationKey { hash } } }',
        variables: { pk: MBA_MISSION_REGISTRY_PUBLIC_KEY }
      })
    });
    const payload = await response.json();
    const account = payload?.data?.account;
    const state = Array.isArray(account?.zkappState) ? account.zkappState : [];
    if (!response.ok || payload?.errors?.length || !account?.publicKey || !account?.verificationKey?.hash || !state[4] || state[5] == null) {
      throw new Error('mba_registry_chain_state_unavailable');
    }
    return {
      reachable: true,
      accountNonce: String(account.nonce || ''),
      registryRoot: String(state[4]),
      sequence: String(state[5]),
      verificationKeyHash: String(account.verificationKey.hash)
    };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readMissionAuthRegistryOnChain() {
  if (!MISSION_AUTH_REGISTRY_PUBLIC_KEY) {
    return { reachable: false, error: 'mission_auth_registry_not_configured' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  timeout.unref?.();
  try {
    const response = await fetch(ZEKO_GRAPHQL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query MissionAuthRegistry($pk: PublicKey!) { account(publicKey: $pk) { publicKey zkappState verificationKey { hash } } }',
        variables: { pk: MISSION_AUTH_REGISTRY_PUBLIC_KEY }
      })
    });
    const payload = await response.json();
    const account = payload?.data?.account;
    const state = Array.isArray(account?.zkappState) ? account.zkappState : [];
    if (!response.ok || payload?.errors?.length || !account?.publicKey || !account?.verificationKey?.hash || state.length < 3) {
      throw new Error('mission_auth_registry_chain_state_unavailable');
    }
    return {
      reachable: true,
      latestStatementHash: String(state[0] || '0'),
      latestPayloadDigest: String(state[1] || '0'),
      anchoredCount: String(state[2] || '0'),
      verificationKeyHash: String(account.verificationKey.hash)
    };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readMissionAuthRegistryEvents() {
  if (!MISSION_AUTH_REGISTRY_PUBLIC_KEY) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  timeout.unref?.();
  try {
    const response = await fetch(ZEKO_GRAPHQL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query MissionAuthRegistryEvents($address: PublicKey!) {
          events(input: { address: $address }) {
            eventData { transactionInfo { hash status } data }
          }
        }`,
        variables: { address: MISSION_AUTH_REGISTRY_PUBLIC_KEY }
      })
    });
    const payload = await response.json();
    if (!response.ok || payload?.errors?.length) return [];
    const groups = Array.isArray(payload?.data?.events) ? payload.data.events : [];
    return groups.flatMap((group) => Array.isArray(group?.eventData) ? group.eventData : []);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function eventTransactionApplied(status) {
  let parsedStatus = status;
  if (typeof status === 'string' && status.trim().startsWith('[')) {
    try {
      parsedStatus = JSON.parse(status);
    } catch {}
  }
  const values = Array.isArray(parsedStatus) ? parsedStatus : [parsedStatus];
  return values.some((value) => String(value || '').toLowerCase() === 'applied');
}

async function reconcileMissionAuthSubmission(submission) {
  if (submission?.anchorPayload?.schema !== 'magic-city-final-submit-chain-anchor-v1') return null;
  const txHash = submission?.txHash || submission?.result?.txHash || null;
  const statementHash = String(submission?.result?.statementHash || submission?.anchorPayload?.statementHash || '');
  if (!txHash || !statementHash) return null;
  const events = await readMissionAuthRegistryEvents();
  const matched = events.find((event) => (
    String(event?.transactionInfo?.hash || '') === String(txHash)
    && eventTransactionApplied(event?.transactionInfo?.status)
    && Array.isArray(event?.data)
    && event.data.some((value) => String(value) === statementHash)
  ));
  if (!matched) return null;
  const chain = await readMissionAuthRegistryOnChain();
  if (!chain.reachable) return null;
  return updateSubmission(submission.id, {
    status: 'submitted',
    txHash,
    result: {
      ...(submission.result || {}),
      accepted: true,
      mode: 'mission_auth_registry',
      registryPublicKey: MISSION_AUTH_REGISTRY_PUBLIC_KEY,
      statementHash,
      payloadDigest: submission?.result?.payloadDigest || null,
      anchoredCount: chain.anchoredCount,
      verificationKeyHash: chain.verificationKeyHash,
      confirmedAt: new Date().toISOString(),
      reconciliation: 'zeko_applied_event'
    }
  });
}

async function missionAuthRelayerReadiness() {
  const chain = await readMissionAuthRegistryOnChain();
  return {
    ready: Boolean(RELAYER_PRIVATE_KEY && MISSION_AUTH_REGISTRY_PRIVATE_KEY && chain.reachable),
    registryAddress: MISSION_AUTH_REGISTRY_PUBLIC_KEY || null,
    capabilities: ['mission_auth_registry', 'authorization_commitment', 'signed_state_update'],
    credentialsConfigured: Boolean(RELAYER_PRIVATE_KEY && MISSION_AUTH_REGISTRY_PRIVATE_KEY),
    chain
  };
}

async function mbaRelayerReadiness() {
  const persistence = getMbaMissionRegistryPersistenceStatus();
  const config = getMbaMissionRegistryConfig();
  const onchain = await readMbaRegistryOnChain();
  let mirror = await getMbaMissionRegistryState(MBA_MISSION_REGISTRY_PUBLIC_KEY);
  if (!mirror && onchain.reachable) {
    try {
      const bootstrap = getMbaMissionRegistryBootstrapState(MBA_MISSION_REGISTRY_PUBLIC_KEY);
      if (bootstrap.registryRoot === onchain.registryRoot && bootstrap.sequence === onchain.sequence) {
        mirror = await upsertMbaMissionRegistryState(MBA_MISSION_REGISTRY_PUBLIC_KEY, {
          ...bootstrap,
          initializedFrom: 'verified_chain_bootstrap'
        });
      }
    } catch {
      // A custom registry must have an explicitly provisioned durable mirror.
    }
  }
  const mirrorMatchesOnchain = Boolean(
    onchain.reachable
    && mirror
    && mirror.pending == null
    && String(mirror.registryRoot || '') === onchain.registryRoot
    && String(mirror.sequence || '') === onchain.sequence
  );
  return {
    ready: Boolean(config.configured && persistence.healthy && onchain.reachable && mirrorMatchesOnchain),
    registryAddress: MBA_MISSION_REGISTRY_PUBLIC_KEY,
    capabilities: ['mba_mission_registry', 'registry_state_sync'],
    credentialsConfigured: config.configured,
    persistence,
    chain: {
      reachable: onchain.reachable,
      accountNonce: onchain.accountNonce || null,
      registryRoot: onchain.registryRoot || null,
      sequence: onchain.sequence || null,
      error: onchain.error || null
    },
    mirror: mirror
      ? {
          registryRoot: String(mirror.registryRoot || ''),
          sequence: String(mirror.sequence || ''),
          pending: Boolean(mirror.pending),
          matchesOnchain: mirrorMatchesOnchain
        }
      : { registryRoot: null, sequence: null, pending: false, matchesOnchain: false }
  };
}

function buildTxPlan(anchorPayload, payloadHash) {
  const authorizationOnly = anchorPayload?.schema === 'magic-city-final-submit-chain-anchor-v1';
  return {
    strategy: 'anchor-commitment',
    networkId: ZEKO_NETWORK_ID,
    graphql: ZEKO_GRAPHQL,
    feeNanomina: TX_FEE,
    payloadHash,
    statementHash: anchorPayload.statementHash,
    memo: `magic-city:${String(anchorPayload.intentId || anchorPayload.receiptId || payloadHash).slice(0, 28)}`,
    note: authorizationOnly
      ? 'Submit the authorization commitment to MagicCityMissionAuthRegistry under the registry signature.'
      : 'Submit the proof commitment through the configured MissionRegistry path.'
  };
}

async function submitAnchorPayment(anchorPayload, payloadHash) {
  if (!RELAYER_PRIVATE_KEY) {
    const err = new Error('ZEKO_RELAYER_PRIVATE_KEY_not_configured');
    err.statusCode = 503;
    throw err;
  }

  const { Mina, PrivateKey, PublicKey, AccountUpdate, Bool, UInt32, UInt64, fetchAccount } = await import('o1js');
  const network = Mina.Network({
    networkId: ZEKO_O1JS_NETWORK_ID,
    mina: ZEKO_GRAPHQL,
    archive: ZEKO_ARCHIVE
  });
  Mina.setActiveInstance(network);

  const relayer = PrivateKey.fromBase58(RELAYER_PRIVATE_KEY);
  const sender = relayer.toPublicKey();
  const recipient = ANCHOR_RECIPIENT ? PublicKey.fromBase58(ANCHOR_RECIPIENT) : sender;
  const memo = buildTxPlan(anchorPayload, payloadHash).memo;
  const amount = UInt64.from(ANCHOR_PAYMENT_AMOUNT);
  const fee = UInt64.from(TX_FEE);

  const attemptSend = async (overrideNonce) => {
    const account = await fetchAccount({ publicKey: sender });
    if (account.error) {
      const err = new Error('submitter_account_not_found');
      err.statusCode = 503;
      throw err;
    }
    const chainNonce = Number(account.account.nonce.toString());
    const nonce = overrideNonce ?? chainNonce;

    const tx = await Mina.transaction({ sender, fee, memo, nonce }, async () => {
      const senderUpdate = AccountUpdate.createSigned(sender);
      senderUpdate.send({ to: recipient, amount });
    });

    const feePayerUpdate = tx.feePayer;
    if (feePayerUpdate?.body?.preconditions?.account?.nonce) {
      feePayerUpdate.body.preconditions.account.nonce = { isSome: Bool(false), value: UInt32.from(0) };
    }
    if (feePayerUpdate?.body) {
      feePayerUpdate.body.useFullCommitment = Bool(true);
    }

    await tx.sign([relayer]);
    const sent = await tx.send();
    const txHash = sent?.hash?.toString?.() ?? sent?.hash ?? sent?.transactionHash ?? null;
    return {
      txHash,
      nonce,
      memo,
      recipient: recipient.toBase58(),
      sender: sender.toBase58()
    };
  };

  try {
    return await attemptSend();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Account_nonce_precondition_unsatisfied')) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const account = await fetchAccount({ publicKey: sender });
    if (account.error) throw error;
    const chainNonce = Number(account.account.nonce.toString());
    return await attemptSend(chainNonce + 1);
  }
}

async function readRelayerNonce(publicKey, graphqlUrl, fetchAccount) {
  try {
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query SenderNonce($pk: PublicKey!) { account(publicKey: $pk) { nonce inferredNonce } }',
        variables: { pk: publicKey.toBase58() }
      })
    });
    const payload = await response.json();
    const rawNonce = payload?.data?.account?.inferredNonce ?? payload?.data?.account?.nonce;
    if (/^\d+$/.test(String(rawNonce))) return Number(rawNonce);
  } catch {}

  const account = await fetchAccount({ publicKey });
  if (account.error || !account.account) {
    const err = new Error(`relayer_account_not_found:${publicKey.toBase58()}`);
    err.statusCode = 503;
    throw err;
  }
  return Number(account.account.nonce.toString());
}

async function submitMissionAuthRegistryAnchor(anchorPayload, payloadHash, { submissionId = null } = {}) {
  let executionStage = 'initializing';
  if (!RELAYER_PRIVATE_KEY) {
    const err = new Error('ZEKO_RELAYER_PRIVATE_KEY_not_configured');
    err.statusCode = 503;
    throw err;
  }
  if (!MISSION_AUTH_REGISTRY_PRIVATE_KEY) {
    const err = new Error('ZEKO_MISSION_AUTH_REGISTRY_PRIVATE_KEY_not_configured');
    err.statusCode = 503;
    throw err;
  }

  const {
    Mina,
    PrivateKey,
    PublicKey,
    Bool,
    Field,
    Poseidon,
    Transaction,
    UInt32,
    fetchAccount,
    addCachedAccount,
    parseFetchedAccount
  } = await import('o1js');
  const { MagicCityMissionAuthRegistry } = await import('./zekoMissionAuthRegistry.js');

  const network = Mina.Network({
    networkId: ZEKO_O1JS_NETWORK_ID,
    mina: ZEKO_GRAPHQL,
    archive: ZEKO_ARCHIVE
  });
  Mina.setActiveInstance(network);

  const relayer = PrivateKey.fromBase58(RELAYER_PRIVATE_KEY);
  const registryKey = PrivateKey.fromBase58(MISSION_AUTH_REGISTRY_PRIVATE_KEY);
  const registryPublicKey = MISSION_AUTH_REGISTRY_PUBLIC_KEY
    ? PublicKey.fromBase58(MISSION_AUTH_REGISTRY_PUBLIC_KEY)
    : registryKey.toPublicKey();
  const relayerPublicKey = relayer.toPublicKey();

  if (registryPublicKey.toBase58() !== registryKey.toPublicKey().toBase58()) {
    const err = new Error('mission_auth_registry_key_mismatch');
    err.statusCode = 500;
    throw err;
  }

  executionStage = 'registry_account_fetch';
  console.info('[zeko-relayer] registry_account_fetch_started');
  const registryAccount = await fetchAndCacheAccountWithGraphqlFallback({
    publicKey: registryPublicKey,
    fetchAccount,
    addCachedAccount,
    parseFetchedAccount,
    graphqlUrl: ZEKO_GRAPHQL
  });
  console.info('[zeko-relayer] registry_account_fetch_completed');
  if (registryAccount.error || !accountResultHasDeployedZkapp(registryAccount)) {
    const err = new Error('mission_auth_registry_not_deployed');
    err.statusCode = 503;
    throw err;
  }

  const statementHash = fieldFromHashLike(anchorPayload.statementHash, Field, Poseidon);
  const payloadDigest = fieldFromText(payloadHash, Field, Poseidon);
  if (submissionId) {
    await updateSubmission(submissionId, {
      result: {
        accepted: true,
        mode: 'mission_auth_registry',
        stage: 'transaction_build',
        registryPublicKey: registryPublicKey.toBase58(),
        statementHash: statementHash.toString(),
        payloadDigest: payloadDigest.toString()
      }
    });
  }
  executionStage = 'relayer_nonce_fetch';
  console.info('[zeko-relayer] relayer_nonce_fetch_started');
  const relayerNonce = await readRelayerNonce(relayerPublicKey, ZEKO_GRAPHQL, fetchAccount);
  console.info('[zeko-relayer] relayer_nonce_fetch_completed');
  const zkapp = new MagicCityMissionAuthRegistry(registryPublicKey);

  let tx = null;
  for (let attempt = 1; attempt <= PRE_BROADCAST_RETRY_LIMIT; attempt += 1) {
    executionStage = 'transaction_build';
    console.info(`[zeko-relayer] transaction_build_started attempt=${attempt}`);
    try {
      tx = await Mina.transaction({ sender: relayerPublicKey, fee: TX_FEE, nonce: relayerNonce }, async () => {
        await zkapp.anchorMissionAuth(statementHash, payloadDigest);
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = /fetch failed|timeout|timed out|ECONNRESET|UND_ERR|socket/i.test(message);
      if (!transient || attempt >= PRE_BROADCAST_RETRY_LIMIT) {
        error.executionStage = executionStage;
        error.safeToRetry = true;
        throw error;
      }
      console.warn(`[zeko-relayer] transaction_build_retry attempt=${attempt} message=${JSON.stringify(message.slice(0, 300))}`);
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      await fetchAccount({ publicKey: registryPublicKey }).catch(() => null);
    }
  }
  if (!tx) {
    const error = new Error('mission_auth_registry_transaction_not_built');
    error.executionStage = executionStage;
    error.safeToRetry = true;
    throw error;
  }
  console.info('[zeko-relayer] transaction_build_completed');
  const feePayerUpdate = tx.feePayer;
  if (feePayerUpdate?.body?.preconditions?.account?.nonce) {
    feePayerUpdate.body.preconditions.account.nonce = { isSome: Bool(false), value: UInt32.from(0) };
  }
  if (feePayerUpdate?.body) {
    feePayerUpdate.body.useFullCommitment = Bool(true);
  }
  executionStage = 'transaction_send';
  console.info('[zeko-relayer] transaction_send_started');
  let pending;
  const signedTx = tx.sign([relayer, registryKey]);
  const localTxHash = await computeSignedTransactionHash(signedTx, Transaction);
  if (submissionId) {
    await updateSubmission(submissionId, {
      txHash: localTxHash,
      result: {
        accepted: true,
        mode: 'mission_auth_registry',
        stage: 'transaction_send',
        registryPublicKey: registryPublicKey.toBase58(),
        statementHash: statementHash.toString(),
        payloadDigest: payloadDigest.toString(),
        txHash: localTxHash,
        broadcastState: 'prepared'
      }
    });
  }
  for (let sendAttempt = 1; sendAttempt <= ZEKO_TX_SEND_RETRY_LIMIT; sendAttempt += 1) {
    try {
      const sendPromise = signedTx.send();
      pending = await withTimeout(sendPromise, ZEKO_TX_SEND_TIMEOUT_MS, () => {
        const err = new Error(`mission_auth_registry_send_timeout:${ZEKO_TX_SEND_TIMEOUT_MS}`);
        err.executionStage = executionStage;
        err.submissionUncertain = true;
        err.safeToRetry = sendAttempt < ZEKO_TX_SEND_RETRY_LIMIT;
        err.txHash = localTxHash;
        return err;
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      error.executionStage = executionStage;
      error.submissionUncertain = true;
      error.txHash = error.txHash || localTxHash;
      if (!isTransientSendError(message) || sendAttempt >= ZEKO_TX_SEND_RETRY_LIMIT) {
        error.safeToRetry = false;
        throw error;
      }
      console.warn(`[zeko-relayer] transaction_send_retry attempt=${sendAttempt} txHash=${localTxHash || 'unknown'} message=${JSON.stringify(message.slice(0, 300))}`);
      await new Promise((resolve) => setTimeout(resolve, 2500 * sendAttempt));
    }
  }
  console.info('[zeko-relayer] transaction_send_completed');
  const txHash = pending?.hash?.toString?.() ?? pending?.hash ?? pending?.transactionHash ?? localTxHash;
  if (Array.isArray(pending?.errors) && pending.errors.length > 0) {
    const err = new Error('mission_auth_registry_broadcast_rejected');
    err.statusCode = 502;
    throw err;
  }
  if (!txHash) {
    const err = new Error('mission_auth_registry_broadcast_missing_hash');
    err.statusCode = 502;
    throw err;
  }

  executionStage = 'registry_confirmation';
  const confirmationDeadline = Date.now() + 90_000;
  let confirmedState = null;
  while (Date.now() < confirmationDeadline) {
    const observed = await readMissionAuthRegistryOnChain();
    if (observed.reachable
      && observed.latestStatementHash === statementHash.toString()
      && observed.latestPayloadDigest === payloadDigest.toString()) {
      confirmedState = observed;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  if (!confirmedState) {
    const err = new Error('mission_auth_registry_confirmation_timeout');
    err.statusCode = 504;
    err.executionStage = executionStage;
    err.submissionUncertain = true;
    err.safeToRetry = false;
    err.txHash = txHash;
    throw err;
  }

  return {
    txHash,
    mode: 'mission_auth_registry',
    registryPublicKey: registryPublicKey.toBase58(),
    relayerPublicKey: relayerPublicKey.toBase58(),
    statementHash: statementHash.toString(),
    payloadDigest: payloadDigest.toString(),
    anchoredCount: confirmedState.anchoredCount,
    verificationKeyHash: confirmedState.verificationKeyHash,
    confirmedAt: new Date().toISOString(),
    nonce: relayerNonce
  };
}

async function runSubmitOnce(submissionId) {
  const submission = await getSubmission(submissionId);
  if (!submission?.anchorPayload || !submission?.payloadHash) {
    const err = new Error(`submission_not_found:${submissionId}`);
    err.statusCode = 404;
    throw err;
  }
  try {
    const authorizationOnly = submission.anchorPayload?.schema === 'magic-city-final-submit-chain-anchor-v1';
    const registryLockKey = authorizationOnly
      ? MISSION_AUTH_REGISTRY_PUBLIC_KEY
      : MBA_MISSION_REGISTRY_PUBLIC_KEY;
    const sent = await withMbaMissionRegistryMutationLock(registryLockKey, () => (
      authorizationOnly
        ? submitMissionAuthRegistryAnchor(submission.anchorPayload, submission.payloadHash, { submissionId: submission.id })
        : MODE === 'mba_mission_registry'
          ? submitMbaMissionRegistryAnchor(submission.anchorPayload, submission.payloadHash)
          : submitMissionAuthRegistryAnchor(submission.anchorPayload, submission.payloadHash, { submissionId: submission.id })
    ));
    const updated = await updateSubmission(submission.id, {
      status: sent.txHash ? 'submitted' : 'pending',
      txHash: sent.txHash,
      result: {
        accepted: true,
        ...sent
      }
    });
    console.log(JSON.stringify({
      ok: true,
      id: updated.id,
      status: updated.status,
      txHash: updated.txHash,
      payloadHash: updated.payloadHash,
      result: updated.result
    }));
    return updated;
  } catch (error) {
    const stage = String(error?.executionStage || MODE);
    const submissionUncertain = Boolean(error?.submissionUncertain);
    const message = error instanceof Error ? error.message : String(error);
    const current = await getSubmission(submission.id).catch(() => null);
    const preservedTxHash = error?.txHash || extractZekoTxHash(message) || current?.txHash || submission.txHash || null;
    await updateSubmission(submission.id, {
      status: submissionUncertain ? 'submission_unknown' : 'failed',
      txHash: preservedTxHash,
      result: {
        ...(current?.result || submission.result || {}),
        accepted: false,
        errorCode: message || 'relayer_submission_failed',
        stage,
        txHash: preservedTxHash,
        safeToRetrySamePayload: !submissionUncertain && error?.safeToRetry !== false
      }
    }).catch(() => null);
    error.executionStage = stage;
    error.submissionUncertain = submissionUncertain;
    throw error;
  }
}

function runSubmitOnceChild(submissionId) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--submit-once', submissionId], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      const err = new Error(`${MODE}_child_timeout:${ZEKO_RELAYER_JOB_TIMEOUT_MS}`);
      err.executionStage = `${MODE}_child`;
      err.submissionUncertain = true;
      err.safeToRetry = false;
      finish(() => reject(err));
    }, ZEKO_RELAYER_JOB_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 256 * 1024) stdout = stdout.slice(-128 * 1024);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-128 * 1024);
    });
    child.on('error', (error) => {
      error.executionStage = `${MODE}_child_spawn`;
      finish(() => reject(error));
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      if (code === 0) {
        try {
          const lines = stdout.trim().split('\n').filter(Boolean);
          const parsed = JSON.parse(lines.at(-1) || '{}');
          return finish(() => resolve(parsed));
        } catch (error) {
          error.executionStage = `${MODE}_child_parse`;
          return finish(() => reject(error));
        }
      }
      const err = new Error(stderr.trim().slice(-1000) || `${MODE}_child_exit:${code ?? signal}`);
      err.executionStage = `${MODE}_child`;
      err.submissionUncertain = /submission_unknown|send_timeout|SIGKILL|timeout|Bad Gateway|Gateway Timeout|502|504/i.test(String(stderr || signal || ''));
      err.txHash = extractZekoTxHash(stderr);
      finish(() => reject(err));
    });
  });
}

async function handleSubmit(req, res) {
  assertToken(req);
  const body = await readBody(req);
  const anchorPayload = requireAnchorPayload(body);
  const payloadHash = `0x${stableHash(anchorPayload)}`;
  const networkId = body.networkId || ZEKO_NETWORK_ID;
  const anchorKey = buildAnchorKey(anchorPayload, networkId);

  const reservation = await createOrGetSubmission({
    status: 'received',
    mode: MODE,
    payloadHash,
    anchorKey,
    networkId,
    anchorPayload,
    txPlan: buildTxPlan(anchorPayload, payloadHash)
  });
  const previous = reservation.created ? null : reservation.submission;
  if (previous?.status === 'submitted' && previous.txHash) {
    return sendJson(res, 200, {
      id: previous.id,
      status: previous.status,
      txHash: previous.txHash,
      payloadHash: previous.payloadHash,
      anchorKey,
      result: previous.result,
      deduplicated: true
    });
  }
  if (previous?.status === 'submission_unknown') {
    const reconciled = await reconcileMissionAuthSubmission(previous);
    if (reconciled?.status === 'submitted' && reconciled.txHash) {
      return sendJson(res, 200, {
        id: reconciled.id,
        status: reconciled.status,
        txHash: reconciled.txHash,
        payloadHash: reconciled.payloadHash,
        anchorKey,
        result: reconciled.result,
        deduplicated: true,
        reconciled: true
      });
    }
    return sendJson(res, 202, {
      id: previous.id,
      status: previous.status,
      txHash: previous.txHash || previous.result?.txHash || null,
      payloadHash: previous.payloadHash,
      anchorKey,
      result: previous.result || {
        accepted: false,
        errorCode: 'mission_auth_submission_unknown',
        txHash: previous.txHash || null
      }
    });
  }
  if (['received', 'processing'].includes(previous?.status)) {
    return sendJson(res, 409, {
      error: 'mission_auth_submission_in_progress',
      id: previous.id,
      status: previous.status,
      payloadHash: previous.payloadHash,
      anchorKey
    });
  }

  const retryablePrevious = previous?.status === 'failed'
    && previous?.result?.safeToRetrySamePayload === true;
  if (previous && !retryablePrevious) {
    return sendJson(res, 409, {
      error: 'mission_auth_submission_not_retryable',
      id: previous.id,
      status: previous.status || 'failed',
      payloadHash: previous.payloadHash,
      anchorKey
    });
  }
  const submission = previous || reservation.submission;

  if (MODE === 'record') {
    const updated = await updateSubmission(submission.id, {
      status: 'submitted',
      txHash: null,
      result: {
        accepted: true,
        mode: 'record'
      }
    });
    return sendJson(res, 201, {
      id: updated.id,
      status: updated.status,
      txHash: updated.txHash,
      payloadHash: updated.payloadHash
    });
  }

  if (MODE === 'plan') {
    const updated = await updateSubmission(submission.id, {
      status: 'planned',
      txHash: null,
      result: {
        accepted: true,
        mode: 'plan'
      }
    });
    return sendJson(res, 201, {
      id: updated.id,
      status: updated.status,
      txHash: updated.txHash,
      payloadHash: updated.payloadHash,
      txPlan: updated.txPlan
    });
  }

  if (MODE === 'payment_memo') {
    const sent = await submitAnchorPayment(anchorPayload, payloadHash);
    const updated = await updateSubmission(submission.id, {
      status: sent.txHash ? 'submitted' : 'pending',
      txHash: sent.txHash,
      result: {
        accepted: true,
        mode: 'payment_memo',
        ...sent
      }
    });
    return sendJson(res, 201, {
      id: updated.id,
      status: updated.status,
      txHash: updated.txHash,
      payloadHash: updated.payloadHash,
      result: updated.result
    });
  }

  if (MODE === 'mission_auth_registry' || MODE === 'mba_mission_registry') {
    try {
      await updateSubmission(submission.id, {
        status: 'processing',
        result: { accepted: true, stage: MODE }
      });
      const childResult = await runSubmitOnceChild(submission.id);
      const updated = await getSubmission(submission.id) || childResult;
      return sendJson(res, 201, {
        id: updated.id,
        status: updated.status,
        txHash: updated.txHash,
        payloadHash: updated.payloadHash,
        result: updated.result
      });
    } catch (error) {
      const stage = String(error?.executionStage || MODE);
      const current = await getSubmission(submission.id).catch(() => null);
      const submissionUncertain = Boolean(error?.submissionUncertain || current?.status === 'submission_unknown');
      const preservedTxHash = error?.txHash || current?.txHash || current?.result?.txHash || null;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[zeko-relayer] mission_auth_submit_failed stage=${stage} uncertain=${submissionUncertain} message=${JSON.stringify(message.slice(0, 500))} cause=${JSON.stringify(String(error?.cause?.message || error?.cause || '').slice(0, 500))}`);
      const updated = await updateSubmission(submission.id, {
        status: submissionUncertain ? 'submission_unknown' : 'failed',
        txHash: preservedTxHash,
        result: {
          ...(current?.result || submission.result || {}),
          accepted: false,
          errorCode: message || 'relayer_submission_failed',
          stage,
          txHash: preservedTxHash,
          safeToRetrySamePayload: !submissionUncertain && error?.safeToRetry !== false
        }
      }).catch(() => null);
      if (submissionUncertain) {
        return sendJson(res, 202, {
          id: updated?.id || submission.id,
          status: updated?.status || 'submission_unknown',
          txHash: updated?.txHash || preservedTxHash,
          payloadHash: updated?.payloadHash || submission.payloadHash,
          anchorKey,
          result: updated?.result || {
            accepted: false,
            errorCode: message || 'relayer_submission_unknown',
            stage,
            txHash: preservedTxHash,
            safeToRetrySamePayload: false
          }
        });
      }
      return sendJson(res, error?.statusCode ?? 502, {
        error: message || 'relayer_submission_failed',
        id: updated?.id || submission.id,
        status: updated?.status || 'failed',
        txHash: updated?.txHash || preservedTxHash,
        payloadHash: updated?.payloadHash || submission.payloadHash,
        anchorKey,
        result: updated?.result || null
      });
    }
  }

  const err = new Error(`unsupported_relayer_mode:${MODE}`);
  err.statusCode = 500;
  throw err;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      const mba = MODE === 'mba_mission_registry' ? await mbaRelayerReadiness() : null;
      const missionAuth = await missionAuthRelayerReadiness();
      return sendJson(res, 200, {
        status: 'ok',
        service: MODE === 'mba_mission_registry' ? 'magic-city-mba-relayer' : 'zeko-relayer',
        mode: MODE,
        networkId: ZEKO_NETWORK_ID,
        o1jsNetworkId: ZEKO_O1JS_NETWORK_ID,
        graphql: ZEKO_GRAPHQL,
        archive: ZEKO_ARCHIVE,
        registryConfigured: Boolean(MISSION_AUTH_REGISTRY_PUBLIC_KEY || MISSION_AUTH_REGISTRY_PRIVATE_KEY),
        persistence: getZekoRelayerPersistenceStatus(),
        mba,
        missionAuth
      });
    }

    if (req.method === 'GET' && url.pathname === '/submissions') {
      assertToken(req);
      return sendJson(res, 200, {
        submissions: await listSubmissions(Number(url.searchParams.get('limit') ?? 20))
      });
    }

    if (req.method === 'GET' && /^\/submissions\/[^/]+$/.test(url.pathname)) {
      assertToken(req);
      const id = url.pathname.split('/').filter(Boolean)[1];
      const submission = await getSubmission(id);
      if (!submission) return sendJson(res, 404, { error: 'not_found' });
      return sendJson(res, 200, submission);
    }

    if (req.method === 'POST' && url.pathname === '/submit') {
      return await handleSubmit(req, res);
    }

    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    return sendJson(res, error?.statusCode ?? 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

if (SUBMIT_ONCE_ID) {
  runSubmitOnce(SUBMIT_ONCE_ID).catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
} else {
  server.listen(PORT, HOST, () => {
    console.log(`[zeko-relayer] listening on http://${HOST}:${PORT}`);
    console.log(`[zeko-relayer] mode=${MODE} network=${ZEKO_NETWORK_ID} graphql=${ZEKO_GRAPHQL}`);
  });
}

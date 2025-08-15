import { Cell } from '@ton/core';

import type { ApiSubmitTransferWithDieselResult } from '../chains/ton/types';
import type {
  ApiActivity,
  ApiChain,
  ApiLocalTransactionParams,
  ApiSignedTransfer,
  ApiTransactionActivity,
  OnApiUpdate,
} from '../types';
import type { ApiSubmitTransferOptions, ApiSubmitTransferResult, CheckTransactionDraftOptions } from './types';

import { parseAccountId } from '../../util/account';
import { buildLocalTxId, mergeActivitiesToMaxTime } from '../../util/activities';
import { getChainConfig } from '../../util/chain';
import { logDebugError } from '../../util/logs';
import { getChainBySlug } from '../../util/tokens';
import chains from '../chains';
import { fetchStoredAccount, fetchStoredAddress, fetchStoredTonWallet } from '../common/accounts';
import { enrichActivities } from '../common/activities';
import { buildLocalTransaction } from '../common/helpers';
import { getPendingTransfer, waitAndCreatePendingTransfer } from '../common/pendingTransfers';
import { FAKE_TX_ID } from '../constants';
import { buildTokenSlug } from './tokens';

let onUpdate: OnApiUpdate;

const { ton, tron } = chains;

export function initTransactions(_onUpdate: OnApiUpdate) {
  onUpdate = _onUpdate;
}

export async function fetchPastActivities(
  accountId: string,
  limit: number,
  tokenSlug?: string,
  toTimestamp?: number,
): Promise<ApiActivity[] | undefined> {
  try {
    let activities = tokenSlug
      ? await fetchTokenActivitySlice(accountId, limit, tokenSlug, toTimestamp)
      : await fetchAllActivitySlice(accountId, limit, toTimestamp);

    activities = await enrichActivities(accountId, activities, tokenSlug);

    return activities;
  } catch (err) {
    logDebugError('fetchPastActivities', tokenSlug, err);
    return undefined;
  }
}

function fetchTokenActivitySlice(
  accountId: string,
  limit: number,
  slug: string,
  toTimestamp?: number,
) {
  return getChainBySlug(slug) === 'ton'
    ? ton.fetchActivitySlice(accountId, slug, toTimestamp, undefined, limit)
    : tron.getTokenTransactionSlice(accountId, slug, toTimestamp, undefined, limit);
}

async function fetchAllActivitySlice(
  accountId: string,
  limit: number,
  toTimestamp?: number,
): Promise<ApiActivity[]> {
  const account = await fetchStoredAccount(accountId);

  const [tonActivities, tronActivities] = await Promise.all([
    'ton' in account ? ton.fetchActivitySlice(accountId, undefined, toTimestamp, undefined, limit) : [],
    'tron' in account ? tron.getAllTransactionSlice(accountId, toTimestamp, limit) : [],
  ]);

  return mergeActivitiesToMaxTime(tonActivities, tronActivities);
}

export function checkTransactionDraft(chain: ApiChain, options: CheckTransactionDraftOptions) {
  return chains[chain].checkTransactionDraft(options);
}

export async function submitTransfer(
  chain: ApiChain,
  options: ApiSubmitTransferOptions,
  shouldCreateLocalActivity = true,
): Promise<(ApiSubmitTransferResult | ApiSubmitTransferWithDieselResult) & { txId?: string }> {
  const {
    accountId,
    password,
    toAddress,
    amount,
    tokenAddress,
    comment,
    fee,
    realFee,
    shouldEncrypt,
    isBase64Data,
    withDiesel,
    dieselAmount,
    isGaslessWithStars,
    noFeeCheck,
  } = options;
  const stateInit = typeof options.stateInit === 'string' ? Cell.fromBase64(options.stateInit) : options.stateInit;

  const fromAddress = await fetchStoredAddress(accountId, chain);

  let result: ApiSubmitTransferResult | ApiSubmitTransferWithDieselResult;

  if (withDiesel && chain === 'ton') {
    result = await ton.submitTransferWithDiesel({
      accountId,
      password,
      toAddress,
      amount,
      tokenAddress: tokenAddress!,
      data: comment,
      shouldEncrypt,
      dieselAmount: dieselAmount!,
      isGaslessWithStars,
    });
  } else {
    result = await chains[chain].submitTransfer({
      accountId,
      password,
      toAddress,
      amount,
      tokenAddress,
      data: comment,
      shouldEncrypt,
      isBase64Data,
      stateInit,
      fee,
      noFeeCheck,
    });
  }

  if ('error' in result) {
    return result;
  }

  if (!shouldCreateLocalActivity) {
    return result;
  }

  const slug = tokenAddress
    ? buildTokenSlug(chain, tokenAddress)
    : getChainConfig(chain).nativeToken.slug;

  let localActivity: ApiTransactionActivity;

  if ('msgHash' in result) {
    const { encryptedComment, msgHashNormalized } = result;
    [localActivity] = createLocalTransactions(accountId, chain, [{
      txId: msgHashNormalized,
      amount,
      fromAddress,
      toAddress,
      comment: shouldEncrypt ? undefined : comment,
      encryptedComment,
      fee: realFee ?? 0n,
      slug,
      externalMsgHashNorm: msgHashNormalized,
      extra: {
        ...('withW5Gasless' in result && { withW5Gasless: result.withW5Gasless }),
      },
    }]);
    if ('paymentLink' in result && result.paymentLink) {
      onUpdate({ type: 'openUrl', url: result.paymentLink, isExternal: true });
    }
  } else {
    const { txId } = result;
    [localActivity] = createLocalTransactions(accountId, chain, [{
      txId,
      amount,
      fromAddress,
      toAddress,
      comment,
      fee: realFee ?? 0n,
      slug,
    }]);
  }

  return {
    ...result,
    txId: localActivity.txId,
  };
}

export async function waitAndCreateTonPendingTransfer(accountId: string) {
  const { network } = parseAccountId(accountId);
  const { address } = await fetchStoredTonWallet(accountId);

  return (await waitAndCreatePendingTransfer(network, address)).id;
}

export async function sendSignedTransferMessage(
  accountId: string,
  message: ApiSignedTransfer,
  pendingTransferId: string,
) {
  const { msgHashNormalized } = await ton.sendSignedMessage(accountId, message, pendingTransferId);

  const [localActivity] = createLocalTransactions(accountId, 'ton', [{
    ...message.localActivity,
    txId: msgHashNormalized,
    externalMsgHashNorm: msgHashNormalized,
  }]);

  return localActivity.txId;
}

export function cancelPendingTransfer(id: string) {
  getPendingTransfer(id)?.resolve();
}

export function decryptComment(accountId: string, encryptedComment: string, fromAddress: string, password: string) {
  const chain = chains.ton;

  return chain.decryptComment(accountId, encryptedComment, fromAddress, password);
}

export function createLocalTransactions(
  accountId: string,
  chain: ApiChain,
  params: ApiLocalTransactionParams[],
) {
  const { network } = parseAccountId(accountId);

  const localTransactions = params.map((subParams, index) => {
    const { toAddress } = subParams;

    let normalizedAddress: string;
    if (subParams.normalizedAddress) {
      normalizedAddress = subParams.normalizedAddress;
    } else if (chain === 'ton') {
      normalizedAddress = ton.normalizeAddress(toAddress, network);
    } else {
      normalizedAddress = toAddress;
    }

    return buildLocalTransaction(subParams, normalizedAddress, index);
  });

  if (localTransactions.length) {
    onUpdate({
      type: 'newLocalActivities',
      activities: localTransactions,
      accountId,
    });
  }

  return localTransactions;
}

export function fetchEstimateDiesel(accountId: string, tokenAddress: string) {
  const chain = chains.ton;

  return chain.fetchEstimateDiesel(accountId, tokenAddress);
}

export async function fetchTonActivityDetails(accountId: string, activity: ApiActivity) {
  const result = await chains.ton.fetchActivityDetails(accountId, activity);
  return result?.activity ?? activity;
}

/**
 * Creates local activities from emulation results instead of basic transaction parameters.
 * This provides richer, parsed transaction details like "liquidity withdrawal" instead of "send TON".
 */
export function createLocalActivitiesFromEmulation(
  accountId: string,
  chain: ApiChain,
  msgHashNormalized: string,
  emulationActivities: ApiActivity[],
): ApiActivity[] {
  const localActivities: ApiActivity[] = [];
  let localActivityIndex = 0;

  emulationActivities.forEach((activity) => {
    if (activity.shouldHide || activity.id === FAKE_TX_ID) {
      return;
    }

    const localActivity = convertEmulationActivityToLocal(
      activity,
      msgHashNormalized,
      localActivityIndex,
      chain,
      accountId,
    );

    localActivities.push(localActivity);

    localActivityIndex++; // Increment only for visible activities
  });

  if (localActivities.length) {
    onUpdate({
      type: 'newLocalActivities',
      activities: localActivities,
      accountId,
    });
  }

  return localActivities;
}

/**
 * Converts an emulation activity to a local activity with proper ID and timestamp
 */
function convertEmulationActivityToLocal(
  activity: ApiActivity,
  msgHashNormalized: string,
  index: number,
  chain: ApiChain,
  accountId?: string,
): ApiActivity {
  const localTxId = buildLocalTxId(msgHashNormalized, index);
  const commonFields = {
    id: localTxId,
    timestamp: Date.now(),
    externalMsgHashNorm: msgHashNormalized,
    status: 'pending',
  } satisfies Partial<ApiActivity>;

  if (activity.kind === 'transaction') {
    let normalizedAddress = activity.normalizedAddress;
    if (!normalizedAddress && chain === 'ton' && accountId) {
      const { network } = parseAccountId(accountId);
      normalizedAddress = chains.ton.normalizeAddress(activity.toAddress, network);
    }

    return {
      ...activity,
      ...commonFields,
      txId: localTxId,
      normalizedAddress: normalizedAddress || activity.normalizedAddress,
    };
  } else {
    return {
      ...activity,
      ...commonFields,
    };
  }
}

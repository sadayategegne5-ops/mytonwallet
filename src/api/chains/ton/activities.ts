import type { ApiActivity, ApiNetwork, ApiSwapActivity, ApiTransactionActivity } from '../../types';
import type { AnyAction, CallContractAction, JettonTransferAction, SwapAction } from './toncenter/types';
import type { ParsedTrace, ParsedTracePart } from './types';

import { TONCOIN } from '../../../config';
import { parseAccountId } from '../../../util/account';
import { getActivityTokenSlugs, getIsActivityPending } from '../../../util/activities';
import { fromDecimal, toDecimal } from '../../../util/decimals';
import { intersection } from '../../../util/iteratees';
import { logDebug, logDebugError } from '../../../util/logs';
import { pause } from '../../../util/schedulers';
import withCacheAsync from '../../../util/withCacheAsync';
import { resolveTokenWalletAddress } from './util/tonCore';
import { fetchStoredTonWallet } from '../../common/accounts';
import { getTokenBySlug, tokensPreload } from '../../common/tokens';
import { SEC } from '../../constants';
import { OpCode, OUR_FEE_PAYLOAD_BOC } from './constants';
import { fetchActions, fetchTransactions, parseActionActivityId, parseLiquidityDeposit } from './toncenter';
import { fetchAndParseTrace } from './traces';

type ActivityDetailsResult = {
  activity: ApiActivity;
  sentForFee: bigint;
  excess: bigint;
};

const GET_TRANSACTIONS_LIMIT = 128;

const TRACE_ATTEMPT_COUNT = 5;
const TRACE_RETRY_DELAY = SEC;

export const checkHasTransaction = withCacheAsync(async (network: ApiNetwork, address: string) => {
  const transactions = await fetchTransactions({
    network,
    address,
    limit: 1,
  });
  return Boolean(transactions.length);
});

export async function fetchActivitySlice(
  accountId: string,
  tokenSlug?: string,
  toTimestamp?: number,
  fromTimestamp?: number,
  limit?: number,
  shouldIncludeFrom?: boolean,
): Promise<ApiActivity[]> {
  const { network } = parseAccountId(accountId);
  const { address } = await fetchStoredTonWallet(accountId);

  if (!tokenSlug) {
    return fetchActions({
      network,
      filter: { address },
      walletAddress: address,
      limit: limit ?? GET_TRANSACTIONS_LIMIT,
      fromTimestamp,
      toTimestamp,
      shouldIncludeFrom,
    });
  } else {
    let tokenWalletAddress = address;

    if (tokenSlug !== TONCOIN.slug) {
      await tokensPreload.promise;
      tokenWalletAddress = await resolveTokenWalletAddress(network, address, getTokenBySlug(tokenSlug).tokenAddress!);
    }

    const activities = await fetchActions({
      network,
      filter: { address: tokenWalletAddress },
      walletAddress: address,
      limit: limit ?? GET_TRANSACTIONS_LIMIT,
      fromTimestamp,
      toTimestamp,
      shouldIncludeFrom,
    });

    return activities.filter((activity) => getActivityTokenSlugs(activity).includes(tokenSlug));
  }
}

export async function fetchNewestActionId(network: ApiNetwork, address: string) {
  const transactions = await fetchTransactions({
    network,
    address,
    limit: 1,
  });

  if (!transactions.length) {
    return undefined;
  }

  return transactions[0].txId;
}

export async function fetchActivityDetails(
  accountId: string,
  activity: ApiActivity,
): Promise<ActivityDetailsResult | undefined> {
  const { network } = parseAccountId(accountId);
  const { address: walletAddress } = await fetchStoredTonWallet(accountId);
  let result: ActivityDetailsResult | undefined;

  // The trace can be unavailable immediately after the action is received, so a couple of delayed retries are made
  for (let attempt = 0; attempt < TRACE_ATTEMPT_COUNT && !result; attempt++) {
    if (attempt > 0) {
      await pause(TRACE_RETRY_DELAY);
    }

    const parsedTrace = await fetchAndParseTrace(
      network,
      walletAddress,
      activity.externalMsgHashNorm!,
      getIsActivityPending(activity),
    );
    if (!parsedTrace) {
      continue;
    }

    result = calculateActivityDetails(activity, parsedTrace);
  }

  if (!result) {
    logDebugError('Trace unavailable for activity', activity.id);
  }

  return result;
}

export function calculateActivityDetails(
  activity: ApiActivity,
  parsedTrace: ParsedTrace,
): ActivityDetailsResult | undefined {
  const { actionId } = parseActionActivityId(activity.id);
  const { actions, byTransactionIndex } = parsedTrace;

  const action = actions.find(({ action_id }) => action_id === actionId);
  if (!action) {
    // This can happen when the trace is requested too early, for example right after receiving the action from a socket
    return undefined;
  }

  const actionHashes = new Set(action.transactions);

  const tracePart = byTransactionIndex.find((item) => {
    return intersection(item.hashes, actionHashes).size;
  })!;

  let result: ActivityDetailsResult;

  if (activity.kind === 'swap') {
    result = setSwapDetails({
      parsedTrace, activity, action: action as SwapAction, tracePart,
    });
  } else {
    result = setTransactionDetails({
      parsedTrace, activity, action, tracePart,
    });
  }

  logDebug('Calculation of fee for action', {
    actionId: action.action_id,
    externalMsgHashNorm: activity.externalMsgHashNorm,
    activityStatus: activity.status,
    networkFee: toDecimal(tracePart.networkFee),
    realFee: toDecimal(getActivityRealFee(result.activity)),
    sentForFee: toDecimal(result.sentForFee),
    excess: toDecimal(result.excess),
    details: action.details,
  });

  return result;
}

function setSwapDetails(options: {
  parsedTrace: ParsedTrace;
  action: SwapAction;
  activity: ApiSwapActivity;
  tracePart: ParsedTracePart;
}): ActivityDetailsResult {
  const { action, tracePart, parsedTrace: { actions } } = options;
  let { activity } = options;

  const { details } = action;

  let sentForFee = tracePart.sent;
  let excess = tracePart.received;

  // When the transaction is failed, its `sent` and `received` are always 0 (as defined in `parseFailedTransactions`)
  if (tracePart.isSuccess) {
    if (!details.asset_in) {
      // TON -> token
      sentForFee -= BigInt(details.dex_incoming_transfer.amount);
    } else if (!details.asset_out) {
      // Token -> TON
      excess -= BigInt(details.dex_outgoing_transfer.amount);
    }
  }

  const realFee = tracePart.networkFee + sentForFee - excess;

  activity = {
    ...activity,
    networkFee: toDecimal(realFee),
  };

  let ourFee: bigint | undefined;
  if (!details.asset_in) {
    const ourFeeAction = actions.find((_action) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
      return _action.type === 'call_contract' && Number(_action.details.opcode) === OpCode.OurFee;
    }) as CallContractAction | undefined;
    if (ourFeeAction?.success) {
      ourFee = BigInt(ourFeeAction.details.value);
    }
  } else {
    const ourFeeAction = actions.find((_action) => {
      return _action.type === 'jetton_transfer' && _action.details.forward_payload === OUR_FEE_PAYLOAD_BOC;
    }) as JettonTransferAction | undefined;
    if (ourFeeAction?.success) {
      ourFee = BigInt(ourFeeAction.details.amount);
    }
  }

  if (ourFee) {
    const tokenIn = getTokenBySlug(activity.from);
    activity.ourFee = toDecimal(ourFee, tokenIn?.decimals);
  }

  delete activity.shouldLoadDetails;

  return { activity, sentForFee, excess };
}

function setTransactionDetails(options: {
  parsedTrace: ParsedTrace;
  action: AnyAction;
  activity: ApiTransactionActivity;
  tracePart: ParsedTracePart;
}): ActivityDetailsResult {
  const {
    action,
    tracePart,
    parsedTrace: {
      addressBook,
      totalSent,
      totalReceived,
      totalNetworkFee,
    },
  } = options;

  let { activity } = options;
  let { networkFee, sent: sentForFee, received: excess } = tracePart;

  switch (action.type) {
    case 'ton_transfer':
    case 'call_contract': {
      sentForFee -= BigInt(action.details.value);
      break;
    }
    case 'nft_transfer': {
      if (action.details.is_purchase) {
        sentForFee -= BigInt(action.details.price!);
      }
      break;
    }
    case 'stake_deposit': {
      sentForFee -= BigInt(action.details.amount);
      break;
    }
    case 'stake_withdrawal': {
      excess -= BigInt(action.details.amount);
      break;
    }
    case 'dex_deposit_liquidity': {
      // Liquidity deposit can be either a dual transaction or two separate single transactions.
      // We display the deposit as separate actions, so we divide by the number of actions.
      const activitiesPerAction = BigInt(parseLiquidityDeposit(action, {
        addressBook,
        // The below fields don't matter here, they are only to satisfy the type requirements:
        network: 'mainnet',
        walletAddress: '',
        metadata: {},
        nftSuperCollectionsByCollectionAddress: {},
      }).length);

      networkFee = totalNetworkFee / activitiesPerAction;
      sentForFee = totalSent / activitiesPerAction;
      excess = totalReceived / activitiesPerAction;

      if (!action.details.asset_1) {
        sentForFee -= BigInt(action.details.amount_1 ?? 0n) / activitiesPerAction;
      } else if (!action.details.asset_2) {
        sentForFee -= BigInt(action.details.amount_2 ?? 0n) / activitiesPerAction;
      }
      break;
    }
    case 'dex_withdraw_liquidity': {
      if (!action.details.asset_1) {
        excess -= BigInt(action.details.amount_1);
      } else if (!action.details.asset_2) {
        excess -= BigInt(action.details.amount_2);
      }

      sentForFee /= 2n;
      excess /= 2n;
      break;
    }
  }

  // When the transaction is failed, its `sent` and `received` are always 0 (as defined in `parseFailedTransactions`)
  if (!tracePart.isSuccess) {
    sentForFee = 0n;
    excess = 0n;
  }

  const realFee = networkFee + sentForFee - excess;

  activity = {
    ...activity,
    fee: realFee,
  };

  delete activity.shouldLoadDetails;

  return { activity, sentForFee, excess };
}

export function getActivityRealFee(activity: ApiActivity) {
  return activity.kind === 'swap' ? fromDecimal(activity.networkFee, TONCOIN.decimals) : activity.fee;
}

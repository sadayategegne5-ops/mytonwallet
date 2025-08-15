import type { ApiActivity, ApiTransaction, ApiTransactionActivity, ApiTransactionType } from '../../api/types';
import type { LangFn } from '../langProvider';

import { ALL_STAKING_POOLS, BURN_ADDRESS } from '../../config';
import { compareActivities } from '../compareActivities';
import { extractKey, groupBy, unique } from '../iteratees';
import { getIsTransactionWithPoisoning } from '../poisoningHash';

type UnusualTxType = 'backend-swap' | 'local' | 'additional';

type TranslationTenses = [past: string, present: string, future: string];

const TRANSACTION_TYPE_TITLES: Partial<Record<ApiTransactionType & keyof any, TranslationTenses>> = {
  stake: ['Staked', 'Staking', '$stake_action'],
  unstake: ['Unstaked', 'Unstaking', '$unstake_action'],
  unstakeRequest: ['Unstake Requested', 'Requesting Unstake', '$request_unstake_action'],
  callContract: ['Contract Called', 'Calling Contract', '$call_contract_action'],
  excess: ['Excess', 'Excess', 'Excess'],
  contractDeploy: ['Contract Deployed', 'Deploying Contract', '$deploy_contract_action'],
  bounced: ['Bounced', 'Bouncing', '$bounce_action'],
  mint: ['Minted', 'Minting', '$mint_action'],
  burn: ['Burned', 'Burning', '$burn_action'],
  auctionBid: ['NFT Auction Bid', 'Bidding at NFT Auction', 'NFT Auction Bid'],
  dnsChangeAddress: ['Address Updated', 'Updating Address', '$update_address_action'],
  dnsChangeSite: ['Site Updated', 'Updating Site', '$update_site_action'],
  dnsChangeSubdomains: ['Subdomains Updated', 'Updating Subdomains', '$update_subdomains_action'],
  dnsChangeStorage: ['Storage Updated', 'Updating Storage', '$update_storage_action'],
  dnsDelete: ['Domain Record Deleted', 'Deleting Domain Record', '$delete_domain_record_action'],
  dnsRenew: ['Domain Renewed', 'Renewing Domain', '$renew_domain_action'],
  liquidityDeposit: ['Liquidity Provided', 'Providing Liquidity', '$provide_liquidity_action'],
  liquidityWithdraw: ['Liquidity Withdrawn', 'Withdrawing Liquidity', '$withdraw_liquidity_action'],
};

export const STAKING_TRANSACTION_TYPES = new Set<ApiTransactionType | undefined>([
  'stake', 'unstake', 'unstakeRequest',
]);

export const DNS_TRANSACTION_TYPES = new Set<ApiTransactionType | undefined>([
  'dnsChangeAddress', 'dnsChangeSite', 'dnsChangeStorage', 'dnsChangeSubdomains', 'dnsDelete', 'dnsRenew',
]);

export function parseTxId(txId: string): {
  hash: string;
  subId?: string;
  type?: UnusualTxType;
} {
  const [hash, subId, type] = txId.split(':') as [string, string | undefined, UnusualTxType | undefined];
  return { hash, type, subId };
}

export function getIsTxIdLocal(txId: string) {
  return txId.endsWith(':local');
}

export function getIsBackendSwapId(id: string) {
  return id.endsWith(':backend-swap');
}

export function buildBackendSwapId(backendId: string) {
  return buildTxId(backendId, undefined, 'backend-swap');
}

export function buildLocalTxId(hash: string, subId?: number) {
  return buildTxId(hash, subId, 'local');
}

export function buildTxId(hash: string, subId?: number | string, type?: UnusualTxType) {
  if (!type && subId === undefined) return hash;
  if (type === undefined) return `${hash}:${subId}`;
  return `${hash}:${subId ?? ''}:${type}`;
}

export function getActivityTokenSlugs(activity: ApiActivity): string[] {
  switch (activity.kind) {
    case 'transaction': {
      if (activity.nft) return []; // We don't want NFT activities to get into any token activity list
      return [activity.slug];
    }
    case 'swap': {
      return [activity.from, activity.to];
    }
  }
}

export function getIsActivitySuitableForFetchingTimestamp(activity: ApiActivity | undefined) {
  return !!activity
    && !getIsTxIdLocal(activity.id)
    && !getIsBackendSwapId(activity.id)
    && !getIsActivityPending(activity);
}

export function getTransactionTitle(
  { type, isIncoming, nft }: ApiTransaction,
  tense: 'past' | 'present' | 'future',
  translate: LangFn,
) {
  const tenseIndex = tense === 'past' ? 0 : tense === 'present' ? 1 : 2;
  let titles: TranslationTenses;

  if (type === 'nftTrade') {
    titles = isIncoming
      ? ['NFT Sold', 'Selling NFT', '$sell_nft_action']
      : ['NFT Bought', 'Buying NFT', '$buy_nft_action'];
  } else if (type && TRANSACTION_TYPE_TITLES[type]) {
    titles = TRANSACTION_TYPE_TITLES[type];
  } else {
    titles = isIncoming
      ? ['Received', 'Receiving', '$receive_action']
      : ['Sent', 'Sending', '$send_action'];
  }

  let title = translate(titles[tenseIndex]);

  if (nft && (!type || type === 'mint' || type === 'burn')) {
    title += ' NFT';
  }

  return title;
}

export function isScamTransaction(transaction: ApiTransaction) {
  return Boolean(transaction.metadata?.isScam)
    || (transaction.isIncoming && getIsTransactionWithPoisoning(transaction));
}

export function shouldShowTransactionComment(transaction: ApiTransaction) {
  return Boolean(transaction.comment || transaction.encryptedComment)
    && !STAKING_TRANSACTION_TYPES.has(transaction.type)
    && !isScamTransaction(transaction);
}

export function getTransactionAmountDisplayMode({ type, amount, nft }: ApiTransaction) {
  const isPlainTransfer = type === undefined && !nft;
  if (!amount && !isPlainTransfer) {
    return 'hide';
  }
  return type === 'stake' || type === 'unstake'
    ? 'noSign'
    : 'normal';
}

/** Returns the UI sections where the address should be shown */
export function shouldShowTransactionAddress(transaction: ApiTransactionActivity): ('list' | 'modal')[] {
  const { type, isIncoming, nft, toAddress, fromAddress, extra } = transaction;

  if (type === 'nftTrade') {
    return extra?.marketplace ? ['list'] : [];
  }

  const shouldHide = isOurStakingTransaction(transaction)
    || type === 'burn'
    || (!isIncoming && nft && toAddress === nft.address)
    || (isIncoming && type === 'excess' && fromAddress === BURN_ADDRESS);

  return shouldHide ? [] : ['list', 'modal'];
}

/** "Our" is staking that can be controlled with MyTonWallet app */
export function isOurStakingTransaction({ type, isIncoming, toAddress, fromAddress }: ApiTransaction) {
  return STAKING_TRANSACTION_TYPES.has(type) && ALL_STAKING_POOLS.includes(isIncoming ? fromAddress : toAddress);
}

export function shouldShowTransactionAnnualYield(transaction: ApiTransaction) {
  return transaction.type === 'stake' && isOurStakingTransaction(transaction);
}

export function mergeActivitiesToMaxTime(array1: ApiActivity[], array2: ApiActivity[]) {
  if (!array1.length && !array2.length) {
    return [];
  } else if (!array1.length && array2.length) {
    return array2;
  } else if (!array2.length && array1.length) {
    return array1;
  }

  const fromTimestamp = Math.max(
    array1[array1.length - 1].timestamp,
    array2[array2.length - 1].timestamp,
  );

  return [...array1, ...array2]
    .filter(({ timestamp }) => timestamp >= fromTimestamp)
    .sort(compareActivities);
}

export function mergeActivityIdsToMaxTime(array1: string[], array2: string[], byId: Record<string, ApiActivity>) {
  if (!array1.length && !array2.length) {
    return [];
  } else if (!array1.length && array2.length) {
    return array2;
  } else if (!array2.length && array1.length) {
    return array1;
  }

  const fromTimestamp = Math.max(
    byId[array1[array1.length - 1]].timestamp,
    byId[array2[array2.length - 1]].timestamp,
  );

  return unique([...array1, ...array2])
    .filter((id) => byId[id].timestamp >= fromTimestamp)
    .sort((a, b) => compareActivities(byId[a], byId[b]));
}

export function getIsActivityWithHash(activity: ApiTransactionActivity) {
  return !getIsTxIdLocal(activity.id) || !activity.extra?.withW5Gasless;
}

export function getIsActivityPending(activity: ApiActivity) {
  // "Pending" is a blockchain term. The activities originated by our backend are never considered pending in this sense.
  return activity.status === 'pending' && !getIsBackendSwapId(activity.id);
}

/**
 * Sometimes activity ids change. This function finds the new id withing `nextActivities` for each activity in
 * `prevActivities`. Currently only local and pending activity ids change, so it's enough to provide only such
 * activities in `prevActivities`.
 *
 * The ids should be unique within each input array. The returned map has previous activity ids as keys and next
 * activity ids as values. If the map has no value for a previous id, it means that there is no matching next activity.
 * The values may be not unique.
 */
export function getActivityIdReplacements(prevActivities: ApiActivity[], nextActivities: ApiActivity[]) {
  // Each previous activity must fall into either of the groups, otherwise the resulting map will falsely miss previous ids
  const prevLocalActivities: ApiActivity[] = [];
  const prevChainActivities: ApiActivity[] = [];

  for (const activity of prevActivities) {
    const group = getIsTxIdLocal(activity.id) ? prevLocalActivities : prevChainActivities;
    group.push(activity);
  }

  return {
    ...getLocalActivityIdReplacements(prevLocalActivities, nextActivities),
    ...getChainActivityIdReplacements(prevChainActivities, nextActivities),
  };
}

/** Replaces local activity ids. See `getActivityIdReplacements` for more details. */
function getLocalActivityIdReplacements(prevLocalActivities: ApiActivity[], nextActivities: ApiActivity[]) {
  const idReplacements: Record<string, string> = {};

  if (!prevLocalActivities.length) {
    return idReplacements;
  }

  const nextActivityIds = new Set(extractKey(nextActivities, 'id'));
  const nextChainActivities = nextActivities.filter((activity) => !getIsTxIdLocal(activity.id));

  for (const localActivity of prevLocalActivities) {
    const { id: prevId } = localActivity;

    // Try a direct id match
    if (nextActivityIds.has(prevId)) {
      idReplacements[prevId] = prevId;
      continue;
    }

    // Otherwise, try to find a match by a heuristic
    const chainActivity = nextChainActivities.find((chainActivity) => {
      return doesLocalActivityMatch(localActivity, chainActivity);
    });
    if (chainActivity) {
      idReplacements[prevId] = chainActivity.id;
    }

    // Otherwise, there is no match
  }

  return idReplacements;
}

/** Replaces chain (i.e. not local) activity ids. See `getActivityIdReplacements` for more details. */
function getChainActivityIdReplacements(prevActivities: ApiActivity[], nextActivities: ApiActivity[]) {
  const idReplacements: Record<string, string> = {};

  if (!prevActivities.length) {
    return idReplacements;
  }

  const nextActivityIds = new Set(extractKey(nextActivities, 'id'));
  const nextActivitiesByMessageHash = groupBy(nextActivities, 'externalMsgHashNorm');

  for (const { id: prevId, externalMsgHashNorm } of prevActivities) {
    // Try a direct id match
    if (nextActivityIds.has(prevId)) {
      idReplacements[prevId] = prevId;
      continue;
    }

    // Otherwise, match by the message hash
    if (externalMsgHashNorm) {
      const nextSubActivities = nextActivitiesByMessageHash[externalMsgHashNorm];
      if (nextSubActivities?.length) {
        idReplacements[prevId] = nextSubActivities[0].id;

        // Leaving 1 activity in each group to ensure there is a match for the further prev activities with the same hash
        if (nextSubActivities.length > 1) {
          nextSubActivities.shift();
        }
      }
    }

    // Otherwise, there is no match
  }

  return idReplacements;
}

/** Decides whether the local activity matches the activity from the blockchain */
export function doesLocalActivityMatch(localActivity: ApiActivity, chainActivity: ApiActivity) {
  if (localActivity.extra?.withW5Gasless) {
    if (localActivity.kind === 'transaction' && chainActivity.kind === 'transaction') {
      return !chainActivity.isIncoming && localActivity.normalizedAddress === chainActivity.normalizedAddress
        && localActivity.amount === chainActivity.amount
        && localActivity.slug === chainActivity.slug;
    } else if (localActivity.kind === 'swap' && chainActivity.kind === 'swap') {
      return localActivity.from === chainActivity.from
        && localActivity.to === chainActivity.to
        && localActivity.fromAmount === chainActivity.fromAmount;
    }
  }

  if (localActivity.externalMsgHashNorm) {
    return localActivity.externalMsgHashNorm === chainActivity.externalMsgHashNorm && !chainActivity.shouldHide;
  }

  return parseTxId(localActivity.id).hash === parseTxId(chainActivity.id).hash;
}

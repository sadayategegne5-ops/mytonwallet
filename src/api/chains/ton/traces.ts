import type { ApiNetwork } from '../../types';
import type { AddressBook, AnyAction, TraceDetail, Transaction } from './toncenter/types';
import type { ParsedTrace, ParsedTracePart } from './types';

import { bigintAbs } from '../../../util/bigint';
import { groupBy } from '../../../util/iteratees';
import { fetchTrace } from './toncenter/traces';
import { parseRawTransaction } from './toncenter';

/**
 * Returns `undefined` when there is no trace for the given hash. It may be unavailable YET, for example if the trace is
 * requested immediately after receiving an action from the socket.
 */
export async function fetchAndParseTrace(
  network: ApiNetwork,
  walletAddress: string,
  msgHashNormalized: string,
  isActionPending?: boolean,
): Promise<ParsedTrace | undefined> {
  const { trace, addressBook } = await fetchTrace({ network, msgHashNormalized, isActionPending });

  return trace && parseTrace({
    network,
    walletAddress,
    actions: trace.actions,
    traceDetail: trace.trace,
    addressBook,
    transactions: trace.transactions,
  });
}

export function parseTrace(options: {
  network: ApiNetwork;
  walletAddress: string;
  actions: AnyAction[];
  traceDetail: TraceDetail;
  addressBook: AddressBook;
  transactions: Record<string, Transaction>;
}): ParsedTrace {
  const {
    network,
    walletAddress,
    actions,
    traceDetail,
    addressBook,
    transactions,
  } = options;

  const byTransactionIndex = isFailedTransactionTrace(traceDetail)
    ? parseFailedTransactions(traceDetail, transactions)
    : parseCompletedTransactions(network, walletAddress, traceDetail, addressBook, transactions);

  return {
    actions,
    traceDetail,
    addressBook,
    byTransactionIndex,
    totalSent: byTransactionIndex.reduce((total, { sent }) => total + sent, 0n),
    totalReceived: byTransactionIndex.reduce((total, { received }) => total + received, 0n),
    totalNetworkFee: byTransactionIndex.reduce((total, { networkFee }) => total + networkFee, 0n),
  };
}

function isFailedTransactionTrace(traceDetails: TraceDetail) {
  return traceDetails.children.length === 0;
}

function parseCompletedTransactions(
  network: ApiNetwork,
  walletAddress: string,
  traceDetail: TraceDetail,
  addressBook: AddressBook,
  rawTransactions: Record<string, Transaction>,
): ParsedTracePart[] {
  const transactions = Object.values(rawTransactions)
    .map((rawTx) => parseRawTransaction(network, rawTx, addressBook))
    .flat();

  const byHash = groupBy(transactions, 'hash');
  const byTransactionIndex: ParsedTracePart[] = [];

  let isWalletTransactionFound = false;

  function processTrace(_traceDetail: TraceDetail, _index?: number) {
    const hash = _traceDetail.tx_hash;
    const txs = byHash[hash] || [];

    if (!isWalletTransactionFound) {
      isWalletTransactionFound = txs.some(({
        fromAddress,
        isIncoming,
      }) => {
        return fromAddress === walletAddress && !isIncoming;
      });

      // In gasless operations, we need to skip transactions before our wallet
      if (!isWalletTransactionFound) {
        _traceDetail.children.forEach(processTrace);
        return;
      }
    }

    for (const [i, tx] of txs.entries()) {
      const {
        fromAddress,
        toAddress,
        amount,
        isIncoming,
        fee,
        msgHash,
        type,
      } = tx;

      const index = _index ?? i;

      if (!(index in byTransactionIndex)) {
        // First transaction from wallet includes all sub-transactions, and its hash is not unique
        byTransactionIndex.push({
          hashes: new Set(),
          sent: 0n,
          received: 0n,
          networkFee: 0n,
          isSuccess: true,
        });
      } else {
        byTransactionIndex[index].hashes.add(hash);
      }

      if (fromAddress === walletAddress && !isIncoming) {
        byTransactionIndex[index].sent += bigintAbs(amount);
        byTransactionIndex[index].networkFee = fee;
      } else if (toAddress === walletAddress && isIncoming && type !== 'bounced') {
        byTransactionIndex[index].received += bigintAbs(amount);
      }

      const child = _traceDetail.children.find(({ in_msg_hash }) => in_msg_hash === msgHash);
      if (child) {
        processTrace(child, index);
      }
    }
  }

  processTrace(traceDetail);

  return byTransactionIndex;
}

function parseFailedTransactions(
  traceDetails: TraceDetail,
  rawTransactions: Record<string, Transaction>,
): ParsedTracePart[] {
  const txHash = traceDetails.tx_hash;
  const rawTx = rawTransactions[txHash];

  // The root transaction can represent multiple actual failed transactions. Instead, the returned array contains only
  // one item. The actual number of failed transactions can be obtained by parsing `rawTx.in_msg.message_content.body`
  // probably, but this is not needed, so the code is simplified.
  return [{
    hashes: new Set([txHash]),
    sent: 0n,
    received: 0n,
    networkFee: BigInt(rawTx.total_fees),
    isSuccess: false,
  }];
}

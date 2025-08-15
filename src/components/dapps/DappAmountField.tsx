import type { TeactNode } from '../../lib/teact/teact';
import React, { memo } from '../../lib/teact/teact';
import { withGlobal } from '../../global';

import type { ApiBaseCurrency, ApiTokenWithPrice } from '../../api/types';

import { UNKNOWN_TOKEN } from '../../config';
import buildClassName from '../../util/buildClassName';
import { toBig, toDecimal } from '../../util/decimals';
import { formatCurrency, getShortCurrencySymbol } from '../../util/formatNumber';
import isEmptyObject from '../../util/isEmptyObject';

import styles from './Dapp.module.scss';

type OwnProps = {
  label: TeactNode;
  amountsBySlug: Record<string, bigint>;
  nftCount?: number;
};

type StateProps = {
  tokensBySlug: Record<string, ApiTokenWithPrice>;
  baseCurrency?: ApiBaseCurrency;
};

function DappAmountField({
  label,
  amountsBySlug,
  nftCount,
  tokensBySlug,
  baseCurrency,
}: OwnProps & StateProps) {
  const amountTerms: TeactNode[] = [];

  if (nftCount) {
    amountTerms.push(
      <span className={styles.payloadFieldTerm}>
        {`${nftCount} NFT${nftCount > 1 ? 's' : ''}`}
      </span>,
    );
  }

  for (const [tokenSlug, amount] of Object.entries(amountsBySlug)) {
    if (amountTerms.length) {
      amountTerms.push(' + ');
    }

    const token = tokensBySlug[tokenSlug] ?? UNKNOWN_TOKEN;

    amountTerms.push(
      <span className={styles.payloadFieldTerm}>
        {formatCurrency(toDecimal(amount, token.decimals), token.symbol)}
      </span>,
    );
  }

  if (!isEmptyObject(amountsBySlug)) {
    const totalCost = getTotalCost(amountsBySlug, tokensBySlug);
    amountTerms.push(` (${formatCurrency(totalCost, getShortCurrencySymbol(baseCurrency))})`);
  }

  return (
    <>
      <span className={styles.label}>
        {label}
      </span>
      <div className={buildClassName(styles.payloadField, styles.payloadField_expanded)}>
        {amountTerms}
      </div>
    </>
  );
}

export default memo(withGlobal<OwnProps>((global): StateProps => {
  return {
    tokensBySlug: global.tokenInfo.bySlug,
    baseCurrency: global.settings.baseCurrency,
  };
})(DappAmountField));

function getTotalCost(amountsBySlug: Record<string, bigint>, tokensBySlug: Record<string, ApiTokenWithPrice>) {
  return Object.entries(amountsBySlug).reduce((sum, [tokenSlug, amount]) => {
    const token = tokensBySlug[tokenSlug];
    if (!token) {
      return sum;
    }
    return sum + toBig(amount, token.decimals).toNumber() * token.price;
  }, 0);
}

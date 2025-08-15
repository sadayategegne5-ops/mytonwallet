import type { ApiNetwork } from '../../../types';

import { TRX } from '../../../../config';
import { getChainConfig } from '../../../../util/chain';
import { buildTokenSlug } from '../../../common/tokens';

export function getTokenSlugs(network: ApiNetwork) {
  const { usdtAddress } = getChainConfig('tron')[network];
  const usdtSlug = buildTokenSlug('tron', usdtAddress);
  return [TRX.slug, usdtSlug];
}

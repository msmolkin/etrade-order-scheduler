export function buildEtradeAuthorizationUrl(consumerKey: string, requestToken: string): string {
  const params = new URLSearchParams({
    key: consumerKey,
    token: requestToken,
  });

  return `https://us.etrade.com/e/t/etws/authorize?${params.toString()}`;
}

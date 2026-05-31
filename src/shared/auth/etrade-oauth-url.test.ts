import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEtradeAuthorizationUrl } from './etrade-oauth-url.js';

test('buildEtradeAuthorizationUrl URL-encodes unsafe query characters', () => {
  const url = buildEtradeAuthorizationUrl('consumer+key', 'abc+/=XYZ');

  assert.equal(
    url,
    'https://us.etrade.com/e/t/etws/authorize?key=consumer%2Bkey&token=abc%2B%2F%3DXYZ',
  );
});

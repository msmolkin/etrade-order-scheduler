import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isTwoFactorDeliveryTriggerText,
  isTwoFactorFollowUpActionText,
  normalizeTwoFactorActionText,
} from './auth-two-factor-actions.js';

test('normalizeTwoFactorActionText collapses whitespace and casing', () => {
  assert.equal(normalizeTwoFactorActionText('  Send   Code  '), 'send code');
});

test('delivery trigger matches a direct send button', () => {
  assert.equal(isTwoFactorDeliveryTriggerText('Send code'), true);
  assert.equal(isTwoFactorDeliveryTriggerText('Text me'), true);
});

test('delivery trigger does not treat resend as a fresh send', () => {
  assert.equal(isTwoFactorDeliveryTriggerText('Resend code'), false);
});

test('follow-up actions allow continue/submit but block resend', () => {
  assert.equal(isTwoFactorFollowUpActionText('Continue'), true);
  assert.equal(isTwoFactorFollowUpActionText('Submit'), true);
  assert.equal(isTwoFactorFollowUpActionText('Resend code', { allowDeliveryTrigger: true }), false);
});

test('follow-up actions only allow send code when explicitly requested', () => {
  assert.equal(isTwoFactorFollowUpActionText('Send code'), false);
  assert.equal(isTwoFactorFollowUpActionText('Send code', { allowDeliveryTrigger: true }), true);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractAutoAuthWebhookPayload } from './auto-auth-webhook.js';

test('extractAutoAuthWebhookPayload reads explicit code and sessionId fields', () => {
  const result = extractAutoAuthWebhookPayload({
    code: '123456',
    session_id: 'abc-session',
  });

  assert.equal(result.code, '123456');
  assert.equal(result.sessionId, 'abc-session');
  assert.equal(result.error, null);
});

test('extractAutoAuthWebhookPayload parses Twilio-style Body text', () => {
  const result = extractAutoAuthWebhookPayload({
    Body: 'E*TRADE security code: 654321. Enter this code to continue.',
    From: '+15555555555',
  });

  assert.equal(result.code, '654321');
  assert.equal(result.error, null);
  assert.match(result.codeSource || '', /Body/);
});

test('extractAutoAuthWebhookPayload prefers explicit code fields over message text', () => {
  const result = extractAutoAuthWebhookPayload({
    message: 'Reference 111111, your E*TRADE login code is 222222.',
    verificationCode: '333333',
  });

  assert.equal(result.code, '333333');
  assert.equal(result.error, null);
  assert.match(result.codeSource || '', /verificationCode/);
});

test('extractAutoAuthWebhookPayload rejects ambiguous payloads without explicit code fields', () => {
  const result = extractAutoAuthWebhookPayload({
    Body: 'Codes seen: 111111 and 222222',
  });

  assert.equal(result.code, null);
  assert.match(result.error || '', /Ambiguous webhook payload/);
});

test('extractAutoAuthWebhookPayload parses the exact E*TRADE SMS format from Google Voice forwarding', () => {
  const result = extractAutoAuthWebhookPayload({
    Body: '<sms>Your E*TRADE verification code is 779678. No one from E*TRADE will contact you for this code unless initiated by you. Didn\'t request a code? Call 1-800-387-2331</sms>',
  });

  assert.equal(result.code, '779678');
  assert.equal(result.error, null);
});

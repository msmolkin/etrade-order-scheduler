export function normalizeTwoFactorActionText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isTwoFactorDeliveryTriggerText(text: string): boolean {
  const normalized = normalizeTwoFactorActionText(text);
  if (!normalized || normalized.includes('resend')) {
    return false;
  }

  return [
    'send code',
    'text me',
    'send text',
    'send sms',
    'get code',
    'call me',
  ].some((needle) => normalized.includes(needle));
}

export function isTwoFactorFollowUpActionText(
  text: string,
  options: { allowDeliveryTrigger?: boolean } = {},
): boolean {
  const normalized = normalizeTwoFactorActionText(text);
  if (!normalized || normalized.includes('resend')) {
    return false;
  }

  if (isTwoFactorDeliveryTriggerText(normalized)) {
    return options.allowDeliveryTrigger === true;
  }

  return [
    'continue',
    'submit',
    'next',
    'confirm',
  ].some((needle) => normalized.includes(needle));
}

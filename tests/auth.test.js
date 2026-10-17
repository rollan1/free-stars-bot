import test from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, TEST_BOT_TOKEN } from './helpers.js';

const server = await bootServer('auth');
const { auth, config } = server;

const user = { id: 42, username: 'fortmain', first_name: 'Fort', last_name: 'Main' };

test('валидный initData принимается и возвращает пользователя', () => {
  const initData = auth.buildInitDataForTest(user);
  const result = auth.validateInitData(initData);
  assert.equal(result.user.id, 42);
  assert.equal(result.user.username, 'fortmain');
  assert.equal(result.user.firstName, 'Fort');
  assert.ok(result.authDate > 0);
});

test('изменённое поле user ломает подпись', () => {
  const initData = auth.buildInitDataForTest(user);
  const tampered = initData.replace('fortmain', 'hacker');
  assert.notEqual(tampered, initData, 'подмена действительно изменила строку');
  assert.throws(() => auth.validateInitData(tampered), /signature mismatch/);
});

test('изменённый auth_date ломает подпись', () => {
  const initData = auth.buildInitDataForTest(user);
  const tampered = initData.replace(/auth_date=\d+/, `auth_date=${Math.floor(Date.now() / 1000) + 10}`);
  assert.throws(() => auth.validateInitData(tampered), /signature mismatch/);
});

test('чужой токен бота не проходит проверку', () => {
  const initData = auth.buildInitDataForTest(user, '999:OTHER-token-value-1234567890abcdef');
  assert.throws(() => auth.validateInitData(initData), /signature mismatch/);
});

test('устаревший initData отклоняется', () => {
  const old = auth.buildInitDataForTest(user, TEST_BOT_TOKEN, Math.floor(Date.now() / 1000) - 200000);
  assert.throws(() => auth.validateInitData(old), /too old/);
});

test('пустой и мусорный initData отклоняются', () => {
  assert.throws(() => auth.validateInitData(''), /missing/);
  assert.throws(() => auth.validateInitData('a=b&hash=zzz'), /signature mismatch/);
  assert.throws(() => auth.validateInitData('hash=abc'), /signature mismatch/);
});

test('initData без пользователя отклоняется', () => {
  const initData = auth.buildInitDataForTest(user).replace(/user=[^&]+/, '');
  assert.throws(() => auth.validateInitData(initData), /signature mismatch/);
});

test('права владельца определяются только по числовому ID', () => {
  assert.equal(auth.isOwner(777000111), true);
  assert.equal(auth.isOwner(42), false);
  assert.equal(auth.isOwner(Number.NaN), false);
  assert.equal(auth.isOwner('777000111'), false);
  assert.deepEqual(config.config.ownerIds, [777000111]);
});

test('владелец определяется по ID, а не по username', () => {
  const stranger = auth.buildInitDataForTest({ id: 1, username: 'Fortmain' });
  const validated = auth.validateInitData(stranger);
  assert.equal(validated.user.username, 'Fortmain');
  assert.equal(auth.isOwner(validated.user.id), false);
});

test('initData с полем signature (как отправляет Telegram) принимается', () => {
  // Настоящие клиенты Telegram присылают Ed25519-подпись. Без публичного ключа
  // её нельзя проверить, но HMAC-проверка по токену уже подтверждает подлинность,
  // поэтому валидные данные не должны отклоняться.
  const withSig = `${auth.buildInitDataForTest(user)}&signature=${Buffer.from('fake-signature').toString('base64')}`;
  const result = auth.validateInitData(withSig);
  assert.equal(result.user.id, 42);
  assert.equal(result.signatureStatus, 'skipped');
});

test('подделка подписи не ломает HMAC-проверку', () => {
  const withSig = `${auth.buildInitDataForTest(user)}&signature=xxx`;
  const tampered = withSig.replace('fortmain', 'evil');
  assert.notEqual(tampered, withSig);
  assert.throws(() => auth.validateInitData(tampered), /signature mismatch/);
});
import assert from 'node:assert/strict';
import test from 'node:test';
import { fitLargeToolResultForModel } from './toolResultFitting';
import { redactSecretsForModel, redactSecretsInValueForModel } from './modelSecretRedaction';

test('redactSecretsForModel removes common terminal secrets', () => {
  const input = [
    'API_TOKEN=tok_live_1234567890',
    'Authorization: Bearer abc.def.very-secret',
    'postgres://admin:p4ssw0rd@db.internal/app',
    '-----BEGIN PRIVATE KEY-----',
    'super-secret-private-key-body',
    '-----END PRIVATE KEY-----',
  ].join('\n');
  const output = redactSecretsForModel(input);

  assert.doesNotMatch(output, /tok_live|abc\.def|p4ssw0rd|private-key-body/);
  assert.match(output, /\[REDACTED\]/);
});

test('redactSecretsInValueForModel recursively redacts tool arguments', () => {
  const value = redactSecretsInValueForModel({
    command: 'curl --password swordfish',
    nested: [
      'Authorization: Bearer secret_token_123456',
      {
        password: 'short',
        telnetPassword: 'telnet-secret',
        passphrase: 'key-passphrase',
        privateKey: 'not-a-pem-but-still-private',
        apiKey: 'tiny-api-key',
        clientSecret: 'client-secret',
        authToken: 'auth-token',
        username: 'operator',
      },
    ],
  });
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /swordfish|secret_token|short|telnet-secret|key-passphrase|not-a-pem|tiny-api-key|client-secret|auth-token/);
  assert.match(serialized, /operator/);
});

test('redactSecretsForModel redacts JSON and quoted shell assignments', () => {
  const input = [
    '{"password":"short value","apiKey":"tiny","username":"operator"}',
    "passphrase='two words'",
    'client_secret = "quoted secret"',
    'PRIVATE_KEY=one-line-key',
  ].join('\n');

  const output = redactSecretsForModel(input);
  assert.doesNotMatch(output, /short value|tiny|two words|quoted secret|one-line-key/);
  assert.match(output, /"username":"operator"/);
  assert.equal((output.match(/\[REDACTED\]/g) ?? []).length, 5);
});

test('generic tool fitting redacts short strings even when truncation is unnecessary', () => {
  const fitted = fitLargeToolResultForModel({
    result: { message: 'password=hunter2' },
    capabilityId: 'example.read',
  }) as { message: string };

  assert.equal(fitted.message, 'password=[REDACTED]');
});

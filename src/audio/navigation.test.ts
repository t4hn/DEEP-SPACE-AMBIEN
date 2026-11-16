import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_SECTIONS,
  DEFAULT_SECTION_ID,
  getAppSectionMeta,
  isAppSectionId,
} from './navigation';

test('navigation defines Console as default and preserves the three required sections', () => {
  assert.equal(DEFAULT_SECTION_ID, 'console');
  assert.deepEqual(
    APP_SECTIONS.map((s) => s.id),
    ['console', 'environments', 'ship-status'],
  );
  assert.deepEqual(
    APP_SECTIONS.map((s) => s.label),
    ['CONSOLE', 'ENVIRONMENTS', 'SHIP STATUS'],
  );
});

test('isAppSectionId validates allowed section IDs strictly', () => {
  assert.equal(isAppSectionId('console'), true);
  assert.equal(isAppSectionId('environments'), true);
  assert.equal(isAppSectionId('ship-status'), true);
  assert.equal(isAppSectionId('settings'), false);
  assert.equal(isAppSectionId(null), false);
  assert.equal(isAppSectionId(123), false);
});

test('getAppSectionMeta resolves matching metadata and falls back safely', () => {
  assert.equal(getAppSectionMeta('environments').label, 'ENVIRONMENTS');
  assert.equal(getAppSectionMeta('ship-status').label, 'SHIP STATUS');
  assert.equal(getAppSectionMeta('console').label, 'CONSOLE');
});

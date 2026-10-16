import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ComposerModelPicker } from './ComposerModelPicker';

test('external agent picker lists presets without a provider column', () => {
  const html = renderToStaticMarkup(
    <ComposerModelPicker
      modelPresets={[
        { id: 'gpt-5.5', name: 'GPT-5.5' },
        { id: 'gpt-5.4', name: 'GPT-5.4' },
      ]}
      selectedModelId="gpt-5.5"
      prefs={{ recent: [{ modelId: 'gpt-5.5' }], pinned: [] }}
      onSelectModel={() => {}}
      onTogglePinned={() => {}}
    />,
  );

  assert.match(html, /GPT-5\.5/);
  assert.match(html, /GPT-5\.4/);
  assert.match(html, /ai\.chat\.recent/);
  assert.doesNotMatch(html, /ai\.chat\.providers/);
});

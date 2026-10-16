import { Check, Pin, Search, Star } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  filterComposerModels,
  resolveComposerEnterModelId,
  resolvePinnedAndRecentModels,
  type ComposerModelPrefEntry,
  type ComposerModelPrefs,
  type ComposerPickerModel,
} from '../../infrastructure/ai/composerPicker';
import type { AgentModelPreset } from '../../infrastructure/ai/types';

export const COMPOSER_MODEL_PICKER_WIDTH = 260;

export interface ComposerModelPickerProps {
  selectedModelId?: string;
  modelPresets?: AgentModelPreset[];
  prefs: ComposerModelPrefs;
  onSelectModel?: (modelId: string) => void;
  onTogglePinned: (entry: ComposerModelPrefEntry) => void;
}

const rowClassName =
  'flex h-8 w-full items-center gap-2 px-2.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer';

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] tracking-wide text-muted-foreground/45">
    {children}
  </div>
);

const ModelRow: React.FC<{
  model: ComposerPickerModel;
  selected: boolean;
  pinned: boolean;
  onSelect: () => void;
  onTogglePinned: () => void;
  pinLabel: string;
  unpinLabel: string;
}> = ({ model, selected, pinned, onSelect, onTogglePinned, pinLabel, unpinLabel }) => (
  <div className="group/row relative">
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={rowClassName}
    >
      {selected
        ? <Check size={11} className="text-primary shrink-0" />
        : <span className="w-[11px] shrink-0" />}
      <span className="min-w-0 flex-1 truncate text-foreground/88">{model.name}</span>
    </button>
    <button
      type="button"
      aria-label={pinned ? unpinLabel : pinLabel}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onTogglePinned();
      }}
      className={`absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 transition-opacity ${
        pinned
          ? 'text-amber-400/90 opacity-100'
          : 'text-muted-foreground/45 opacity-0 group-hover/row:opacity-100 hover:text-foreground/70'
      }`}
    >
      <Star size={11} fill={pinned ? 'currentColor' : 'none'} />
    </button>
  </div>
);

export const ComposerModelPicker: React.FC<ComposerModelPickerProps> = ({
  selectedModelId,
  modelPresets = [],
  prefs,
  onSelectModel,
  onTogglePinned,
}) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');

  const models = useMemo<ComposerPickerModel[]>(
    () => modelPresets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: preset.description,
    })),
    [modelPresets],
  );

  const filtered = useMemo(() => filterComposerModels(models, query), [models, query]);
  const grouped = useMemo(
    () => resolvePinnedAndRecentModels({
      models: filtered,
      prefs,
      allowMissing: !query.trim(),
    }),
    [filtered, prefs, query],
  );
  const pinnedKeys = useMemo(
    () => new Set(prefs.pinned.map((entry) => entry.modelId)),
    [prefs.pinned],
  );

  const trimmedQuery = query.trim();
  const showCustom = Boolean(
    trimmedQuery
    && !models.some((model) => model.id.toLowerCase() === trimmedQuery.toLowerCase()),
  );

  const selectModel = (modelId: string) => {
    onSelectModel?.(modelId);
  };

  return (
    <div className="w-[260px] max-w-[calc(100vw-16px)] py-1">
      <div className="px-2 pb-1">
        <div className="flex h-7 items-center gap-1.5 rounded-md bg-muted/40 px-2">
          <Search size={11} className="text-muted-foreground/50 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && trimmedQuery) {
                event.preventDefault();
                const nextId = resolveComposerEnterModelId({
                  query: trimmedQuery,
                  models,
                  grouped,
                  filtered,
                  showCustom,
                });
                if (nextId) selectModel(nextId);
              }
            }}
            placeholder={t('ai.chat.searchModels')}
            className="h-full w-full bg-transparent text-[12px] text-foreground/88 outline-none placeholder:text-muted-foreground/40"
          />
        </div>
      </div>

      <div className="max-h-[280px] overflow-y-auto">
        {showCustom && (
          <button
            type="button"
            onClick={() => selectModel(trimmedQuery)}
            className={rowClassName}
          >
            <Pin size={11} className="text-muted-foreground/55 shrink-0" />
            <span className="min-w-0 truncate text-foreground/85">
              {t('ai.chat.useCustomModel').replace('{id}', trimmedQuery)}
            </span>
          </button>
        )}

        {grouped.pinned.length > 0 && (
          <>
            <SectionLabel>{t('ai.chat.pinned')}</SectionLabel>
            {grouped.pinned.map((model) => (
              <ModelRow
                key={`pin-${model.id}`}
                model={model}
                selected={model.id === selectedModelId}
                pinned
                onSelect={() => selectModel(model.id)}
                onTogglePinned={() => onTogglePinned({ modelId: model.id })}
                pinLabel={t('ai.chat.pinModel')}
                unpinLabel={t('ai.chat.unpinModel')}
              />
            ))}
          </>
        )}

        {grouped.recent.length > 0 && (
          <>
            <SectionLabel>{t('ai.chat.recent')}</SectionLabel>
            {grouped.recent.map((model) => (
              <ModelRow
                key={`recent-${model.id}`}
                model={model}
                selected={model.id === selectedModelId}
                pinned={pinnedKeys.has(model.id)}
                onSelect={() => selectModel(model.id)}
                onTogglePinned={() => onTogglePinned({ modelId: model.id })}
                pinLabel={t('ai.chat.pinModel')}
                unpinLabel={t('ai.chat.unpinModel')}
              />
            ))}
          </>
        )}

        {(grouped.pinned.length > 0 || grouped.recent.length > 0) && grouped.rest.length > 0 && (
          <SectionLabel>{t('ai.chat.models')}</SectionLabel>
        )}

        {grouped.rest.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            selected={model.id === selectedModelId}
            pinned={pinnedKeys.has(model.id)}
            onSelect={() => selectModel(model.id)}
            onTogglePinned={() => onTogglePinned({ modelId: model.id })}
            pinLabel={t('ai.chat.pinModel')}
            unpinLabel={t('ai.chat.unpinModel')}
          />
        ))}

        {filtered.length === 0 && !showCustom && (
          <div className="px-2.5 py-2 text-[11px] text-muted-foreground/50">
            {t('ai.chat.noMatchingModels')}
          </div>
        )}
      </div>
    </div>
  );
};

export default React.memo(ComposerModelPicker);

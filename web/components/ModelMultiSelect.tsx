'use client';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface ModelOption {
  modelId: string;
  displayName?: string;
}

/**
 * A dropdown multi-select for picking model ids from the set of available
 * models. Supports type-ahead filtering on id + display name and toggling
 * selection by clicking. No free-text entry / copy-pasting.
 *
 * An empty selection means "all models are allowed".
 */
export function ModelMultiSelect({
  available,
  selected,
  onChange,
  label,
  ariaLabel,
}: {
  available: ModelOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  label?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside the widget.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Merge available models with any selected ids that aren't in the available
  // list (e.g. inference-profile ids) so existing selections stay visible and
  // removable instead of being silently dropped.
  const options = useMemo<ModelOption[]>(() => {
    const byId = new Map<string, ModelOption>();
    for (const o of available) byId.set(o.modelId, o);
    for (const id of selected) if (!byId.has(id)) byId.set(id, { modelId: id });
    return Array.from(byId.values()).sort((a, b) => a.modelId.localeCompare(b.modelId));
  }, [available, selected]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.modelId.toLowerCase().includes(q) ||
        (o.displayName ?? '').toLowerCase().includes(q),
    );
  }, [options, filter]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  function toggle(modelId: string) {
    if (selectedSet.has(modelId)) {
      onChange(selected.filter((m) => m !== modelId));
    } else {
      onChange([...selected, modelId]);
    }
  }

  const summary =
    selected.length === 0
      ? 'All models'
      : `${selected.length} model${selected.length === 1 ? '' : 's'} selected`;

  return (
    <div className="model-select" ref={containerRef}>
      {label && <span className="model-select-label">{label}</span>}
      <button
        type="button"
        className="model-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? label ?? 'Select models'}
        onClick={() => setOpen((v) => !v)}
      >
        {summary}
        <span aria-hidden="true" className="model-select-caret">▾</span>
      </button>

      {selected.length > 0 && (
        <div className="model-select-chips">
          {selected.map((id) => (
            <span key={id} className="model-chip">
              {id}
              <button
                type="button"
                className="model-chip-remove"
                aria-label={`Remove ${id}`}
                onClick={() => toggle(id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className="model-select-panel" role="listbox" aria-label={ariaLabel ?? label ?? 'Models'}>
          <input
            type="text"
            className="model-select-filter"
            placeholder="Filter by model id…"
            aria-label="Filter models"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          <ul className="model-select-options">
            {filtered.length === 0 && (
              <li className="model-select-empty">No matching models</li>
            )}
            {filtered.map((o) => {
              const isSelected = selectedSet.has(o.modelId);
              return (
                <li key={o.modelId}>
                  <label className="model-select-option" role="option" aria-selected={isSelected}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggle(o.modelId)}
                    />
                    <span className="model-select-option-text">
                      <span className="model-select-option-id">{o.modelId}</span>
                      {o.displayName && (
                        <span className="model-select-option-name">{o.displayName}</span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

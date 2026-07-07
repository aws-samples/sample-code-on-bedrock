'use client';
import { useState, useRef, KeyboardEvent, ReactNode } from 'react';

export interface TabItem {
  /** Stable identifier, used to build tab/panel element ids. */
  id: string;
  label: string;
  content: ReactNode;
}

/**
 * Accessible tabbed container following the WAI-ARIA tabs pattern:
 * roving tabindex, arrow/Home/End keyboard navigation, and linked
 * tab/tabpanel aria attributes. Only the active panel is mounted.
 */
export function Tabs({ tabs, ariaLabel }: { tabs: TabItem[]; ariaLabel?: string }) {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Guard against the active index pointing past the end if `tabs` shrinks
  // (e.g. an admin signs out and the admin tabs disappear).
  const activeIndex = Math.min(active, tabs.length - 1);
  const activeTab = tabs[activeIndex];

  function focusTab(index: number) {
    setActive(index);
    tabRefs.current[index]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    let next = activeIndex;
    switch (e.key) {
      case 'ArrowRight':
        next = (activeIndex + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        next = (activeIndex - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    focusTab(next);
  }

  if (tabs.length === 0) return null;

  return (
    <div className="tabs">
      <div className="tab-list" role="tablist" aria-label={ariaLabel}>
        {tabs.map((tab, i) => {
          const selected = i === activeIndex;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`tabpanel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className={`tab${selected ? ' tab-active' : ''}`}
              onClick={() => setActive(i)}
              onKeyDown={onKeyDown}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        className="tab-panel"
        role="tabpanel"
        id={`tabpanel-${activeTab.id}`}
        aria-labelledby={`tab-${activeTab.id}`}
        tabIndex={0}
      >
        {activeTab.content}
      </div>
    </div>
  );
}

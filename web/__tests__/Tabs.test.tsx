import { render, screen, fireEvent } from '@testing-library/react';
import { describe, test, expect } from 'vitest';
import { Tabs, TabItem } from '@/components/Tabs';

const tabs: TabItem[] = [
  { id: 'one', label: 'One', content: <p>Panel One</p> },
  { id: 'two', label: 'Two', content: <p>Panel Two</p> },
  { id: 'three', label: 'Three', content: <p>Panel Three</p> },
];

describe('Tabs', () => {
  test('renders all tab labels and shows the first panel by default', () => {
    render(<Tabs tabs={tabs} ariaLabel="test" />);

    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Panel One')).toBeInTheDocument();
    // Inactive panels are not mounted.
    expect(screen.queryByText('Panel Two')).not.toBeInTheDocument();
    expect(screen.queryByText('Panel Three')).not.toBeInTheDocument();
  });

  test('clicking a tab switches the active panel', () => {
    render(<Tabs tabs={tabs} ariaLabel="test" />);

    fireEvent.click(screen.getByRole('tab', { name: 'Two' }));

    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Panel Two')).toBeInTheDocument();
    expect(screen.queryByText('Panel One')).not.toBeInTheDocument();
  });

  test('arrow keys move between tabs (wrapping at the ends)', () => {
    render(<Tabs tabs={tabs} ariaLabel="test" />);
    const first = screen.getByRole('tab', { name: 'One' });
    first.focus();

    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Two' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');

    // ArrowLeft from the first tab wraps to the last.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'One' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Three' })).toHaveAttribute('aria-selected', 'true');
  });

  test('Home and End jump to the first and last tabs', () => {
    render(<Tabs tabs={tabs} ariaLabel="test" />);
    const first = screen.getByRole('tab', { name: 'One' });
    first.focus();

    fireEvent.keyDown(first, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Three' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Three' }), { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
  });

  test('uses roving tabindex on the tab buttons', () => {
    render(<Tabs tabs={tabs} ariaLabel="test" />);

    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('tabindex', '-1');
  });

  test('links the tabpanel to its tab for accessibility', () => {
    render(<Tabs tabs={tabs} ariaLabel="test" />);

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', 'tabpanel-one');
    expect(panel).toHaveAttribute('aria-labelledby', 'tab-one');
  });
});

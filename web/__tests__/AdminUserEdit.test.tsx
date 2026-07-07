import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { AdminUserEdit, EditableUser, EditTier } from '@/components/AdminUserEdit';

vi.mock('@/lib/api', () => ({
  apiPut: vi.fn(),
}));

import { apiPut } from '@/lib/api';
const mockApiPut = vi.mocked(apiPut);

const tiers: EditTier[] = [
  { tierId: 'tier-standard', dailyUsd: 5, monthlyUsd: 50 },
  { tierId: 'tier-power', dailyUsd: 10, monthlyUsd: 100 },
];

const manualUser: EditableUser = {
  sub: 'abc-123',
  email: 'alice@example.com',
  tier: '',
  blocked: false,
  dailyUsd: 7,
  monthlyUsd: 70,
  allowedModels: ['m1'],
};

const manualUserNoModels: EditableUser = {
  ...manualUser,
  allowedModels: [],
};

const tierUser: EditableUser = {
  sub: 'def-456',
  email: 'bob@example.com',
  tier: 'tier-power',
  blocked: false,
  dailyUsd: 10,
  monthlyUsd: 100,
};

const MODELS = [
  { modelId: 'm1' },
  { modelId: 'modelA', displayName: 'Model A' },
  { modelId: 'modelB' },
  { modelId: 'modelC' },
];

describe('AdminUserEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiPut.mockResolvedValue({} as never);
  });

  test('defaults to manual mode for a user without a tier', () => {
    render(<AdminUserEdit token="t" user={manualUser} tiers={tiers} onSaved={() => {}} onCancel={() => {}} />);
    expect((screen.getByRole('radio', { name: 'Manual' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Current:/)).toHaveTextContent('Manual limits');
  });

  test('defaults to tier mode for a tier-managed user', () => {
    render(<AdminUserEdit token="t" user={tierUser} tiers={tiers} onSaved={() => {}} onCancel={() => {}} />);
    expect((screen.getByRole('radio', { name: 'Tier' }) as HTMLInputElement).checked).toBe(true);
  });

  test('saving in tier mode calls PUT /admin/users/{sub}/tier', async () => {
    const onSaved = vi.fn();
    render(<AdminUserEdit token="tok" user={tierUser} tiers={tiers} onSaved={onSaved} onCancel={() => {}} />);

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith('/admin/users/def-456/tier', 'tok', { tier: 'tier-power' });
    });
    expect(onSaved).toHaveBeenCalled();
  });

  test('saving in manual mode keeps the existing allowlist', async () => {
    const onSaved = vi.fn();
    render(<AdminUserEdit token="tok" user={manualUser} tiers={tiers} availableModels={MODELS} onSaved={onSaved} onCancel={() => {}} />);

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith('/admin/users/abc-123/limits', 'tok', { dailyUsd: 7, monthlyUsd: 70, allowedModels: ['m1'] });
    });
    expect(onSaved).toHaveBeenCalled();
  });

  test('selecting models via the dropdown sends the chosen list', async () => {
    const onSaved = vi.fn();
    render(<AdminUserEdit token="tok" user={manualUserNoModels} tiers={tiers} availableModels={MODELS} onSaved={onSaved} onCancel={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Allowed models' }));
    const filter = screen.getByLabelText('Filter models');
    for (const id of ['modelA', 'modelB', 'modelC']) {
      fireEvent.change(filter, { target: { value: id } });
      fireEvent.click(screen.getByRole('checkbox'));
    }

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith('/admin/users/abc-123/limits', 'tok', {
        dailyUsd: 7,
        monthlyUsd: 70,
        allowedModels: ['modelA', 'modelB', 'modelC'],
      });
    });
  });

  test('clearing the manual allowlist sends an empty array', async () => {
    const onSaved = vi.fn();
    render(<AdminUserEdit token="tok" user={manualUser} tiers={tiers} availableModels={MODELS} onSaved={onSaved} onCancel={() => {}} />);

    fireEvent.click(screen.getByLabelText('Remove m1'));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith('/admin/users/abc-123/limits', 'tok', {
        dailyUsd: 7,
        monthlyUsd: 70,
        allowedModels: [],
      });
    });
  });

  test('switching a manual user to a tier sends the tier request', async () => {
    const onSaved = vi.fn();
    render(<AdminUserEdit token="tok" user={manualUser} tiers={tiers} onSaved={onSaved} onCancel={() => {}} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Tier' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'tier-standard' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith('/admin/users/abc-123/tier', 'tok', { tier: 'tier-standard' });
    });
  });
});

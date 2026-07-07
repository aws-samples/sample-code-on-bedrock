import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { AdminTiers } from '@/components/AdminTiers';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

import { apiFetch, apiPost, apiPut } from '@/lib/api';

const mockApiFetch = vi.mocked(apiFetch);
const mockApiPost = vi.mocked(apiPost);
const mockApiPut = vi.mocked(apiPut);

const TIERS = [
  { tierId: 'tier-standard', dailyUsd: 5, monthlyUsd: 50, allowedModels: ['m1', 'm2'] },
  { tierId: 'tier-open', dailyUsd: 1, monthlyUsd: 10, allowedModels: [] },
];

const RATES = [
  { modelId: 'a', displayName: 'Model A' },
  { modelId: 'b', displayName: 'Model B' },
  { modelId: 'm1' },
  { modelId: 'm2' },
];

function mockFetchByPath() {
  mockApiFetch.mockImplementation((path: string) => {
    if (path === '/admin/tiers') return Promise.resolve({ tiers: TIERS }) as never;
    if (path === '/admin/model-rates') return Promise.resolve({ rates: RATES }) as never;
    return Promise.resolve({}) as never;
  });
}

describe('AdminTiers — model allowlists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchByPath();
    mockApiPost.mockResolvedValue({} as never);
    mockApiPut.mockResolvedValue({} as never);
  });

  test('renders the allowlist for each tier', async () => {
    render(<AdminTiers token="t" />);
    expect(await screen.findByText('m1, m2')).toBeInTheDocument();
    expect(screen.getAllByText('All models').length).toBeGreaterThan(0);
  });

  test('create sends models selected via the dropdown', async () => {
    render(<AdminTiers token="t" />);
    await screen.findByText('m1, m2');

    fireEvent.change(screen.getByLabelText('Tier ID'), { target: { value: 'tier-x' } });
    fireEvent.change(screen.getByLabelText('Daily USD'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Monthly USD'), { target: { value: '30' } });

    // Open the selector and pick two models by filtering then checking.
    fireEvent.click(screen.getByRole('button', { name: 'Allowed models' }));
    const filter = screen.getByLabelText('Filter models');
    fireEvent.change(filter, { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(filter, { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('checkbox'));

    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/admin/tiers', 't', {
        tierId: 'tier-x',
        dailyUsd: 3,
        monthlyUsd: 30,
        allowedModels: ['a', 'b'],
      });
    });
  });

  test('edit can clear the allowlist by removing chips', async () => {
    render(<AdminTiers token="t" />);
    await screen.findByText('m1, m2');

    // Open edit for the first tier (allowedModels = ['m1','m2']).
    fireEvent.click(screen.getAllByText('Edit')[0]);

    // Remove both selected models via their chips.
    fireEvent.click(screen.getByLabelText('Remove m1'));
    fireEvent.click(screen.getByLabelText('Remove m2'));

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockApiPut).toHaveBeenCalledWith(
        '/admin/tiers/tier-standard',
        't',
        expect.objectContaining({ allowedModels: [] }),
      );
    });
  });
});

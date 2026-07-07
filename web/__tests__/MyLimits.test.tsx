import { render, screen } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { MyLimits } from '@/components/MyLimits';

// R-UI-3: "My limits" view showing dailyUsd, monthlyUsd, blocked, tier, allowedModels
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
const mockApiFetch = vi.mocked(apiFetch);

describe('MyLimits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders daily and monthly limits', async () => {
    mockApiFetch.mockResolvedValueOnce({
      dailyUsd: 5.0,
      monthlyUsd: 50.0,
      blocked: false,
    });

    render(<MyLimits token="test-token" />);

    expect(await screen.findByText(/\$5\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\$50\.00/)).toBeInTheDocument();
  });

  test('renders blocked status when blocked', async () => {
    mockApiFetch.mockResolvedValueOnce({
      dailyUsd: 5.0,
      monthlyUsd: 50.0,
      blocked: true,
    });

    render(<MyLimits token="test-token" />);

    expect(await screen.findByText(/Blocked/)).toBeInTheDocument();
  });

  test('renders active status when not blocked', async () => {
    mockApiFetch.mockResolvedValueOnce({
      dailyUsd: 5.0,
      monthlyUsd: 50.0,
      blocked: false,
    });

    render(<MyLimits token="test-token" />);

    expect(await screen.findByText(/Active/)).toBeInTheDocument();
  });

  test('renders the tier name', async () => {
    mockApiFetch.mockResolvedValueOnce({
      dailyUsd: 5.0,
      monthlyUsd: 50.0,
      blocked: false,
      tier: 'tier-power',
    });

    render(<MyLimits token="test-token" />);

    expect(await screen.findByText(/Tier: tier-power/)).toBeInTheDocument();
  });

  test('renders "None" when the user has no tier', async () => {
    mockApiFetch.mockResolvedValueOnce({
      dailyUsd: 5.0,
      monthlyUsd: 50.0,
      blocked: false,
      tier: null,
    });

    render(<MyLimits token="test-token" />);

    expect(await screen.findByText(/Tier: None/)).toBeInTheDocument();
  });

  test('renders the allowed models list', async () => {
    mockApiFetch.mockResolvedValueOnce({
      dailyUsd: 5.0,
      monthlyUsd: 50.0,
      blocked: false,
      tier: 'tier-power',
      allowedModels: [
        'anthropic.claude-3-5-sonnet-20241022-v2:0',
        'amazon.titan-text-express-v1',
      ],
    });

    render(<MyLimits token="test-token" />);

    expect(
      await screen.findByText(/anthropic\.claude-3-5-sonnet-20241022-v2:0, amazon\.titan-text-express-v1/),
    ).toBeInTheDocument();
  });

  test('renders "All models" when no allowlist is set', async () => {
    mockApiFetch.mockResolvedValueOnce({
      dailyUsd: 5.0,
      monthlyUsd: 50.0,
      blocked: false,
      tier: 'tier-power',
      allowedModels: [],
    });

    render(<MyLimits token="test-token" />);

    expect(await screen.findByText(/Allowed models: All models/)).toBeInTheDocument();
  });

  test('calls GET /me/limits', async () => {
    mockApiFetch.mockResolvedValueOnce({
      dailyUsd: 5.0,
      monthlyUsd: 50.0,
      blocked: false,
    });

    render(<MyLimits token="test-token" />);
    await screen.findByText(/\$5\.00/);

    expect(mockApiFetch).toHaveBeenCalledWith('/me/limits', 'test-token');
  });
});

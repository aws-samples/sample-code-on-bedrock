import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { MyCredentials } from '@/components/MyCredentials';

vi.mock('@/lib/api', () => ({
  apiPost: vi.fn(),
}));

import { apiPost } from '@/lib/api';
const mockApiPost = vi.mocked(apiPost);

const fakeCreds = {
  Version: 1,
  AccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  SessionToken: 'FwoGZXIvYXdzEBY...',
  Expiration: '2026-05-06T13:00:00Z',
};

describe('MyCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders generate button', () => {
    render(<MyCredentials token="test-token" />);
    expect(screen.getByRole('button', { name: /Generate Credentials/i })).toBeInTheDocument();
  });

  test('calls POST /credentials on button click', async () => {
    mockApiPost.mockResolvedValueOnce(fakeCreds);
    render(<MyCredentials token="test-token" />);

    fireEvent.click(screen.getByRole('button', { name: /Generate Credentials/i }));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/credentials', 'test-token', { assistant: 'web-ui' });
    });
  });

  test('displays credentials in env format after generation', async () => {
    mockApiPost.mockResolvedValueOnce(fakeCreds);
    render(<MyCredentials token="test-token" />);

    fireEvent.click(screen.getByRole('button', { name: /Generate Credentials/i }));

    expect(await screen.findByText(/export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE/)).toBeInTheDocument();
  });

  test('displays credentials in JSON format after generation', async () => {
    mockApiPost.mockResolvedValueOnce(fakeCreds);
    render(<MyCredentials token="test-token" />);

    fireEvent.click(screen.getByRole('button', { name: /Generate Credentials/i }));

    await waitFor(() => {
      expect(screen.getByText(/"AccessKeyId"/)).toBeInTheDocument();
    });
  });

  test('shows expiration warning', async () => {
    mockApiPost.mockResolvedValueOnce(fakeCreds);
    render(<MyCredentials token="test-token" />);

    fireEvent.click(screen.getByRole('button', { name: /Generate Credentials/i }));

    expect(await screen.findByText(/expire in 15 minutes/)).toBeInTheDocument();
  });

  test('shows blocked error on 403', async () => {
    mockApiPost.mockRejectedValueOnce(new Error('API error: 403'));
    render(<MyCredentials token="test-token" />);

    fireEvent.click(screen.getByRole('button', { name: /Generate Credentials/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/blocked/i);
  });

  test('shows generic error on failure', async () => {
    mockApiPost.mockRejectedValueOnce(new Error('API error: 500'));
    render(<MyCredentials token="test-token" />);

    fireEvent.click(screen.getByRole('button', { name: /Generate Credentials/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Failed to generate/);
  });
});

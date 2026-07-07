'use client';
import { useState, useEffect, useCallback } from 'react';
import { apiPost } from '@/lib/api';

interface Credentials {
  Version: number;
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken: string;
  Expiration: string;
}

export function MyCredentials({ token }: { token: string }) {
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Auto-hide credentials after 5 minutes
  useEffect(() => {
    if (!creds) return;
    const timer = setTimeout(() => setCreds(null), 5 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [creds]);

  const generate = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const data = await apiPost<Credentials>('/credentials', token, { assistant: 'web-ui' });
      setCreds(data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      if (msg.includes('403')) {
        setError('Your account is blocked. Contact an admin to unblock.');
      } else {
        setError(`Failed to generate credentials: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  const envFormat = creds
    ? `export AWS_ACCESS_KEY_ID=${creds.AccessKeyId}\nexport AWS_SECRET_ACCESS_KEY=${creds.SecretAccessKey}\nexport AWS_SESSION_TOKEN=${creds.SessionToken}`
    : '';

  const jsonFormat = creds
    ? JSON.stringify({ AccessKeyId: creds.AccessKeyId, SecretAccessKey: creds.SecretAccessKey, SessionToken: creds.SessionToken }, null, 2)
    : '';

  return (
    <div className="card">
      <h2>My Credentials</h2>
      <button className="btn-primary" onClick={generate} disabled={loading}>
        {loading ? 'Generating...' : 'Generate Credentials'}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
      {creds && (
        <div>
          <p className="warning">⚠️ These credentials expire in 15 minutes (at {new Date(creds.Expiration).toLocaleTimeString()}).</p>
          <h3>Environment Variables</h3>
          <pre>{envFormat}</pre>
          <h3>JSON</h3>
          <pre>{jsonFormat}</pre>
        </div>
      )}
    </div>
  );
}

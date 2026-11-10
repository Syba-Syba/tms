import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Alert } from '../alert';

describe('Alert', () => {
  it('does not announce static information assertively', () => {
    render(<Alert title="Your data is kept for five years" />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Your data is kept for five years')).toBeTruthy();
  });

  it('is a polite status for warnings and errors', () => {
    render(<Alert tone="danger" title="Could not load" />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Could not load');
  });

  it('interrupts only when asked to', () => {
    render(<Alert tone="danger" live="assertive" title="Payment failed" />);
    expect(screen.getByRole('alert').textContent).toContain('Payment failed');
  });
});

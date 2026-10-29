import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CurrencyInput } from '../currency-input';

function Harness() {
  const [cents, setCents] = useState<number | null>(null);
  return (
    <>
      <CurrencyInput aria-label="Rent" cents={cents} onCentsChange={setCents} />
      <button disabled={cents === null}>Save</button>
    </>
  );
}

describe('CurrencyInput', () => {
  it('reports the amount while typing, without reformatting under the cursor', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Rent');
    fireEvent.change(input, { target: { value: '8' } });
    expect(input).toHaveValue('8');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    fireEvent.change(input, { target: { value: '8500' } });
    expect(input).toHaveValue('8500');
    fireEvent.blur(input);
    expect(input).toHaveValue('8500.00');
  });
});

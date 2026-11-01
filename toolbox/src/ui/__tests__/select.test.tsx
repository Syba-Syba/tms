import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Select } from '../select';

const OPTIONS = [
  { label: 'Employed', value: 'employed' },
  { label: 'Retired', value: 'retired' },
];

describe('Select', () => {
  it('shows that nothing is chosen when its value is empty, not the first option', () => {
    render(<Select aria-label="Employment" value="" onChange={() => {}} options={OPTIONS} />);
    const select = screen.getByLabelText('Employment') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.selectedOptions[0]?.textContent).toBe('Choose…');
  });

  it('adds no prompt once something is chosen, or when an option already means "none"', () => {
    const { rerender } = render(<Select aria-label="Employment" value="retired" onChange={() => {}} options={OPTIONS} />);
    expect(screen.queryByText('Choose…')).toBeNull();
    rerender(<Select aria-label="Employment" value="" onChange={() => {}} options={[{ label: 'All', value: '' }, ...OPTIONS]} />);
    expect(screen.queryByText('Choose…')).toBeNull();
  });
});

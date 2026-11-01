import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SegmentedControl } from '../segmented';

describe('SegmentedControl', () => {
  it('wraps rather than overflowing a narrow screen when it has many options', () => {
    render(
      <SegmentedControl
        value="good"
        onChange={() => {}}
        options={['Excellent', 'Good', 'Fair', 'Poor', 'Damaged'].map((label) => ({ label, value: label.toLowerCase() }))}
      />,
    );
    const group = screen.getByRole('tablist');
    expect(group.className).toContain('flex-wrap');
    expect(group.className).toContain('max-w-full');
  });
});

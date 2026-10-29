import { Card, CardBody, SegmentedControl, useTheme, type ThemeChoice } from '@hlonie/toolbox/ui';

/** Light, dark, or whatever the phone or computer is set to. Kept on this device only. */
export function Appearance() {
  const { choice, setChoice } = useTheme();
  return (
    <section aria-label="Appearance">
      <h2 className="label mb-2">Appearance</h2>
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-body text-ink">
            {choice === 'system' ? 'Follows your device setting.' : `Always ${choice}.`}
          </p>
          <SegmentedControl<ThemeChoice>
            value={choice}
            onChange={setChoice}
            options={[
              { value: 'system', label: 'Device' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </CardBody>
      </Card>
    </section>
  );
}

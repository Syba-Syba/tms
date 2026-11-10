import { SegmentedControl, useTheme, type ThemeChoice } from '@hlonie/toolbox/ui';
import { SettingsCard } from './settings-nav';

/** Light, dark, or whatever the phone or computer is set to. Kept on this device only. */
export function Appearance() {
  const { choice, setChoice } = useTheme();
  return (
    <SettingsCard title="Appearance" description="Kept on this device only.">
      <div className="flex flex-wrap items-center justify-between gap-3">
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
      </div>
    </SettingsCard>
  );
}

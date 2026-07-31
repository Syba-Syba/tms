import { Controller, type Control, type FieldValues, type Path, type RegisterOptions } from 'react-hook-form';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Input } from '../ui/input';
import { Select, type SelectOption } from '../ui/select';
import { Textarea } from '../ui/textarea';
import { Checkbox } from '../ui/checkbox';

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
        {label}
        {required ? <span className="ml-0.5 text-danger">*</span> : null}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-ink-muted">{hint}</p>
      ) : null}
    </div>
  );
}

interface BaseProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  hint?: string;
  required?: boolean;
  /** react-hook-form rules, so a form can refuse bad input inline before the API does. */
  rules?: Omit<RegisterOptions<T, Path<T>>, 'valueAsNumber' | 'valueAsDate' | 'setValueAs' | 'disabled'>;
}

export function TextField<T extends FieldValues>({
  control,
  name,
  label,
  hint,
  required,
  rules,
  ...input
}: BaseProps<T> & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Controller
      control={control}
      name={name}
      rules={rules}
      render={({ field, fieldState }) => (
        <Field label={label} htmlFor={name} hint={hint} required={required} error={fieldState.error?.message}>
          <Input id={name} invalid={!!fieldState.error} {...field} {...input} />
        </Field>
      )}
    />
  );
}

export function TextAreaField<T extends FieldValues>({
  control,
  name,
  label,
  hint,
  required,
  ...props
}: BaseProps<T> & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field label={label} htmlFor={name} hint={hint} required={required} error={fieldState.error?.message}>
          <Textarea id={name} invalid={!!fieldState.error} {...field} {...props} />
        </Field>
      )}
    />
  );
}

export function SelectField<T extends FieldValues>({
  control,
  name,
  label,
  hint,
  required,
  options,
  placeholder,
}: BaseProps<T> & { options: SelectOption[]; placeholder?: string }) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field label={label} htmlFor={name} hint={hint} required={required} error={fieldState.error?.message}>
          <Select id={name} options={options} placeholder={placeholder} invalid={!!fieldState.error} {...field} />
        </Field>
      )}
    />
  );
}

export function CheckboxField<T extends FieldValues>({ control, name, label }: BaseProps<T>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <div className="space-y-1">
          <Checkbox id={name} label={label} checked={!!field.value} onChange={field.onChange} />
          {fieldState.error ? <p className="text-xs text-danger">{fieldState.error.message}</p> : null}
        </div>
      )}
    />
  );
}

export * from './schemas';

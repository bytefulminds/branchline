import { useId, useState, type ReactNode } from "react";
import type { Settings } from "../../types/settings";

export type Setter = (change: (s: Settings) => Settings) => void;

/** A labelled row: title and help on the left, the control on the right. */
export function Field({
  label,
  help,
  htmlFor,
  stacked = false,
  children,
}: {
  label: string;
  help?: ReactNode;
  htmlFor?: string;
  /** Put the control under the text, for wide controls such as text areas. */
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`bl-setting${stacked ? " bl-setting--stacked" : ""}`}>
      <div className="bl-setting__text">
        <label className="bl-setting__label" htmlFor={htmlFor}>
          {label}
        </label>
        {help && <p className="bl-setting__help">{help}</p>}
      </div>
      <div className="bl-setting__control">{children}</div>
    </div>
  );
}

/** A switch-like checkbox with its own label (for rows without a separate control label). */
export function Toggle({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <Field label={label} help={help} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="bl-switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </Field>
  );
}

export function NumberSelect({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: number;
  options: { value: number; label: string }[];
  onChange: (v: number) => void;
}) {
  return (
    <select
      id={id}
      className="bl-input bl-setting__select"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A text input that saves when it loses focus or on Enter (not on every keystroke). */
export function TextSetting({
  id,
  value,
  placeholder,
  mono = true,
  onCommit,
}: {
  id: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  // Follow outside changes (for example the stored, trimmed value).
  if (shown !== value) {
    setShown(value);
    setDraft(value);
  }
  return (
    <input
      id={id}
      className={`bl-input${mono ? " mono" : ""}`}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && draft !== value) onCommit(draft);
      }}
    />
  );
}

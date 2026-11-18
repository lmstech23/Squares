import { useId, type InputHTMLAttributes } from "react";
import styles from "./TextField.module.css";

// A labelled text input — UI System 1.0. The label is always visible (never a
// placeholder standing in for one). Helper text and the inline error are tied
// to the input with aria-describedby; an error also sets aria-invalid.

export type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
  label: string;
  helper?: string;
  error?: string | null;
  className?: string;
};

export function TextField({ label, helper, error, id, className, ...input }: TextFieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const helperId = helper ? `${inputId}-helper` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={[styles.field, error ? styles.invalid : "", className ?? ""].filter(Boolean).join(" ")}>
      <label htmlFor={inputId} className={styles.label}>
        {label}
      </label>
      <input
        id={inputId}
        className={styles.input}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...input}
      />
      {helper ? (
        <span id={helperId} className={styles.helper}>
          {helper}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className={styles.error} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

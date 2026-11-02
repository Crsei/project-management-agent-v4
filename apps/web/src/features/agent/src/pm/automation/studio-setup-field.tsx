import { useId, type ReactNode } from "react";
import styles from "./studio-setup.module.css";

export function StudioSetupField({ label, children, help, issue }: { label: string; children: (id: string) => ReactNode; help?: string; issue?: string }) {
  const id = useId();
  return <div className={styles.field}><label htmlFor={id}>{label}</label>{children(id)}{help && <p>{help}</p>}{issue && <p className={styles.error} role="alert">{issue}</p>}</div>;
}

export interface DocumentSelection { from: number; to: number }
export interface DocumentEdit { text: string; selection: DocumentSelection }
export interface DocumentCommandDefinition {
  id: string;
  label: string;
  labelEn: string;
  group: 'text' | 'paragraph' | 'insert' | 'table' | 'block' | 'template';
  input?: { label: string; labelEn: string; initial?: string };
}
export type DocumentCommand = (text: string, selection: DocumentSelection, command: string, input?: string) => DocumentEdit;

interface IndexColumn {
  name: string;
  key_ordinal: number;
  is_descending_key: boolean;
  is_included_column: boolean;
}

const quote = (name: string) => `[${name.replace(/]/g, ']]')}]`;

/** Logical DDL for disk-based rowstore indexes; storage/maintenance settings use defaults. */
export function sqlServerIndexScript(
  schema: string, table: string, index: Record<string, unknown>,
): string | undefined {
  // Other index families require different DDL and catalog metadata.
  if (![1, 2].includes(index.type_id as number) || index.is_memory_optimized) return;
  if (index.has_filter && !index.filter_definition) return;
  const columns: IndexColumn[] = JSON.parse((index.index_columns as string) || '[]');
  const keys = columns.filter((c) => c.key_ordinal > 0).sort((a, b) => a.key_ordinal - b.key_ordinal);
  if (!keys.length) return;
  const keySql = keys.map((c) => `${quote(c.name)} ${c.is_descending_key ? 'DESC' : 'ASC'}`).join(', ');
  const target = `${quote(schema)}.${quote(table)}`;
  const kind = index.type_id === 1 ? 'CLUSTERED' : 'NONCLUSTERED';
  let ddl: string;
  if (index.constraint_name) {
    ddl = `ALTER TABLE ${target}\nADD CONSTRAINT ${quote(index.constraint_name as string)} ${index.is_primary ? 'PRIMARY KEY' : 'UNIQUE'} ${kind} (${keySql})`;
  } else {
    ddl = `CREATE ${index.is_unique ? 'UNIQUE ' : ''}${kind} INDEX ${quote(index.index_name as string)}\nON ${target} (${keySql})`;
    const included = columns.filter((c) => c.is_included_column);
    if (included.length) ddl += `\nINCLUDE (${included.map((c) => quote(c.name)).join(', ')})`;
    if (index.has_filter) ddl += `\nWHERE ${index.filter_definition}`;
  }
  return `-- Logical definition; storage and maintenance options use database defaults.\n${ddl};`;
}

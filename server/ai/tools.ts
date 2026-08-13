import { DbType } from '../connections';
import { ColumnNode, Driver, SchemaTree } from '../drivers/types';
import { ToolCall, ToolSpec } from './types';

/**
 * The complete set of database access the assistant has: read the catalog, read column
 * lists. There is deliberately no tool that runs a query — generated SQL goes into the
 * editor and only a human's click on Run ever executes it.
 */

/** Caps, so a warehouse with thousands of tables cannot blow out the model's context. */
const MAX_TABLES = 400;
const MAX_COLUMNS_PER_TABLE = 250;
const MAX_TABLES_PER_DESCRIBE = 12;
/** How many documents to sample when a document store has to have its fields inferred. */
const MONGO_SAMPLE_SIZE = 50;

export interface ToolOutcome {
  /** Short past-tense line shown in the panel's trace, e.g. "Reading columns for orders". */
  label: string;
  /** Text handed back to the model. */
  content: string;
}

export interface SchemaToolset {
  specs: ToolSpec[];
  run(call: ToolCall): Promise<ToolOutcome>;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  // Models occasionally send a bare string where the schema asks for an array.
  return typeof value === 'string' ? [value] : [];
}

function describeColumns(columns: ColumnNode[]): string {
  const shown = columns.slice(0, MAX_COLUMNS_PER_TABLE);
  const lines = shown.map(
    (c) => `  ${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`,
  );
  if (columns.length > shown.length) {
    lines.push(`  … ${columns.length - shown.length} more columns omitted`);
  }
  return lines.join('\n');
}

export function createSchemaToolset(
  driver: Driver,
  dbType: DbType,
  database: string,
): SchemaToolset {
  const isDocumentStore = dbType === 'mongodb';
  const tableWord = isDocumentStore ? 'collection' : 'table';

  // One catalog read per chat turn, shared by every tool call in the agent loop.
  let treePromise: Promise<SchemaTree> | null = null;
  function tree(): Promise<SchemaTree> {
    if (!treePromise) treePromise = driver.getSchemaTree();
    return treePromise;
  }

  /** Flattens the tree into (schema, table) pairs, ignoring the database layer. */
  async function allTables(): Promise<{ schema: string; table: string; columns: ColumnNode[] }[]> {
    const out: { schema: string; table: string; columns: ColumnNode[] }[] = [];
    for (const db of (await tree()).databases) {
      for (const schema of db.schemas) {
        for (const table of schema.tables) {
          out.push({ schema: schema.name, table: table.name, columns: table.columns });
        }
      }
    }
    return out;
  }

  /**
   * Document stores get two tools, not three.
   *
   * MongoDB has no schema layer: getSchemaTree() invents a single synthetic "collections"
   * node purely so the existing tree UI renders unchanged. Offering that to the model was
   * worse than useless — it would call list_schemas, discover the synthetic group, then
   * re-list the collections scoped to it, spending two extra round-trips to learn nothing.
   * The same reasoning removes the `schema` argument from the other two.
   */
  /** Relational names carry their schema; a collection name stands alone. */
  const qualify = (schema: string, table: string) =>
    isDocumentStore ? table : `${schema}.${table}`;

  const schemaArg = isDocumentStore
    ? {}
    : { schema: { type: 'string', description: `Restrict to one schema. Omit to list every ${tableWord}.` } };

  const specs: ToolSpec[] = [];

  if (!isDocumentStore) {
    specs.push({
      name: 'list_schemas',
      description: `List the schemas in the "${database}" database, with how many tables each one holds.`,
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }

  specs.push({
    name: 'list_tables',
    description: `List the ${tableWord}s in "${database}". Call this before guessing at any name.`,
    parameters: { type: 'object', properties: { ...schemaArg }, required: [] },
  });

  specs.push({
    name: 'describe_tables',
    description: isDocumentStore
      ? `Infer the fields of one or more collections by sampling up to ${MONGO_SAMPLE_SIZE} documents from each. Returns field paths and their types only. Request every collection you need in a single call.`
      : `Get the columns, types, and nullability of one or more tables. Request every table you need in a single call.`,
    parameters: {
      type: 'object',
      properties: {
        tables: {
          type: 'array',
          items: { type: 'string' },
          description: `Names of the ${tableWord}s to describe (max ${MAX_TABLES_PER_DESCRIBE}).`,
        },
        ...(isDocumentStore
          ? {}
          : { schema: { type: 'string', description: 'Schema the names belong to, if ambiguous.' } }),
      },
      required: ['tables'],
    },
  });

  async function listSchemas(): Promise<ToolOutcome> {
    const tables = await allTables();
    const counts = new Map<string, number>();
    for (const t of tables) counts.set(t.schema, (counts.get(t.schema) ?? 0) + 1);

    const lines = [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([schema, count]) => `${schema} (${count} ${tableWord}${count === 1 ? '' : 's'})`);

    return {
      label: `Listing schemas in ${database}`,
      content: lines.length > 0 ? lines.join('\n') : `"${database}" has no ${tableWord}s.`,
    };
  }

  async function listTables(args: Record<string, unknown>): Promise<ToolOutcome> {
    const wanted = str(args.schema);
    const tables = (await allTables()).filter((t) => !wanted || t.schema === wanted);

    if (tables.length === 0) {
      return {
        label: `Listing ${tableWord}s in ${wanted ?? database}`,
        content: wanted
          ? `No ${tableWord}s found in schema "${wanted}". Call list_schemas to see which schemas exist.`
          : `"${database}" has no ${tableWord}s.`,
      };
    }

    const shown = tables.slice(0, MAX_TABLES);
    // Qualifying a collection as "collections.dup" would invite db.collections.dup — the
    // prefix is the synthetic node, not part of any real name.
    const lines = shown.map((t) => qualify(t.schema, t.table));
    if (tables.length > shown.length) {
      lines.push(`… ${tables.length - shown.length} more omitted`);
    }

    return {
      label: `Listing ${tableWord}s in ${wanted ? `${database}.${wanted}` : database}`,
      content: lines.join('\n'),
    };
  }

  async function describeTables(args: Record<string, unknown>): Promise<ToolOutcome> {
    const requested = stringArray(args.tables).slice(0, MAX_TABLES_PER_DESCRIBE);
    const wantedSchema = str(args.schema);

    if (requested.length === 0) {
      return {
        label: `Reading columns`,
        content: `No ${tableWord} names were given. Pass them in the "tables" array.`,
      };
    }

    const known = await allTables();
    const sections: string[] = [];

    for (const name of requested) {
      // Accept "schema.table" as well as a bare name, since models write both.
      const [maybeSchema, maybeTable] = name.includes('.') ? name.split('.', 2) : [undefined, name];
      const schemaFilter = maybeSchema ?? wantedSchema;
      const match = known.find(
        (t) =>
          t.table.toLowerCase() === maybeTable.toLowerCase() &&
          (!schemaFilter || t.schema.toLowerCase() === schemaFilter.toLowerCase()),
      );

      if (!match) {
        sections.push(`${name}: no such ${tableWord}. Call list_tables for the real names.`);
        continue;
      }

      let columns = match.columns;
      // Document stores carry no column list in the catalog — sample for it instead.
      if (columns.length === 0 && driver.inferFields) {
        try {
          columns = await driver.inferFields(match.table, MONGO_SAMPLE_SIZE);
        } catch (err) {
          sections.push(
            `${qualify(match.schema, match.table)}: could not sample fields (${err instanceof Error ? err.message : String(err)}).`,
          );
          continue;
        }
      }

      const qualified = qualify(match.schema, match.table);
      sections.push(
        columns.length > 0
          ? `${qualified}:\n${describeColumns(columns)}`
          : `${qualified}: no ${isDocumentStore ? 'fields found — the collection may be empty' : 'columns'}.`,
      );
    }

    const names = requested.map((n) => n.split('.').pop()).join(', ');
    return {
      label: `Reading ${isDocumentStore ? 'fields' : 'columns'} for ${names}`,
      content: sections.join('\n\n'),
    };
  }

  return {
    specs,
    async run(call: ToolCall): Promise<ToolOutcome> {
      const unknownTool = (): ToolOutcome => ({
        label: `Ignoring unknown tool ${call.name}`,
        content: `There is no tool called "${call.name}". Available tools: ${specs
          .map((s) => s.name)
          .join(', ')}.`,
      });

      switch (call.name) {
        // On a document store this tool was never offered, so a call to it gets the
        // unknown-tool reply — which names the tools that do exist, a better nudge than
        // quietly serving up the synthetic "collections" group.
        case 'list_schemas':
          return isDocumentStore ? unknownTool() : listSchemas();
        case 'list_tables':
          return listTables(call.args);
        case 'describe_tables':
          return describeTables(call.args);
        default:
          return unknownTool();
      }
    },
  };
}

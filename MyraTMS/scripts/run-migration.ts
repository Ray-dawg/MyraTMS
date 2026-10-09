import { db } from '../lib/pipeline/db-adapter';
import { readFileSync } from 'fs';
import { join } from 'path';

async function runMigration(fileName: string): Promise<void> {
  try {
    const migrationPath = join(__dirname, fileName);
    const sql = readFileSync(migrationPath, 'utf-8');

    // Split by semicolon and filter out empty statements
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const statement of statements) {
      console.log(`Executing: ${statement.substring(0, 50)}...`);
      await db.query(statement);
    }

    console.log(`Migration ${fileName} completed successfully`);
  } catch (error) {
    console.error(`Failed to run migration ${fileName}:`, error);
    process.exit(1);
  }
}

const fileName = process.argv[2] || '052-t22-objection-playbook.sql';
runMigration(fileName).catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
